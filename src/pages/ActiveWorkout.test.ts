import { describe, expect, it } from 'vitest';
import { afterSetDone, editSet, fillOnDone, keptWithoutSets, newerPendingCopy, placeholders, swapEntry, timedByDefault } from './ActiveWorkout';
import { runRules } from '../domain/engine';
import { exerciseHistory, previousOccurrence } from '../domain/progress';
import { summarizeSession } from '../domain/summary';
import { client, entry, exerciseMap, session, set, settings } from '../domain/testkit';
import type { PerformedSet, Session, SessionEntry } from '../domain/types';

const planned = (weight: number | null) => ({ weight, repsMin: 8, repsMax: 12, rir: 2, rest: 90 });

/** an active workout from a plan: bench 3 × 8–12 @ 80 with set 1 done, then rows */
function activeBench(doneFirst = true): Session {
  return session(
    '2026-10-24',
    [
      entry(
        'bench_press_bb',
        [
          set(80, 10, 2, { planned: planned(80), plannedSetId: 'ps1', done: doneFirst, doneAt: doneFirst ? 1 : null }),
          set(80, null, null, { planned: planned(80), plannedSetId: 'ps2', done: false }),
          set(80, null, null, { planned: planned(80), plannedSetId: 'ps3', done: false }),
        ],
        { plannedExerciseId: 'slot-1', status: doneFirst ? 'done' : 'pending' },
      ),
      entry('row_cable_seated', [set(50, null, null, { done: false })], { status: 'pending' }),
    ],
    {
      status: 'active',
      endedAt: null,
      currentIndex: 0,
      plannedWorkoutId: 'w1',
      plannedSnapshot: {
        id: 'w1',
        name: 'A',
        days: [],
        blocks: [
          {
            id: 'b1',
            type: 'single',
            section: 'main',
            items: [
              {
                id: 'slot-1',
                exerciseId: 'bench_press_bb',
                setup: {},
                sets: ['ps1', 'ps2', 'ps3'].map((id) => ({ id, type: 'working' as const, weight: 80, repsMin: 8, repsMax: 12, rir: 2, rest: 90 })),
              },
            ],
          },
        ],
      },
    },
  );
}

