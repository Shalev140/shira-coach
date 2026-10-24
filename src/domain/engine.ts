/**
 * Rule-based recommendation engine (spec §11).
 *
 * Transparent rules only — nothing is changed automatically. Each rule returns a
 * draft that explains what was detected, which data it is based on and what can
 * be done. The trainer approves / edits / rejects it.
 *
 * Safety gates: reported pain or poor technique on an exercise block every
 * load-increase recommendation for it until checked. Large changes are never
 * inferred from a single session.
 */
import type {
  Client,
  Evidence,
  Exercise,
  ID,
  MuscleId,
  PerformedSet,
  Program,
  RecSuggestion,
  RecType,
  Recommendation,
  Session,
  SessionEntry,
  Settings,
  Technique,
} from './types';
import { GOAL_REP_RANGES, PROGRAM_GOALS, TECHNIQUE } from './labels';
import { compareWithPrevious, e1rm, entryStats, exerciseHistory, formatSet, type ExerciseOccurrence } from './progress';
import { performedVolume, sessionsInRange, weekRange } from './volume';
import { addDays, daysBetween, fmtDate, fmtNum, roundTo } from './util';

export type RecDraft = Omit<Recommendation, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'status' | 'demo'>;

export interface EngineInput {
  client: Client;
  sessions: Session[];
  exercises: Map<ID, Exercise>;
  program?: Program | null;
  settings: Settings;
  today: string;
  /** the session that was just completed; exercise rules focus on it */
  sessionId?: ID | null;
  /** existing recommendations — an unresolved pain / technique check keeps blocking load increases */
  existing?: Recommendation[];
}

const SAFETY_TYPES: RecType[] = ['painCheck', 'techniqueCheck'];

function isBlockingEntry(e: SessionEntry): boolean {
  const t = worstTechnique(e);
  return !!e.pain?.reported || t === 'poor' || t === 'fix';
}

/** Exercises that must not get a load increase: flagged anywhere in the session, or with a safety check still pending. */
export function blockedExercises(session: Session | undefined, existing: Recommendation[] = []): Set<ID> {
  const out = new Set<ID>();
  for (const e of session?.entries ?? []) {
    if (!isBlockingEntry(e)) continue;
    out.add(e.exerciseId);
    // a swapped entry can't tell whether the flag came before or after the swap — block the original too
    if (e.swappedFromId) out.add(e.swappedFromId);
  }
  for (const r of existing) if (r.status === 'pending' && !r.deletedAt && SAFETY_TYPES.includes(r.type) && r.exerciseId) out.add(r.exerciseId);
  return out;
}

const PROGRESSION_TYPES: RecType[] = ['increaseWeight', 'addReps', 'reduceLoad'];
export const LOAD_INCREASE_TYPES: RecType[] = ['increaseWeight'];
/** advice about the client as a whole (not one exercise or workout) */
const CLIENT_TYPES: RecType[] = ['recoveryCheck', 'adherence'];

/**
 * Recommendations that push an exercise forward: a weight increase, more reps, or the
 * bodyweight "progress the variation" range change (the goal-based range rec is not one).
 */
export function isLoadIncrease(r: Pick<Recommendation, 'type' | 'dedupeKey'>): boolean {
  if (LOAD_INCREASE_TYPES.includes(r.type) || r.type === 'addReps') return true;
  return r.type === 'adjustRange' && !(r.dedupeKey ?? '').includes('|goal|');
}

/**
 * The load step for an exercise: its own jump when one was set (library entries only carry one
 * when it differs from the gear default, e.g. 1 kg for small raises), otherwise the trainer's
 * jump for that gear from Settings — the same rule the live-workout stepper uses.
 */
export function incrementFor(ex: Exercise, settings: Settings): number {
  return ex.increment ?? settings.increments[ex.equipment] ?? 2.5;
}

/** Library exercises whose logged weight is the machine's HELP (more weight = easier). */
const ASSISTED_IDS = new Set<ID>(['pull_up_assisted']);

export function isAssisted(ex: Exercise): boolean {
  return (ex as Exercise & { assisted?: boolean }).assisted ?? ASSISTED_IDS.has(ex.id);
}

/** RIR of a set; in RPE mode only the RPE is recorded, so it is converted (RPE 10 = 0 in reserve). */
function effectiveRir(rir?: number | null, rpe?: number | null): number | null {
  if (typeof rir === 'number') return rir;
  return typeof rpe === 'number' ? Math.max(0, 10 - rpe) : null;
}

type Series = { slot?: ID | null; programId?: ID | null };

/**
 * Two occurrences of an exercise belong to the same progression series: the same program slot, or no way to
 * tell them apart (a free workout or an added entry has no slot; a duplicated program has new slot ids).
 * A heavy and a light day of one exercise in the same program are different series.
 */
export function sameSeries(a: Series, b: Series): boolean {
  if (!a.slot || !b.slot || a.slot === b.slot) return true;
  return !!a.programId && !!b.programId && a.programId !== b.programId;
}

/** Occurrences of the same program slot when there are any, else all of them (oldest first, like the input). */
function slotSeries(history: ExerciseOccurrence[], slot: ID | null | undefined): ExerciseOccurrence[] {
  if (!slot) return history;
  const same = history.filter((o) => o.entry.plannedExerciseId === slot);
  return same.length ? same : history;
}

/**
 * A later entry of an exercise counts as a re-evaluation of it: real working sets (✓-only sets taken from
 * the target are not), or a safety flag — reported pain, or technique marked poor / needs fixing.
 */
export function supersedesProgression(entry: SessionEntry): boolean {
  return evaluable(entry) || isBlockingEntry(entry);
}

/**
 * A newer completed workout re-evaluated this exercise after `session`: real working sets in the same
 * program slot, or a safety flag in any slot. Progression advice from `session` would then be stale.
 */
export function reevaluatedLater(sessions: Session[], session: Session, exerciseId: ID, slot?: ID | null): boolean {
  return evaluableLater(sessions, session, exerciseId, slot) || blockedLater(sessions, session, exerciseId);
}

const laterSessions = (sessions: Session[], session: Session) =>
  sessions.filter((s) => !s.deletedAt && s.status === 'completed' && s.startedAt > session.startedAt);

/** A newer workout has real working sets of this exercise in the same series — its numbers supersede `session`'s. */
export function evaluableLater(sessions: Session[], session: Session, exerciseId: ID, slot?: ID | null): boolean {
  return laterSessions(sessions, session).some((s) =>
    s.entries.some(
      (e) => e.exerciseId === exerciseId && evaluable(e) && sameSeries({ slot, programId: session.programId }, { slot: e.plannedExerciseId, programId: s.programId }),
    ),
  );
}

/**
 * A newer workout flagged this exercise (pain / poor or needs-fix technique). That blocks pushing it
 * forward, but says nothing about the numbers — a load reduction from `session` is still judged on them.
 */
