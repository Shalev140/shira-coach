import { describe, expect, it } from 'vitest';
import { computeAlerts } from './agenda';
import { compareWithPrevious, entryStats, exerciseHistory, formatSet, previousOccurrence } from './progress';
import { summarizeSession } from './summary';
import { client, entry, exerciseMap, session, set } from './testkit';
import { matches } from './util';
import type { PlannedWorkout, Session } from './types';

const ex = exerciseMap();
const bw = (reps: number) => set(null, reps, null);
const hold = (seconds: number) => set(null, null, null, { duration: seconds });
const stats = (exerciseId: string, sets: ReturnType<typeof set>[]) => entryStats(entry(exerciseId, sets));
const compare = (exerciseId: string, prev: ReturnType<typeof set>[], cur: ReturnType<typeof set>[]) =>
  compareWithPrevious(stats(exerciseId, cur), stats(exerciseId, prev));

describe('progress comparison', () => {
  it('reports bodyweight rep gains and drops instead of "stable"', () => {
    const up = compare('pull_up', [bw(5), bw(5)], [bw(10), bw(10)]);
    expect(up.trend).toBe('up');
    expect(up.label).toBe('+5 חזרות בסט הטוב');
    const down = compare('pull_up', [bw(10), bw(10)], [bw(2), bw(2)]);
    expect(down.trend).toBe('down');
    expect(down.label).toBe('-8 חזרות בסט הטוב');
    expect(compare('pull_up', [bw(10), bw(10)], [bw(10), bw(10)]).trend).toBe('same');
  });

  it('reports longer and shorter holds for timed exercises', () => {
    const up = compare('plank', [hold(30)], [hold(90)]);
    expect(up.trend).toBe('up');
    expect(up.label).toBe('+60 שניות בסט הטוב');
    expect(compare('plank', [hold(60), hold(60)], [hold(40), hold(40)]).trend).toBe('down');
  });

  it('makes no claim when last time had no load and this time has (added load, or weight not logged)', () => {
    const c = compare('pull_up', [bw(10)], [set(5, 6, null)]);
    expect(c.trend).toBe('new');
    expect(c.label).toBe('אין בסיס להשוואה');
    // a loaded exercise whose last weight was simply not logged must not be shown as a big gain
    const missing = compare('bench_press_bb', [set(null, 8, null)], [set(60, 8, null)]);
    expect(missing.trend).toBe('new');
  });

  it('shows an improved bodyweight exercise in the session summary', () => {
    const s1 = session('2026-10-20', [entry('pull_up', [bw(5), bw(5)])]);
    const s2 = session('2026-10-22', [entry('pull_up', [bw(10), bw(10)])]);
    const summary = summarizeSession(s2, [s1, s2], ex);
    expect(summary.improved).toHaveLength(1);
  });

  it('a warm-up exercise never shows up as improved or declined', () => {
    const warm = (minutes: number) => entry('bike', [set(null, null, null, { duration: minutes * 60 })], { section: 'warmup' });
    const s1 = session('2026-10-20', [warm(5), entry('pull_up', [bw(5)])]);
    const s2 = session('2026-10-22', [warm(10), entry('pull_up', [bw(8)])]);
    const summary = summarizeSession(s2, [s1, s2], ex);
    expect(summary.improved.map((e) => e.entry.exerciseId)).toEqual(['pull_up']);
    expect(summary.declined).toEqual([]);
  });

  it('never explains a trend with a change pointing the other way', () => {
    // lighter but many more reps: e1rm up, top weight down
    const up = compare('bench_press_bb', [set(100, 5)], [set(90, 12)]);
    expect(up.trend).toBe('up');
    expect(up.label).toBe('+7 חזרות בסט הטוב');
    // heavier but far fewer reps: e1rm down, top weight up
    const down = compare('bench_press_bb', [set(100, 10)], [set(105, 3)]);
    expect(down.trend).toBe('down');
    expect(down.label).toBe('-7 חזרות בסט הטוב');
    // heavy block → higher-rep block: trend from volume, top weight down
    const block = compare('bench_press_bb', [set(70, 6), set(70, 6), set(70, 6)], [set(60, 12), set(60, 12), set(60, 12)]);
    expect(block.trend).toBe('up');
    expect(block.label).not.toContain('ק״ג');
    // keeps the shape callers rely on
    expect(Object.keys(block).sort()).toEqual(['e1rmDelta', 'label', 'newPR', 'repsDelta', 'topWeightDelta', 'trend', 'volumeDelta']);
  });

  it('falls back to the e1rm change when weight and reps both moved against the trend', () => {
    // best set 100×8 (top weight 110×1) → best set 105×8, top weight only 105
    const c = compare('bench_press_bb', [set(110, 1), set(100, 8)], [set(105, 8)]);
    expect(c.trend).toBe('up');
    expect(c.label).toMatch(/^\+\d+% ב-1RM המשוער$/);
  });
});

