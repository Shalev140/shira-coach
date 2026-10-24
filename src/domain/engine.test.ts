import { describe, expect, it } from 'vitest';
import { blockedIncreaseRecs, incrementFor, runRules, staleProgressionRecs, supersedesProgression } from './engine';
import { client, entry, exerciseMap, session, set, settings } from './testkit';
import type { PerformedSet, Recommendation, Session } from './types';

const ex = exerciseMap();
const run = (sessions: Session[], sessionId?: string, today = '2026-10-23') =>
  runRules({ client: client(), sessions, exercises: ex, settings: settings(), today, sessionId: sessionId ?? sessions[sessions.length - 1].id });
const types = (drafts: ReturnType<typeof run>) => drafts.map((d) => d.type);

describe('recommendation engine', () => {
  it('suggests a weight increase when every set hit the top of the range with good technique', () => {
    const s = session('2026-10-22', [entry('bench_press_db', [set(20, 12, 2), set(20, 12, 2), set(20, 12, 1)])]);
    const recs = run([s]);
    const inc = recs.find((r) => r.type === 'increaseWeight');
    expect(inc).toBeTruthy();
    expect(inc!.suggestion.weight).toBe(22); // +2 kg dumbbell increment
    expect(inc!.evidence.length).toBeGreaterThan(0);
    expect(inc!.reasoning).toContain('2');
  });

  it('never suggests a load increase when pain was reported — it raises a pain check instead', () => {
    const s = session('2026-10-22', [
      entry('bench_press_db', [set(20, 12), set(20, 12), set(20, 12)], { pain: { reported: true, location: 'כתף' } }),
    ]);
    const t = types(run([s]));
    expect(t).not.toContain('increaseWeight');
    expect(t).toContain('painCheck');
  });

  it('blocks a load increase when technique is poor or needs fixing', () => {
    for (const technique of ['poor', 'fix'] as const) {
      const s = session('2026-10-22', [entry('bench_press_db', [set(20, 12), set(20, 12), set(20, 12)], { technique })]);
      expect(types(run([s]))).not.toContain('increaseWeight');
    }
    const poor = session('2026-10-22', [entry('bench_press_db', [set(20, 12), set(20, 12), set(20, 12)], { technique: 'poor' })]);
    expect(types(run([poor]))).toContain('techniqueCheck');
  });

  it('does not suggest an increase when the range was not completed', () => {
    const s = session('2026-10-22', [entry('bench_press_db', [set(20, 12), set(20, 10), set(20, 9)])]);
    expect(types(run([s]))).not.toContain('increaseWeight');
  });

  it('suggests adding reps when there is clearly room left (RIR well above target)', () => {
    const s = session('2026-10-22', [entry('bench_press_db', [set(20, 9, 4), set(20, 9, 4), set(20, 9, 5)])]);
    expect(types(run([s]))).toContain('addReps');
  });

  it('does not draw a big conclusion from a single bad session', () => {
    const one = session('2026-10-22', [entry('bench_press_db', [set(24, 5, 0), set(24, 5, 0), set(24, 4, 0)])]);
    expect(types(run([one]))).not.toContain('reduceLoad');
    const before = session('2026-10-19', [entry('bench_press_db', [set(24, 6, 0), set(24, 5, 0), set(24, 5, 0)])]);
    expect(types(run([before, one]))).toContain('reduceLoad');
  });

  it('suggests a swap after pain in two of the last three sessions', () => {
    const p = { reported: true, location: 'ברך' };
    const a = session('2026-10-15', [entry('lunge_db', [set(10, 10)], { pain: p })]);
    const b = session('2026-10-18', [entry('lunge_db', [set(10, 10)])]);
    const c = session('2026-10-22', [entry('lunge_db', [set(10, 10)], { pain: p })]);
    const swap = run([a, b, c]).find((r) => r.type === 'swapExercise');
    expect(swap).toBeTruthy();
    expect(swap!.suggestion.alternativeIds!.length).toBeGreaterThan(0);
  });

  it('detects a plateau over the configured number of weeks', () => {
    const dates = ['2026-09-01', '2026-09-08', '2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19'];
    const sessions = dates.map((d) => session(d, [entry('bench_press_bb', [set(80, 6, 2), set(80, 6, 2), set(80, 5, 2)])]));
    expect(types(run(sessions))).toContain('swapExercise');
  });

  it('withdraws a pending increase once pain appears in a later session', () => {
    const earlier = session('2026-10-19', [entry('bench_press_db', [set(20, 12)])]);
    const later = session('2026-10-22', [entry('bench_press_db', [set(20, 10)], { pain: { reported: true } })]);
    const pending = { id: 'r', type: 'increaseWeight', status: 'pending', exerciseId: 'bench_press_db', sourceSessionId: earlier.id } as Recommendation;
    const byId = new Map([earlier, later].map((x) => [x.id, x]));
    expect(blockedIncreaseRecs([pending], later, byId)).toHaveLength(1);
  });

  it('blocks the increase per exercise, even when the exercise appears twice in one session', () => {
    const s = session('2026-10-22', [
      entry('bench_press_db', [set(20, 12), set(20, 12), set(20, 12)]),
      entry('bench_press_db', [set(20, 12), set(20, 12)], { pain: { reported: true } }),
    ]);
    expect(types(run([s]))).not.toContain('increaseWeight');
  });

  it('keeps blocking load increases while a pain / technique check is still pending', () => {
    const s = session('2026-10-22', [entry('bench_press_db', [set(20, 12), set(20, 12), set(20, 12)])]);
    const pendingPain = { id: 'p', type: 'painCheck', status: 'pending', exerciseId: 'bench_press_db' } as Recommendation;
    const recs = runRules({ client: client(), sessions: [s], exercises: ex, settings: settings(), today: '2026-10-23', sessionId: s.id, existing: [pendingPain] });
    expect(recs.map((r) => r.type)).not.toContain('increaseWeight');
    const resolved = { ...pendingPain, status: 'approved' } as Recommendation;
    const again = runRules({ client: client(), sessions: [s], exercises: ex, settings: settings(), today: '2026-10-23', sessionId: s.id, existing: [resolved] });
    expect(again.map((r) => r.type)).toContain('increaseWeight');
  });

  it('does not treat reps recorded only by tapping ✓ (taken from the target) as evidence', () => {
    const auto = { autoFilled: true };
    const s = session('2026-10-22', [entry('bench_press_db', [set(20, 12, 2, auto), set(20, 12, 2, auto), set(20, 12, 2, auto)])]);
    expect(types(run([s]))).not.toContain('increaseWeight');
  });

  it('carries the planned slot so an approved change lands on the right program item', () => {
    const s = session('2026-10-22', [entry('bench_press_db', [set(20, 12), set(20, 12), set(20, 12)], { plannedExerciseId: 'slot-1' })]);
    expect(run([s]).find((r) => r.type === 'increaseWeight')?.suggestion.plannedExerciseId).toBe('slot-1');
  });

  it('supersedes only recommendations that came from OLDER sessions, and only after real working sets', () => {
    const older = session('2026-10-15', [entry('bench_press_db', [set(20, 12)])]);
    const newer = session('2026-10-22', [entry('bench_press_db', [set(20, 10)])]);
    const skipped = session('2026-10-23', [entry('bench_press_db', [set(20, null, null, { done: false })], { status: 'skipped' })]);
    const byId = new Map([older, newer, skipped].map((x) => [x.id, x]));
    const fromNewer = { id: 'r1', type: 'increaseWeight', status: 'pending', exerciseId: 'bench_press_db', sourceSessionId: newer.id } as Recommendation;
    expect(staleProgressionRecs([fromNewer], older, byId)).toHaveLength(0); // re-checking an old session can't kill newer advice
    expect(staleProgressionRecs([fromNewer], skipped, byId)).toHaveLength(0); // a skipped entry is not a re-evaluation
    const fromOlder = { ...fromNewer, id: 'r2', sourceSessionId: older.id } as Recommendation;
    expect(staleProgressionRecs([fromOlder], newer, byId)).toHaveLength(1);
  });

  it('flags consistent decline across several exercises as a recovery check', () => {
    const mk = (d: string, w: number) => session(d, [entry('squat_back_bb', [set(w, 8), set(w, 8)]), entry('row_bb', [set(w - 20, 8), set(w - 20, 8)])]);
    const recs = run([mk('2026-10-10', 100), mk('2026-10-15', 92), mk('2026-10-20', 85)]);
    expect(recs.find((r) => r.type === 'recoveryCheck')?.severity).toBe('warn');
  });
});