export function blockedLater(sessions: Session[], session: Session, exerciseId: ID): boolean {
  return laterSessions(sessions, session).some((s) => s.entries.some((e) => e.exerciseId === exerciseId && isBlockingEntry(e)));
}

function workingSets(entry: SessionEntry): PerformedSet[] {
  return entry.sets.filter((s) => s.type === 'working' || s.type === 'backoff');
}

/** The entry can be evaluated for progression: done working sets, all with typed reps (✓-only sets taken from the target are not evidence). */
function evaluable(entry: SessionEntry): boolean {
  if (entry.section === 'warmup') return false;
  const done = workingSets(entry).filter((s) => s.done);
  return done.length > 0 && done.every((s) => typeof s.reps === 'number' && s.reps > 0 && !s.autoFilled);
}

const TECHNIQUE_ORDER: Technique[] = ['poor', 'fix', 'good', 'na'];

function worstTechnique(entry: SessionEntry): Technique {
  const all = [entry.technique, ...entry.sets.map((s) => s.technique).filter(Boolean)] as Technique[];
  for (const t of TECHNIQUE_ORDER) if (all.includes(t)) return t;
  return 'na';
}

/** One occurrence per workout, oldest first: the same exercise may appear twice in a session, but rules count workouts. */
function perSession(history: ExerciseOccurrence[]): ExerciseOccurrence[] {
  const out = new Map<ID, ExerciseOccurrence>();
  for (const o of history) {
    const prev = out.get(o.session.id);
    if (!prev) {
      out.set(o.session.id, o);
      continue;
    }
    const techniques = [prev.entry.technique, o.entry.technique];
    const entry: SessionEntry = {
      ...o.entry,
      sets: [...prev.entry.sets, ...o.entry.sets],
      technique: TECHNIQUE_ORDER.find((t) => techniques.includes(t)) ?? 'na',
      pain: prev.entry.pain?.reported ? prev.entry.pain : o.entry.pain,
    };
    out.set(o.session.id, { session: o.session, entry, stats: entryStats(entry) });
  }
  return [...out.values()];
}

/**
 * Earlier workouts of an exercise for the safety rules, one per workout, oldest first: every completed
 * occurrence with work done in any slot, plus one where it was skipped or stopped with pain / poor technique.
 */
function safetyHistory(sessions: Session[], exerciseId: ID, session: Session): ExerciseOccurrence[] {
  const out: ExerciseOccurrence[] = [];
  const sorted = sessions
    .filter((s) => !s.deletedAt && s.status === 'completed' && s.id !== session.id && s.startedAt <= session.startedAt)
    .sort((a, b) => a.startedAt - b.startedAt);
  for (const s of sorted)
    for (const e of s.entries) {
      if (e.exerciseId !== exerciseId) continue;
      const stats = entryStats(e);
      if (stats.sets > 0 || isBlockingEntry(e)) out.push({ session: s, entry: e, stats });
    }
  return perSession(out);
}

function setsEvidence(occ: ExerciseOccurrence, label?: string): Evidence {
  const sets = workingSets(occ.entry).filter((s) => s.done);
  return {
    label: label ?? fmtDate(occ.session.date),
    value: sets.map((s) => formatSet(s)).join(' · ') || '—',
    date: occ.session.date,
    sessionId: occ.session.id,
  };
}

/**
 * The effort target of a planned set as a RIR. In RPE mode the trainer only sees and edits the RPE, so a
 * leftover RIR default (never shown) must not win over it.
 */
export function plannedRir(p: { rir?: number | null; rpe?: number | null } | null | undefined, mode: Settings['rirMode']): number | null {
  if (!p) return null;
  if (mode === 'rpe') return typeof p.rpe === 'number' ? Math.max(0, 10 - p.rpe) : null;
  return effectiveRir(p.rir, p.rpe);
}

function plannedRange(entry: SessionEntry, mode: Settings['rirMode'] = 'rir'): { min: number | null; max: number | null; rir: number | null } {
  const ws = workingSets(entry).filter((s) => s.planned);
  const mins = ws.map((s) => s.planned?.repsMin).filter((v): v is number => typeof v === 'number');
  const maxs = ws.map((s) => s.planned?.repsMax ?? s.planned?.repsMin).filter((v): v is number => typeof v === 'number');
  const rirs = ws.map((s) => plannedRir(s.planned, mode)).filter((v): v is number => typeof v === 'number');
  return {
    min: mins.length ? Math.min(...mins) : null,
    max: maxs.length ? Math.max(...maxs) : null,
    rir: rirs.length ? Math.min(...rirs) : null,
  };
}

function exName(ex: Exercise | undefined) {
  return ex?.nameHe ?? 'תרגיל';
}

function alternativesFor(ex: Exercise, input: EngineInput): ID[] {
  const avoid = (input.client.uncomfortableExercises ?? '').toLowerCase();
  const pool = ex.alternatives
    .map((id) => input.exercises.get(id))
    .filter((e): e is Exercise => !!e && !e.archived && !e.deletedAt);
  // fall back to same primary muscle + pattern
  if (pool.length < 2) {
    for (const e of input.exercises.values()) {
      if (e.id === ex.id || e.archived || e.deletedAt || pool.includes(e)) continue;
      if (e.pattern === ex.pattern && e.primary.some((m) => ex.primary.includes(m))) pool.push(e);
      if (pool.length >= 4) break;
    }
  }
  return pool.filter((e) => !avoid || !avoid.includes(e.nameHe.toLowerCase())).slice(0, 4).map((e) => e.id);
}

/* ------------------------------------------------------------ exercise rules */

