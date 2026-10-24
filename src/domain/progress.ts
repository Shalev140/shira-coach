import type { ID, PerformedSet, Session, SessionEntry, Technique } from './types';

/**
 * Estimated 1RM (Epley) from weight × reps. RIR is deliberately not folded in:
 * it is optional to record, and mixing adjusted / unadjusted sets would make
 * session-to-session comparisons jump for no real reason.
 */
export function e1rm(weight?: number | null, reps?: number | null, _rir?: number | null): number {
  if (!weight || !reps || weight <= 0 || reps <= 0) return 0;
  if (reps === 1) return weight;
  return weight * (1 + reps / 30);
}

export const isWorkSet = (s: PerformedSet) => s.type !== 'warmup';

export function completedWorkSets(entry: SessionEntry): PerformedSet[] {
  return entry.sets.filter((s) => s.done && isWorkSet(s));
}

export interface EntryStats {
  sets: number;
  reps: number;
  volume: number; // kg × reps
  duration: number; // seconds, timed sets
  bestDuration: number;
  loadTime: number; // kg × seconds, loaded timed sets (carries, weighted holds)
  bestLoadTime: number;
  topWeight: number;
  bestE1rm: number;
  bestSet?: PerformedSet;
  avgRir: number | null;
}

/** Tie-break for sets with the same e1rm (all unloaded sets score 0): more reps, then the longer hold. */
const moreWork = (a: PerformedSet, b?: PerformedSet) =>
  (a.reps ?? 0) > (b?.reps ?? 0) || ((a.reps ?? 0) === (b?.reps ?? 0) && (a.duration ?? 0) > (b?.duration ?? 0));

export function entryStats(entry: SessionEntry): EntryStats {
  const sets = completedWorkSets(entry);
  let reps = 0;
  let volume = 0;
  let duration = 0;
  let bestDuration = 0;
  let loadTime = 0;
  let bestLoadTime = 0;
  let topWeight = 0;
  let bestE1rm = 0;
  let bestSet: PerformedSet | undefined;
  const rirs: number[] = [];
  for (const s of sets) {
    reps += s.reps ?? 0;
    volume += (s.weight ?? 0) * (s.reps ?? 0);
    duration += s.duration ?? 0;
    bestDuration = Math.max(bestDuration, s.duration ?? 0);
    const lt = (s.weight ?? 0) * (s.duration ?? 0);
    loadTime += lt;
    bestLoadTime = Math.max(bestLoadTime, lt);
    topWeight = Math.max(topWeight, s.weight ?? 0);
    const est = e1rm(s.weight, s.reps, s.rir);
    if (est > bestE1rm || (est === bestE1rm && moreWork(s, bestSet))) {
      bestE1rm = Math.max(bestE1rm, est);
      bestSet = s;
    }
    if (s.rir !== null && s.rir !== undefined) rirs.push(s.rir);
  }
  return {
    sets: sets.length,
    reps,
    volume,
    duration,
    bestDuration,
    loadTime,
    bestLoadTime,
    topWeight,
    bestE1rm,
    bestSet,
    avgRir: rirs.length ? rirs.reduce((a, b) => a + b, 0) / rirs.length : null,
  };
}

export interface ExerciseOccurrence {
  session: Session;
  entry: SessionEntry;
  stats: EntryStats;
}

const sameSlot = (hist: ExerciseOccurrence[], plannedExerciseId?: ID | null) =>
  plannedExerciseId ? hist.filter((o) => o.entry.plannedExerciseId === plannedExerciseId) : [];

/**
 * All completed occurrences of an exercise for a client, oldest first. Given the program slot
 * (`plannedExerciseId`), only that slot's occurrences are returned when it has any, so a heavy and a
 * light day of the same exercise (or a main lift and its finisher) are never mixed up.
 */
