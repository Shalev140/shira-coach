import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { AlertTriangle, ChevronLeft, Info, Lightbulb, RefreshCw, ShieldAlert, TrendingUp } from 'lucide-react';
import { db } from '../db/db';
import { alive, runEngine } from '../db/repo';
import { useAllSessions, useClients, useExercises, useNotes, usePrograms, useRecommendations, useSettings } from '../db/hooks';
import type { RecStatus } from '../domain/types';
import { computeAlerts } from '../domain/agenda';
import { performedVolume, sessionsInRange, weekRange } from '../domain/volume';
import { isoDate, plural } from '../domain/util';
import { Avatar, Empty, Seg, SectionHead, TopBar, useUi } from '../components/ui';
import { RecCard } from '../components/RecCard';

type Tab = 'recs' | 'alerts' | 'volume';

export function Insights() {
  const { toast } = useUi();
  const [tab, setTab] = useState<Tab>('recs');
  const [status, setStatus] = useState<'pending' | 'done'>('pending');
  const [clientFilter, setClientFilter] = useState<string | null>(null);
  const recs = useRecommendations();
  const clients = useClients();
  const sessions = useAllSessions();
  const programs = usePrograms();
  const notes = useNotes();
  const settings = useSettings();
  const { map: exercises } = useExercises();
  const measurements = useLiveQuery(async () => (await db.measurements.toArray()).filter(alive), []);
  const clientById = new Map((clients ?? []).map((c) => [c.id, c]));

  const shown = (recs ?? [])
    .filter((r) => clientById.has(r.clientId))
    .filter((r) => (status === 'pending' ? r.status === 'pending' : r.status !== 'pending'))
    .filter((r) => !clientFilter || r.clientId === clientFilter)
    .sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || b.createdAt - a.createdAt);
  const pendingCount = (recs ?? []).filter((r) => r.status === 'pending' && clientById.has(r.clientId)).length;

  const alerts = useMemo(
    () =>
      computeAlerts({
        clients: clients ?? [],
        sessions: sessions ?? [],
        programs: programs ?? [],
        recs: recs ?? [],
        notes: notes ?? [],
        measurements: measurements ?? [],
        exercises,
      }),
    [clients, sessions, programs, recs, notes, measurements, exercises],
  );

  const range = weekRange(isoDate(), settings.weekStartsOn);
  const volumeRows = useMemo(
    () =>
      (clients ?? []).map((c) => {
        const own = (sessions ?? []).filter((s) => s.clientId === c.id && s.status === 'completed');
        const vols = performedVolume(sessionsInRange(own, range), exercises, settings, c);
        return { c, under: vols.filter((v) => v.status === 'under'), over: vols.filter((v) => v.status === 'over'), ok: vols.filter((v) => v.status === 'ok').length, sessions: sessionsInRange(own, range).length };
      }),
    [clients, sessions, exercises, settings, range.start],
  );
  const names = new Map(settings.muscles.map((m) => [m.id, m.name]));

  const rerun = async () => {
    let n = 0;
    for (const c of clients ?? []) n += (await runEngine(c.id)).length;
    toast(n === 1 ? 'נוצרה המלצה חדשה אחת' : n ? `נוצרו ${n} המלצות חדשות` : 'אין המלצות חדשות — הכול מעודכן');
  };

  return (
    <>
      <TopBar
        title="תובנות"
        sub="המלצות מנומקות — ההחלטה תמיד שלך"
        actions={
          <>
            <Link to="/progress" className="btn btn-sm">
              <TrendingUp /> התקדמות
            </Link>
            <button className="icon-btn" onClick={rerun} aria-label="בדיקה מחדש">
              <RefreshCw />
            </button>
          </>
        }
      />
      <div className="page stack-lg">
        <Seg
          value={tab}
          onChange={setTab}
          options={[
            { value: 'recs', label: `המלצות${pendingCount ? ` (${pendingCount})` : ''}` },
            { value: 'alerts', label: `התראות${alerts.length ? ` (${alerts.length})` : ''}` },
            { value: 'volume', label: 'נפח השבוע' },
          ]}
        />

        {tab === 'recs' && (
          <>
            <div className="row row-wrap between">
              <Seg
                value={status}
                onChange={setStatus}
                options={[
                  { value: 'pending', label: 'ממתינות' },
                  { value: 'done', label: 'היסטוריה' },
                ]}
              />
            </div>
            {(clients?.length ?? 0) > 1 && (
              <div className="chips-scroll">
                <button className={`chip chip-sm ${!clientFilter ? 'on' : ''}`} onClick={() => setClientFilter(null)}>
                  כולם
                </button>
                {(clients ?? []).map((c) => (
                  <button key={c.id} className={`chip chip-sm ${clientFilter === c.id ? 'on' : ''}`} onClick={() => setClientFilter(clientFilter === c.id ? null : c.id)}>
                    {c.name}
                  </button>
                ))}
              </div>
            )}
            {shown.length === 0 && (
              <div className="card">
                <Empty icon={<Lightbulb />} title={status === 'pending' ? 'אין המלצות ממתינות' : 'אין עדיין היסטוריית המלצות'}>
                  המנוע בודק אחרי כל אימון: העלאת משקל / חזרות, התאמת טווח, החלפת תרגיל, התאוששות, איזון נפח ופער תכנון-ביצוע. כאב או טכניקה לא מספקת חוסמים המלצות להעלאת עומס.
                </Empty>
              </div>
            )}
            <div className="grid-recs">
              {shown.map((r) => (
                <RecCard key={r.id} rec={r} client={clientById.get(r.clientId)} exercises={exercises} compact={status === 'done'} />
              ))}
            </div>
            {status === 'done' && shown.length > 0 && <HistoryLegend statuses={shown.map((r) => r.status)} />}
          </>
        )}

        {tab === 'alerts' && (
          <section className="section">
            {alerts.length === 0 ? (
              <div className="card">
                <Empty icon={<ShieldAlert />} title="אין התראות">התראות על כאב שדווח, ירידה עקבית בביצועים, נתונים חסרים ופערים יופיעו כאן.</Empty>
              </div>
            ) : (
              <div className="card list">
                {alerts.map((a) => (
                  <Link key={a.id} to={a.link} className="list-item">
                    <div className={`alert-icon tone-${a.tone}`}>{a.tone === 'danger' ? <ShieldAlert /> : a.tone === 'warn' ? <AlertTriangle /> : <Info />}</div>
                    <div className="grow">
                      <div className="title small">{a.title}</div>
                      <div className="sub">{a.detail}</div>
                    </div>
                    <ChevronLeft className="chev" />
                  </Link>
                ))}
              </div>
            )}
          </section>
        )}

        {tab === 'volume' && (
          <section className="section">
            <SectionHead title="מצב הנפח השבועי לפי מתאמן/ת" />
            <p className="small muted">השבוע הנוכחי. לפירוט מלא וההסבר איך חושב — בכרטיס המתאמן/ת, לשונית התקדמות.</p>
            <div className="card list">
              {volumeRows.map(({ c, under, over, ok, sessions: n }) => (
                <Link key={c.id} to={`/clients/${c.id}?tab=progress`} className="list-item">
                  <Avatar name={c.name} color={c.color} size="sm" />
                  <div className="grow">
                    <div className="title small">{c.name}</div>
                    <div className="sub">
                      {plural(n, 'אימון אחד', 'אימונים')} השבוע
                      {under.length ? ` · חסר: ${under.slice(0, 4).map((v) => names.get(v.muscle)).join(', ')}` : ''}
                    </div>
                  </div>
                  <div className="row" style={{ gap: 4 }}>
                    {ok > 0 && <span className="badge tone-success num" aria-label={`${ok} ביעד`}>{ok} ✓</span>}
                    {under.length > 0 && <span className="badge tone-warn num" aria-label={`${under.length} מתחת ליעד`}>{under.length} ↓</span>}
                    {over.length > 0 && <span className="badge tone-info num" aria-label={`${over.length} מעל היעד`}>{over.length} ↑</span>}
                  </div>
                  <ChevronLeft className="chev" />
                </Link>
              ))}
            </div>
          </section>
        )}
      </div>
    </>
  );
}

function sevRank(s: string) {
  return s === 'warn' ? 0 : s === 'suggest' ? 1 : 2;
}

function HistoryLegend({ statuses }: { statuses: RecStatus[] }) {
  const counts = statuses.reduce<Record<string, number>>((m, s) => ((m[s] = (m[s] ?? 0) + 1), m), {});
  const labels: Record<string, string> = { approved: 'אושרו', applied: 'בוצעו', rejected: 'נדחו', edited: 'נערכו' };
  return (
    <div className="row row-wrap small muted" style={{ gap: 10, justifyContent: 'center' }}>
      {Object.entries(counts).map(([k, v]) => (
        <span key={k}>
          {labels[k] ?? k}: <b className="num">{v}</b>
        </span>
      ))}
    </div>
  );
}