function exerciseRules(entry: SessionEntry, session: Session, input: EngineInput, blockedEx: Set<ID>): RecDraft[] {
  const out: RecDraft[] = [];
  const ex = input.exercises.get(entry.exerciseId);
  if (!ex) return out;
  const base = {
    clientId: input.client.id,
    programId: input.program?.id ?? session.programId ?? null,
    exerciseId: ex.id,
    muscle: null,
    sourceSessionId: session.id,
  };
  const all = exerciseHistory(input.sessions, ex.id);
  // this entry is always the latest occurrence — even with no completed working sets (pain in the warm-up, a skipped
  // exercise), so the safety rules below still fire for it
  const current: ExerciseOccurrence = { session, entry, stats: entryStats(entry) };
  const slot = entry.plannedExerciseId ?? null;
  // progression compares the same program slot — a heavy and a light day of one exercise are different series
  const earlier = perSession(slotSeries(all.filter((o) => o.session.id !== session.id && o.session.startedAt <= session.startedAt), slot));
  const history = [...earlier, current];
  // safety counts every workout of the exercise, in any slot — also one where it was skipped because of pain
  const safety = [...safetyHistory(input.sessions, ex.id, session), current];
  const recent = safety.slice(-4);
  const technique = worstTechnique(entry);
  const pain = entry.pain?.reported;
  // the exercise this entry was swapped from during the workout
  const origId = entry.swappedFromId && entry.swappedFromId !== ex.id ? entry.swappedFromId : null;
  const orig = origId ? input.exercises.get(origId) : undefined;
  const origBase = origId ? { ...base, exerciseId: origId } : null;
  const swapNote = origId ? `באימון ${fmtDate(session.date)} ${exName(orig)} הוחלף ב${exName(ex)}` : '';

  /* --- safety: pain --- */
  if (pain && origBase) {
    // unknown whether the pain started before or after the swap — the original must be checked before it returns
    out.push({
      ...origBase,
      type: 'painCheck',
      severity: 'warn',
      title: `כאב דווח ב${exName(orig)}`,
      detected: `${swapNote} ודווח כאב או אי-נוחות${entry.pain.location ? ` (${entry.pain.location})` : ''}${entry.pain.severity ? `, עוצמה ${entry.pain.severity}/10` : ''}.`,
      reasoning:
        'לא ידוע אם הכאב הופיע לפני ההחלפה או אחריה, ולכן גם התרגיל המקורי חסום להעלאת עומס עד לבדיקה. המערכת אינה מאבחנת — זו תזכורת לבדוק את הסיבה.',
      action: `לבדוק לפני שחוזרים ל${exName(orig)}: להתאים טווח/עומס, או להמשיך עם החלופה.`,
      evidence: [{ label: fmtDate(session.date), value: `כאב${entry.pain.location ? ` · ${entry.pain.location}` : ''}`, sessionId: session.id, date: session.date }],
      suggestion: { kind: 'none', exerciseId: origId!, alternativeIds: orig ? alternativesFor(orig, input) : [] },
      dedupeKey: `painCheck|${input.client.id}|${origId}|${session.id}`,
    });
  }
  if (pain) {
    const painCount = recent.slice(-3).filter((o) => o.entry.pain?.reported).length;
    const where = entry.pain.location ? ` (${entry.pain.location})` : '';
    const sev = entry.pain.severity ? `, עוצמה ${entry.pain.severity}/10` : '';
    out.push({
      ...base,
      type: 'painCheck',
      severity: 'warn',
      title: `כאב דווח ב${exName(ex)}`,
      detected: `דווח כאב או אי-נוחות${where}${sev} באימון ${fmtDate(session.date)}.`,
      reasoning:
        'כאב מדווח חוסם המלצות להעלאת עומס בתרגיל עד לבדיקה. המערכת אינה מאבחנת — זו תזכורת לבדוק את הסיבה (טכניקה, טווח תנועה, ציוד, עייפות).',
      action: 'לבדוק לפני האימון הבא: להתאים טווח/עומס, או לבחור חלופה מתאימה.',
      evidence: recent.slice(-3).map((o) => ({
        label: fmtDate(o.session.date),
        value: o.entry.pain?.reported ? `כאב${o.entry.pain.location ? ` · ${o.entry.pain.location}` : ''}` : 'ללא כאב',
        sessionId: o.session.id,
        date: o.session.date,
      })),
      suggestion: { kind: 'none', exerciseId: ex.id, alternativeIds: alternativesFor(ex, input) },
      dedupeKey: `painCheck|${input.client.id}|${ex.id}|${session.id}`,
    });
    if (painCount >= 2) {
      const alts = alternativesFor(ex, input);
      out.push({
        ...base,
        type: 'swapExercise',
        severity: 'warn',
        title: `לשקול החלפה של ${exName(ex)}`,
        detected: `כאב דווח ב-${painCount} מתוך ${Math.min(3, recent.length)} האימונים האחרונים בתרגיל.`,
        reasoning: 'כאב חוזר באותו תרגיל הוא סיבה לשקול חלופה שמעמיסה על אותם שרירים בדפוס נוח יותר.',
        action: alts.length ? 'לבחור חלופה מהרשימה ולעדכן את התוכנית.' : 'לבחור חלופה מספריית התרגילים.',
        evidence: recent.slice(-3).map((o) => setsEvidence(o)),
        suggestion: { kind: 'swap', exerciseId: ex.id, alternativeIds: alts },
        dedupeKey: `swapExercise|${input.client.id}|${ex.id}|pain|${session.id}`,
      });
    }
  }

  /* --- safety: technique --- */
  if (technique === 'poor' || technique === 'fix') {
    const badCount = recent.filter((o) => ['poor', 'fix'].includes(worstTechnique(o.entry))).length;
    // both marks block load increases until checked, so both leave an open check behind (the next
    // workout starts with technique "not recorded", which must not lift the block)
    const poor = technique === 'poor';
    const checkTitle = (e: Exercise | undefined) => (poor ? `טכניקה לא מספקת ב${exName(e)}` : `נדרש תיקון טכניקה ב${exName(e)}`);
    if (origBase) {
      out.push({
        ...origBase,
        type: 'techniqueCheck',
        severity: poor ? 'warn' : 'info',
        title: checkTitle(orig),
        detected: `${swapNote} והטכניקה סומנה "${TECHNIQUE[technique]}".`,
        reasoning: 'לא ידוע אם הסימון היה לפני ההחלפה או אחריה, ולכן גם התרגיל המקורי חסום להעלאת עומס עד לבדיקה.',
        action: `לבדוק את הטכניקה ב${exName(orig)} לפני העלאת עומס בו.`,
        evidence: [{ label: fmtDate(session.date), value: TECHNIQUE[technique], sessionId: session.id, date: session.date }],
        suggestion: { kind: 'none', exerciseId: origId! },
        dedupeKey: `techniqueCheck|${input.client.id}|${origId}|${session.id}`,
      });
    }
    out.push({
      ...base,
      type: 'techniqueCheck',
      severity: poor ? 'warn' : 'info',
      title: checkTitle(ex),
      detected: `איכות הטכניקה סומנה "${TECHNIQUE[technique]}" באימון ${fmtDate(session.date)}.`,
      reasoning: poor
        ? 'טכניקה לא מספקת חוסמת המלצה להעלאת עומס עד לבדיקה.'
        : `טכניקה שסומנה "${TECHNIQUE.fix}" חוסמת המלצה להעלאת עומס עד לבדיקה.`,
      action: poor ? 'לשמור או להוריד עומס, לחזק דגשי ביצוע, ולבדוק שוב באימון הבא.' : 'לחזק דגשי ביצוע בעומס הנוכחי ולבדוק שוב באימון הבא, לפני העלאת עומס.',
      evidence: recent.slice(-3).map((o) => ({
        label: fmtDate(o.session.date),
        value: TECHNIQUE[worstTechnique(o.entry)],
        sessionId: o.session.id,
        date: o.session.date,
      })),
      suggestion: { kind: 'none', exerciseId: ex.id },
      dedupeKey: `techniqueCheck|${input.client.id}|${ex.id}|${session.id}`,
    });
    if (badCount >= 3 && recent.length >= 3) {
      const alts = alternativesFor(ex, input);
      out.push({
        ...base,
        type: 'swapExercise',
        severity: 'suggest',
        title: `קושי טכני מתמשך ב${exName(ex)}`,
        detected: `הטכניקה סומנה כלא תקינה ב-${badCount} מתוך ${recent.length} האימונים האחרונים.`,
        reasoning: 'קושי טכני מתמשך הוא סיבה לשקול וריאציה פשוטה יותר או חלופה.',
        action: 'לשקול רגרסיה לווריאציה קלה יותר או החלפה.',
        evidence: recent.map((o) => ({ label: fmtDate(o.session.date), value: TECHNIQUE[worstTechnique(o.entry)], sessionId: o.session.id })),
        suggestion: { kind: 'swap', exerciseId: ex.id, alternativeIds: alts },
        dedupeKey: `swapExercise|${input.client.id}|${ex.id}|technique|${session.id}`,
      });
    }
  }

  // warm-up / preparation work: safety checks only, no progression advice
  if (entry.section === 'warmup') return out;
  // a newer workout already re-evaluated this exercise (e.g. re-checking an old session from history):
  // progression advice from this one would be stale — safety checks only. ✓-only sets are not a
  // re-evaluation, and a newer light day does not re-evaluate the heavy day's slot.
  if (evaluableLater(input.sessions, session, ex.id, slot)) return out;
  // a newer safety flag only blocks pushing forward; a load reduction is still judged on these numbers
  const flaggedLater = blockedLater(input.sessions, session, ex.id);

  // the gate is per exercise (it may appear twice in a session) and stays until a pending check is resolved
  const blocked = pain || technique === 'poor' || technique === 'fix' || blockedEx.has(ex.id) || flaggedLater;
  const range = plannedRange(entry, input.settings.rirMode);
  const ws = workingSets(entry);
  const done = ws.filter((s) => s.done);
  const allDone = ws.length > 0 && done.length === ws.length && !entry.cutShort && entry.status !== 'notdone' && entry.status !== 'skipped';
  // reps recorded only by tapping ✓ (taken from the target) are not evidence for progression
  if (!evaluable(entry)) return out;
  // per program slot: the same exercise twice in one workout (heavy + back-off slot) gets advice for each
  const slotKey = slot ? `${slot}|` : '';

  // on an assisted machine the logged weight is the help: the hardest set is the one with the least of it
  const assisted = isAssisted(ex);
  const weights = done.map((s) => s.weight ?? 0);
  const topWeight = assisted ? Math.min(...weights) : Math.max(...weights);
  const atTop = range.max !== null && done.every((s) => (s.reps ?? 0) >= (s.planned?.repsMax ?? s.planned?.repsMin ?? range.max!));
  // effort: RIR, or the RIR an RPE stands for (RPE mode records only the RPE)
  const knownRir = done.map((s) => effectiveRir(s.rir, s.rpe)).filter((v): v is number => v !== null);
  const avgRir = knownRir.length ? knownRir.reduce((a, b) => a + b, 0) / knownRir.length : null;
  const rpes = done.every((s) => typeof s.rir !== 'number') ? done.map((s) => s.rpe).filter((v): v is number => typeof v === 'number') : [];
  const effortText = rpes.length ? `RPE ממוצע ${fmtNum(rpes.reduce((a, b) => a + b, 0) / rpes.length)}` : `RIR ממוצע ${fmtNum(avgRir)}`;
  const rirOk = range.rir === null || avgRir === null || avgRir >= range.rir - 1;
  const inc = incrementFor(ex, input.settings);
  // no weight jumps at all (bodyweight / band / TRX, a zero jump, 'other' gear that never carried a load): the
  // progression is the variation. A loaded exercise logged without a weight is missing data, not a bodyweight move.
  const unloaded =
    ['bodyweight', 'band', 'trx'].includes(ex.equipment) ||
    inc <= 0 ||
    // an assisted machine already at zero help: the next step is the variation (e.g. the unassisted move)
    (assisted && topWeight === 0) ||
    (ex.equipment === 'other' && !entry.sets.some((s) => s.planned?.weight) && !all.some((o) => o.entry.sets.some((s) => s.done && s.weight)));

  /* --- increase weight --- */
  if (allDone && atTop && rirOk && !blocked) {
    const prev = earlier[earlier.length - 1];
    const prevAlsoTop =
      !!prev &&
      workingSets(prev.entry)
        .filter((s) => s.done)
        .every((s) => (s.reps ?? 0) >= (s.planned?.repsMax ?? range.max ?? 99) + 3);
    const farAbove = done.every((s) => (s.reps ?? 0) >= (s.planned?.repsMax ?? range.max ?? 99) + 3);
    const steps = farAbove && prevAlsoTop ? 2 : 1;
    const evidence = [setsEvidence(current, `${fmtDate(session.date)} (אחרון)`)];
    if (prev) evidence.push(setsEvidence(prev));
    evidence.push({ label: 'טווח מתוכנן', value: `${range.min ?? '?'}–${range.max ?? '?'} חזרות${range.rir !== null ? ` · RIR ${range.rir}` : ''}` });
    evidence.push({ label: 'טכניקה', value: TECHNIQUE[technique] });
    if (inc > 0 && topWeight > 0) {
      const next = Math.max(0, roundTo(topWeight + (assisted ? -1 : 1) * inc * steps, inc >= 1 ? 0.5 : 0.25));
      const restart = `ולהתחיל שוב מתחתית הטווח (${range.min ?? range.max} חזרות).`;
      out.push({
        ...base,
        type: 'increaseWeight',
        severity: 'suggest',
        title: assisted ? `להפחית עזרה ב${exName(ex)}` : `להעלות משקל ב${exName(ex)}`,
        detected: `כל ${done.length} סטי העבודה הושלמו בטווח העליון (${range.max} חזרות)${avgRir !== null ? ` עם ${effortText}` : ''}.`,
        reasoning:
          `הסטים הושלמו בראש הטווח, ${rpes.length ? 'ה-RPE' : avgRir === null ? 'ה-RIR/RPE' : 'ה-RIR'} ${avgRir === null ? 'לא תועד' : 'תואם את היעד'} והטכניקה ${technique === 'na' ? 'לא תועדה — כדאי לוודא' : 'טובה'}. ` +
          (assisted
            ? `במכונת עזרה המשקל הוא העזרה — פחות משקל הוא תרגיל קשה יותר. קפיצת המשקל הזמינה לתרגיל היא ${inc} ק״ג`
            : `קפיצת המשקל הזמינה ל${ex.equipment === 'dumbbell' ? 'משקולת' : 'תרגיל'} היא ${inc} ק״ג`) +
          (steps === 2 ? ' — מאחר שגם באימון הקודם החזרות עברו את הטווח בהרבה, מוצעת קפיצה כפולה.' : '.'),
        action: assisted
          ? next > 0
            ? `להפחית עזרה מ-${topWeight} ל-${next} ק״ג ${restart}`
            : `לנסות ללא עזרה (מ-${topWeight} ל-0 ק״ג) ${restart}`
          : `לעלות מ-${topWeight} ל-${next} ק״ג ${restart}`,
        evidence,
        suggestion: { kind: 'weight', exerciseId: ex.id, plannedExerciseId: slot, from: `${topWeight}`, to: `${next}`, weight: next },
        dedupeKey: `increaseWeight|${input.client.id}|${ex.id}|${slotKey}${session.id}`,
      });
    } else if (unloaded) {
      out.push({
        ...base,
        type: 'adjustRange',
        severity: 'info',
        title: `להתקדם בווריאציה ב${exName(ex)}`,
        detected: `כל הסטים הושלמו בראש הטווח (${range.max} חזרות) בתרגיל ללא קפיצות משקל.`,
        reasoning: 'בתרגיל משקל גוף/גומייה ההתקדמות היא בווריאציה קשה יותר, עומס חיצוני, טמפו איטי או טווח חזרות גבוה יותר.',
        action: 'לבחור התקדמות: וריאציה קשה יותר, אפוד/משקולת, או הגדלת טווח החזרות.',
        evidence,
        suggestion: {
          kind: 'range',
          exerciseId: ex.id,
          plannedExerciseId: slot,
          from: `${range.min}–${range.max}`,
          to: `${(range.min ?? 0) + 2}–${(range.max ?? 0) + 3}`,
          repsMin: (range.min ?? 0) + 2,
          repsMax: (range.max ?? 0) + 3,
        },
        dedupeKey: `adjustRange|${input.client.id}|${ex.id}|${slotKey}${session.id}`,
      });
    }
    // else: a loaded exercise logged without a weight — no advice from missing data (the agenda asks to fill it in)
  } else if (allDone && !atTop && !blocked && range.max !== null && avgRir !== null && range.rir !== null && avgRir >= range.rir + 2) {
    /* --- add reps: room to progress inside the range --- */
    const minReps = Math.min(...done.map((s) => s.reps ?? 0));
    const target = Math.min(range.max, minReps + 2);
    out.push({
      ...base,
      type: 'addReps',
      severity: 'info',
      title: `להוסיף חזרות ב${exName(ex)}`,
      detected: `${effortText} לעומת יעד ${rpes.length ? 'RIR ' : ''}${range.rir} — נשארו יותר חזרות ברזרבה מהמתוכנן.`,
      reasoning: 'יש עוד מקום להתקדם בתוך טווח החזרות לפני שמעלים משקל.',
      action: assisted
        ? `באימון הבא לכוון ל-${target} חזרות לסט באותה עזרה${topWeight ? ` (${topWeight} ק״ג)` : ''}.`
        : `באימון הבא לכוון ל-${target} חזרות לסט במשקל ${topWeight || 'הנוכחי'} ק״ג.`,
      evidence: [setsEvidence(current), { label: 'טווח מתוכנן', value: `${range.min}–${range.max} · RIR ${range.rir}` }],
      suggestion: { kind: 'reps', exerciseId: ex.id, plannedExerciseId: slot, from: `${minReps}`, to: `${target}` },
      dedupeKey: `addReps|${input.client.id}|${ex.id}|${slotKey}${session.id}`,
    });
  }

  /* --- reduce load: below range in two consecutive sessions --- */
  if (range.min !== null) {
    const below = (o: ExerciseOccurrence) => {
      const d = workingSets(o.entry).filter((s) => s.done);
      return d.length > 0 && d.filter((s) => (s.reps ?? 0) < (s.planned?.repsMin ?? range.min!)).length >= Math.ceil(d.length / 2);
    };
    const lastTwo = history.slice(-2);
    if (lastTwo.length === 2 && lastTwo.every(below)) {
      const step = inc >= 1 ? inc / 2 : 0.25;
      let next: number | null;
      if (assisted) {
        // easier = MORE help on the machine
        next = inc > 0 && topWeight > 0 ? roundTo(topWeight + inc, step) : null;
      } else {
        // ~8% lighter, but always strictly below the current load (light machine / kettlebell / cable weights round back up)
        let lower = roundTo(topWeight * 0.92, step);
        if (lower >= topWeight) lower = Math.floor((topWeight - 1e-9) / step) * step;
        next = inc > 0 && topWeight > 0 && lower > 0 ? lower : null;
      }
      out.push({
        ...base,
        type: 'reduceLoad',
        severity: 'suggest',
        title: `החזרות מתחת לטווח ב${exName(ex)}`,
        detected: `בשני האימונים האחרונים רוב הסטים לא הגיעו לתחתית הטווח (${range.min} חזרות).`,
        reasoning: 'דפוס חוזר (לא אימון בודד) מצביע שהעומס גבוה מדי לטווח שנבחר.',
        action: assisted
          ? next
            ? `להוסיף עזרה ל-${next} ק״ג או להוריד את טווח החזרות.`
            : 'להוסיף עזרה או להוריד את טווח החזרות.'
          : next
            ? `להוריד ל-${next} ק״ג או להוריד את טווח החזרות.`
            : 'להוריד עומס או את טווח החזרות.',
        evidence: lastTwo.map((o) => setsEvidence(o)),
        suggestion: next
          ? { kind: 'weight', exerciseId: ex.id, plannedExerciseId: slot, from: `${topWeight}`, to: `${next}`, weight: next }
          : { kind: 'none', exerciseId: ex.id, plannedExerciseId: slot },
        dedupeKey: `reduceLoad|${input.client.id}|${ex.id}|${slotKey}${session.id}`,
      });
    }
  }

  /* --- rep range vs program goal (compound lifts) --- */
  const program = input.program;
  if (program && range.min !== null && range.max !== null) {
    const [gMin, gMax] = GOAL_REP_RANGES[program.goal];
    const compound = ['squat', 'hinge', 'hpush', 'vpush', 'hpull', 'vpull', 'lunge'].includes(ex.pattern);
    const mismatch =
      (program.goal === 'strength' && compound && range.min > gMax) ||
      (program.goal !== 'strength' && (range.max < gMin - 2 || range.min > gMax + 5));
    if (mismatch) {
      out.push({
        ...base,
        type: 'adjustRange',
        severity: 'info',
        title: `טווח החזרות ב${exName(ex)} לא תואם למטרה`,
        detected: `הטווח המתוכנן ${range.min}–${range.max} חזרות, ומטרת התוכנית היא ${PROGRAM_GOALS[program.goal]} (טווח אופייני ${gMin}–${gMax}).`,
        reasoning: 'התאמת טווח חזרות נעשית לפי מטרת התוכנית והשלב בה — לא רק בגלל שעבר זמן.',
        action: `לשקול טווח של ${gMin}–${Math.min(gMax, gMin + 4)} חזרות, אם זה תואם את השלב בתוכנית.`,
        evidence: [{ label: 'מטרת התוכנית', value: PROGRAM_GOALS[program.goal] }, { label: 'טווח נוכחי', value: `${range.min}–${range.max}` }],
        suggestion: {
          kind: 'range',
          exerciseId: ex.id,
          plannedExerciseId: slot,
          from: `${range.min}–${range.max}`,
          to: `${gMin}–${Math.min(gMax, gMin + 4)}`,
          repsMin: gMin,
          repsMax: Math.min(gMax, gMin + 4),
        },
        dedupeKey: `adjustRange|${input.client.id}|${ex.id}|goal|${program.id}|${program.goal}`,
      });
    }
  }

  /* --- stagnation → consider swap / variation --- */
  // (not on an assisted machine: less help is progress, so its estimated 1RM goes DOWN as the client improves)
  const weeks = input.settings.stagnationWeeks;
  const windowStart = addDays(input.today, -weeks * 7);
  const inWindow = history.filter((o) => o.session.date >= windowStart);
  // the baseline is the workouts right before the window — not a peak from before a long break
  const before = history.filter((o) => o.session.date < windowStart && daysBetween(o.session.date, windowStart) <= weeks * 7);
  // ...and a climb inside the window (e.g. rebuilding after the break) is progress, whatever the old peak was
  const rising = inWindow.length >= 2 && inWindow[inWindow.length - 1].stats.bestE1rm > inWindow[0].stats.bestE1rm * 1.02;
  if (!assisted && inWindow.length >= 4 && before.length >= 1 && !pain && !rising) {
    const baseline = Math.max(...before.slice(-2).map((o) => o.stats.bestE1rm));
    const best = Math.max(...inWindow.map((o) => o.stats.bestE1rm));
    if (baseline > 0 && best <= baseline * 1.01) {
      out.push({
        ...base,
        type: 'swapExercise',
        severity: 'suggest',
        title: `אין התקדמות ב${exName(ex)} ${weeks} שבועות`,
        detected: `ה-1RM המשוער לא השתפר ב-${inWindow.length} אימונים במהלך ${weeks} השבועות האחרונים (שיא בתקופה ${fmtNum(best)} מול ${fmtNum(baseline)} לפני).`,
        reasoning: 'חוסר התקדמות לאורך תקופה שהוגדרה בהגדרות הוא סיבה לשקול שינוי גירוי: וריאציה, טווח חזרות או החלפת תרגיל. לפני כן כדאי לבדוק התאוששות.',
        action: 'לשקול וריאציה/חלופה או שינוי טווח חזרות.',
        evidence: inWindow.slice(-4).map((o) => ({ label: fmtDate(o.session.date), value: `1RM משוער ${fmtNum(o.stats.bestE1rm)}`, sessionId: o.session.id })),
        suggestion: { kind: 'swap', exerciseId: ex.id, alternativeIds: alternativesFor(ex, input) },
        dedupeKey: `swapExercise|${input.client.id}|${ex.id}|stagnation|${windowStart.slice(0, 7)}`,
      });
    }
  }

  return out;
}