export function exerciseHistory(sessions: Session[], exerciseId: ID, beforeSessionId?: ID, plannedExerciseId?: ID | null): ExerciseOccurrence[] {
  const out: ExerciseOccurrence[] = [];
  const sorted = [...sessions]
    .filter((s) => !s.deletedAt && s.status === 'completed' && s.id !== beforeSessionId)
    .sort((a, b) => a.startedAt - b.startedAt);
  for (const session of sorted) {
    for (const entry of session.entries) {
      if (entry.exerciseId !== exerciseId) continue;
      const stats = entryStats(entry);
      if (stats.sets === 0) continue;
      out.push({ session, entry, stats });
    }
  }
  const slot = sameSlot(out, plannedExerciseId);
  return slot.length ? slot : out;
}

/**
 * Last completed occurrence before a given session (for "previous workout" panels). Given the program
 * slot, the last time that slot was done is preferred; without one, the last occurrence anywhere.
 */
export function previousOccurrence(sessions: Session[], exerciseId: ID, current?: Session, plannedExerciseId?: ID | null): ExerciseOccurrence | null {
  const hist = exerciseHistory(sessions, exerciseId, current?.id).filter(
    (o) => !current || o.session.startedAt < current.startedAt,
  );
  const slot = sameSlot(hist, plannedExerciseId);
  const from = slot.length ? slot : hist;
  return from.length ? from[from.length - 1] : null;
}

export interface PersonalRecords {
  topWeight: { value: number; reps: number; date: string } | null;
  bestE1rm: { value: number; weight: number; reps: number; date: string } | null;
  bestVolume: { value: number; date: string } | null;
  mostReps: { value: number; weight: number; date: string } | null;
}

export function personalRecords(history: ExerciseOccurrence[]): PersonalRecords {
  const pr: PersonalRecords = { topWeight: null, bestE1rm: null, bestVolume: null, mostReps: null };
  for (const { session, entry, stats } of history) {
    for (const s of completedWorkSets(entry)) {
      const w = s.weight ?? 0;
      const r = s.reps ?? 0;
      if (w > 0 && r > 0 && (!pr.topWeight || w > pr.topWeight.value))
        pr.topWeight = { value: w, reps: r, date: session.date };
      const est = e1rm(w, r, s.rir);
      if (est > 0 && (!pr.bestE1rm || est > pr.bestE1rm.value))
        pr.bestE1rm = { value: est, weight: w, reps: r, date: session.date };
      if (r > 0 && (!pr.mostReps || r > pr.mostReps.value)) pr.mostReps = { value: r, weight: w, date: session.date };
    }
    if (stats.volume > 0 && (!pr.bestVolume || stats.volume > pr.bestVolume.value))
      pr.bestVolume = { value: stats.volume, date: session.date };
  }
  return pr;
}

/** 'none': no working set was done this time (only the warm-up, or stopped and swapped) — nothing to compare. */
export type Trend = 'up' | 'down' | 'same' | 'new' | 'none';

export interface Comparison {
  trend: Trend;
  e1rmDelta: number; // %
  volumeDelta: number; // %
  repsDelta: number;
  topWeightDelta: number;
  newPR: boolean;
  label: string;
}

