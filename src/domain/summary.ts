/** Automatic post-workout summary (spec §8) — derived, never stored separately. */
import type { Exercise, ID, PlannedExercise, Session, SessionEntry, SetupFields } from './types';
import {
  compareWithPrevious,
  entryStats,
  exerciseHistory,
  personalRecords,
  type Comparison,
  type EntryStats,
  type ExerciseOccurrence,
} from './progress';

/** Machine / setup fields (seat height, grip …) as the trainer sees them. */
export const SETUP_LABEL: Record<keyof SetupFields, string> = {
  seat: 'כיסא/משענת',
  bench: 'ספסל',
  angle: 'זווית',
  cable: 'גובה כבל',
  grip: 'אחיזה',
  rom: 'טווח',
  other: 'אחר',
};

export interface PlanChange {
  entryId: ID;
  exerciseId: ID;
  kind: 'weight' | 'reps' | 'sets-added' | 'sets-missed' | 'skipped' | 'notdone' | 'swapped' | 'added' | 'setup';
  text: string;
}

export interface EntrySummary {
  entry: SessionEntry;
  stats: EntryStats;
  comparison: Comparison;
  plannedSets: number;
  doneSets: number;
  incompleteSets: number;
}

export interface SessionSummary {
  entries: EntrySummary[];
  changes: PlanChange[];
  totals: { sets: number; plannedSets: number; reps: number; volume: number; exercises: number; durationMs: number };
  improved: EntrySummary[];
  declined: EntrySummary[];
  prs: EntrySummary[];
  pain: SessionEntry[];
  techniqueIssues: SessionEntry[];
}

/**
 * What an entry is measured against: the last time the same program slot was done, so a light day is
 * never compared with the heavy one, nor a finisher with the main lift. Without one (a free workout, an
 * added exercise, a new program), the entry at the same place among that exercise's entries in the last
 * session that had it.
 */
function previousOfSlot(history: ExerciseOccurrence[], session: Session, entry: SessionEntry): ExerciseOccurrence | null {
  if (!history.length) return null;
  const slot = entry.plannedExerciseId ? history.filter((o) => o.entry.plannedExerciseId === entry.plannedExerciseId) : [];
  if (slot.length) return slot[slot.length - 1];
  const lastId = history[history.length - 1].session.id;
  const there = history.filter((o) => o.session.id === lastId);
  const sameSection = there.filter((o) => o.entry.section === entry.section);
  const pool = sameSection.length ? sameSection : there;
  const mine = session.entries.filter((e) => e.exerciseId === entry.exerciseId && (!sameSection.length || e.section === entry.section));
  return pool[Math.min(Math.max(0, mine.indexOf(entry)), pool.length - 1)];
}

function plannedItem(session: Session, entry: SessionEntry): PlannedExercise | null {
  if (!entry.plannedExerciseId || !session.plannedSnapshot) return null;
  for (const b of session.plannedSnapshot.blocks) for (const i of b.items) if (i.id === entry.plannedExerciseId) return i;
  return null;
}