/* -------------------------------------------------------------- client rules */

function recoveryRules(input: EngineInput): RecDraft[] {
  const out: RecDraft[] = [];
  const completed = input.sessions
    .filter((s) => !s.deletedAt && s.status === 'completed')
    .sort((a, b) => a.startedAt - b.startedAt);
  const last3 = completed.slice(-3);
  if (last3.length < 3) return out;
  const base = { clientId: input.client.id, programId: input.program?.id ?? null, exerciseId: null, muscle: null, sourceSessionId: input.sessionId ?? null };

  // consistent decline: exercise down in two consecutive comparisons — one occurrence per workout, within one
  // program slot (a back-off entry or the light day is not a decline from the heavy one)
  const declining: { ex: Exercise; occ: ExerciseOccurrence[] }[] = [];
  const recentIds = new Set(last3.flatMap((s) => s.entries.map((e) => e.exerciseId)));
  for (const id of recentIds) {
    const ex = input.exercises.get(id);
    // an assisted machine's estimated 1RM falls as the client improves (less help)
    if (!ex || isAssisted(ex)) continue;
    const all = exerciseHistory(completed, id);
    const slots = new Set(last3.flatMap((s) => s.entries.filter((e) => e.exerciseId === id).map((e) => e.plannedExerciseId ?? null)));
    for (const slot of slots) {
      const hist = perSession(slotSeries(all, slot)).slice(-3);
      if (hist.length < 3) continue;
      const t1 = compareWithPrevious(hist[1].stats, hist[0].stats).trend;
      const t2 = compareWithPrevious(hist[2].stats, hist[1].stats).trend;
      if (t1 === 'down' && t2 === 'down' && daysBetween(hist[0].session.date, input.today) <= 35) {
        declining.push({ ex, occ: hist });
        break;
      }
    }
  }
  // client-level advice is keyed by its evidence (the newest workout it rests on), not by the current week:
  // re-checking with no new workout must not raise it again, nor bring back a rejected one
  const newestOf = (list: Session[]) => list.reduce((a, b) => (b.startedAt > a.startedAt ? b : a));
  if (declining.length >= 2) {
    out.push({
      ...base,
      type: 'recoveryCheck',
      severity: 'warn',
      title: 'ירידה עקבית בביצועים',
      detected: `ב-${declining.length} תרגילים נרשמה ירידה בשני אימונים רצופים.`,
      reasoning: 'ירידה עקבית במספר תרגילים עשויה להעיד על עייפות או עומס מצטבר (שינה, לחץ, תזונה, נפח). זו אינה אבחנה — רק דפוס שכדאי לבדוק.',
      action: 'לשוחח על שינה, אנרגיה ועומסים; לשקול שבוע מופחת (דילואד) או הורדת נפח זמנית.',
      evidence: declining.slice(0, 5).map(({ ex, occ }) => ({
        label: ex.nameHe,
        // loaded work is shown as estimated 1RM; bodyweight / timed work by its best set
        value: occ.every((o) => o.stats.bestE1rm > 0)
          ? '1RM משוער: ' + occ.map((o) => fmtNum(o.stats.bestE1rm)).join(' ← ')
          : occ.some((o) => o.stats.bestDuration > 0)
            ? 'שניות בסט הטוב: ' + occ.map((o) => o.stats.bestDuration).join(' ← ')
            : 'חזרות בסט הטוב: ' + occ.map((o) => o.stats.bestSet?.reps ?? 0).join(' ← '),
      })),
      suggestion: { kind: 'none' },
      dedupeKey: `recoveryCheck|${input.client.id}|decline|${newestOf(declining.flatMap((d) => d.occ.map((o) => o.session))).id}`,
    });
  }

  // readiness flags (optional data — only when recorded); old workouts say nothing about recovery now
  if (daysBetween(last3[2].date, input.today) > 14) return out;
  const lowReady = last3.filter((s) => {
    const r = s.readiness ?? {};
    return (r.energy ?? 5) <= 2 || (r.sleep ?? 5) <= 2 || (r.fatigue ?? 1) >= 4;
  });
  const hardSessions = last3.filter((s) => (s.wrapUp?.effort ?? 0) >= 9);
  if (lowReady.length >= 2 || hardSessions.length >= 3) {
    out.push({
      ...base,
      type: 'recoveryCheck',
      severity: 'info',
      title: 'סימנים לעייפות מצטברת',
      detected:
        lowReady.length >= 2
          ? `ב-${lowReady.length} מתוך 3 האימונים האחרונים דווחו אנרגיה/שינה נמוכות או עייפות גבוהה.`
          : 'שלושה אימונים רצופים דורגו במאמץ 9–10.',
      reasoning: 'דיווחי תחושה עוזרים לפרש ביצועים בהקשר. מגמה — לא אבחנה.',
      action: 'לבדוק התאוששות בין אימונים ולשקול להפחית עצימות באימון הבא.',
      evidence: last3.map((s) => ({
        label: fmtDate(s.date),
        value: [
          s.readiness?.energy ? `אנרגיה ${s.readiness.energy}/5` : null,
          s.readiness?.sleep ? `שינה ${s.readiness.sleep}/5` : null,
          s.readiness?.fatigue ? `עייפות ${s.readiness.fatigue}/5` : null,
          s.wrapUp?.effort ? `מאמץ ${s.wrapUp.effort}/10` : null,
        ]
          .filter(Boolean)
          .join(' · ') || 'לא תועד',
        sessionId: s.id,
      })),
      suggestion: { kind: 'none' },
      // keyed by the newest FLAGGED workout: a later well-rested workout doesn't re-raise advice the
      // trainer already rejected or checked from the same evidence
      dedupeKey: `recoveryCheck|${input.client.id}|readiness|${newestOf(lowReady.length >= 2 ? lowReady : hardSessions).id}`,
    });
  }
  return out;
}