/** Compares an entry with the previous occurrence of the same exercise. */
export function compareWithPrevious(current: EntryStats, prev: EntryStats | null, prHistory?: PersonalRecords): Comparison {
  if (current.sets === 0)
    return { trend: 'none', e1rmDelta: 0, volumeDelta: 0, repsDelta: 0, topWeightDelta: 0, newPR: false, label: 'לא בוצעו סטי עבודה' };
  if (!prev || prev.sets === 0) {
    return { trend: 'new', e1rmDelta: 0, volumeDelta: 0, repsDelta: 0, topWeightDelta: 0, newPR: false, label: 'פעם ראשונה' };
  }
  // a record is measured against the whole history, not just last time, so it holds even when last time can't be compared
  const newPR = !!prHistory?.bestE1rm && current.bestE1rm > prHistory.bestE1rm.value + 0.01;
  const pct = (a: number, b: number) => (b > 0 ? ((a - b) / b) * 100 : 0);
  // Compare best sets (strength) — totals would punish a shortened workout.
  const e1rmDelta = pct(current.bestE1rm, prev.bestE1rm);
  const volumeDelta = pct(current.volume, prev.volume);
  const topWeightDelta = Math.round((current.topWeight - prev.topWeight) * 100) / 100;
  const repsDelta = (current.bestSet?.reps ?? 0) - (prev.bestSet?.reps ?? 0);
  const secondsDelta = current.bestDuration - prev.bestDuration;
  const sameWork = current.sets >= prev.sets;
  // Unloaded work (bodyweight, timed holds) has no e1rm or volume, so it is judged the same
  // way on best-set reps / total reps, or on the longest hold / total time.
  let best = e1rmDelta;
  let total = volumeDelta;
  if (!prev.bestE1rm && !current.bestE1rm) {
    if (prev.reps > 0 && current.reps > 0) {
      best = pct(current.bestSet?.reps ?? 0, prev.bestSet?.reps ?? 0);
      total = pct(current.reps, prev.reps);
    } else if (prev.duration > 0 && current.duration > 0) {
      // a loaded carry / weighted hold is judged on load × time, so a heavier carry for as long is progress
      // and a lighter one held a little longer is not
      const loaded = prev.topWeight > 0 || current.topWeight > 0;
      best = loaded ? pct(current.bestLoadTime, prev.bestLoadTime) : pct(current.bestDuration, prev.bestDuration);
      total = loaded ? pct(current.loadTime, prev.loadTime) : pct(current.duration, prev.duration);
    }
  }
  // last time had no load but this time does: either load was added to a bodyweight move or last
  // time's weight simply wasn't logged — there is no honest comparison, so don't claim one
  if (!prev.topWeight && (current.bestE1rm > 0 || current.bestLoadTime > 0))
    return { trend: 'new', e1rmDelta: 0, volumeDelta: 0, repsDelta, topWeightDelta, newPR, label: 'אין בסיס להשוואה' };
  let trend: Trend = 'same';
  // A 2% band filters out noise from rounding / RIR estimates.
  if (best > 2 || (Math.abs(best) <= 2 && total > 5 && sameWork)) trend = 'up';
  else if (best < -2 || (Math.abs(best) <= 2 && total < -10 && sameWork)) trend = 'down';
  const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);
  // The label explains the trend, so it only quotes a change that points the same way.
  const dir = trend === 'up' ? 1 : -1;
  let label = 'יציב';
  if (trend !== 'same')
    label =
      Math.sign(topWeightDelta) === dir ? `${signed(topWeightDelta)} ק״ג`
      : Math.sign(repsDelta) === dir ? `${signed(repsDelta)} חזרות בסט הטוב`
      : Math.sign(secondsDelta) === dir ? `${signed(secondsDelta)} שניות בסט הטוב`
      : Math.abs(e1rmDelta) > 2 ? `${signed(Math.round(e1rmDelta))}% ב-1RM המשוער`
      : trend === 'up' ? 'יותר נפח' : 'פחות נפח';
  return { trend, e1rmDelta, volumeDelta, repsDelta, topWeightDelta, newPR, label };
}

export const TECHNIQUE_SCORE: Record<Technique, number | null> = { good: 3, fix: 2, poor: 1, na: null };

const LRM = '‎';

/**
 * One set as "80×8 @2" / "BW×10" / "30ש׳" / "32 ק״ג · 40ש׳" (a loaded carry or hold). Wrapped in an LTR
 * isolate (U+2066…U+2069) so it reads the same inside RTL text on every screen — without it the bidi
 * algorithm shows "2@ 8×80".
 */
export function formatSet(s: Pick<PerformedSet, 'weight' | 'reps' | 'rir' | 'duration'>): string {
  const parts: string[] = [];
  // the LRM keeps what follows ("· 40", "@2") from attaching to the Hebrew unit and jumping before it
  if (s.duration) parts.push(`${s.weight ? `${s.weight} ק״ג${LRM} · ` : ''}${s.duration}ש׳${LRM}`);
  else {
    const w = s.weight ? `${s.weight}` : 'BW';
    parts.push(`${w}×${s.reps ?? '—'}`);
  }
  if (s.rir !== null && s.rir !== undefined) parts.push(`@${s.rir}`);
  return `⁦${parts.join(' ')}⁩`;
}