describe('entryStats best set', () => {
  it('picks the set with the most reps when no set has load', () => {
    expect(stats('push_up', [bw(8), bw(15), bw(12)]).bestSet?.reps).toBe(15);
  });

  it('picks the longest hold for timed sets', () => {
    const s = stats('plank', [hold(30), hold(45), hold(40)]);
    expect(s.bestSet?.duration).toBe(45);
    expect(s.bestDuration).toBe(45);
    expect(s.duration).toBe(115);
  });

  it('still ranks loaded sets by e1rm', () => {
    expect(stats('bench_press_bb', [set(60, 15), set(100, 5), set(80, 8)]).bestSet?.weight).toBe(100);
  });
});

describe('formatSet', () => {
  const LRI = '⁦';
  const PDI = '⁩';
  it('wraps the set in an LTR isolate so weight and reps never swap inside RTL text', () => {
    expect(formatSet({ weight: 80, reps: 8, rir: 2 })).toBe(`${LRI}80×8 @2${PDI}`);
    expect(formatSet({ weight: null, reps: 10, rir: null })).toBe(`${LRI}BW×10${PDI}`);
  });

  it('keeps RIR after a timed set from attaching to the Hebrew unit', () => {
    expect(formatSet({ duration: 30, rir: 2 })).toBe(`${LRI}30ש׳‎ @2${PDI}`);
  });

  it('shows the load of a loaded timed set (carry, weighted hold)', () => {
    const LRM = '‎';
    expect(formatSet({ weight: 32, duration: 40, rir: null })).toBe(`${LRI}32 ק״ג${LRM} · 40ש׳${LRM}${PDI}`);
    expect(formatSet({ weight: 32, duration: 40 })).not.toBe(formatSet({ weight: 16, duration: 40 }));
    expect(formatSet({ weight: null, duration: 40 })).toBe(`${LRI}40ש׳${LRM}${PDI}`);
  });
});

describe('program slot (heavy / light day, main lift / finisher)', () => {
  const heavy = (w: number) => [set(w, 5), set(w, 5), set(w, 5)];
  const light = (w: number) => [set(w, 15), set(w, 15)];

  it('prefers the same slot for the previous occurrence and history, falling back to any slot', () => {
    const a = session('2026-10-19', [entry('bench_press_bb', heavy(30), { plannedExerciseId: 'A1' })]);
    const b = session('2026-10-21', [entry('bench_press_bb', light(20), { plannedExerciseId: 'B1' })]);
    const next = session('2026-10-23', [], { status: 'active' });
    expect(previousOccurrence([a, b], 'bench_press_bb', next)?.session.id).toBe(b.id);
    expect(previousOccurrence([a, b], 'bench_press_bb', next, 'A1')?.session.id).toBe(a.id);
    expect(previousOccurrence([a, b], 'bench_press_bb', next, 'B1')?.session.id).toBe(b.id);
    expect(previousOccurrence([a, b], 'bench_press_bb', next, 'new-slot')?.session.id).toBe(b.id);
    // a same-slot occurrence after the current session doesn't count
    expect(previousOccurrence([a, b], 'bench_press_bb', session('2026-10-20', []), 'B1')?.session.id).toBe(a.id);
    expect(exerciseHistory([a, b], 'bench_press_bb', undefined, 'A1').map((o) => o.session.id)).toEqual([a.id]);
    expect(exerciseHistory([a, b], 'bench_press_bb', undefined, 'new-slot')).toHaveLength(2);
    expect(exerciseHistory([a, b], 'bench_press_bb')).toHaveLength(2);
  });

  it('compares the same exercise twice in a workout each with its own slot', () => {
    const day = (date: string) =>
      session(date, [
        entry('squat_back_bb', heavy(100), { plannedExerciseId: 'main' }),
        entry('squat_back_bb', light(60), { plannedExerciseId: 'fin', section: 'finisher' }),
      ]);
    const s1 = day('2026-10-20');
    const s2 = day('2026-10-22');
    const summary = summarizeSession(s2, [s1, s2], ex);
    expect(summary.entries.map((e) => e.comparison.trend)).toEqual(['same', 'same']);
    expect(summary.improved).toHaveLength(0);
    expect(summary.declined).toHaveLength(0);
  });

  it('falls back to the same position when entries have no slot (free workout)', () => {
    const day = (date: string) =>
      session(date, [entry('squat_back_bb', heavy(100)), entry('squat_back_bb', light(60))], { plannedSnapshot: null });
    const s1 = day('2026-10-20');
    const s2 = day('2026-10-22');
    expect(summarizeSession(s2, [s1, s2], ex).entries.map((e) => e.comparison.trend)).toEqual(['same', 'same']);
  });

  it('compares a light day with the last light day, not with the heavy day in between', () => {
    const b1 = session('2026-10-17', [entry('bench_press_bb', light(20), { plannedExerciseId: 'B1' })]);
    const a1 = session('2026-10-19', [entry('bench_press_bb', heavy(30), { plannedExerciseId: 'A1' })]);
    const b2 = session('2026-10-21', [entry('bench_press_bb', light(20), { plannedExerciseId: 'B1' })]);
    const summary = summarizeSession(b2, [b1, a1, b2], ex);
    expect(summary.entries[0].comparison.trend).toBe('same');
    expect(summary.declined).toHaveLength(0);
  });
});