function volumeRules(input: EngineInput): RecDraft[] {
  const out: RecDraft[] = [];
  // Evaluate the last full week (the current one is still in progress).
  const thisWeek = weekRange(input.today, input.settings.weekStartsOn);
  const lastWeek = weekRange(addDays(thisWeek.start, -1), input.settings.weekStartsOn);
  const sessions = sessionsInRange(
    input.sessions.filter((s) => s.status === 'completed'),
    lastWeek,
  );
  if (!sessions.length) return out;
  const vols = performedVolume(sessions, input.exercises, input.settings, input.client);
  const names = new Map(input.settings.muscles.map((m) => [m.id, m.name]));
  const under = vols.filter((v) => v.status === 'under');
  const over = vols.filter((v) => v.status === 'over');
  const base = { clientId: input.client.id, programId: input.program?.id ?? null, exerciseId: null, sourceSessionId: null };
  const label = `${fmtDate(lastWeek.start)}–${fmtDate(lastWeek.end)}`;
  if (under.length) {
    out.push({
      ...base,
      muscle: under[0].muscle as MuscleId,
      type: 'volumeLow',
      severity: 'info',
      title: under.length === 1 ? `${names.get(under[0].muscle)}: מתחת ליעד הנפח` : `${under.length} קבוצות שריר מתחת ליעד הנפח`,
      detected: `בשבוע ${label} (${sessions.length === 1 ? "אימון אחד" : `${sessions.length} אימונים`}) הנפח האפקטיבי היה נמוך מהיעד ב: ${under.map((v) => names.get(v.muscle)).join(', ')}.`,
      reasoning: `נפח אפקטיבי = סטים ישירים + סטים עקיפים × מקדם (ברירת מחדל ${input.settings.indirectFactor}). משווים ליעד האישי של המתאמן/ת.`,
      action: 'לשקול הוספת סטים/תרגיל לקבוצות החסרות, או לעדכן את היעד אם הוא לא מתאים לשלב הנוכחי.',
      evidence: under.map((v) => ({
        label: names.get(v.muscle) ?? v.muscle,
        value: `${fmtNum(v.effective)} סטים (ישיר ${v.direct} + עקיף ${fmtNum(v.indirect)}) · יעד ${v.target?.min}–${v.target?.max}`,
      })),
      suggestion: { kind: 'none' },
      dedupeKey: `volumeLow|${input.client.id}|${lastWeek.start}`,
    });
  }
  if (over.length) {
    out.push({
      ...base,
      muscle: over[0].muscle as MuscleId,
      type: 'volumeHigh',
      severity: 'info',
      title: over.length === 1 ? `${names.get(over[0].muscle)}: מעל יעד הנפח` : `${over.length} קבוצות שריר מעל יעד הנפח`,
      detected: `בשבוע ${label} הנפח האפקטיבי עבר את היעד ב: ${over.map((v) => names.get(v.muscle)).join(', ')}.`,
      reasoning: 'נפח גבוה מהיעד לאורך זמן עלול לפגוע בהתאוששות. כדאי לבדוק אם זה מכוון.',
      action: 'לבדוק אם העודף מכוון (שלב העמסה) או לצמצם סטים.',
      evidence: over.map((v) => ({
        label: names.get(v.muscle) ?? v.muscle,
        value: `${fmtNum(v.effective)} סטים · יעד ${v.target?.min}–${v.target?.max}`,
      })),
      suggestion: { kind: 'none' },
      dedupeKey: `volumeHigh|${input.client.id}|${lastWeek.start}`,
    });
  }
  return out;
}

