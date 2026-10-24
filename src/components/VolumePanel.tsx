import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowDown, ArrowUp, Check, ChevronLeft, ChevronRight, HelpCircle, Minus } from 'lucide-react';
import type { Client, Exercise, ID, Program, Session, Settings } from '../domain/types';
import { adjacentOverlap, explainContributions, performedVolume, plannedVolume, sessionsInRange, weekRange, type MuscleVolume, type OverlapFlag, type WeekRange } from '../domain/volume';
import { addDays, fmtDate, fmtNum, isoDate, plural } from '../domain/util';
import { VolumeBar } from './charts';
import { Seg } from './ui';

/** Status is always icon + word (never color alone); the word hides on narrow screens. */
function StatusTag({ v }: { v: MuscleVolume }) {
  if (v.status === 'none') return <span className="tiny faint">ללא יעד</span>;
  const map = {
    under: { tone: 'warn', icon: <ArrowDown />, label: 'מתחת' },
    over: { tone: 'info', icon: <ArrowUp />, label: 'מעל' },
    ok: { tone: 'success', icon: <Check />, label: 'ביעד' },
  } as const;
  const s = map[v.status];
  return (
    <span className={`badge tone-${s.tone}`} title={s.label} aria-label={s.label}>
      {s.icon}
      <span className="st-label">{s.label}</span>
    </span>
  );
}

/**
 * Back-to-back heavy days for the shown week. The days just outside the week are looked at too, so a
 * Saturday + Sunday pair across the week boundary is flagged in both weeks, as any pair inside one is.
 */
export function weekOverlap(completed: Session[], range: WeekRange, exercises: Map<ID, Exercise>, settings: Settings, client: Client): OverlapFlag[] {
  const wide = { start: addDays(range.start, -1), end: addDays(range.end, 1) };
  const inWeek = (d: string) => d >= range.start && d <= range.end;
  return adjacentOverlap(performedVolume(sessionsInRange(completed, wide), exercises, settings, client)).filter((o) => inWeek(o.dayA) || inWeek(o.dayB));
}