describe('session summary edge cases', () => {
  it('still flags a real record when last time had no load to compare with', () => {
    const s1 = session('2026-10-18', [entry('pull_up', [set(10, 6)])]);
    const s2 = session('2026-10-20', [entry('pull_up', [bw(10)])]);
    const s3 = session('2026-10-22', [entry('pull_up', [set(12.5, 6)])]);
    const summary = summarizeSession(s3, [s1, s2, s3], ex);
    expect(summary.entries[0].comparison.label).toBe('אין בסיס להשוואה');
    expect(summary.entries[0].comparison.newPR).toBe(true);
    expect(summary.prs).toHaveLength(1);
  });

  it('makes no claim for an exercise with only its warm-up done', () => {
    const s1 = session('2026-10-20', [entry('bench_press_bb', [set(40, 10, null, { type: 'warmup' }), set(80, 8), set(80, 8)])]);
    const s2 = session('2026-10-22', [entry('bench_press_bb', [set(40, 10, null, { type: 'warmup' })], { cutShort: true })]);
    const summary = summarizeSession(s2, [s1, s2], ex);
    expect(summary.entries[0].comparison.trend).toBe('none');
    expect(summary.declined).toHaveLength(0);
  });

  it('lists no plan changes for a free workout, and an added exercise once', () => {
    const added = (id: string) => entry(id, [set(60, 8, 2, { added: true }), set(60, 8, 2, { added: true })], { added: true });
    const free = session('2026-10-22', [added('bench_press_bb'), added('row_bb')], { plannedSnapshot: null, plannedWorkoutId: null });
    expect(summarizeSession(free, [free], ex).changes).toEqual([]);
    const planned = session('2026-10-22', [entry('squat_back_bb', [set(100, 10)]), added('bench_press_bb')], { plannedWorkoutId: 'w' });
    expect(summarizeSession(planned, [planned], ex).changes.map((c) => c.kind)).toEqual(['added']);
  });

  it('lists a setup change made during the workout', () => {
    const plan: PlannedWorkout = {
      id: 'w',
      name: 'A',
      days: [],
      blocks: [
        {
          id: 'b',
          type: 'single',
          section: 'main',
          items: [{ id: 'pi1', exerciseId: 'leg_extension', setup: { seat: '4', grip: 'רחבה' }, sets: [{ id: 'ps', type: 'working' }] }],
        },
      ],
    };
    const s = session('2026-10-22', [entry('leg_extension', [set(40, 12)], { plannedExerciseId: 'pi1', setup: { seat: '6', grip: 'רחבה ' } })], {
      plannedSnapshot: plan,
      plannedWorkoutId: 'w',
    });
    const changes = summarizeSession(s, [s], ex).changes.filter((c) => c.kind === 'setup');
    expect(changes.map((c) => c.text)).toEqual([`${ex.get('leg_extension')!.nameHe}: כיסא/משענת 4 ← 6`]);
    // clearing every field of the planned setup is a change too
    const cleared = { ...s, entries: [entry('leg_extension', [set(40, 12)], { plannedExerciseId: 'pi1', setup: { seat: '', grip: '' } })] };
    expect(summarizeSession(cleared, [cleared], ex).changes.filter((c) => c.kind === 'setup')).toHaveLength(2);
    // a replacement exercise doesn't inherit the planned machine's setup as a "change"
    const swapped = { ...s, entries: [entry('leg_press', [set(100, 10)], { plannedExerciseId: 'pi1', swappedFromId: 'leg_extension', setup: {} })] };
    expect(summarizeSession(swapped, [swapped], ex).changes.filter((c) => c.kind === 'setup')).toEqual([]);
  });
});

