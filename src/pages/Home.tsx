import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  AlertTriangle,
  BookOpen,
  CalendarDays,
  ChevronLeft,
  CircleCheck,
  DatabaseBackup,
  Info,
  Play,
  Plus,
  Settings as SettingsIcon,
  Share,
  ShieldAlert,
  Smartphone,
  Sparkles,
  StickyNote,
  UserPlus,
  WifiOff,
  X,
  Zap,
} from 'lucide-react';
import { useInstall } from '../components/install';
import { db } from '../db/db';
import { alive, startSession } from '../db/repo';
import { useActiveSessions, useAllSessions, useClients, useExercises, useMeta, useNotes, usePrograms, useRecommendations, useSettings } from '../db/hooks';
import { computeAlerts, nextWorkout, openNextNotes, openTasks, todayAgenda } from '../domain/agenda';
import { daysBetween, fmtMinutes, isoDate, matches, relativeDay } from '../domain/util';
import { Avatar, Empty, SearchInput, SectionHead, TopBar, useOnline, useUi } from '../components/ui';
import { RecCard } from '../components/RecCard';
import { loadDemoData } from '../domain/demo';

/**
 * Nudges installing to the home screen: works like an app, opens offline, and storage is protected.
 * On an iPhone in Safari it stays (no dismiss): the home-screen app has its own storage, so what is
 * entered in Safari never reaches it — and Safari may delete it after a week without a visit.
 */
function InstallBanner({ hasData }: { hasData: boolean }) {
  const inst = useInstall();
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem('install-dismissed') === '1';
    } catch {
      return false;
    }
  });
  const iosSafari = inst.ios && !inst.installed;
  if (inst.installed || (hidden && !iosSafari) || (!inst.canPrompt && !inst.ios)) return null;
  const dismiss = () => {
    setHidden(true);
    try {
      localStorage.setItem('install-dismissed', '1');
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="banner tone-accent">
      <Smartphone />
      <div className="grow small">
        <div className="strong">התקנה למסך הבית</div>
        {inst.ios ? (
          <>
            <div>
              כפתור השיתוף <Share size={14} style={{ verticalAlign: -2 }} /> ← ״הוספה למסך הבית״, ואז לפתוח את האייקון פעם אחת כשיש אינטרנט — מאותו רגע האפליקציה עובדת גם בלי קליטה.
            </div>
            <div className="strong">
              חשוב: מה שנשמר כאן בספארי לא עובר לאפליקציה שבמסך הבית, וספארי עלול למחוק אותו אחרי שבוע בלי כניסה. לעבוד רק מהאייקון.
            </div>
            {hasData && (
              <Link to="/backup" className="link-btn">
                כבר הוזנו נתונים כאן? גיבוי עכשיו ← שמירה בקבצים, ואז באייקון: גיבוי ← בחירת קובץ גיבוי ← מיזוג <ChevronLeft />
              </Link>
            )}
          </>
        ) : (
          <div>נפתחת כמו אפליקציה, עובדת בלי אינטרנט והנתונים מוגנים יותר.</div>
        )}
      </div>
      {inst.canPrompt && (
        <button className="btn btn-primary btn-sm" onClick={() => inst.prompt()}>
          התקנה
        </button>
      )}
      {!iosSafari && (
        <button className="icon-btn" aria-label="סגירה" onClick={dismiss}>
          <X size={18} />
        </button>
      )}
    </div>
  );
}

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'לילה טוב';
  if (h < 12) return 'בוקר טוב';
  if (h < 17) return 'צהריים טובים';
  if (h < 21) return 'ערב טוב';
  return 'לילה טוב';
}

