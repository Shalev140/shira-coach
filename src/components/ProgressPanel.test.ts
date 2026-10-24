import { describe, expect, it } from 'vitest';
import { exerciseHistory } from '../domain/progress';
import { entry, session, set } from '../domain/testkit';
import { defaultMetric, latestSlot, perWorkout, periodChange, slotHistory } from './ProgressPanel';

const SQUAT = 'squat_back_bb';
const reps = (w: number, r: number, n: number) => Array.from({ length: n }, () => set(w, r));

describe('progress tab: like-for-like comparisons', () => {
  // heavy squat 3×5 in the main block plus a lighter squat 2×10 in the finisher, every workout
  const twice = [100, 105, 110, 115].map((w, i) =>
    session(`2026-09-0${i + 1}`, [
      entry(SQUAT, reps(w, 5, 3), { plannedExerciseId: 'heavy', blockLabel: 'A' }),
      entry(SQUAT, reps(70 + 2.5 * i, 10, 2), { plannedExerciseId: 'light', blockLabel: 'D', section: 'finisher' }),
    ]),
  );

  it('one point per workout: the best set of the session, totals added up', () => {
    const h = perWorkout(exerciseHistory(twice, SQUAT));
    expect(h).toHaveLength(4);
    expect(h.map((o) => Math.round(o.stats.bestE1rm * 10) / 10)).toEqual([116.7, 122.5, 128.3, 134.2]);
    expect(h[0].stats.volume).toBe(100 * 5 * 3 + 70 * 10 * 2);
    expect(new Set(h.map((o) => o.session.date)).size).toBe(4);
  });

  it('the same exercise twice in a workout no longer reads as a drop in the period', () => {
    const slot = latestSlot(exerciseHistory(twice, SQUAT));
    expect(slot).toBe('heavy');
    const change = periodChange(slotHistory(twice, SQUAT, slot));
    expect(change?.label).toBe('שינוי ב-1RM בתקופה');
    expect(change!.pct).toBeCloseTo(15, 0);
  });

  it('a heavy day and a light day are compared each with itself', () => {
    // A: 5 reps heavy, B: 12 reps light, both +5 kg over three weeks; the period ends on a light day
    const ab = [0, 1, 2].flatMap((wk) => [
      session(`2026-09-${String(1 + wk * 7).padStart(2, '0')}`, [entry(SQUAT, reps(100 + 5 * wk, 5, 3), { plannedExerciseId: 'dayA' })], { workoutName: 'A' }),
      session(`2026-09-${String(4 + wk * 7).padStart(2, '0')}`, [entry(SQUAT, reps(60 + 5 * wk, 12, 3), { plannedExerciseId: 'dayB' })], { workoutName: 'B' }),
    ]);
    const slot = latestSlot(exerciseHistory(ab, SQUAT));
    expect(slot).toBe('dayB');
    const line = slotHistory(ab, SQUAT, slot);
    expect(line.map((o) => o.entry.plannedExerciseId)).toEqual(['dayB', 'dayB', 'dayB']);
    expect(periodChange(line)!.pct).toBeGreaterThan(0);
  });

  it('a slot too new to compare falls back to every workout', () => {
    const s = [
      session('2026-09-01', [entry(SQUAT, reps(100, 5, 3), { plannedExerciseId: 'old' })]),
      session('2026-09-08', [entry(SQUAT, reps(110, 5, 3), { plannedExerciseId: 'new' })]),
    ];
    expect(slotHistory(s, SQUAT, 'new')).toHaveLength(2);
  });
});

describe('progress tab: timed holds and bodyweight moves', () => {
  const plank = [30, 40, 50, 60].map((d, i) =>
    session(`2026-09-0${i + 1}`, [entry('plank', [1, 2, 3].map(() => set(null, null, null, { duration: d })))]),
  );
  const pushups = [10, 12].map((r, i) => session(`2026-09-0${i + 1}`, [entry('push_up', reps(0, r, 3).map((x) => ({ ...x, weight: null })))]));

  it('opens on seconds for a hold, reps for a bodyweight move, e1rm for loaded work', () => {
    expect(defaultMetric(exerciseHistory(plank, 'plank'))).toBe('duration');
    expect(defaultMetric(exerciseHistory(pushups, 'push_up'))).toBe('reps');
    expect(defaultMetric(exerciseHistory([session('2026-09-01', [entry(SQUAT, reps(100, 5, 3))])], SQUAT))).toBe('e1rm');
  });

  it('the period change follows the hold time, not a neutral 0% on 1RM', () => {
    const change = periodChange(perWorkout(exerciseHistory(plank, 'plank')));
    expect(change?.label).toBe('שינוי בזמן ההחזקה');
    expect(change!.pct).toBe(100);
    const reps = periodChange(perWorkout(exerciseHistory(pushups, 'push_up')));
    expect(reps?.label).toBe('שינוי בחזרות בסט הטוב');
    expect(reps!.pct).toBeCloseTo(20);
  });

  it('one workout, or load added to a bodyweight move, has no period change', () => {
    expect(periodChange(perWorkout(exerciseHistory(plank.slice(0, 1), 'plank')))).toBeNull();
    const loaded = [...pushups, session('2026-09-05', [entry('push_up', reps(10, 10, 3))])];
    expect(periodChange(perWorkout(exerciseHistory(loaded, 'push_up')))).toBeNull();
  });
});
