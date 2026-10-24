import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/db';
import { blankClient, initDatabase, saveClient } from '../db/repo';
import { entry, session, set } from '../domain/testkit';
import { correctSet, saveWrapRating } from './SessionSummary';

async function reset() {
  await db.delete();
  await db.open();
  await initDatabase();
}

describe('correcting a set in the summary', () => {
  const unticked = () => [set(null, null, null, { done: false }), set(null, null, null, { done: false })];

  it('ticking a set done makes a skipped exercise done, as completing a set does in the live workout', () => {
    const e = entry('bench_press_db', unticked(), { status: 'skipped' });
    const fixed = correctSet(e, e.sets[0].id, { ...e.sets[0], weight: 20, reps: 12, rir: 2, done: true });
    expect(fixed.status).toBe('done');
    expect(fixed.sets[0]).toMatchObject({ weight: 20, reps: 12, done: true, autoFilled: false });
  });

  it('ticking a set done makes a not-done exercise done', () => {
    const e = entry('bench_press_db', unticked(), { status: 'notdone' });
    expect(correctSet(e, e.sets[1].id, { ...e.sets[1], weight: 20, reps: 10, done: true }).status).toBe('done');
  });

  it('correcting the numbers of a set done before the skip keeps the exercise skipped', () => {
    const e = entry('bench_press_db', [set(20, 10), set(null, null, null, { done: false })], { status: 'skipped' });
    expect(correctSet(e, e.sets[0].id, { ...e.sets[0], weight: 22.5 }).status).toBe('skipped');
  });

  it('un-ticking the only done set makes a done exercise not done, as finishing the workout would', () => {
    const e = entry('bench_press_db', [set(20, 10), set(null, null, null, { done: false })]);
    expect(correctSet(e, e.sets[0].id, { ...e.sets[0], done: false }).status).toBe('notdone');
    const two = entry('bench_press_db', [set(20, 10), set(20, 9)]);
    expect(correctSet(two, two.sets[0].id, { ...two.sets[0], done: false }).status).toBe('done');
  });

  it('confirms an auto-filled set as real data', () => {
    const e = entry('bench_press_db', [set(20, 10, 2, { autoFilled: true })]);
    expect(correctSet(e, e.sets[0].id, { ...e.sets[0] }).sets[0].autoFilled).toBe(false);
  });
});

describe('rating a finished workout in the summary', () => {
  beforeEach(reset);

  const fatigue = async (clientId: string) =>
    (await db.recommendations.where('clientId').equals(clientId).toArray()).filter((r) => r.type === 'recoveryCheck' && r.title === 'סימנים לעייפות מצטברת');

  it('three workouts in a row rated 9–10 raise the fatigue check without a manual re-check', async () => {
    const c = { ...blankClient(), name: 'נועה' };
    await saveClient(c);
    const days = ['2026-10-19', '2026-10-21', '2026-10-23'];
    const sessions = days.map((d) => session(d, [entry('bench_press_db', [set(20, 10), set(20, 10)])], { clientId: c.id }));
    await db.sessions.bulkPut(sessions);
    // each workout is finished first (engine already ran) and only then rated in the summary
    await saveWrapRating(sessions[0].id, { effort: 10 });
    await saveWrapRating(sessions[1].id, { effort: 9 });
    expect(await fatigue(c.id)).toHaveLength(0);
    const created = await saveWrapRating(sessions[2].id, { effort: 10 });
    expect(created.map((r) => r.title)).toContain('סימנים לעייפות מצטברת');
    expect(await fatigue(c.id)).toHaveLength(1);
    // re-rating does not duplicate it
    await saveWrapRating(sessions[2].id, { effort: 9 });
    expect(await fatigue(c.id)).toHaveLength(1);
    expect((await db.sessions.get(sessions[2].id))?.wrapUp.effort).toBe(9);
  });

  it('a quick burst of taps keeps the last rating and the other wrap-up fields', async () => {
    const c = { ...blankClient(), name: 'דנה' };
    await saveClient(c);
    const s = session('2026-10-23', [entry('bench_press_db', [set(20, 10)])], { clientId: c.id, wrapUp: { note: 'הגיעה עייפה' } });
    await db.sessions.put(s);
    await Promise.all([saveWrapRating(s.id, { effort: 7 }), saveWrapRating(s.id, { feeling: 4 }), saveWrapRating(s.id, { effort: 8 })]);
    expect((await db.sessions.get(s.id))?.wrapUp).toEqual({ note: 'הגיעה עייפה', effort: 8, feeling: 4 });
  });

  it('an unfinished workout is only saved, not re-checked', async () => {
    const c = { ...blankClient(), name: 'דנה' };
    await saveClient(c);
    const s = session('2026-10-23', [entry('bench_press_db', [set(20, 10)])], { clientId: c.id, status: 'active' });
    await db.sessions.put(s);
    expect(await saveWrapRating(s.id, { effort: 10 })).toEqual([]);
    expect((await db.sessions.get(s.id))?.wrapUp.effort).toBe(10);
  });
});