describe('workout screen: swapping an exercise', () => {
  it('keeps done sets on the original exercise and moves the rest to a new entry without the old load', () => {
    const s = activeBench();
    const next = swapEntry(s, 0, 'chest_press_machine')!;
    expect(next.entries).toHaveLength(3);
    const [orig, repl, row] = next.entries;
    expect(orig.exerciseId).toBe('bench_press_bb');
    expect(orig.sets).toHaveLength(1);
    expect(orig.sets[0]).toMatchObject({ done: true, weight: 80, reps: 10 });
    expect(repl.exerciseId).toBe('chest_press_machine');
    expect(repl.swappedFromId).toBe('bench_press_bb');
    expect(repl.status).toBe('pending');
    expect(repl.sets).toHaveLength(2);
    // nothing of bench's 80 kg is left to be proposed / recorded for the new exercise
    expect(repl.sets.every((z) => !z.done && z.weight == null)).toBe(true);
    expect(row.exerciseId).toBe('row_cable_seated');
    expect(next.currentIndex).toBe(1);
    // the input session is not mutated
    expect(s.entries).toHaveLength(2);
    expect(s.entries[0].sets).toHaveLength(3);

    // after finishing: the bench set stays bench history; chest press has no 80 kg "evidence"
    const done: Session = { ...next, status: 'completed', endedAt: next.startedAt + 3600000 };
    expect(exerciseHistory([done], 'bench_press_bb')[0].entry.sets.filter((z) => z.done)).toHaveLength(1);
    const chest = previousOccurrence([done], 'chest_press_machine');
    expect(chest?.entry.sets.some((z) => z.weight === 80) ?? false).toBe(false);
  });

  it('swaps in place when nothing is done yet', () => {
    const s = activeBench(false);
    const next = swapEntry(s, 0, 'chest_press_machine')!;
    expect(next.entries).toHaveLength(2);
    expect(next.entries[0].exerciseId).toBe('chest_press_machine');
    expect(next.entries[0].swappedFromId).toBe('bench_press_bb');
    expect(next.entries[0].sets.every((z) => z.weight == null)).toBe(true);
    // swapping back restores the planned exercise and its planned load
    const back = swapEntry(next, 0, 'bench_press_bb')!;
    expect(back.entries[0].swappedFromId).toBeNull();
    expect(back.entries[0].sets.every((z) => z.weight === 80)).toBe(true);
  });

  it('returning to the planned exercise after sets were done brings its planned load back', () => {
    const swapped = swapEntry(activeBench(false), 0, 'chest_press_machine')!;
    swapped.entries[0].sets[0] = { ...swapped.entries[0].sets[0], weight: 40, reps: 10, done: true, doneAt: 1 };
    const next = swapEntry(swapped, 0, 'bench_press_bb')!;
    expect(next.entries[0]).toMatchObject({ exerciseId: 'chest_press_machine', swappedFromId: 'bench_press_bb' });
    expect(next.entries[1]).toMatchObject({ exerciseId: 'bench_press_bb', swappedFromId: null });
    expect(next.entries[1].sets.map((z) => z.weight)).toEqual([80, 80]);
  });

  it('going back to an earlier replacement (not the planned exercise) never brings the planned load with it', () => {
    const s1 = swapEntry(activeBench(false), 0, 'chest_press_machine')!;
    s1.entries[0].sets[0] = { ...s1.entries[0].sets[0], weight: 40, reps: 10, done: true, doneAt: 1 };
    const s2 = swapEntry(s1, 0, 'push_up')!; // push-ups take over the chest press's remaining sets
    expect(s2.entries[1]).toMatchObject({ exerciseId: 'push_up', swappedFromId: 'chest_press_machine' });
    const s3 = swapEntry(s2, 1, 'chest_press_machine')!; // back to the chest press before any push-up
    expect(s3.entries[1]).toMatchObject({ exerciseId: 'chest_press_machine', swappedFromId: 'bench_press_bb' });
    expect(s3.entries[1].sets.map((z) => z.weight ?? null)).toEqual([null, null]);
    expect(s3.entries[1].sets.map((z) => z.planned?.weight ?? null)).toEqual([null, null]);
  });

  it('gives the replacement a fresh set when every set was already done', () => {
    const s = activeBench();
    for (const z of s.entries[0].sets) Object.assign(z, { done: true, reps: 10 });
    const next = swapEntry(s, 0, 'chest_press_machine')!;
    expect(next.entries[0].sets).toHaveLength(3);
    expect(next.entries[1].sets).toHaveLength(1);
    expect(next.entries[1].sets[0]).toMatchObject({ done: false, weight: null, added: true });
  });

  it('does nothing when the same exercise is picked', () => {
    expect(swapEntry(activeBench(), 0, 'bench_press_bb')).toBeNull();
  });

  it('the replacement has no planned load of the old exercise: no target, no "changed from plan" in the summary', () => {
    // swapped before any set (in place) …
    const inPlace = swapEntry(activeBench(false), 0, 'chest_press_machine')!;
    for (const z of inPlace.entries[0].sets) {
      expect(z.planned?.weight ?? null).toBeNull();
      // reps / RIR / rest targets still apply to the replacement
      expect(z.planned).toMatchObject({ repsMin: 8, repsMax: 12, rir: 2, rest: 90 });
    }
    // … and after some (the moved sets)
    const moved = swapEntry(activeBench(), 0, 'chest_press_machine')!;
    expect(moved.entries[1].sets.map((z) => z.planned?.weight ?? null)).toEqual([null, null]);
    expect(moved.entries[0].sets[0].planned?.weight).toBe(80);
    // the plan itself is untouched
    expect(moved.plannedSnapshot?.blocks[0].items[0].sets.every((x) => x.weight === 80)).toBe(true);

    for (const z of inPlace.entries[0].sets) Object.assign(z, { weight: 40, reps: 10, done: true, doneAt: 1 });
    const done: Session = { ...inPlace, status: 'completed', endedAt: inPlace.startedAt + 3600000 };
    const changes = summarizeSession(done, [done], exerciseMap()).changes;
    expect(changes.some((c) => c.kind === 'swapped')).toBe(true);
    expect(changes.some((c) => c.kind === 'weight')).toBe(false);
  });
});

describe('workout screen: editing an auto-filled set', () => {
  const autoSets = () => [1, 2, 3].map(() => set(60, 12, null, { autoFilled: true }));

  it('a weight-only correction keeps reps taken from the target out of the evidence', () => {
    const e = entry('bench_press_db', autoSets());
    for (const z of e.sets) editSet(z, { weight: 62 });
    expect(e.sets.every((z) => z.weight === 62 && z.autoFilled)).toBe(true);
    const s = session('2026-10-22', [e]);
    const recs = runRules({ client: client(), sessions: [s], exercises: exerciseMap(), settings: settings(), today: '2026-10-23', sessionId: s.id });
    expect(recs.map((r) => r.type)).not.toContain('increaseWeight');
  });

  it('typed reps / duration make the set real data again', () => {
    const a = set(60, 12, null, { autoFilled: true });
    editSet(a, { rir: 1 });
    expect(a.autoFilled).toBe(true);
    editSet(a, { reps: 11 });
    expect(a.autoFilled).toBe(false);
    const b = set(null, null, null, { autoFilled: true });
    editSet(b, { duration: 45 });
    expect(b.autoFilled).toBe(false);
  });
});

