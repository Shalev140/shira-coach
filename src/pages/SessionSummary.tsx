import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  AlertTriangle,
  Award,
  Check,
  ClipboardList,
  Clock,
  GitCompare,
  Plus,
  RotateCcw,
  Sparkles,
  StickyNote,
  Trash2,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { db } from '../db/db';
import { addNote, alive, discardSession, resolveNote, runEngine, softDelete } from '../db/repo';
import { useClient, useExercises, useNotes, useRecommendations } from '../db/hooks';
import type { ID, PerformedSet, Recommendation, Session, SessionEntry, SessionWrapUp } from '../domain/types';
import { SET_TYPES, TECHNIQUE } from '../domain/labels';
import { summarizeSession, type EntrySummary } from '../domain/summary';
import { formatSet } from '../domain/progress';
import { fmtDate, fmtMinutes, fmtNum, fmtTime, now, plural } from '../domain/util';
import { Field, NumInput, Rating, Sheet, TopBar, useUi } from '../components/ui';
import { RecCard } from '../components/RecCard';

/**
 * Changes the LATEST stored session, never a render-time copy: on a phone, leaving the note by
 * tapping a rating or a button fires blur and click in one task, before the live query re-renders,
 * so a whole-session save from this render would wipe the note that was just saved.
 */
export function patchStoredSession(id: ID, fn: (cur: Session) => void): Promise<number> {
  return db.sessions.update(id, (cur) => {
    fn(cur);
    cur.updatedAt = now();
  });
}

// one re-check at a time, so a burst of rating taps is applied in order and the last run sees the final rating
let recheckChain: Promise<unknown> = Promise.resolve();

/**
 * Saves the workout's effort / feeling rating. Those are rated only here, after the engine already ran
 * when the workout was finished, so a finished workout is re-checked right away: the fatigue rule
 * (three workouts in a row rated 9–10) reads this rating.
 */
export async function saveWrapRating(id: ID, patch: Pick<SessionWrapUp, 'effort' | 'feeling'>): Promise<Recommendation[]> {
  await patchStoredSession(id, (cur) => {
    cur.wrapUp = { ...cur.wrapUp, ...patch };
  });
  const cur = await db.sessions.get(id);
  if (!alive(cur) || cur.status !== 'completed') return [];
  const clientId = cur.clientId;
  const run = recheckChain.then(() => runEngine(clientId, id));
  recheckChain = run.catch(() => {});
  try {
    return await run;
  } catch (e) {
    console.warn('re-check after rating failed', e);
    return [];
  }
}

/**
 * A set corrected in the summary is real data. Ticking it done makes a skipped / not-done exercise done,
 * as completing a set does in the live workout; un-ticking its last done set makes it not done, as
 * finishing the workout does.
 */
export function correctSet(e: SessionEntry, setId: ID, s: PerformedSet): SessionEntry {
  const before = e.sets.find((x) => x.id === setId);
  const sets = e.sets.map((x) => (x.id === setId ? { ...s, autoFilled: false } : x));
  const ticked = s.done && !before?.done;
  const status = ticked && e.status !== 'done' ? 'done' : e.status === 'done' && !sets.some((x) => x.done) ? 'notdone' : e.status;
  return { ...e, status, sets };
}

export function SessionSummaryPage({ mode }: { mode: 'summary' | 'view' }) {
  const { id } = useParams();
  const session = useLiveQuery(async () => {
    const s = id ? await db.sessions.get(id) : undefined;
    return alive(s) ? s : null;
  }, [id]);
  if (session === undefined) return null;
  if (!session)
    return (
      <>
        <TopBar title="האימון לא נמצא" back="/" />
      </>
    );
  // one instance per workout: an evidence link opens another workout on the same route, and a kept
  // instance would carry the unsaved note / inputs over and save them into that workout
  return <Summary key={session.id} session={session} mode={mode} />;
}