export function Home() {
  const nav = useNavigate();
  const { toast } = useUi();
  const settings = useSettings();
  const clients = useClients();
  const sessions = useAllSessions();
  const programs = usePrograms();
  const recs = useRecommendations();
  const notes = useNotes();
  const active = useActiveSessions();
  const { map: exercises } = useExercises();
  const measurements = useLiveQuery(async () => (await db.measurements.toArray()).filter(alive), []);
  const online = useOnline();
  const [q, setQ] = useState('');
  const today = isoDate();

  const agenda = useMemo(() => todayAgenda(clients ?? [], programs ?? [], sessions ?? [], today), [clients, programs, sessions, today]);
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
  const clientById = new Map((clients ?? []).map((c) => [c.id, c]));
  // archived clients' recommendations are left out here, as in the nav badge and in Insights
  const pending = (recs ?? []).filter((r) => r.status === 'pending' && clientById.has(r.clientId));
  const tasks = openTasks(notes ?? []);
  const loading = !clients || !sessions;
  const hasData = (clients?.length ?? 0) > 0;
  const lastBackup = useMeta<number>('lastExternalBackupAt');
  const backupDue = hasData && (!lastBackup || Date.now() - lastBackup > settings.backupReminderDays * 86400000);

  const lastSessionOf = (id: string) => (sessions ?? []).find((s) => s.clientId === id && s.status === 'completed');
  const shownClients = (clients ?? [])
    .filter((c) => matches(q, c.name, c.phone))
    .sort((a, b) => (lastSessionOf(b.id)?.startedAt ?? b.createdAt) - (lastSessionOf(a.id)?.startedAt ?? a.createdAt))
    .slice(0, q ? 20 : 6);

  // the program's next workout for any client, also one who isn't on today's agenda (same as the clients screen)
  const start = async (clientId: string) => {
    const program = (programs ?? []).find((p) => p.clientId === clientId && p.status === 'active') ?? null;
    const w = nextWorkout(program, (sessions ?? []).filter((s) => s.clientId === clientId));
    const s = await startSession({ clientId, program, workoutId: w?.id });
    nav(`/session/${s.id}`);
  };

  const demo = async () => {
    await loadDemoData();
    toast('נטענו נתוני הדגמה — אפשר למחוק אותם בהגדרות');
  };

  return (
    <>
      <TopBar
        title={`${greeting()}, ${settings.trainerName || 'שירה'}`}
        sub={new Intl.DateTimeFormat('he-IL', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())}
        actions={
          <>
            {!online && (
              <span className="offline-pill" title="אין חיבור — הכול נשמר במכשיר">
                <WifiOff /> לא מקוון
              </span>
            )}
            <Link to="/library" className="icon-btn hide-desktop" aria-label="ספריית תרגילים">
              <BookOpen />
            </Link>
            <Link to="/backup" className="icon-btn hide-desktop" aria-label="גיבוי">
              <DatabaseBackup />
              {backupDue && <span className="dot" />}
            </Link>
            <Link to="/settings" className="icon-btn hide-desktop" aria-label="הגדרות">
              <SettingsIcon />
            </Link>
          </>
        }
      />
      <div className="page stack-lg">
        {(active ?? []).map((s) => {
          const c = clientById.get(s.clientId);
          const total = s.entries.reduce((n, e) => n + e.sets.length, 0);
          const done = s.entries.reduce((n, e) => n + e.sets.filter((x) => x.done).length, 0);
          return (
            <button key={s.id} className="hero hero-live" onClick={() => nav(`/session/${s.id}`)} style={{ textAlign: 'start' }}>
              <div className="row between" style={{ position: 'relative', zIndex: 1 }}>
                <div className="stack-sm">
                  {Date.now() - s.startedAt > 6 * 3600000 ? (
                    <span className="badge tone-warn">
                      <AlertTriangle /> נפתח {relativeDay(s.date)} ולא הסתיים — כדאי לסיים או לבטל
                    </span>
                  ) : (
                    <span className="badge tone-lime">
                      <Zap /> אימון פעיל · {fmtMinutes(Date.now() - s.startedAt)}
                    </span>
                  )}
                  <h2 style={{ color: '#fff', marginTop: 6 }}>{c?.name ?? 'מתאמן/ת'}</h2>
                  <div className="muted small">
                    {s.workoutName} · {done}/{total} סטים
                  </div>
                </div>
                <span className="btn btn-lime">
                  המשך <ChevronLeft />
                </span>
              </div>
              <div className="bar" style={{ marginTop: 14, background: 'rgba(255,255,255,.12)', position: 'relative', zIndex: 1 }}>
                <i style={{ width: `${total ? (done / total) * 100 : 0}%`, background: 'var(--lime)' }} />
              </div>
            </button>
          );
        })}

        {backupDue && (
          <Link to="/backup" className="banner tone-warn" style={{ color: 'inherit' }}>
            <DatabaseBackup />
            <div className="grow">
              <div className="strong">כדאי לגבות את הנתונים</div>
              <div className="small">
                {lastBackup
                  ? `הגיבוי האחרון מחוץ למכשיר היה ${relativeDay(isoDate(lastBackup))}.`
                  : 'עדיין לא נשמר גיבוי מחוץ למכשיר.'}{' '}
                לחיצה אחת שולחת קובץ גיבוי לדרייב / וואטסאפ / מייל.
              </div>
            </div>
            <ChevronLeft />
          </Link>
        )}

        <InstallBanner hasData={hasData} />

        {!loading && !hasData && (
          <div className="hero">
            <div className="stack" style={{ position: 'relative', zIndex: 1 }}>
              <span className="badge tone-lime" style={{ alignSelf: 'flex-start' }}>
                <Sparkles /> ברוכה הבאה
              </span>
              <h1 style={{ color: '#fff' }}>מתחילים לעבוד</h1>
              <p className="muted">
                תכנון מראש ← תיעוד מהיר בזמן אמת ← סיכום אוטומטי ← המלצות מנומקות ← ההחלטה שלך. הכול נשמר במכשיר ועובד גם בלי קליטה.
              </p>
              <div className="row row-wrap">
                <Link to="/clients/new" className="btn btn-lime">
                  <UserPlus /> מתאמן/ת ראשון/ה
                </Link>
                <button className="btn" style={{ background: 'rgba(255,255,255,.14)', color: '#fff', borderColor: 'transparent' }} onClick={demo}>
                  <Sparkles /> לנסות עם נתוני הדגמה
                </button>
              </div>
              <Link to="/backup" className="link-btn" style={{ color: '#fff' }}>
                <DatabaseBackup size={16} /> יש קובץ גיבוי? שחזור מקובץ
              </Link>
            </div>
          </div>
        )}

        <div className="split">
          <div className="stack-lg">
            {hasData && (
              <section className="section">
                <SectionHead
                  title={
                    <>
                      <CalendarDays size={18} /> היום
                    </>
                  }
                  count={agenda.length}
                  action={
                    <Link to="/workout" className="link-btn">
                      אימון לא מתוכנן <Plus />
                    </Link>
                  }
                />
                {agenda.length === 0 && (
                  <div className="card">
                    <Empty title="אין אימונים מתוכננים להיום">
                      ימי האימון נקבעים בכרטיס המתאמן/ת. אפשר להתחיל אימון לכל מתאמן/ת בכל רגע.
                    </Empty>
                  </div>
                )}
                {agenda.map((a) => {
                  const nextNotes = openNextNotes(notes ?? [], a.client.id);
                  const status = a.session?.status === 'active' ? 'live' : a.session?.status === 'completed' ? 'done' : 'planned';
                  return (
                    <div key={a.client.id} className={`card agenda ${status}`}>
                      <div className="row">
                        <Avatar name={a.client.name} color={a.client.color} />
                        <Link to={`/clients/${a.client.id}`} className="grow" style={{ color: 'inherit' }}>
                          <div className="strong">{a.client.name}</div>
                          <div className="small muted ellipsis">
                            {a.workout ? `אימון ${a.workout.name}${a.workout.focus ? ` · ${a.workout.focus}` : ''}` : a.program ? a.program.name : 'ללא תוכנית פעילה'}
                          </div>
                        </Link>
                        {status === 'done' && (
                          <button className="btn btn-sm" onClick={() => nav(`/session/${a.session!.id}/view`)}>
                            <CircleCheck /> הושלם
                          </button>
                        )}
                        {status === 'live' && (
                          <button className="btn btn-lime btn-sm" onClick={() => nav(`/session/${a.session!.id}`)}>
                            <Zap /> בתהליך
                          </button>
                        )}
                        {status === 'planned' && (
                          <button className="btn btn-primary btn-sm" onClick={() => start(a.client.id)}>
                            <Play /> התחלה
                          </button>
                        )}
                      </div>
                      {status === 'planned' && nextNotes.length > 0 && (
                        <div className="next-notes">
                          <StickyNote />
                          <div className="grow stack-sm">
                            {nextNotes.slice(0, 3).map((n) => (
                              <div key={n.id} className="small">
                                {n.text}
                              </div>
                            ))}
                            {nextNotes.length > 3 && <div className="tiny muted">ועוד {nextNotes.length - 3}…</div>}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </section>
            )}

            {pending.length > 0 && (
              <section className="section">
                <SectionHead
                  title="ממתין לאישור"
                  count={pending.length}
                  action={
                    <Link to="/insights" className="link-btn">
                      הכול <ChevronLeft />
                    </Link>
                  }
                />
                {pending
                  .slice()
                  .sort((a, b) => (a.severity === 'warn' ? -1 : 0) - (b.severity === 'warn' ? -1 : 0))
                  .slice(0, 3)
                  .map((r) => (
                    <RecCard key={r.id} rec={r} client={clientById.get(r.clientId)} exercises={exercises} compact />
                  ))}
              </section>
            )}
          </div>

          <div className="stack-lg">
            {alerts.length > 0 && (
              <section className="section">
                <SectionHead title="דורש תשומת לב" count={alerts.length} />
                <div className="card list">
                  {alerts.slice(0, 8).map((a) => (
                    <Link key={a.id} to={a.link} className="list-item">
                      <div className={`alert-icon tone-${a.tone}`}>
                        {a.tone === 'danger' ? <ShieldAlert /> : a.tone === 'warn' ? <AlertTriangle /> : <Info />}
                      </div>
                      <div className="grow">
                        <div className="title small">{a.title}</div>
                        <div className="sub">{a.detail}</div>
                      </div>
                      <ChevronLeft className="chev" />
                    </Link>
                  ))}
                </div>
              </section>
            )}

            {tasks.length > 0 && (
              <section className="section">
                <SectionHead title="משימות מעקב" count={tasks.length} />
                <div className="card list">
                  {tasks.slice(0, 6).map((t) => (
                    <Link key={t.id} to={`/clients/${t.clientId}?tab=notes`} className="list-item">
                      <Avatar name={clientById.get(t.clientId)?.name ?? '?'} color={clientById.get(t.clientId)?.color} size="sm" />
                      <div className="grow">
                        <div className="small strong">{t.text}</div>
                        <div className="sub">{clientById.get(t.clientId)?.name}</div>
                      </div>
                    </Link>
                  ))}
                </div>
              </section>
            )}

            {hasData && (
              <section className="section">
                <SectionHead
                  title="מתאמנים"
                  count={clients?.length}
                  action={
                    <Link to="/clients/new" className="link-btn">
                      חדש <Plus />
                    </Link>
                  }
                />
                <SearchInput value={q} onChange={setQ} placeholder="חיפוש מתאמן/ת לפי שם…" />
                <div className="card list">
                  {shownClients.map((c) => {
                    const last = lastSessionOf(c.id);
                    const gap = last ? daysBetween(last.date, today) : null;
                    return (
                      <div key={c.id} className="list-item">
                        <Link to={`/clients/${c.id}`} className="row grow" style={{ color: 'inherit' }}>
                          <Avatar name={c.name} color={c.color} size="sm" />
                          <div className="grow">
                            <div className="title small">{c.name}</div>
                            <div className="sub">{last ? `אימון אחרון ${relativeDay(last.date)}` : 'עוד לא התאמן/ה'}</div>
                          </div>
                        </Link>
                        {gap !== null && gap > 10 && <span className="badge tone-warn">{gap} ימים</span>}
                        <button className="icon-btn" aria-label={`התחלת אימון ל${c.name}`} onClick={() => start(c.id)}>
                          <Play />
                        </button>
                      </div>
                    );
                  })}
                  {shownClients.length === 0 && <div className="empty small">לא נמצאו מתאמנים</div>}
                </div>
                {!q && (clients?.length ?? 0) > 6 && (
                  <Link to="/clients" className="btn btn-ghost btn-sm" style={{ alignSelf: 'center' }}>
                    לכל {clients?.length} המתאמנים
                  </Link>
                )}
              </section>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