describe('workout screen: copy kept on hide / before a reload', () => {
  const dbRow = () => activeBench();

  it('wins only when it is newer than the database row', () => {
    const row = dbRow();
    const local = { ...row, updatedAt: row.updatedAt + 1000, currentIndex: 1 };
    expect(newerPendingCopy(row, JSON.stringify(local))?.currentIndex).toBe(1);
    expect(newerPendingCopy(row, JSON.stringify({ ...local, updatedAt: row.updatedAt }))).toBeNull();
    expect(newerPendingCopy(row, JSON.stringify({ ...local, updatedAt: row.updatedAt - 1 }))).toBeNull();
  });

  it('never revives a finished / discarded workout or another session', () => {
    const row = dbRow();
    const local = { ...row, updatedAt: row.updatedAt + 1000 };
    expect(newerPendingCopy({ ...row, status: 'completed' }, JSON.stringify(local))).toBeNull();
    expect(newerPendingCopy(row, JSON.stringify({ ...local, status: 'completed' }))).toBeNull();
    expect(newerPendingCopy(row, JSON.stringify({ ...local, deletedAt: 5 }))).toBeNull();
    expect(newerPendingCopy(row, JSON.stringify({ ...local, id: 'other' }))).toBeNull();
  });

  it('ignores a missing or broken copy', () => {
    const row = dbRow();
    expect(newerPendingCopy(row, null)).toBeNull();
    expect(newerPendingCopy(row, '{not json')).toBeNull();
    expect(newerPendingCopy(row, JSON.stringify({ id: row.id, status: 'active', updatedAt: row.updatedAt + 1 }))).toBeNull();
  });
});

describe('workout screen: finishing without any set marked done', () => {
  const noSets = (patch: Partial<SessionEntry> = {}, sp: Partial<Session> = {}) =>
    session(
      '2026-10-24',
      [entry('bench_press_db', [1, 2, 3].map(() => set(20, null, null, { done: false })), { status: 'pending', technique: 'na', ...patch })],
      { status: 'active', endedAt: null, ...sp },
    );

  it('nothing recorded → nothing to keep (discard / back only)', () => {
    expect(keptWithoutSets(noSets())).toEqual([]);
    expect(keptWithoutSets(noSets({ notes: '   ' }))).toEqual([]);
  });

  it('a pain report, technique, notes or readiness can be saved instead of only discarded', () => {
    expect(keptWithoutSets(noSets({ pain: { reported: true, location: 'כתף', severity: 7 } }))).toEqual(['דיווח כאב']);
    expect(keptWithoutSets(noSets({ technique: 'poor' }))).toEqual(['הערכת טכניקה']);
    expect(keptWithoutSets(noSets({ notes: 'כאב בכתף בחימום' }))).toEqual(['הערות']);
    expect(keptWithoutSets(noSets({}, { readiness: { energy: 2 } }))).toEqual(['תחושה ומוכנות']);
  });

  it('the saved pain report reaches the engine: a pain check, never a load increase', () => {
    const before = session('2026-10-20', [entry('bench_press_db', [1, 2, 3].map(() => set(20, 10, 2)))]);
    const today = noSets({ pain: { reported: true, location: 'כתף', severity: 7 } });
    // what completeSession stores for it: entries without a done set become "not done"
    const saved: Session = {
      ...today,
      status: 'completed',
      endedAt: today.startedAt + 600000,
      entries: today.entries.map((e) => ({ ...e, status: e.sets.some((z) => z.done) ? 'done' : 'notdone' })),
    };
    const input = { client: client(), sessions: [before, saved], exercises: exerciseMap(), settings: settings(), today: '2026-10-24', sessionId: saved.id };
    const types = runRules(input).map((r) => r.type);
    expect(types).toContain('painCheck');
    expect(types).not.toContain('increaseWeight');
  });
});