function Summary({ session, mode }: { session: Session; mode: 'summary' | 'view' }) {
  const nav = useNavigate();
  const { toast, confirm } = useUi();
  const client = useClient(session.clientId);
  const { map: exercises } = useExercises();
  const allSessions = useLiveQuery(async () => (await db.sessions.where('clientId').equals(session.clientId).toArray()).filter(alive), [session.clientId]);
  const notes = useNotes(session.clientId) ?? [];
  const recs = (useRecommendations(session.clientId) ?? []).filter((r) => r.sourceSessionId === session.id);
  const summary = useMemo(() => (allSessions ? summarizeSession(session, allSessions, exercises) : null), [session, allSessions, exercises]);
  const [noteText, setNoteText] = useState('');
  const [taskText, setTaskText] = useState('');
  const [editSet, setEditSet] = useState<{ entryId: string; setId: string } | null>(null);
  const sessionNotes = notes.filter((n) => n.sessionId === session.id);
  const shownNotes = notes.filter((n) => session.shownNoteIds?.includes(n.id));
  const autoFilled = session.entries.reduce((n, e) => n + e.sets.filter((x) => x.done && x.autoFilled).length, 0);
  const isSummary = mode === 'summary';

  const patchWrap = (patch: Partial<Session['wrapUp']>) =>
    patchStoredSession(session.id, (cur) => {
      cur.wrapUp = { ...cur.wrapUp, ...patch };
    });
  const rate = async (patch: Pick<SessionWrapUp, 'effort' | 'feeling'>) => {
    const created = await saveWrapRating(session.id, patch);
    if (created.length) toast(`הדירוג נשמר · ${plural(created.length, 'המלצה חדשה', 'המלצות חדשות')}`);
  };

  const addNext = async () => {
    if (!noteText.trim()) return;
    await addNote(session.clientId, 'next', noteText, { sessionId: session.id, demo: session.demo });
    setNoteText('');
  };
  const addTask = async () => {
    if (!taskText.trim()) return;
    await addNote(session.clientId, 'task', taskText, { sessionId: session.id, demo: session.demo });
    setTaskText('');
  };

  if (!summary) return null;
  const t = summary.totals;

  return (
    <>
      <TopBar
        title={isSummary ? 'סיכום האימון' : session.workoutName}
        sub={
          <>
            {client?.name} · {fmtDate(session.date)}
            {session.endedAt && (
              <>
                {' · '}
                <span className="ltr">
                  {fmtTime(session.startedAt)}–{fmtTime(session.endedAt)}
                </span>
              </>
            )}
          </>
        }
        back={isSummary ? undefined : true}
      />
      <div className="page stack-lg">
        {isSummary && (
          <div className="hero">
            <div className="stack-sm" style={{ position: 'relative', zIndex: 1 }}>
              <span className="badge tone-lime" style={{ alignSelf: 'flex-start' }}>
                <Check /> האימון נשמר
              </span>
              <h1 style={{ color: '#fff' }}>כל הכבוד, {client?.name.split(' ')[0]}!</h1>
              <p className="muted">
                {session.workoutName} · {plural(t.sets, 'סט אחד', 'סטים')} · {fmtMinutes(t.durationMs)}
                {summary.prs.length ? ` · ${plural(summary.prs.length, 'שיא חדש', 'שיאים חדשים')}` : ''}
              </p>
            </div>
          </div>
        )}

        <div className="kpis">
          <div className="kpi">
            <div className="k-label">סטים שבוצעו</div>
            <div className="k-value">
              <span className="num">{t.sets}</span>
              {t.plannedSets > 0 && <small>מתוך {t.plannedSets}</small>}
            </div>
          </div>
          <div className="kpi">
            <div className="k-label">תרגילים</div>
            <div className="k-value">
              <span className="num">{t.exercises}</span>
            </div>
          </div>
          <div className="kpi">
            <div className="k-label">נפח כולל</div>
            <div className="k-value">
              <span className="num">{fmtNum(t.volume / 1000, 2)}</span>
              <small>טון</small>
            </div>
          </div>
          <div className="kpi">
            <div className="k-label">משך</div>
            <div className="k-value">{fmtMinutes(t.durationMs)}</div>
          </div>
        </div>

        <div className="split">
          <div className="stack-lg">
            {(summary.prs.length > 0 || summary.improved.length > 0 || summary.declined.length > 0 || summary.pain.length > 0 || summary.techniqueIssues.length > 0) && (
              <section className="card card-pad stack">
                <div className="card-title">
                  <Sparkles /> נקודות חשובות
                </div>
                {summary.prs.map((e) => (
                  <Highlight key={e.entry.id} tone="lime" icon={<Award size={16} />} text={`שיא חדש ב${exercises.get(e.entry.exerciseId)?.nameHe} — ${e.stats.bestSet ? formatSet(e.stats.bestSet) : ''}`} />
                ))}
                {summary.improved
                  .filter((e) => !e.comparison.newPR)
                  .map((e) => (
                    <Highlight key={e.entry.id} tone="success" icon={<TrendingUp size={16} />} text={`${exercises.get(e.entry.exerciseId)?.nameHe}: ${e.comparison.label} לעומת הפעם הקודמת`} />
                  ))}
                {summary.declined.map((e) => (
                  <Highlight key={e.entry.id} tone="danger" icon={<TrendingDown size={16} />} text={`${exercises.get(e.entry.exerciseId)?.nameHe}: ${e.comparison.label} לעומת הפעם הקודמת`} />
                ))}
                {summary.pain.map((e) => (
                  <Highlight
                    key={e.id}
                    tone="danger"
                    icon={<AlertTriangle size={16} />}
                    text={`כאב ב${exercises.get(e.exerciseId)?.nameHe}${e.pain.location ? ` · ${e.pain.location}` : ''}${e.pain.severity ? ` · ${e.pain.severity}/10` : ''}`}
                  />
                ))}
                {summary.techniqueIssues.map((e) => (
                  <Highlight key={e.id} tone="warn" icon={<AlertTriangle size={16} />} text={`טכניקה ${TECHNIQUE[e.technique]} ב${exercises.get(e.exerciseId)?.nameHe}`} />
                ))}
              </section>
            )}

            <section className="section">
              <div className="section-head">
                <div className="section-title">תרגילים וסטים</div>
                <span className="tiny muted">לחיצה על סט לתיקון</span>
              </div>
              {summary.entries.map((e) => (
                <EntryBlock key={e.entry.id} e={e} name={exercises.get(e.entry.exerciseId)?.nameHe ?? ''} swappedFrom={e.entry.swappedFromId ? exercises.get(e.entry.swappedFromId)?.nameHe : undefined} onEditSet={(setId) => setEditSet({ entryId: e.entry.id, setId })} />
              ))}
            </section>

            {autoFilled > 0 && (
              <div className="banner tone-info small">
                <AlertTriangle />
                <div className="grow">
                  {autoFilled === 1
                    ? 'סט אחד נרשם לפי היעד בלי הזנת חזרות/משקל. לחיצה על הסט מאפשרת לתקן. עד שיאושר, הוא לא משמש כראיה להמלצות התקדמות.'
                    : `${autoFilled} סטים נרשמו לפי היעד בלי הזנת חזרות/משקל. לחיצה על סט מאפשרת לתקן. עד שיאושרו, הם לא משמשים כראיה להמלצות התקדמות.`}
                </div>
                <button
                  className="btn btn-sm btn-primary"
                  onClick={async () => {
                    await patchStoredSession(session.id, (cur) => {
                      cur.entries = cur.entries.map((e) => ({ ...e, sets: e.sets.map((x) => (x.autoFilled ? { ...x, autoFilled: false } : x)) }));
                    });
                    const created = await runEngine(session.clientId, session.id);
                    toast(created.length ? `הנתונים אושרו · ${plural(created.length, 'המלצה חדשה', 'המלצות חדשות')}` : 'הנתונים אושרו');
                  }}
                >
                  <Check /> בוצע כפי שנרשם
                </button>
              </div>
            )}

            {summary.changes.length > 0 && (
              <section className="card card-pad stack-sm">
                <div className="card-title">
                  <GitCompare /> שינויים ביחס לתוכנית
                </div>
                <p className="tiny muted">התכנון המקורי נשמר בנפרד ולא השתנה. כך נראה הביצוע בפועל:</p>
                {summary.changes.map((c, i) => (
                  <div key={i} className="small change-line">
                    • {c.text}
                  </div>
                ))}
              </section>
            )}
          </div>

          <div className="stack-lg">
            <section className="card card-pad stack">
              <div className="card-title">
                <Clock /> תחושה, מאמץ והתאוששות
              </div>
              <Field label="מאמץ כללי (RPE אימון)">
                <Rating value={session.wrapUp?.effort} max={10} onChange={(v) => rate({ effort: v })} low="קל" high="מקסימלי" />
              </Field>
              <Field label="תחושה כללית">
                <Rating value={session.wrapUp?.feeling} onChange={(v) => rate({ feeling: v })} low="רעה" high="מצוינת" />
              </Field>
              <Field label="התאוששות / הערות כלליות" optional>
                <textarea className="textarea" style={{ minHeight: 64 }} defaultValue={session.wrapUp?.note ?? ''} onBlur={(e) => patchWrap({ note: e.target.value })} placeholder="למשל: הגיעה עייפה אחרי משמרת" />
              </Field>
              {(session.readiness?.energy || session.readiness?.sleep || session.readiness?.soreness || session.readiness?.fatigue) && (
                <div className="row row-wrap small muted" style={{ gap: 10 }}>
                  {session.readiness.energy && <span>אנרגיה {session.readiness.energy}/5</span>}
                  {session.readiness.sleep && <span>שינה {session.readiness.sleep}/5</span>}
                  {session.readiness.fatigue && <span>עייפות {session.readiness.fatigue}/5</span>}
                  {session.readiness.soreness && <span>כאבי שרירים {session.readiness.soreness}/5</span>}
                </div>
              )}
              <p className="tiny muted">אין חובה למלא — כל שדה רשות.</p>
            </section>

            {shownNotes.length > 0 && (
              <section className="card card-pad stack-sm">
                <div className="card-title">
                  <Check /> דגשים שהוצגו באימון הזה
                </div>
                <p className="tiny muted">נסגרו אוטומטית עם סיום האימון. אפשר להשאיר דגש פתוח לאימון הבא.</p>
                {shownNotes.map((n) => (
                  <div key={n.id} className="row row-top">
                    <div className={`grow small ${n.done ? 'muted' : ''}`} style={{ textDecoration: n.done ? 'line-through' : undefined }}>
                      {n.text}
                    </div>
                    <button className="btn btn-sm btn-ghost" onClick={() => resolveNote(n.id, !n.done)}>
                      {n.done ? 'להשאיר פתוח' : 'סגירה'}
                    </button>
                  </div>
                ))}
              </section>
            )}

            <section className="card card-pad stack next-card">
              <div className="card-title">
                <StickyNote /> הערות ודגשים לאימון הבא
              </div>
              {sessionNotes
                .filter((n) => n.kind === 'next')
                .map((n) => (
                  <div key={n.id} className="row row-top">
                    <div className="grow small">• {n.text}</div>
                    <button className="icon-btn" aria-label="מחיקה" onClick={() => softDelete('notes', n.id)}>
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
              <div className="row">
                <input className="input" value={noteText} onChange={(e) => setNoteText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addNext()} placeholder="יוצג בבולט באימון הבא…" />
                <button className="btn btn-icon btn-primary" onClick={addNext} aria-label="הוספה">
                  <Plus />
                </button>
              </div>
            </section>

            <section className="card card-pad stack">
              <div className="card-title">
                <ClipboardList /> משימות מעקב
              </div>
              {sessionNotes
                .filter((n) => n.kind === 'task')
                .map((n) => (
                  <div key={n.id} className="row row-top">
                    <button className={`check-btn ${n.done ? 'on' : ''}`} onClick={() => resolveNote(n.id, !n.done)} aria-label="בוצע">
                      <Check size={14} />
                    </button>
                    <div className="grow small">{n.text}</div>
                  </div>
                ))}
              <div className="row">
                <input className="input" value={taskText} onChange={(e) => setTaskText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addTask()} placeholder="למשל: לבדוק התאמת ספסל" />
                <button className="btn btn-icon" onClick={addTask} aria-label="הוספה">
                  <Plus />
                </button>
              </div>
            </section>

            <section className="section">
              <div className="section-head">
                <div className="section-title">
                  המלצות מהאימון <span className="count">{recs.length}</span>
                </div>
                <button
                  className="link-btn"
                  onClick={async () => {
                    const created = await runEngine(session.clientId, session.id);
                    toast(created.length === 1 ? 'נוצרה המלצה אחת' : created.length ? `נוצרו ${created.length} המלצות` : 'אין המלצות חדשות');
                  }}
                >
                  <RotateCcw /> בדיקה מחדש
                </button>
              </div>
              {recs.length === 0 && <div className="card empty small">אין המלצות חדשות מהאימון הזה. המנוע מציע שינוי רק כשהנתונים תומכים בכך.</div>}
              {recs.map((r) => (
                <RecCard key={r.id} rec={r} exercises={exercises} />
              ))}
            </section>
          </div>
        </div>

        <div className="row row-wrap" style={{ justifyContent: 'center' }}>
          {isSummary ? (
            <>
              <button className="btn btn-primary btn-lg" onClick={() => nav('/', { replace: true })}>
                <Check /> סיום
              </button>
              <Link className="btn btn-lg" to={`/clients/${session.clientId}`}>
                לכרטיס המתאמן/ת
              </Link>
            </>
          ) : (
            <button
              className="btn btn-danger"
              onClick={async () => {
                if (!(await confirm({ title: 'למחוק את האימון מההיסטוריה?', body: 'לפני המחיקה נשמרת נקודת שחזור, כך שאפשר לחזור אליה ממסך הגיבוי.', danger: true, confirmLabel: 'מחיקה' }))) return;
                try {
                  await discardSession(session.id);
                } catch (e) {
                  toast(e instanceof Error ? e.message : 'המחיקה נכשלה', { tone: 'error', ms: 9000 });
                  return;
                }
                toast('האימון נמחק · נשמרה נקודת שחזור');
                nav(-1);
              }}
            >
              <Trash2 /> מחיקת האימון
            </button>
          )}
        </div>
      </div>
      {editSet && <EditSetSheet session={session} entryId={editSet.entryId} setId={editSet.setId} onClose={() => setEditSet(null)} />}
    </>
  );
}

function Highlight({ tone, icon, text }: { tone: string; icon: ReactNode; text: string }) {
  return (
    <div className={`highlight tone-${tone}`}>
      {icon}
      <span>{text}</span>
    </div>
  );
}

function EntryBlock({ e, name, swappedFrom, onEditSet }: { e: EntrySummary; name: string; swappedFrom?: string; onEditSet: (setId: string) => void }) {
  const en = e.entry;
  const skipped = en.status === 'skipped' || en.status === 'notdone';
  const c = e.comparison;
  return (
    <div className={`card card-pad entry-sum ${skipped ? 'skipped' : ''}`}>
      <div className="row between row-wrap">
        <div className="row grow" style={{ gap: 8 }}>
          <span className="block-tag">{en.blockLabel}</span>
          <div style={{ minWidth: 0 }}>
            <div className="strong">{name}</div>
            {swappedFrom && <div className="tiny muted">במקום {swappedFrom}</div>}
          </div>
        </div>
        <div className="row row-wrap" style={{ gap: 6 }}>
          {skipped && <span className="badge tone-warn">{en.status === 'skipped' ? 'דולג' : 'לא בוצע'}</span>}
          {!skipped && c.trend === 'up' && <span className="badge tone-success"><TrendingUp /> {c.label}</span>}
          {!skipped && c.trend === 'down' && <span className="badge tone-danger"><TrendingDown /> {c.label}</span>}
          {!skipped && c.trend === 'same' && <span className="badge">יציב</span>}
          {!skipped && c.trend === 'new' && <span className="badge tone-info">חדש</span>}
          {c.newPR && <span className="badge tone-lime"><Award /> שיא</span>}
        </div>
      </div>
      <div className="sum-sets">
        {en.sets.map((s, i) => (
          <button key={s.id} className={`sum-set ${s.done ? '' : 'missed'} t-${s.type}`} onClick={() => onEditSet(s.id)}>
            {/* numbered among non-warm-up sets, the same as the live workout screen */}
            <span className="tiny muted">{s.type === 'working' ? en.sets.slice(0, i + 1).filter((x) => x.type !== 'warmup').length : SET_TYPES[s.type]}</span>
            <span className="num strong">{s.done ? formatSet(s) : 'לא הושלם'}</span>
            {s.planned && (
              // only the numbers are left-to-right; "יעד" stays in the right-to-left flow
              <span className="tiny muted">
                יעד{' '}
                <span className="num">
                  {s.planned.weight ?? ''}
                  {s.planned.weight != null ? '×' : ''}
                  {s.planned.duration ? `${s.planned.duration}ש׳` : `${s.planned.repsMin ?? ''}${s.planned.repsMax != null && s.planned.repsMax !== s.planned.repsMin ? `–${s.planned.repsMax}` : ''}`}
                </span>
              </span>
            )}
            {s.added && <span className="tiny" style={{ color: 'var(--info)' }}>נוסף</span>}
          </button>
        ))}
      </div>
      {(en.technique !== 'na' || en.pain?.reported || en.notes) && (
        <div className="row row-wrap small" style={{ gap: 8, marginTop: 8 }}>
          {en.technique !== 'na' && <span className={`badge ${en.technique === 'good' ? 'tone-success' : en.technique === 'fix' ? 'tone-warn' : 'tone-danger'}`}>טכניקה: {TECHNIQUE[en.technique]}</span>}
          {en.pain?.reported && <span className="badge tone-danger"><AlertTriangle /> כאב{en.pain.location ? ` · ${en.pain.location}` : ''}</span>}
          {en.notes && <span className="muted">"{en.notes}"</span>}
        </div>
      )}
    </div>
  );
}

function EditSetSheet({ session, entryId, setId, onClose }: { session: Session; entryId: string; setId: string; onClose: () => void }) {
  const { toast } = useUi();
  const entry = session.entries.find((e) => e.id === entryId);
  const orig = entry?.sets.find((s) => s.id === setId);
  const [s, setS] = useState<PerformedSet | undefined>(orig ? { ...orig } : undefined);
  if (!entry || !s) return null;
  // a timed hold (plank, wall sit) is corrected in seconds, as it is logged in the live workout
  const timed = orig?.duration != null || !!orig?.planned?.duration;
  const save = async () => {
    await patchStoredSession(session.id, (cur) => {
      cur.entries = cur.entries.map((e) => (e.id !== entryId ? e : correctSet(e, setId, s)));
    });
    onClose();
    // a corrected set can change what the numbers support — re-evaluate this workout's advice right away
    if (session.status === 'completed') {
      try {
        await runEngine(session.clientId, session.id);
      } catch (e) {
        console.warn('re-check after correction failed', e);
      }
    }
    toast('הסט עודכן · ההמלצות עודכנו בהתאם');
  };
  return (
    <Sheet
      title="תיקון סט"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>ביטול</button>
          <button className="btn btn-primary" onClick={save}>שמירה</button>
        </>
      }
    >
      <div className="stack">
        <p className="small muted">תיקון נתוני הביצוע בפועל. התכנון המקורי לא משתנה.</p>
        <div className="grid-2">
          <Field label="משקל (ק״ג)">
            <NumInput className="input" decimal value={s.weight ?? null} onChange={(v) => setS({ ...s, weight: v })} />
          </Field>
          {timed ? (
            <Field label="שניות">
              <NumInput className="input" value={s.duration ?? null} onChange={(v) => setS({ ...s, duration: v })} />
            </Field>
          ) : (
            <Field label="חזרות">
              <NumInput className="input" value={s.reps ?? null} onChange={(v) => setS({ ...s, reps: v })} />
            </Field>
          )}
          <Field label="RIR" optional>
            <NumInput className="input" value={s.rir ?? null} onChange={(v) => setS({ ...s, rir: v })} />
          </Field>
          <Field label="RPE" optional>
            <NumInput className="input" decimal value={s.rpe ?? null} onChange={(v) => setS({ ...s, rpe: v })} />
          </Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={s.done} onChange={(e) => setS({ ...s, done: e.target.checked })} />
          הסט בוצע
        </label>
      </div>
    </Sheet>
  );
}