/* ------------------------------------------------------------ regressions */

// turns drafts into pending rows, the way runEngine stores them
const asPending = (drafts: ReturnType<typeof run>) =>
  drafts.map((d, i) => ({ ...d, id: `r${i}-${d.dedupeKey}`, createdAt: 1, updatedAt: 1, status: 'pending' }) as Recommendation);
const top3 = () => [set(20, 12), set(20, 12), set(20, 12)];

describe('engine regressions', () => {
  it('pain / poor technique on an entry with no completed working sets still raises a check that blocks the next increase', () => {
    const pain = { reported: true, location: 'כתף', severity: 6 };
    const cases = [
      // skipped
      entry('bench_press_db', [set(20, null, null, { done: false }), set(20, null, null, { done: false })], { status: 'skipped', pain }),
      // stopped after the warm-up set
      entry('bench_press_db', [set(10, 10, null, { type: 'warmup' }), set(20, null, null, { done: false })], { status: 'notdone', pain }),
      // warm-up section, warm-up sets only
      entry('bench_press_db', [set(10, 10, null, { type: 'warmup' })], { section: 'warmup', pain }),
    ];
    for (const e of cases) {
      const s1 = session('2026-10-19', [e]);
      const first = run([s1]);
      expect(types(first)).toContain('painCheck');
      const s2 = session('2026-10-22', [entry('bench_press_db', top3())]);
      const next = runRules({ client: client(), sessions: [s1, s2], exercises: ex, settings: settings(), today: '2026-10-23', sessionId: s2.id, existing: asPending(first) });
      expect(types(next)).not.toContain('increaseWeight');
    }
    const poor = session('2026-10-19', [entry('bench_press_db', [set(20, null, null, { done: false })], { status: 'skipped', technique: 'poor' })]);
    expect(types(run([poor]))).toContain('techniqueCheck');
  });

  it('pain on a swapped entry also checks and blocks the original exercise', () => {
    const s0 = session('2026-10-15', [entry('bench_press_db', top3())]);
    const s1 = session('2026-10-19', [
      entry('chest_press_machine', [set(40, 10), set(40, 10)], { swappedFromId: 'bench_press_db', pain: { reported: true, location: 'כתף' } }),
    ]);
    const first = run([s0, s1]);
    const checks = first.filter((r) => r.type === 'painCheck').map((r) => r.exerciseId);
    expect(checks).toEqual(expect.arrayContaining(['chest_press_machine', 'bench_press_db']));
    // the older pending bench increase is withdrawn
    const byId = new Map([s0, s1].map((x) => [x.id, x]));
    const benchInc = asPending(run([s0])).filter((r) => r.type === 'increaseWeight');
    expect(benchInc).toHaveLength(1);
    expect(blockedIncreaseRecs(benchInc, s1, byId)).toHaveLength(1);
    // and bench gets no increase next time while its check is pending
    const s2 = session('2026-10-22', [entry('bench_press_db', top3())]);
    const next = runRules({ client: client(), sessions: [s0, s1, s2], exercises: ex, settings: settings(), today: '2026-10-23', sessionId: s2.id, existing: asPending(first) });
    expect(types(next)).not.toContain('increaseWeight');
  });

  it('re-checking an OLDER session gives no progression advice once a newer workout trained the exercise — safety still fires', () => {
    const s1 = session('2026-10-15', [entry('bench_press_db', top3())]);
    const s2 = session('2026-10-19', [entry('bench_press_db', top3(), { technique: 'fix' })]);
    expect(types(run([s1, s2], s1.id))).not.toContain('increaseWeight');
    // a skipped newer occurrence is not a re-evaluation
    const skipped = session('2026-10-19', [entry('bench_press_db', [set(20, null, null, { done: false })], { status: 'skipped' })]);
    expect(types(run([s1, skipped], s1.id))).toContain('increaseWeight');
    // pain in the old session still raises its check
    const painful = session('2026-10-15', [entry('bench_press_db', top3(), { pain: { reported: true } })]);
    expect(types(run([painful, s2], painful.id))).toContain('painCheck');
  });

  it('the same exercise twice in one session is one workout: no double jump, own evidence, no reduceLoad from a single session', () => {
    const range = { planned: { weight: 20, repsMin: 8, repsMax: 12, rir: 2, rest: 90 } };
    const s = session('2026-10-22', [
      entry('bench_press_db', [set(20, 15, 2, range), set(20, 15, 2, range), set(20, 15, 2, range)]),
      entry('bench_press_db', [set(14, 10), set(14, 10)]),
    ]);
    const inc = run([s]).find((r) => r.type === 'increaseWeight')!;
    expect(inc.suggestion.weight).toBe(22);
    expect(inc.evidence[0].value).toContain('20×15');
    expect(inc.evidence[0].value).not.toContain('14×');
    const low = session('2026-10-22', [entry('bench_press_db', [set(24, 5), set(24, 5)]), entry('bench_press_db', [set(20, 6), set(20, 6)])]);
    expect(types(run([low]))).not.toContain('reduceLoad');
  });

  it('auto-filled (✓-only) sets in a newer session do not supersede older advice', () => {
    const older = session('2026-10-15', [entry('bench_press_db', top3())]);
    const auto = { autoFilled: true };
    const allAuto = session('2026-10-22', [entry('bench_press_db', [set(20, 12, 2, auto), set(20, 12, 2, auto)])]);
    const mixed = session('2026-10-22', [entry('bench_press_db', [set(20, 12), set(20, 12, 2, auto)])]);
    const real = session('2026-10-22', [entry('bench_press_db', [set(20, 12), set(20, 12)])]);
    const byId = new Map([older, allAuto, mixed, real].map((x) => [x.id, x]));
    const pending = asPending(run([older])).filter((r) => r.type === 'increaseWeight');
    expect(staleProgressionRecs(pending, allAuto, byId)).toHaveLength(0);
    expect(staleProgressionRecs(pending, mixed, byId)).toHaveLength(0);
    expect(staleProgressionRecs(pending, real, byId)).toHaveLength(1);
  });

  it('variation and add-reps advice is superseded by a newer evaluation and withdrawn after pain; goal-range advice is not', () => {
    const bw = () => [set(null, 12), set(null, 12), set(null, 12)];
    const s1 = session('2026-10-12', [entry('push_up', bw())]);
    const s2 = session('2026-10-15', [entry('push_up', bw())]);
    const s3 = session('2026-10-19', [entry('push_up', [set(null, null, null, { done: false })], { status: 'skipped', pain: { reported: true } })]);
    const byId = new Map([s1, s2, s3].map((x) => [x.id, x]));
    const variation = asPending(run([s1])).filter((r) => r.type === 'adjustRange');
    expect(variation).toHaveLength(1);
    expect(staleProgressionRecs(variation, s2, byId)).toHaveLength(1); // no second identical pending variation rec
    expect(blockedIncreaseRecs(variation, s3, byId)).toHaveLength(1);
    const goal = { ...variation[0], id: 'g', dedupeKey: 'adjustRange|c1|push_up|goal|p1|strength' } as Recommendation;
    expect(staleProgressionRecs([goal], s2, byId)).toHaveLength(0);
    expect(blockedIncreaseRecs([goal], s3, byId)).toHaveLength(0);

    const b1 = session('2026-10-15', [entry('bench_press_db', [set(20, 9, 4), set(20, 9, 4), set(20, 9, 5)])]);
    const b2 = session('2026-10-19', [entry('bench_press_db', [set(20, null, null, { done: false })], { status: 'skipped', pain: { reported: true } })]);
    const addReps = asPending(run([b1])).filter((r) => r.type === 'addReps');
    expect(addReps).toHaveLength(1);
    expect(blockedIncreaseRecs(addReps, b2, new Map([b1, b2].map((x) => [x.id, x])))).toHaveLength(1);
  });

  it('reduceLoad always suggests a strictly lower weight, also for light machine / dumbbell / kettlebell loads', () => {
    const below = (id: string, w: number) => {
      const a = session('2026-10-19', [entry(id, [set(w, 6, 0), set(w, 5, 0), set(w, 5, 0)])]);
      const b = session('2026-10-22', [entry(id, [set(w, 6, 0), set(w, 5, 0), set(w, 5, 0)])]);
      return run([a, b]).find((r) => r.type === 'reduceLoad')!.suggestion;
    };
    expect(below('chest_press_machine', 15).weight).toBe(12.5);
    expect(below('chest_press_machine', 10).weight).toBe(7.5);
    expect(below('chest_press_machine', 50).weight).toBe(45);
    expect(below('bench_press_db', 6).weight).toBe(5);
    expect(below('bench_press_db', 20).weight).toBe(18);
    expect(below('kb_swing', 8).weight).toBe(6);
    expect(below('bench_press_db', 1).kind).toBe('none');
  });

  it('does not re-suggest a pain swap while the same swap is still pending', () => {
    const p = { reported: true, location: 'ברך' };
    const a = session('2026-10-15', [entry('lunge_db', [set(10, 10)], { pain: p })]);
    const b = session('2026-10-18', [entry('lunge_db', [set(10, 10)], { pain: p })]);
    const c = session('2026-10-22', [entry('lunge_db', [set(10, 10)], { pain: p })]);
    const swapB = asPending(run([a, b])).filter((r) => r.type === 'swapExercise');
    expect(swapB).toHaveLength(1);
    const withPending = runRules({ client: client(), sessions: [a, b, c], exercises: ex, settings: settings(), today: '2026-10-23', sessionId: c.id, existing: swapB });
    expect(types(withPending)).not.toContain('swapExercise');
    expect(types(withPending)).toContain('painCheck');
    const rejected = swapB.map((r) => ({ ...r, status: 'rejected' }) as Recommendation);
    const afterReject = runRules({ client: client(), sessions: [a, b, c], exercises: ex, settings: settings(), today: '2026-10-23', sessionId: c.id, existing: rejected });
    expect(types(afterReject)).toContain('swapExercise');
  });
  it('an exercise stopped early and swapped out mid-workout is not "fully completed" evidence', () => {
    const s = session('2026-10-22', [entry('bench_press_db', [set(20, 12)], { cutShort: true })]);
    expect(types(run([s]))).not.toContain('increaseWeight');
  });
});