function adherenceRules(input: EngineInput): RecDraft[] {
  const from = addDays(input.today, -14);
  const recent = input.sessions.filter((s) => !s.deletedAt && s.status === 'completed' && s.date >= from);
  if (recent.length < 2) return [];
  let planned = 0;
  let performed = 0;
  const skipped: string[] = [];
  for (const s of recent) {
    for (const e of s.entries) {
      if (e.added) continue;
      const ws = e.sets.filter((x) => x.type !== 'warmup' && !x.added);
      planned += ws.length;
      performed += ws.filter((x) => x.done).length;
      if (e.status === 'skipped' || e.status === 'notdone') skipped.push(input.exercises.get(e.exerciseId)?.nameHe ?? '');
    }
  }
  if (!planned) return [];
  const ratio = performed / planned;
  if (ratio >= 0.75) return [];
  // keyed by the newest workout that actually missed planned sets (the evidence): a later complete
  // workout doesn't re-raise advice the trainer already handled
  const missedSome = (s: Session) =>
    s.entries.some((e) => !e.added && e.sets.some((x) => x.type !== 'warmup' && !x.added && !x.done));
  const flagged = recent.filter(missedSome);
  const newest = (flagged.length ? flagged : recent).reduce((a, b) => (b.startedAt > a.startedAt ? b : a));
  const counts = new Map<string, number>();
  skipped.forEach((n) => counts.set(n, (counts.get(n) ?? 0) + 1));
  return [
    {
      clientId: input.client.id,
      programId: input.program?.id ?? null,
      exerciseId: null,
      muscle: null,
      sourceSessionId: input.sessionId ?? null,
      type: 'adherence',
      severity: 'info',
      title: 'פער בין התוכנית לביצוע',
      detected: `בשבועיים האחרונים בוצעו ${performed} מתוך ${planned} סטי עבודה מתוכננים (${Math.round(ratio * 100)}%).`,
      reasoning: 'פער עקבי בין תכנון לביצוע עשוי להעיד שהתוכנית ארוכה/קשה מדי לזמן או למצב הנוכחי.',
      action: 'לשקול לקצר את האימון, לתעדף תרגילים, או לבדוק מה גורם לדילוגים.',
      evidence: [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, n]) => ({ label: name, value: `לא בוצע ${n} פעמים` })),
      suggestion: { kind: 'none' },
      dedupeKey: `adherence|${input.client.id}|${newest.id}`,
    },
  ];
}