describe('loaded timed sets (carries, weighted holds)', () => {
  const carry = (kg: number, s: number) => set(kg, null, null, { duration: s });
  const prev = [carry(24, 40), carry(24, 40), carry(24, 40)];

  it('counts a heavier carry for as long as progress', () => {
    const c = compare('farmer_carry', prev, [carry(32, 40), carry(32, 40), carry(32, 40)]);
    expect(c.trend).toBe('up');
    expect(c.label).toBe('+8 ק״ג');
  });

  it('does not count a much lighter carry held a little longer as progress', () => {
    const c = compare('farmer_carry', prev, [carry(16, 45), carry(16, 45), carry(16, 45)]);
    expect(c.trend).toBe('down');
    expect(c.label).toBe('-8 ק״ג');
  });

  it('counts a heavier carry held a little shorter as progress, not a decline', () => {
    expect(compare('farmer_carry', prev, [carry(32, 35), carry(32, 35), carry(32, 35)]).trend).toBe('up');
  });

  it('still compares unloaded holds on time, and makes no claim when load was added', () => {
    expect(compare('plank', [hold(60)], [hold(60)]).trend).toBe('same');
    expect(compare('plank', [hold(60)], [set(10, null, null, { duration: 45 })]).label).toBe('אין בסיס להשוואה');
  });
});

describe('missing-data alert', () => {
  const alerts = (sessions: Session[]) =>
    computeAlerts({ clients: [client()], sessions, programs: [], recs: [], notes: [], exercises: ex, today: '2026-10-24' }).filter((a) =>
      a.id.startsWith('missing-'),
    );

  it('does not flag unloaded sets of "other" gear such as the ab wheel', () => {
    const s = session('2026-10-23', [entry('ab_wheel', [bw(10), bw(10)]), entry('leg_curl_ball', [bw(12)]), entry('plank', [hold(30)])]);
    expect(alerts([s])).toHaveLength(0);
  });

  it('flags "other" gear once the plan or an earlier session had a weight', () => {
    const planned = session('2026-10-23', [entry('ab_wheel', [set(null, 10, null, { planned: { weight: 5, repsMin: 10 } })])]);
    expect(alerts([planned])[0]?.detail).toContain('סט אחד');
    const before = session('2026-10-20', [entry('ab_wheel', [set(5, 10, null, { planned: null })])]);
    const after = session('2026-10-23', [entry('ab_wheel', [set(null, 10, null, { planned: null })])]);
    expect(alerts([before, after])[0]?.detail).toContain('סט אחד');
  });

  it('does not flag earlier unloaded sets once the exercise is loaded in a LATER session', () => {
    const before = session('2026-10-18', [entry('ab_wheel', [bw(10), bw(10), bw(10)])]);
    const later = session('2026-10-24', [entry('ab_wheel', [set(5, 8, null, { planned: null })])]);
    expect(alerts([before])).toHaveLength(0);
    expect(alerts([before, later])).toHaveLength(0);
  });

  it('still flags loaded gear logged without weight', () => {
    const s = session('2026-10-23', [entry('bench_press_bb', [set(null, 8, null, { planned: null })])]);
    expect(alerts([s])).toHaveLength(1);
  });

  it('flags a timed set without weight only when the plan gave one', () => {
    const free = session('2026-10-23', [entry('bench_press_bb', [set(null, null, null, { duration: 40, planned: null })])]);
    expect(alerts([free])).toHaveLength(0);
    const planned = session('2026-10-23', [entry('bench_press_bb', [set(null, null, null, { duration: 40, planned: { weight: 20, duration: 40 } })])]);
    expect(alerts([planned])).toHaveLength(1);
  });
});

describe('Hebrew search', () => {
  it('finds singular names from dual plurals', () => {
    expect(matches('כתפיים', 'הרחקת כתף בכבל')).toBe(true);
    expect(matches('רגליים', 'קירוב רגל בשכיבה על הצד')).toBe(true);
    expect(matches('ירכיים', 'הרחקת ירך בכבל')).toBe(true);
  });

  it('does not create two-letter stems from short duals', () => {
    expect(matches('ידיים', 'יד')).toBe(false);
  });
});