describe('workout screen: timed holds', () => {
  const plank = (sets: PerformedSet[]) => entry('plank', sets, { status: 'pending' });
  const hold = (secs: number, opts: Partial<PerformedSet> = {}) =>
    set(null, null, null, { planned: { duration: secs, rest: 60 }, duration: null, done: false, ...opts });
  const extra = () => set(null, null, null, { planned: null, done: false, added: true });

  it('a set added to a planned hold, and a hold added mid-workout that was timed last time, default to seconds', () => {
    expect(timedByDefault(plank([hold(30), extra()]), null)).toBe(true);
    const added = plank([extra(), extra(), extra()]);
    expect(timedByDefault(added, null)).toBe(false);
    expect(timedByDefault(added, plank([set(null, null, null, { duration: 40 })]))).toBe(true);
    expect(timedByDefault(entry('bench_press_db', [set(20, null, null, { done: false })]), null)).toBe(false);
  });

  it('✓ on an extra hold records seconds (last hold / last time), flagged as not typed — never reps', () => {
    const e = plank([hold(30, { duration: 35, done: true }), extra()]);
    const ph = placeholders(e, 1, null);
    expect(ph.duration).toBe(35);
    const z = e.sets[1];
    fillOnDone(z, ph, true);
    expect(z).toMatchObject({ duration: 35, reps: null, autoFilled: true });
    // from last time when nothing in this workout says it
    expect(placeholders(plank([extra()]), 0, plank([set(null, null, null, { duration: 45 })])).duration).toBe(45);
  });

  it('the planned hold time is taken as is; reps mode still fills reps', () => {
    const z = hold(30);
    fillOnDone(z, placeholders(plank([z]), 0, null), true);
    expect(z.duration).toBe(30);
    expect(z.autoFilled).toBeFalsy();
    const r = set(20, null, null, { done: false });
    fillOnDone(r, { weight: 20, reps: 12, duration: null }, false);
    expect(r).toMatchObject({ reps: 12, autoFilled: true });
    expect(r.duration ?? null).toBeNull();
  });

  it('a typed value is never overwritten', () => {
    const z = set(null, null, null, { planned: null, done: false, duration: 50 });
    fillOnDone(z, { weight: null, reps: 10, duration: 30 }, true);
    expect(z).toMatchObject({ duration: 50, reps: null });
    expect(z.autoFilled).toBeFalsy();
  });
});

describe('workout screen: flow and rest after a set', () => {
  const w = (rest: number | null, opts: Partial<PerformedSet> = {}) =>
    set(20, null, null, { planned: { weight: 20, repsMin: 8, repsMax: 12, rest }, done: false, ...opts });
  /** marks the first undone set of the current entry done, like the ✓ on the screen */
  const tick = (s: Session) => {
    const i = s.currentIndex ?? 0;
    const e = s.entries[i];
    const k = e.sets.findIndex((z) => !z.done);
    Object.assign(e.sets[k], { done: true, doneAt: 1 });
    e.status = 'done';
    const rest = afterSetDone(s, i, k, 120);
    return `${e.exerciseId}:${e.sets[k].type}:${rest}`;
  };
  const active = (entries: SessionEntry[], patch: Partial<Session> = {}) =>
    session('2026-10-24', entries, { status: 'active', endedAt: null, currentIndex: 0, ...patch });

  it('a drop set follows at once; the rest after it is that of the set it drops from', () => {
    // the editor's drop-set preset: working sets rest 90, the drop rest 0
    const s = active([entry('curl_db', [w(90), w(90), w(0, { type: 'drop' })], { status: 'pending' })]);
    expect([tick(s), tick(s), tick(s)]).toEqual(['curl_db:working:90', 'curl_db:working:0', 'curl_db:drop:90']);
    // a rest planned on the drop itself is kept, not cut to 15 s
    const t = active([entry('curl_db', [w(90), w(150, { type: 'drop' })], { status: 'pending' })]);
    expect([tick(t), tick(t)]).toEqual(['curl_db:working:0', 'curl_db:drop:150']);
  });

  it('a superset pairs work sets: a warm-up stays on its exercise with its own rest and is not a round', () => {
    const block = { blockId: 'A', blockType: 'superset' as const, status: 'pending' as const };
    const s = active(
      [
        entry('bench_press_db', [w(60, { type: 'warmup' }), w(90), w(90), w(90)], block),
        entry('row_cable_seated', [w(90), w(90), w(90)], block),
        entry('curl_db', [w(60)], { status: 'pending' }),
      ],
      { plannedSnapshot: { id: 'w', name: 'A', days: [], blocks: [{ id: 'A', type: 'superset', section: 'main', restAfter: 150, items: [] }] } },
    );
    expect(Array.from({ length: 8 }, () => tick(s))).toEqual([
      'bench_press_db:warmup:60',
      'bench_press_db:working:0',
      'row_cable_seated:working:150',
      'bench_press_db:working:0',
      'row_cable_seated:working:150',
      'bench_press_db:working:0',
      'row_cable_seated:working:150',
      'curl_db:working:60',
    ]);
  });
});