/** Runs every rule and returns fresh drafts (deduplication happens in the repo). */
export function runRules(input: EngineInput): RecDraft[] {
  const drafts: RecDraft[] = [];
  const focus = input.sessionId
    ? input.sessions.find((s) => s.id === input.sessionId)
    : [...input.sessions].filter((s) => s.status === 'completed' && !s.deletedAt).sort((a, b) => b.startedAt - a.startedAt)[0];
  const blockedEx = blockedExercises(focus, input.existing);
  if (focus && focus.status === 'completed') {
    for (const entry of focus.entries) drafts.push(...exerciseRules(entry, focus, input, blockedEx));
  }
  drafts.push(...recoveryRules(input), ...volumeRules(input), ...adherenceRules(input));
  // a swap for the same exercise and reason that is still pending is not suggested again (its key carries the session)
  const swapGroup = (key: string | undefined) => (key ?? '').split('|').slice(0, 4).join('|');
  const pendingSwaps = new Set(
    (input.existing ?? []).filter((r) => r.status === 'pending' && !r.deletedAt && r.type === 'swapExercise').map((r) => swapGroup(r.dedupeKey)),
  );
  // the same for client-level advice (recovery per kind, adherence): while one is pending, a copy from newer
  // evidence is not added next to it. Its own key still passes, so the repo can refresh it in place.
  const clientGroup = (r: Pick<Recommendation, 'type' | 'dedupeKey'>) =>
    (r.dedupeKey ?? '').split('|').slice(0, r.type === 'recoveryCheck' ? 3 : 2).join('|');
  const pendingClient = new Map<string, Set<string>>();
  for (const r of input.existing ?? []) {
    if (r.status !== 'pending' || r.deletedAt || !CLIENT_TYPES.includes(r.type)) continue;
    const g = clientGroup(r);
    pendingClient.set(g, (pendingClient.get(g) ?? new Set()).add(r.dedupeKey));
  }
  const dupOfPending = (d: RecDraft) => {
    const keys = CLIENT_TYPES.includes(d.type) ? pendingClient.get(clientGroup(d)) : undefined;
    return !!keys && !keys.has(d.dedupeKey);
  };
  // ...and once the trainer decided on such advice, evidence she had already seen (workouts that ended
  // before her decision) doesn't raise it again — only a workout after the decision can
  const decidedAtByGroup = new Map<string, number>();
  for (const r of input.existing ?? []) {
    if (r.status === 'pending' || r.deletedAt || !CLIENT_TYPES.includes(r.type) || !r.decidedAt) continue;
    const g = clientGroup(r);
    decidedAtByGroup.set(g, Math.max(decidedAtByGroup.get(g) ?? 0, r.decidedAt));
  }
  const alreadyHandled = (d: RecDraft) => {
    if (!CLIENT_TYPES.includes(d.type)) return false;
    const decided = decidedAtByGroup.get(clientGroup(d));
    const evidence = input.sessions.find((s) => s.id === d.dedupeKey.split('|').pop());
    return decided !== undefined && !!evidence && decided >= (evidence.endedAt ?? evidence.startedAt);
  };
  // final safety net: no load increase for an exercise flagged anywhere in the session or still under a pending check
  return drafts.filter(
    (d) =>
      !(isLoadIncrease(d) && d.exerciseId && blockedEx.has(d.exerciseId)) &&
      !(d.type === 'swapExercise' && pendingSwaps.has(swapGroup(d.dedupeKey))) &&
      !dupOfPending(d) &&
      !alreadyHandled(d),
  );
}