export function VolumePanel({
  client,
  sessions,
  program,
  exercises,
  settings,
  compact,
  initialMode,
}: {
  client: Client;
  sessions: Session[];
  program?: Program | null;
  exercises: Map<ID, Exercise>;
  settings: Settings;
  compact?: boolean;
  /** start on the planned view (the program editor) */
  initialMode?: 'done' | 'plan';
}) {
  const [offset, setOffset] = useState(0);
  const [mode, setMode] = useState<'done' | 'plan'>(initialMode ?? 'done');
  const [open, setOpen] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const range = weekRange(addDays(isoDate(), offset * 7), settings.weekStartsOn);
  const weekSessions = useMemo(() => sessionsInRange(sessions.filter((s) => s.status === 'completed'), range), [sessions, range.start]);
  const vols = useMemo(
    () => (mode === 'plan' && program ? plannedVolume(program, exercises, settings, client) : performedVolume(weekSessions, exercises, settings, client)),
    [mode, program, weekSessions, exercises, settings, client],
  );
  const overlap = useMemo(
    () => (mode === 'done' ? weekOverlap(sessions.filter((s) => s.status === 'completed'), range, exercises, settings, client) : []),
    [mode, sessions, range.start, exercises, settings, client],
  );
  const names = new Map(settings.muscles.map((m) => [m.id, m.name]));
  const scaleMax = Math.max(10, ...vols.map((v) => Math.max(v.effective, v.target?.max ?? 0))) * 1.08;
  const shown = compact ? (mode === 'done' && weekSessions.length === 0 ? [] : vols.filter((v) => v.effective > 0 || v.status === 'under')) : vols;
  const under = vols.filter((v) => v.status === 'under').length;
  const over = vols.filter((v) => v.status === 'over').length;
  // "balanced" needs at least one muscle on target, and in the performed view a week with workouts
  const balanced = under === 0 && over === 0 && vols.some((v) => v.status === 'ok') && (mode === 'plan' || weekSessions.length > 0);

  return (
    <div className="stack">
      <div className="row between row-wrap">
        {mode === 'done' ? (
          <div className="row" style={{ gap: 4 }}>
            <button className="icon-btn" onClick={() => setOffset((o) => o - 1)} aria-label="שבוע קודם">
              <ChevronRight />
            </button>
            <div className="small strong" style={{ minWidth: 118, textAlign: 'center' }}>
              {offset === 0 ? 'השבוע' : offset === -1 ? 'שבוע שעבר' : `${fmtDate(range.start)} – ${fmtDate(range.end)}`}
              <div className="tiny muted">{plural(weekSessions.length, 'אימון אחד', 'אימונים')}</div>
            </div>
            <button className="icon-btn" onClick={() => setOffset((o) => Math.min(0, o + 1))} disabled={offset === 0} aria-label="שבוע הבא">
              <ChevronLeft />
            </button>
          </div>
        ) : (
          <div className="small muted">לפי התוכנית הפעילה, שבוע טיפוסי</div>
        )}
        {program && (
          <Seg
            value={mode}
            onChange={setMode}
            options={[
              { value: 'done', label: 'בוצע' },
              { value: 'plan', label: 'מתוכנן' },
            ]}
          />
        )}
      </div>

      <div className="row row-wrap small muted" style={{ gap: 14 }}>
        <span className="legend"><i className="lg-direct" /> סטים ישירים</span>
        <span className="legend"><i className="lg-indirect" /> עקיפים (משוקללים)</span>
        <span className="legend"><i className="lg-target" /> טווח יעד</span>
        <button className="link-btn" onClick={() => setHelp((h) => !h)}>
          <HelpCircle /> איך זה מחושב?
        </button>
      </div>
      {help && (
        <div className="banner tone-info">
          <HelpCircle />
          <div className="grow small">
            <p>
              <b>סט ישיר</b> — כל סט עבודה שהושלם נספר כ-1 לכל שריר <b>עיקרי</b> של התרגיל.
            </p>
            <p>
              <b>תרומה עקיפה</b> — אותו סט נספר גם לשרירים <b>המשניים</b>, מוכפל במקדם (ברירת מחדל {settings.indirectFactor}, אפשר לשנות לכל תרגיל).
            </p>
            <p>
              <b>נפח אפקטיבי</b> = ישיר + Σ(עקיף × מקדם), ומושווה ליעד האישי. סטי חימום לא נספרים
              {settings.countDropSets ? '' : ', וגם לא סטי דרופ'}
              {settings.hardSetMaxRir !== null ? `; נספרים רק סטים עם RIR ≤ ${settings.hardSetMaxRir}` : ''}.
            </p>
            <p>
              <b>תדירות</b> — במספר אימונים השריר קיבל לפחות סט ישיר אחד. לחיצה על שורה מציגה את הפירוט.{' '}
              <Link to="/settings">שינוי הכללים בהגדרות</Link>
            </p>
          </div>
        </div>
      )}

      <div className="card vol-list">
        {shown.map((v) => {
          const expanded = open === v.muscle;
          return (
            <div key={v.muscle} className="vol-item">
              <button className="vol-row" onClick={() => setOpen(expanded ? null : v.muscle)} aria-expanded={expanded}>
                <div className="vol-name">
                  <div className="strong small">{names.get(v.muscle)}</div>
                  <div className="tiny muted">
                    {v.frequency > 0 ? `×${v.frequency} ${mode === 'plan' ? 'בשבוע' : v.frequency === 1 ? 'אימון' : 'אימונים'}` : '—'}
                  </div>
                </div>
                <div className="grow">
                  <VolumeBar direct={v.direct} indirect={v.indirect} target={v.target} scaleMax={scaleMax} />
                </div>
                <div className="vol-num">
                  <div className="strong num">{fmtNum(v.effective)}</div>
                  <div className="tiny muted num">{v.target ? `${v.target.min}–${v.target.max}` : ''}</div>
                </div>
                <div className="vol-status">
                  <StatusTag v={v} />
                </div>
              </button>
              {expanded && (
                <div className="vol-explain">
                  <div className="small">
                    <span className="num strong">{v.direct}</span> ישירים + <span className="num strong">{fmtNum(v.indirect)}</span> עקיפים ={' '}
                    <span className="num strong">{fmtNum(v.effective)}</span> סטים אפקטיביים
                    {v.target && (
                      <>
                        {' '}
                        · יעד <span className="num">{v.target.min}–{v.target.max}</span>
                      </>
                    )}
                  </div>
                  {explainContributions(v).length === 0 && <div className="tiny muted">לא נרשמה עבודה לשריר הזה.</div>}
                  {explainContributions(v).map((c, i) => (
                    <div key={i} className="ex-line">
                      <span className="ellipsis">{exercises.get(c.exerciseId)?.nameHe ?? c.exerciseId}</span>
                      <span className={`badge ${c.role === 'primary' ? 'tone-accent' : ''}`}>{c.role === 'primary' ? 'ישיר' : 'עקיף'}</span>
                      <span className="num tiny muted" style={{ minWidth: 70, textAlign: 'left' }}>
                        {c.role === 'primary' ? `${c.sets} ${c.sets === 1 ? 'סט' : 'סטים'}` : `${c.sets} × ${c.factor}`}
                      </span>
                      <span className="num strong" style={{ minWidth: 34, textAlign: 'left' }}>{fmtNum(c.value)}</span>
                    </div>
                  ))}
                  {mode === 'done' && Object.keys(v.byDay).length > 0 && (
                    <div className="tiny muted">
                      לפי יום:{' '}
                      {Object.entries(v.byDay)
                        .sort()
                        .map(([d, n]) => `${fmtDate(d)} — ${fmtNum(n)}`)
                        .join(' · ')}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {shown.length === 0 && <div className="empty small">אין עדיין סטים שבוצעו בשבוע הזה</div>}
      </div>

      {(under > 0 || over > 0 || balanced) && (
        <div className="row row-wrap small" style={{ gap: 8 }}>
          {under > 0 && <span className="badge tone-warn"><ArrowDown /> {under} מתחת ליעד</span>}
          {over > 0 && <span className="badge tone-info"><ArrowUp /> {over} מעל היעד</span>}
          {balanced && <span className="badge tone-success"><Minus /> מאוזן</span>}
        </div>
      )}
      {overlap.length > 0 && (
        <div className="banner tone-warn">
          <AlertTriangle />
          <div className="grow small">
            <b>חפיפה בין אימונים סמוכים:</b>{' '}
            {overlap.map((o) => `${names.get(o.muscle)} (${fmtDate(o.dayA)} ו-${fmtDate(o.dayB)})`).join(', ')} — עבודה משמעותית ביומיים רצופים.
          </div>
        </div>
      )}
    </div>
  );
}