/* --------------------------------------------------- engine review fixes (round 2) */

describe('engine review fixes', () => {
  const auto = { autoFilled: true };
  const notDone = (w: number | null = 20) => set(w, null, null, { done: false });

  it('C2: only real working sets or a safety flag count as a later re-evaluation', () => {
    expect(supersedesProgression(entry('bench_press_db', top3()))).toBe(true);
    expect(supersedesProgression(entry('bench_press_db', [set(20, 12, 2, auto), set(20, 12, 2, auto)]))).toBe(false);
    expect(supersedesProgression(entry('bench_press_db', [notDone()], { status: 'skipped' }))).toBe(false);
    expect(supersedesProgression(entry('bench_press_db', [notDone()], { status: 'notdone', pain: { reported: true } }))).toBe(true);
    expect(supersedesProgression(entry('bench_press_db', [set(20, 12, 2, auto)], { technique: 'fix' }))).toBe(true);
  });

  it('#2: a later ✓-only workout does not stop an older session from being re-evaluated after a correction', () => {
    const later = session('2026-10-22', [entry('bench_press_db', [set(20, 12, 2, auto), set(20, 12, 2, auto), set(20, 12, 2, auto)])]);
    // set 3 corrected to 9 reps → re-evaluated: no increase any more (the repo then withdraws the old one)
    const corrected = session('2026-10-19', [entry('bench_press_db', [set(20, 12), set(20, 12), set(20, 9)])]);
    expect(types(run([corrected, later], corrected.id))).not.toContain('increaseWeight');
    // still supported → the advice is produced again (and refreshed in place)
    const ok = session('2026-10-19', [entry('bench_press_db', top3())]);
    expect(types(run([ok, later], ok.id))).toContain('increaseWeight');
    // a later pain report does count as newer: no progression advice from the older session
    const painful = session('2026-10-22', [entry('bench_press_db', [notDone()], { status: 'notdone', pain: { reported: true } })]);
    expect(types(run([ok, painful], ok.id))).not.toContain('increaseWeight');
  });

  it('#8: "needs fixing" technique leaves an open check that blocks the next increase', () => {
    const s1 = session('2026-10-19', [entry('bench_press_db', top3(), { technique: 'fix' })]);
    const first = run([s1]);
    expect(types(first)).not.toContain('increaseWeight');
    expect(first.find((r) => r.type === 'techniqueCheck')?.exerciseId).toBe('bench_press_db');
    // next workout: technique left at "not recorded" — still blocked while the check is open
    const s2 = session('2026-10-22', [entry('bench_press_db', top3(), { technique: 'na' })]);
    const next = runRules({ client: client(), sessions: [s1, s2], exercises: ex, settings: settings(), today: '2026-10-23', sessionId: s2.id, existing: asPending(first) });
    expect(types(next)).not.toContain('increaseWeight');
    // a swapped entry checks the original exercise too
    const sw = session('2026-10-19', [entry('chest_press_machine', [set(40, 10), set(40, 10)], { swappedFromId: 'bench_press_db', technique: 'fix' })]);
    const checks = run([sw]).filter((r) => r.type === 'techniqueCheck').map((r) => r.exerciseId);
    expect(checks).toEqual(expect.arrayContaining(['chest_press_machine', 'bench_press_db']));
  });

  it('#9: in RPE mode the effort gate still applies (RPE 10 = nothing in reserve)', () => {
    const rpe = (r: number, reps = 12, extra = {}) => set(20, reps, null, { rpe: r, ...extra });
    expect(types(run([session('2026-10-22', [entry('bench_press_db', [rpe(10), rpe(10), rpe(10)])])]))).not.toContain('increaseWeight');
    const inc = run([session('2026-10-22', [entry('bench_press_db', [rpe(8), rpe(8), rpe(8)])])]).find((r) => r.type === 'increaseWeight');
    expect(inc?.detected).toContain('RPE ממוצע 8');
    expect(inc?.reasoning).not.toContain('לא תועד');
    // low RPE inside the range → room for more reps
    expect(types(run([session('2026-10-22', [entry('bench_press_db', [rpe(6, 9), rpe(6, 9), rpe(6, 9)])])]))).toContain('addReps');
    // a planned RPE is a target too
    const plannedRpe = { planned: { weight: 20, repsMin: 8, repsMax: 12, rir: null, rpe: 7, rest: 90 } };
    const over = session('2026-10-22', [entry('bench_press_db', [rpe(10, 12, plannedRpe), rpe(10, 12, plannedRpe), rpe(10, 12, plannedRpe)])]);
    expect(types(run([over]))).not.toContain('increaseWeight');
  });

  it('#10: recovery and adherence advice is keyed by its evidence, so re-checks in later weeks add nothing', () => {
    const tired = { energy: 2, sleep: 2, fatigue: 4 };
    const missed = () => [entry('bench_press_db', [set(20, 10), notDone(), notDone(), notDone()])];
    const ss = ['2026-10-19', '2026-10-21', '2026-10-23'].map((d) => session(d, missed(), { readiness: tired }));
    const keys = (today: string, existing: Recommendation[] = []) =>
      runRules({ client: client(), sessions: ss, exercises: ex, settings: settings(), today, existing })
        .filter((r) => r.type === 'recoveryCheck' || r.type === 'adherence')
        .map((r) => r.dedupeKey)
        .sort();
    const first = keys('2026-10-23');
    expect(first).toEqual([`adherence|c1|${ss[2].id}`, `recoveryCheck|c1|readiness|${ss[2].id}`]);
    expect(keys('2026-10-25')).toEqual(first); // next week, no new workout → the same keys (nothing new; a rejected one stays rejected)
    expect(keys('2026-11-22')).toEqual([]); // a month later, old workouts raise nothing
    // a pending copy (also one stored under the old week-based key) is not duplicated...
    const old = [
      { id: 'o1', type: 'recoveryCheck', status: 'pending', dedupeKey: 'recoveryCheck|c1|readiness|2026-10-18' },
      { id: 'o2', type: 'adherence', status: 'pending', dedupeKey: 'adherence|c1|2026-10-18' },
    ] as Recommendation[];
    expect(keys('2026-10-25', old)).toEqual([]);
    // ...but its own key still reaches the repo (refresh in place)
    const same = first.map((k, i) => ({ id: `p${i}`, type: k.split('|')[0], status: 'pending', dedupeKey: k }) as Recommendation);
    expect(keys('2026-10-25', same)).toEqual(first);
  });

  it('#25: three workouts rated effort 9–10 raise the fatigue check (keyed by the newest workout)', () => {
    const ss = ['2026-10-19', '2026-10-21', '2026-10-23'].map((d) => session(d, [entry('bench_press_db', top3())], { wrapUp: { effort: 10 } }));
    expect(run(ss).find((r) => r.type === 'recoveryCheck')?.dedupeKey).toBe(`recoveryCheck|c1|readiness|${ss[2].id}`);
  });

  it('#11: pain / poor technique on a skipped exercise counts toward the repeated-problem swap', () => {
    const p = { reported: true, location: 'ברך' };
    const a = session('2026-10-15', [entry('lunge_db', [notDone(10)], { status: 'skipped', pain: p })]);
    const b = session('2026-10-22', [entry('lunge_db', [set(10, 10), set(10, 10)], { pain: p })]);
    const recs = run([a, b]);
    expect(types(recs)).toContain('swapExercise');
    expect(recs.find((r) => r.type === 'painCheck')!.evidence.map((e) => e.sessionId)).toEqual([a.id, b.id]);
    const poor = (d: string, sets: PerformedSet[], status: 'skipped' | 'done') => session(d, [entry('squat_back_bb', sets, { status, technique: 'poor' })]);
    const t = run([poor('2026-10-08', [notDone(60)], 'skipped'), poor('2026-10-15', [notDone(60)], 'skipped'), poor('2026-10-22', [set(60, 8)], 'done')]);
    expect(t.some((r) => r.type === 'swapExercise' && r.dedupeKey.includes('|technique|'))).toBe(true);
  });

  it('#12: a newer workout supersedes only advice of the same program slot', () => {
    const p1 = { programId: 'p1' };
    const older = session('2026-10-19', [entry('bench_press_db', top3(), { plannedExerciseId: 'heavy' })], p1);
    const inc = asPending(run([older])).filter((r) => r.type === 'increaseWeight');
    expect(inc).toHaveLength(1);
    const two = () => [set(30, 10), set(30, 10)];
    const light = session('2026-10-21', [entry('bench_press_db', [set(14, 13), set(14, 13)], { plannedExerciseId: 'light' })], p1);
    const heavyAgain = session('2026-10-23', [entry('bench_press_db', two(), { plannedExerciseId: 'heavy' })], p1);
    const free = session('2026-10-23', [entry('bench_press_db', two())]);
    const nextCycle = session('2026-10-23', [entry('bench_press_db', two(), { plannedExerciseId: 'heavy-copy' })], { programId: 'p2' });
    const byId = new Map([older, light, heavyAgain, free, nextCycle].map((x) => [x.id, x]));
    expect(staleProgressionRecs(inc, light, byId)).toHaveLength(0);
    expect(staleProgressionRecs(inc, heavyAgain, byId)).toHaveLength(1);
    expect(staleProgressionRecs(inc, free, byId)).toHaveLength(1); // no slot → can't tell, exercise-level
    expect(staleProgressionRecs(inc, nextCycle, byId)).toHaveLength(1); // a duplicated program has new slot ids
    // re-checking the heavy day after only a light day still evaluates the heavy slot
    expect(types(run([older, light], older.id))).toContain('increaseWeight');
    expect(types(run([older, heavyAgain], older.id))).not.toContain('increaseWeight');
  });

  it('#59: the same exercise in two slots of one workout gets advice for each slot', () => {
    const heavy = { planned: { weight: 100, repsMin: 4, repsMax: 6, rir: 2, rest: 180 } };
    const light = { planned: { weight: 60, repsMin: 12, repsMax: 15, rir: 2, rest: 90 } };
    const s = session('2026-10-22', [
      entry('squat_back_bb', [set(100, 6, 2, heavy), set(100, 6, 2, heavy), set(100, 6, 2, heavy)], { plannedExerciseId: 'heavy' }),
      entry('squat_back_bb', [set(60, 15, 2, light), set(60, 15, 2, light)], { plannedExerciseId: 'light' }),
    ]);
    const inc = run([s]).filter((r) => r.type === 'increaseWeight');
    expect(inc.map((r) => [r.suggestion.plannedExerciseId, r.suggestion.weight])).toEqual([
      ['heavy', 102.5],
      ['light', 62.5],
    ]);
    expect(new Set(inc.map((r) => r.dedupeKey)).size).toBe(2);
    expect(inc.every((r) => r.dedupeKey.endsWith(`|${s.id}`))).toBe(true); // the repo's "own advice" check still matches
  });

  it('#59: progression history is the same slot — a light day in between is not "the previous workout"', () => {
    const heavyPlan = { planned: { weight: 30, repsMin: 6, repsMax: 8, rir: 2, rest: 120 } };
    const lightPlan = { planned: { weight: 20, repsMin: 12, repsMax: 15, rir: 2, rest: 90 } };
    const h = (d: string, reps: number) => session(d, [entry('bench_press_db', [0, 1, 2].map(() => set(30, reps, 1, heavyPlan)), { plannedExerciseId: 'heavy' })]);
    const l = (d: string, reps: number) => session(d, [entry('bench_press_db', [0, 1, 2].map(() => set(20, reps, 1, lightPlan)), { plannedExerciseId: 'light' })]);
    // heavy fine, light below ITS range, heavy below → one heavy session below range is not a pattern
    expect(types(run([h('2026-10-15', 7), l('2026-10-19', 10), h('2026-10-22', 5)]))).not.toContain('reduceLoad');
    expect(types(run([h('2026-10-15', 5), l('2026-10-19', 13), h('2026-10-22', 5)]))).toContain('reduceLoad');
  });

  it('#21: on an assisted machine less weight is progress (less help)', () => {
    const s = session('2026-10-22', [entry('pull_up_assisted', [set(30, 12), set(30, 12), set(30, 12)])]);
    const inc = run([s]).find((r) => r.type === 'increaseWeight')!;
    expect(inc.suggestion.weight).toBe(25);
    expect(inc.title).toContain('עזרה');
    const below = (d: string) => session(d, [entry('pull_up_assisted', [set(30, 6, 0), set(30, 6, 0), set(30, 5, 0)])]);
    expect(run([below('2026-10-19'), below('2026-10-22')]).find((r) => r.type === 'reduceLoad')!.suggestion.weight).toBe(35);
    // improving on the assisted machine (less help each time) is not a "decline"
    const mk = (d: string, w: number, help: number) =>
      session(d, [entry('squat_back_bb', [set(w, 8), set(w, 8)]), entry('pull_up_assisted', [set(help, 8), set(help, 8)])]);
    const recs = run([mk('2026-10-10', 100, 40), mk('2026-10-15', 92, 35), mk('2026-10-20', 85, 30)]);
    expect(recs.find((r) => r.type === 'recoveryCheck' && r.severity === 'warn')).toBeUndefined();
  });

  it('#22: no plateau swap from a peak before a long break, nor while the lift is climbing', () => {
    const s = (d: string, w: number) => session(d, [entry('bench_press_bb', [set(w, 8), set(w, 8), set(w, 8)])]);
    const jan = [s('2026-01-10', 80), s('2026-01-14', 80)];
    const rebuild = [s('2026-09-28', 55), s('2026-10-05', 60), s('2026-10-12', 65), s('2026-10-19', 70), s('2026-10-23', 72.5)];
    expect(types(run([...jan, ...rebuild], undefined, '2026-10-24'))).not.toContain('swapExercise');
    const flat = [s('2026-09-28', 70), s('2026-10-05', 70), s('2026-10-12', 70), s('2026-10-19', 70)];
    expect(types(run([...jan, ...flat], undefined, '2026-10-24'))).not.toContain('swapExercise');
    const recentPeak = [s('2026-09-12', 80), s('2026-09-19', 80)];
    const climbing = [s('2026-09-28', 60), s('2026-10-05', 65), s('2026-10-12', 70), s('2026-10-19', 75)];
    expect(types(run([...recentPeak, ...climbing], undefined, '2026-10-24'))).not.toContain('swapExercise');
    // a real plateau right after recent work still fires
    const plateau = [s('2026-09-28', 80), s('2026-10-05', 80), s('2026-10-12', 80), s('2026-10-19', 80)];
    expect(types(run([...recentPeak, ...plateau], undefined, '2026-10-24'))).toContain('swapExercise');
  });

  it('#26: library exercises follow the Settings weight jumps; a real per-exercise jump still wins', () => {
    const st = settings({ increments: { ...settings().increments, dumbbell: 2.5, machine: 2.5 } });
    expect(incrementFor(ex.get('bench_press_db')!, st)).toBe(2.5);
    expect(incrementFor(ex.get('chest_press_machine')!, st)).toBe(2.5);
    expect(incrementFor(ex.get('lateral_raise_db')!, st)).toBe(1);
    // a jump the trainer saved on the exercise itself always wins over Settings
    expect(incrementFor({ ...ex.get('bench_press_db')!, increment: 2 }, st)).toBe(2);
    expect(incrementFor(ex.get('bench_press_db')!, settings())).toBe(2);
    const s = session('2026-10-22', [entry('bench_press_db', top3())]);
    const inc = runRules({ client: client(), sessions: [s], exercises: ex, settings: st, today: '2026-10-23', sessionId: s.id }).find((r) => r.type === 'increaseWeight');
    expect(inc?.suggestion.weight).toBe(22.5);
  });

  it('#40: a back-off entry or another slot in the same workout is not a "second decline"', () => {
    const s = (d: string, reps: number, backoff = false) =>
      session(d, [
        entry('squat_back_bb', [set(100, reps), set(100, reps)]),
        entry('row_bb', [set(80, reps), set(80, reps)]),
        ...(backoff ? [entry('squat_back_bb', [set(80, 10), set(80, 10)]), entry('row_bb', [set(60, 12), set(60, 12)])] : []),
      ]);
    const warn = (sessions: Session[]) => run(sessions).find((r) => r.type === 'recoveryCheck' && r.severity === 'warn');
    expect(warn([s('2026-10-15', 8), s('2026-10-19', 8), s('2026-10-22', 7, true)])).toBeUndefined();
    // heavy, slightly weaker heavy, then the light day: the light day is its own series
    const slot = (d: string, slotId: string, w: number, reps: number) =>
      session(d, [
        entry('squat_back_bb', [set(w, reps), set(w, reps)], { plannedExerciseId: `sq-${slotId}` }),
        entry('row_bb', [set(w - 20, reps), set(w - 20, reps)], { plannedExerciseId: `row-${slotId}` }),
      ]);
    expect(warn([slot('2026-10-15', 'a', 100, 8), slot('2026-10-19', 'a', 100, 7), slot('2026-10-22', 'b', 70, 10)])).toBeUndefined();
  });

  it('#41: a loaded exercise logged without a weight gets no "progress the variation" advice', () => {
    const s = session('2026-10-22', [entry('bench_press_db', [set(null, 12), set(null, 12), set(null, 12)])]);
    expect(types(run([s]))).not.toContain('adjustRange');
    expect(types(run([s]))).not.toContain('increaseWeight');
    // an ab wheel ('other' gear that never carried a load) still progresses by variation
    const wheel = session('2026-10-22', [entry('ab_wheel', [set(null, 12), set(null, 12), set(null, 12)])]);
    expect(types(run([wheel]))).toContain('adjustRange');
  });

  it('C4: a workout saved with only a pain report still raises the check and blocks the next increase', () => {
    const s1 = session('2026-10-19', [
      entry('bench_press_db', [notDone(), notDone()], { status: 'notdone', pain: { reported: true, location: 'כתף' } }),
      entry('row_bb', [notDone(60)], { status: 'notdone' }),
    ]);
    const first = run([s1]);
    expect(types(first)).toContain('painCheck');
    const s2 = session('2026-10-22', [entry('bench_press_db', top3())]);
    const next = runRules({ client: client(), sessions: [s1, s2], exercises: ex, settings: settings(), today: '2026-10-23', sessionId: s2.id, existing: asPending(first) });
    expect(types(next)).not.toContain('increaseWeight');
  });
  it('a well-rested, complete workout after rejected fatigue / adherence advice does not re-raise it', () => {
    const tired = { energy: 2, sleep: 2, fatigue: 4 };
    const missed = () => [entry('bench_press_db', [set(20, 10), notDone(), notDone(), notDone()])];
    const ss = ['2026-10-18', '2026-10-19', '2026-10-20'].map((d) => session(d, missed(), { readiness: tired }));
    const first = runRules({ client: client(), sessions: ss, exercises: ex, settings: settings(), today: '2026-10-20' }).filter(
      (r) => r.type === 'recoveryCheck' || r.type === 'adherence',
    );
    const rested = session('2026-10-21', [entry('bench_press_db', top3())], { readiness: { energy: 5, sleep: 5, fatigue: 1 } });
    const later = runRules({ client: client(), sessions: [...ss, rested], exercises: ex, settings: settings(), today: '2026-10-21' }).filter(
      (r) => r.type === 'recoveryCheck' || r.type === 'adherence',
    );
    // same evidence → same keys → the repo won't create them again
    for (const r of later) expect(first.map((x) => x.dedupeKey)).toContain(r.dedupeKey);
  });

  it('an assisted machine already at zero help gets "progress the variation", not silence', () => {
    const s = session('2026-10-22', [entry('pull_up_assisted', [set(0, 12), set(0, 12), set(0, 12)])]);
    const recs = run([s]);
    expect(types(recs)).not.toContain('increaseWeight');
    expect(types(recs)).toContain('adjustRange');
  });
});