/** A recommendation counts as "older" only if its source session started before `session`. */
function fromOlderSession(r: Recommendation, session: Session, sessions: Map<ID, Session>): boolean {
  if (!r.sourceSessionId || r.sourceSessionId === session.id) return false;
  const src = sessions.get(r.sourceSessionId);
  return !src || src.startedAt < session.startedAt;
}

/**
 * Pending progression recs from OLDER sessions become stale once a newer session
 * re-evaluated the exercise with real working sets (skipped / warm-up-only / ✓-only entries don't count) —
 * in the same program slot: a light day does not re-evaluate the heavy day's advice.
 */
export function staleProgressionRecs(existing: Recommendation[], session: Session, sessions: Map<ID, Session> = new Map()): Recommendation[] {
  const entries = session.entries.filter(evaluable);
  return existing.filter((r) => {
    if (r.status !== 'pending' || r.deletedAt || !(PROGRESSION_TYPES.includes(r.type) || isLoadIncrease(r)) || !r.exerciseId) return false;
    if (!fromOlderSession(r, session, sessions)) return false;
    const series = { slot: r.suggestion?.plannedExerciseId, programId: sessions.get(r.sourceSessionId ?? '')?.programId ?? r.programId };
    return entries.some((e) => e.exerciseId === r.exerciseId && sameSeries(series, { slot: e.plannedExerciseId, programId: session.programId }));
  });
}

/** Pending load-increase recs (weight, reps, variation) from older sessions are withdrawn when pain / poor technique appear. */
export function blockedIncreaseRecs(existing: Recommendation[], session: Session, sessions: Map<ID, Session> = new Map()): Recommendation[] {
  const blocked = blockedExercises(session);
  return existing.filter(
    (r) =>
      r.status === 'pending' &&
      !r.deletedAt &&
      isLoadIncrease(r) &&
      !!r.exerciseId &&
      blocked.has(r.exerciseId) &&
      fromOlderSession(r, session, sessions),
  );
}

export function suggestionText(s: RecSuggestion): string {
  if (s.kind === 'weight') return `${s.from} ← ${s.to} ק״ג`;
  if (s.kind === 'reps') return `${s.from} ← ${s.to} חזרות`;
  if (s.kind === 'range') return `טווח ${s.from} ← ${s.to}`;
  return '';
}

export { e1rm, entryStats };