export function summarizeSession(session: Session, allSessions: Session[], exercises: Map<ID, Exercise>): SessionSummary {
  const entries: EntrySummary[] = [];
  const changes: PlanChange[] = [];
  const name = (id: ID) => exercises.get(id)?.nameHe ?? 'תרגיל';
  // a free workout has no plan, so there is nothing to have changed against
  const planned = !!(session.plannedSnapshot || session.plannedWorkoutId);

  for (const entry of session.entries) {
    const stats = entryStats(entry);
    const history = exerciseHistory(allSessions, entry.exerciseId, session.id).filter(
      (o) => o.session.startedAt < session.startedAt,
    );
    const prev = previousOfSlot(history, session, entry)?.stats ?? null;
    // records still count against the whole history of the exercise
    const comparison = compareWithPrevious(stats, prev, history.length ? personalRecords(history) : undefined);
    const work = entry.sets.filter((s) => s.type !== 'warmup');
    const plannedSets = work.filter((s) => !s.added).length;
    const doneSets = work.filter((s) => s.done).length;
    entries.push({ entry, stats, comparison, plannedSets, doneSets, incompleteSets: Math.max(0, work.filter((s) => !s.done).length) });

    if (!planned) continue;
    if (entry.added) changes.push({ entryId: entry.id, exerciseId: entry.exerciseId, kind: 'added', text: `נוסף תרגיל: ${name(entry.exerciseId)}` });
    if (entry.swappedFromId)
      changes.push({
        entryId: entry.id,
        exerciseId: entry.exerciseId,
        kind: 'swapped',
        text: `${name(entry.swappedFromId)} הוחלף ב${name(entry.exerciseId)}`,
      });
    if (entry.status === 'skipped' || entry.status === 'notdone') {
      changes.push({
        entryId: entry.id,
        exerciseId: entry.exerciseId,
        kind: entry.status,
        text: `${name(entry.exerciseId)} — ${entry.status === 'skipped' ? 'דולג' : 'לא בוצע'}`,
      });
      continue;
    }
    // the sets of an added exercise are all "added" — the "נוסף תרגיל" line already says so
    const addedSets = entry.added ? 0 : work.filter((s) => s.added && s.done).length;
    if (addedSets) changes.push({ entryId: entry.id, exerciseId: entry.exerciseId, kind: 'sets-added', text: `${name(entry.exerciseId)}: ${addedSets === 1 ? "נוסף סט אחד" : `נוספו ${addedSets} סטים`}` });
    const missed = work.filter((s) => !s.added && !s.done).length;
    if (missed) changes.push({ entryId: entry.id, exerciseId: entry.exerciseId, kind: 'sets-missed', text: `${name(entry.exerciseId)}: ${missed === 1 ? "סט אחד לא הושלם" : `${missed} סטים לא הושלמו`}` });

    const weightDiffs = work.filter(
      (s) => s.done && s.planned?.weight != null && s.weight != null && s.weight !== s.planned.weight,
    );
    if (weightDiffs.length) {
      const s = weightDiffs[0];
      changes.push({
        entryId: entry.id,
        exerciseId: entry.exerciseId,
        kind: 'weight',
        text: `${name(entry.exerciseId)}: משקל ${s.planned!.weight} ← ${s.weight} ק״ג${weightDiffs.length > 1 ? ` (${weightDiffs.length} סטים)` : ''}`,
      });
    }
    const repsOff = work.filter((s) => {
      if (!s.done || s.reps == null || !s.planned) return false;
      const min = s.planned.repsMin ?? s.planned.repsMax;
      const max = s.planned.repsMax ?? s.planned.repsMin;
      if (min == null || max == null) return false;
      return s.reps < min || s.reps > max;
    });
    if (repsOff.length) {
      const below = repsOff.filter((s) => s.reps! < (s.planned!.repsMin ?? s.planned!.repsMax!)).length;
      changes.push({
        entryId: entry.id,
        exerciseId: entry.exerciseId,
        kind: 'reps',
        text: `${name(entry.exerciseId)}: ${repsOff.length === 1 ? "סט אחד" : `${repsOff.length} סטים`} מחוץ לטווח החזרות (${below ? `${below} מתחת` : ''}${below && repsOff.length - below ? ', ' : ''}${repsOff.length - below ? `${repsOff.length - below} מעל` : ''})`,
      });
    }

    // machine setup changed during the workout ("כיוונים לאימון הזה") — what was actually used, a field
    // cleared included. Not for a replacement exercise (the plan's setup was for another machine)
    const item = plannedItem(session, entry);
    if (item && item.exerciseId === entry.exerciseId) {
      const diffs = (Object.keys(SETUP_LABEL) as (keyof SetupFields)[]).filter(
        // only fields this workout actually holds — an entry that started without the plan's setup
        // (e.g. swapped back mid-workout) must not report every planned value as "cleared"
        (k) => k in (entry.setup ?? {}) && (item.setup?.[k] ?? '').trim() !== (entry.setup?.[k] ?? '').trim(),
      );
      for (const k of diffs)
        changes.push({
          entryId: entry.id,
          exerciseId: entry.exerciseId,
          kind: 'setup',
          text: `${name(entry.exerciseId)}: ${SETUP_LABEL[k]} ${item.setup?.[k]?.trim() || '—'} ← ${entry.setup?.[k]?.trim() || '—'}`,
        });
    }
  }

  const done = entries.filter((e) => e.doneSets > 0);
  // a warm-up exercise (bike, mobility) is not a performance — it never makes "improved" / "declined"
  const performance = done.filter((e) => e.entry.section !== 'warmup');
  return {
    entries,
    changes,
    totals: {
      sets: done.reduce((a, e) => a + e.doneSets, 0),
      plannedSets: entries.reduce((a, e) => a + e.plannedSets, 0),
      reps: done.reduce((a, e) => a + e.stats.reps, 0),
      volume: done.reduce((a, e) => a + e.stats.volume, 0),
      exercises: done.length,
      durationMs: (session.endedAt ?? Date.now()) - session.startedAt,
    },
    improved: performance.filter((e) => e.comparison.trend === 'up'),
    declined: performance.filter((e) => e.comparison.trend === 'down'),
    prs: done.filter((e) => e.comparison.newPR),
    pain: session.entries.filter((e) => e.pain?.reported),
    techniqueIssues: session.entries.filter((e) => e.technique === 'poor' || e.technique === 'fix'),
  };
}
