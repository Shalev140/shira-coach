import { beforeEach, describe, expect, it } from 'vitest';
import { db } from './db';
import {
  activateProgram,
  addNote,
  alive,
  applyRecommendation,
  blankClient,
  blankPlannedExercise,
  blankProgram,
  blankSet,
  blankWorkout,
  completeSession,
  discardSession,
  duplicateProgram,
  entriesFromWorkout,
  initDatabase,
  latestVersion,
  resolveNote,
  restoreProgramVersion,
  runEngine,
  saveClient,
  saveProgram,
  saveSession,
  saveSettings,
  softDelete,
  startSession,
} from './repo';
import { buildBackup, createSnapshot, importBackup, listSnapshots, restoreSnapshot, validateBackup } from './backup';
import { blankBlock } from './repo';
import { noteShowsIn } from '../domain/agenda';
import type { PerformedSet, Program, Session } from '../domain/types';

async function reset() {
  await db.delete();
  await db.open();
  await initDatabase();
}

async function clientWithProgram() {
  const c = { ...blankClient(), name: 'נועה' };
  await saveClient(c);
  const p = blankProgram(c.id, 'תוכנית');
  const b = blankBlock('main', 'single');
  b.items.push(blankPlannedExercise('bench_press_db', 3, { weight: 20, repsMin: 8, repsMax: 12, rir: 2, rest: 90 }));
  p.workouts[0].blocks.push(b);
  const { program } = await saveProgram(p);
  return { c, program };
}

/** Logs workout A with every set done as `perf` (good technique) and finishes it. */
async function logWorkout(clientId: string, program: Program, perf: Partial<PerformedSet>, edit?: (s: Session) => void) {
  const s = await startSession({ clientId, program, workoutId: program.workouts[0].id });
  s.entries[0].technique = 'good';
  s.entries[0].sets.forEach((x) => Object.assign(x, { done: true, ...perf }));
  edit?.(s);
  return { s, ...(await completeSession(s)) };
}

/** Bench on a heavy day A (30 kg, 6–8) and a light day B (no planned weights → carry-over, 12–15). */
async function heavyAndLightDays() {
  const c = { ...blankClient(), name: 'דנה' };
  await saveClient(c);
  const p = blankProgram(c.id, 'תוכנית');
  const heavy = blankBlock('main', 'single');
  heavy.items.push(blankPlannedExercise('bench_press_db', 3, { weight: 30, repsMin: 6, repsMax: 8, rir: 2 }));
  p.workouts[0].blocks.push(heavy);
  const b = blankWorkout('B');
  const light = blankBlock('main', 'single');
  light.items.push(blankPlannedExercise('bench_press_db', 3, { repsMin: 12, repsMax: 15, rir: 2 }));
  b.blocks.push(light);
  p.workouts.push(b);
  const { program } = await saveProgram(p);
  return { c, program };
}

const plannedWeights = (p: Program, workout: string) =>
  p.workouts.find((w) => w.name === workout)!.blocks[0].items[0].sets.map((x) => x.weight);

describe('data layer', () => {
  beforeEach(reset);

  it('seeds the exercise library once', async () => {
    const n = await db.exercises.count();
    expect(n).toBeGreaterThan(100);
    await initDatabase();
    expect(await db.exercises.count()).toBe(n);
  });

  it('versions a program only when its content changes, with a diff and reason', async () => {
    const { program } = await clientWithProgram();
    expect(program.version).toBe(1);
    const same = await saveProgram(program, { reason: 'ללא שינוי' });
    expect(same.version).toBeNull();
    const changed: Program = JSON.parse(JSON.stringify(program));
    changed.workouts[0].blocks[0].items[0].sets[0].weight = 22;
    const { version } = await saveProgram(changed, { reason: 'התקדמות' });
    expect(version?.version).toBe(2);
    expect(version?.reason).toBe('התקדמות');
    expect(version?.changes.some((c) => c.from === '20' && c.to === '22')).toBe(true);
    expect(await db.programVersions.count()).toBe(2);
  });

  it('keeps the plan separate from what was performed', async () => {
    const { c, program } = await clientWithProgram();
    const s = await startSession({ clientId: c.id, program, workoutId: program.workouts[0].id });
    expect(s.entries[0].sets[0].planned?.weight).toBe(20);
    s.entries[0].sets.forEach((x) => Object.assign(x, { weight: 25, reps: 6, done: true }));
    await saveSession(s);
    await completeSession(s);
    const stored = await db.programs.get(program.id);
    expect(stored?.workouts[0].blocks[0].items[0].sets[0].weight).toBe(20);
    const done = await db.sessions.get(s.id);
    expect(done?.status).toBe('completed');
    expect(done?.plannedSnapshot?.blocks[0].items[0].sets[0].weight).toBe(20);
    expect(done?.entries[0].sets[0].weight).toBe(25);
  });

  it('recovers an in-progress workout exactly as it was saved', async () => {
    const { c, program } = await clientWithProgram();
    const s = await startSession({ clientId: c.id, program, workoutId: program.workouts[0].id });
    s.entries[0].sets[0] = { ...s.entries[0].sets[0], weight: 20, reps: 11, done: true };
    await saveSession(s);
    const again = await startSession({ clientId: c.id, program, workoutId: program.workouts[0].id });
    expect(again.id).toBe(s.id); // reopening resumes instead of starting over
    expect(again.entries[0].sets[0].reps).toBe(11);
  });

  it('turns an approved recommendation into a new program version', async () => {
    const { c, program } = await clientWithProgram();
    const s = await startSession({ clientId: c.id, program, workoutId: program.workouts[0].id });
    s.entries[0].technique = 'good';
    s.entries[0].sets.forEach((x) => Object.assign(x, { weight: 20, reps: 12, rir: 2, done: true }));
    const { created } = await completeSession(s);
    const inc = created.find((r) => r.type === 'increaseWeight');
    expect(inc).toBeTruthy();
    const res = await applyRecommendation(inc!);
    expect(res.applied).toBe(true);
    const updated = await db.programs.get(program.id);
    expect(updated?.version).toBe(2);
    expect(updated?.workouts[0].blocks[0].items[0].sets.every((x) => x.weight === 22)).toBe(true);
    expect((await db.recommendations.get(inc!.id))?.status).toBe('applied');
  });

  it('never creates duplicate recommendations or versions when actions are double-tapped', async () => {
    const { c, program } = await clientWithProgram();
    const s = await startSession({ clientId: c.id, program, workoutId: program.workouts[0].id });
    s.entries[0].technique = 'good';
    s.entries[0].sets.forEach((x) => Object.assign(x, { weight: 20, reps: 12, rir: 2, done: true }));
    await completeSession(s);
    await Promise.all([runEngine(c.id, s.id), runEngine(c.id, s.id), runEngine(c.id, s.id)]);
    const keys = (await db.recommendations.toArray()).map((r) => r.dedupeKey);
    expect(new Set(keys).size).toBe(keys.length);

    const a: Program = JSON.parse(JSON.stringify(program));
    a.name = 'א';
    const b: Program = JSON.parse(JSON.stringify(program));
    b.name = 'ב';
    await Promise.all([saveProgram(a), saveProgram(b)]);
    const versions = (await db.programVersions.where('programId').equals(program.id).toArray()).map((v) => v.version).sort();
    expect(versions).toEqual([1, 2, 3]);
  });

  it('applies a weight recommendation relative to the PLANNED load, once', async () => {
    const { c, program } = await clientWithProgram(); // planned 20 kg
    const s = await startSession({ clientId: c.id, program, workoutId: program.workouts[0].id });
    s.entries[0].technique = 'good';
    s.entries[0].sets.forEach((x) => Object.assign(x, { weight: 22, reps: 12, rir: 2, done: true })); // performed heavier
    const { created } = await completeSession(s);
    const inc = created.find((r) => r.type === 'increaseWeight')!;
    expect(inc.suggestion.to).toBe('24');
    await applyRecommendation(inc);
    const planned = (await db.programs.get(program.id))!.workouts[0].blocks[0].items[0].sets.map((x) => x.weight);
    expect(planned).toEqual([24, 24, 24]);
    const second = await applyRecommendation(inc);
    expect(second.applied).toBe(false);
    expect((await db.programs.get(program.id))!.version).toBe(2);
  });

  it('restoring an old version keeps the current status (no second active program)', async () => {
    const { program } = await clientWithProgram();
    const v1 = (await db.programVersions.where('programId').equals(program.id).toArray())[0];
    await saveProgram({ ...program, status: 'archived' }, { reason: 'ארכיון' });
    const current = (await db.programs.get(program.id))!;
    await restoreProgramVersion(current, v1);
    expect((await db.programs.get(program.id))!.status).toBe('archived');
  });

  it('a merge on a fresh device brings the trainer settings along', async () => {
    await saveSettings({ trainerName: 'שירה א.', indirectFactor: 0.25 });
    await createSnapshot('בדיקה');
    const settingsBefore = (await db.settings.get('settings'))!;
    const payload = await buildBackup();
    expect(payload.data.settings[0].updatedAt).toBe(settingsBefore.updatedAt); // snapshot didn't touch settings
    await db.delete();
    await db.open();
    await initDatabase();
    await importBackup(payload, 'merge');
    const s = (await db.settings.get('settings'))!;
    expect(s.trainerName).toBe('שירה א.');
    expect(s.indirectFactor).toBe(0.25);
  });

  it('carries the last weight of the same set type — a warm-up load never lands on a working set', async () => {
    const { c, program } = await clientWithProgram();
    const p: Program = JSON.parse(JSON.stringify(program));
    const item = p.workouts[0].blocks[0].items[0];
    item.sets = [{ ...item.sets[0], id: 'w', type: 'warmup', weight: null }, ...item.sets.map((x) => ({ ...x, weight: null }))];
    const { program: saved } = await saveProgram(p);
    const s1 = await startSession({ clientId: c.id, program: saved, workoutId: saved.workouts[0].id });
    s1.entries[0].sets.forEach((x, i) => Object.assign(x, { weight: i === 0 ? 10 : 30, reps: 10, done: true }));
    await completeSession(s1);
    const s2 = await startSession({ clientId: c.id, program: saved, workoutId: saved.workouts[0].id });
    expect(s2.entries[0].sets.map((x) => x.weight)).toEqual([10, 30, 30, 30]);
  });

  it('round-trips a backup file and detects tampering', async () => {
    await clientWithProgram();
    const payload = await buildBackup();
    const v = validateBackup(JSON.parse(JSON.stringify(payload)));
    expect(v.ok).toBe(true);
    const tampered = JSON.parse(JSON.stringify(payload));
    tampered.data.clients[0].name = 'שונה';
    expect(validateBackup(tampered).ok).toBe(false);
    expect(validateBackup({ app: 'other' }).ok).toBe(false);

    await db.clients.clear();
    await importBackup(v.payload!, 'replace');
    expect(await db.clients.count()).toBe(1);
  });

  it('keeps edited library exercises in the backup and re-seeds untouched ones on restore', async () => {
    const libSize = await db.exercises.count();
    const bench = (await db.exercises.get('bench_press_bb'))!;
    await db.exercises.put({ ...bench, secondary: [{ muscle: 'triceps', factor: 0.25 }], updatedAt: Date.now() });
    const payload = await buildBackup();
    expect(payload.data.exercises.map((e) => e.id)).toEqual(['bench_press_bb']);
    await importBackup(payload, 'replace');
    expect(await db.exercises.count()).toBe(libSize);
    expect((await db.exercises.get('bench_press_bb'))?.secondary[0].factor).toBe(0.25);
  });

  it('merges a backup without losing newer local edits', async () => {
    const { c } = await clientWithProgram();
    const payload = await buildBackup();
    await saveClient({ ...c, name: 'נועה (עדכני)' });
    const extra = { ...blankClient(), name: 'חדשה' };
    payload.data.clients.push(extra as never);
    const res = await importBackup(payload, 'merge');
    expect(res.added).toBe(1);
    expect((await db.clients.get(c.id))?.name).toBe('נועה (עדכני)');
    expect(await db.clients.count()).toBe(2);
  });

  it('never wipes a table that the backup file does not contain', async () => {
    await clientWithProgram();
    const payload = await buildBackup();
    delete (payload.data as Record<string, unknown>).sessions;
    const s = await db.sessions.count();
    await importBackup(payload, 'replace');
    expect(await db.sessions.count()).toBe(s);
  });

  it('restores an automatic snapshot (time machine)', async () => {
    await clientWithProgram();
    const snap = await createSnapshot('בדיקה');
    await db.clients.clear();
    expect(await db.clients.count()).toBe(0);
    await restoreSnapshot(snap.id);
    expect(await db.clients.count()).toBe(1);
    expect((await listSnapshots()).length).toBeGreaterThanOrEqual(2); // restore takes its own safety snapshot
  });

  it('a re-check after correcting a set refreshes or withdraws that session\'s own recommendation', async () => {
    const { c, program } = await clientWithProgram();
    const { s, created } = await logWorkout(c.id, program, { weight: 20, reps: 12, rir: 2 });
    const inc = created.find((r) => r.type === 'increaseWeight')!;
    expect(inc.suggestion.to).toBe('22');
    const fix = async (patch: Partial<PerformedSet>) => {
      const stored = (await db.sessions.get(s.id))!;
      stored.entries[0].sets.forEach((x) => Object.assign(x, patch));
      await saveSession(stored);
      return runEngine(c.id, s.id);
    };

    await fix({ weight: 25 }); // the weight was really 25
    const refreshed = (await db.recommendations.get(inc.id))!;
    expect(refreshed.status).toBe('pending');
    expect(refreshed.suggestion.to).toBe('27');

    await fix({ reps: 8 }); // not at the top of the range → the data no longer supports an increase
    const withdrawn = (await db.recommendations.get(inc.id))!;
    expect(withdrawn.status).toBe('rejected');
    expect(withdrawn.decisionNote).toBeTruthy();
    expect((await applyRecommendation(inc)).applied).toBe(false);
    expect((await db.programs.get(program.id))!.version).toBe(1);

    const back = await fix({ reps: 12 }); // corrected back → the same recommendation returns
    expect(back.map((r) => r.id)).toEqual([inc.id]);
    expect((await db.recommendations.get(inc.id))!.status).toBe('pending');
    const keys = (await db.recommendations.toArray()).map((r) => r.dedupeKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('deleting a finished workout withdraws its recommendations and reopens the notes it closed', async () => {
    const { c, program } = await clientWithProgram();
    const note = await addNote(c.id, 'next', 'לבדוק כתף', { createdAt: Date.now() - 60_000 });
    const { s, created } = await logWorkout(c.id, program, { weight: 20, reps: 12, rir: 2 });
    const inc = created.find((r) => r.type === 'increaseWeight')!;
    expect((await db.notes.get(note.id))!.done).toBe(true);

    await discardSession(s.id);
    expect((await db.recommendations.get(inc.id))!.status).toBe('rejected');
    expect((await db.notes.get(note.id))!.done).toBe(false); // shown again in the real next workout
    expect((await applyRecommendation(inc)).applied).toBe(false);
    expect((await db.programs.get(program.id))!.version).toBe(1);
  });

  it('a recommendation whose workout is gone can no longer change the program', async () => {
    const { c, program } = await clientWithProgram();
    const { s, created } = await logWorkout(c.id, program, { weight: 20, reps: 12, rir: 2 });
    const inc = created.find((r) => r.type === 'increaseWeight')!;
    await softDelete('sessions', s.id);
    expect((await applyRecommendation(inc)).applied).toBe(false);
    expect((await db.recommendations.get(inc.id))!.status).toBe('rejected');
    expect((await db.programs.get(program.id))!.version).toBe(1);
  });

  it('a double-tapped approve applies once, keeps the version link and adds a "next session" note once', async () => {
    const { c, program } = await clientWithProgram();
    const first = await logWorkout(c.id, program, { weight: 20, reps: 12, rir: 2 }, (s) => (s.startedAt -= 60_000));
    const inc = first.created.find((r) => r.type === 'increaseWeight')!;
    const res = await Promise.all([applyRecommendation(inc), applyRecommendation(inc)]);
    expect(res.filter((r) => r.applied)).toHaveLength(1);
    expect((await db.recommendations.get(inc.id))!.appliedVersion).toBe(2);

    const second = await logWorkout(c.id, (await db.programs.get(program.id))!, { weight: 22, reps: 10, rir: 4 });
    const reps = second.created.find((r) => r.type === 'addReps')!;
    await Promise.all([applyRecommendation(reps), applyRecommendation(reps)]);
    expect((await db.notes.toArray()).filter((n) => n.kind === 'next')).toHaveLength(1);
  });

  it('a double-tapped start opens one workout', async () => {
    const { c, program } = await clientWithProgram();
    const opts = { clientId: c.id, program, workoutId: program.workouts[0].id };
    const [a, b] = await Promise.all([startSession(opts), startSession(opts)]);
    expect(a.id).toBe(b.id);
    expect(await db.sessions.where('status').equals('active').count()).toBe(1);
  });

  it('applying a weight recommendation to a slot without planned weights keeps the pyramid and the back-off set', async () => {
    const c = { ...blankClient(), name: 'נועה' };
    await saveClient(c);
    const p = blankProgram(c.id, 'תוכנית');
    const b = blankBlock('main', 'single');
    const item = blankPlannedExercise('bench_press_db', 3, { repsMin: 8, repsMax: 12, rir: 2 }); // weights null → carry-over
    item.sets.push(blankSet('backoff', { repsMin: 8, repsMax: 12, rir: 2 }));
    b.items.push(item);
    p.workouts[0].blocks.push(b);
    const { program } = await saveProgram(p);
    const { created } = await logWorkout(c.id, program, { reps: 12, rir: 2 }, (s) =>
      [60, 70, 80, 60].forEach((w, i) => (s.entries[0].sets[i].weight = w)),
    );
    const inc = created.find((r) => r.type === 'increaseWeight')!;
    expect(inc.suggestion.to).toBe('82');
    expect((await applyRecommendation(inc)).applied).toBe(true);
    expect(plannedWeights((await db.programs.get(program.id))!, 'A')).toEqual([62, 72, 82, 62]);
  });

  it('after "duplicate for the next cycle" a weight recommendation lands on the workout it came from', async () => {
    const { c, program } = await heavyAndLightDays();
    const s = await startSession({ clientId: c.id, program, workoutId: program.workouts[1].id });
    s.entries[0].technique = 'good';
    s.entries[0].sets.forEach((x) => Object.assign(x, { weight: 20, reps: 15, rir: 2, done: true }));
    const { created } = await completeSession(s);
    const inc = created.find((r) => r.type === 'increaseWeight')!;
    expect(inc.suggestion.to).toBe('22');
    const copy = await duplicateProgram(program, c.id, 'מחזור 2'); // every slot gets a new id
    await activateProgram(copy);
    expect((await applyRecommendation(inc)).applied).toBe(true);
    const stored = (await db.programs.get(copy.id))!;
    expect(plannedWeights(stored, 'A')).toEqual([30, 30, 30]); // the heavy day is never lowered
    expect(plannedWeights(stored, 'B')).toEqual([22, 22, 22]);
  });

  it('a weight recommendation whose slot cannot be told apart is not guessed', async () => {
    const { c, program } = await heavyAndLightDays();
    const s = await startSession({ clientId: c.id, name: 'אימון חופשי' });
    const [e] = entriesFromWorkout(program.workouts[1]); // added during a free session → no program slot
    e.plannedExerciseId = null;
    e.technique = 'good';
    e.sets.forEach((x) => Object.assign(x, { weight: 20, reps: 15, rir: 2, done: true }));
    const { created } = await completeSession({ ...s, entries: [e] });
    const inc = created.find((r) => r.type === 'increaseWeight')!;
    expect(inc.suggestion.to).toBe('22');
    expect((await applyRecommendation(inc)).applied).toBe(false);
    const stored = (await db.programs.get(program.id))!;
    expect(stored.version).toBe(1);
    expect(plannedWeights(stored, 'A')).toEqual([30, 30, 30]);
    expect((await db.recommendations.get(inc.id))!.status).toBe('approved');
  });

  it('an approved swap clears the old exercise\'s planned loads', async () => {
    const { c, program } = await clientWithProgram(); // bench at 20 kg
    const pain = (s: Session) => (s.entries[0].pain = { reported: true });
    await logWorkout(c.id, program, { weight: 20, reps: 10, rir: 2 }, (s) => {
      pain(s);
      s.startedAt -= 60_000;
    });
    const { created } = await logWorkout(c.id, program, { weight: 20, reps: 10, rir: 2 }, pain);
    const swap = created.find((r) => r.type === 'swapExercise')!;
    expect((await applyRecommendation(swap, { alternativeId: 'push_up' })).applied).toBe(true);
    const item = (await db.programs.get(program.id))!.workouts[0].blocks[0].items[0];
    expect(item.exerciseId).toBe('push_up');
    expect(item.sets.map((x) => x.weight)).toEqual([null, null, null]);
  });

  it('a save that changes nothing keeps updatedAt, so a merge cannot let a stale copy win', async () => {
    const { program } = await clientWithProgram();
    const before = (await db.programs.get(program.id))!.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    const same = await saveProgram({ ...program, phase: '' }); // typed and erased in the details sheet
    expect(same.version).toBeNull();
    expect((await db.programs.get(program.id))!.updatedAt).toBe(before);
    const rounds: Program = JSON.parse(JSON.stringify(program));
    rounds.workouts[0].blocks[0].rounds = 3; // a real edit still counts, even one the version diff doesn't list
    await saveProgram(rounds);
    expect((await db.programs.get(program.id))!.updatedAt).toBeGreaterThan(before);
  });

  it('restoring a version after a backup round trip clears fields the old version did not have', async () => {
    const { program } = await clientWithProgram(); // v1: no phase / end date / notes
    await saveProgram({ ...program, phase: 'כוח', endDate: '2026-12-01', notes: 'הערה' });
    const v1 = (await db.programVersions.where('programId').equals(program.id).toArray()).find((v) => v.version === 1)!;
    await db.programVersions.put(JSON.parse(JSON.stringify(v1))); // JSON drops the undefined keys
    const restored = await restoreProgramVersion((await db.programs.get(program.id))!, (await db.programVersions.get(v1.id))!);
    expect(restored.version).toBe(3);
    expect([restored.phase, restored.endDate, restored.notes].map((x) => x ?? '')).toEqual(['', '', '']);
  });
  it('re-checking a session where nothing changed keeps its own swap advice pending (no flip-flop)', async () => {
    const { c, program } = await clientWithProgram();
    const log = async () => {
      const s = await startSession({ clientId: c.id, program, workoutId: program.workouts[0].id });
      s.entries[0].pain = { reported: true, location: 'כתף' };
      s.entries[0].sets.forEach((x) => Object.assign(x, { weight: 20, reps: 10, done: true }));
      await completeSession(s);
      return s;
    };
    await log();
    const s2 = await log();
    const swap = async () => (await db.recommendations.toArray()).find((r) => r.type === 'swapExercise' && r.sourceSessionId === s2.id);
    expect((await swap())?.status).toBe('pending');
    await runEngine(c.id, s2.id);
    await runEngine(c.id, s2.id);
    expect((await swap())?.status).toBe('pending');
  });

  it('re-checking an OLDER session does not withdraw its advice as "data corrected"', async () => {
    const { c, program } = await clientWithProgram();
    const s1 = await startSession({ clientId: c.id, program, workoutId: program.workouts[0].id });
    s1.entries[0].technique = 'good';
    s1.entries[0].sets.forEach((x) => Object.assign(x, { weight: 20, reps: 12, rir: 2, done: true }));
    const { created } = await completeSession(s1);
    const inc = created.find((r) => r.type === 'increaseWeight')!;
    const s2 = await startSession({ clientId: c.id, program, workoutId: program.workouts[0].id });
    s2.entries[0].sets.forEach((x) => Object.assign(x, { weight: 20, reps: 12, done: true, autoFilled: true }));
    await completeSession(s2);
    await runEngine(c.id, s1.id);
    expect((await db.recommendations.get(inc.id))?.status).toBe('pending');
  });

  it('a weight increase cannot be applied while a pain check for that exercise is open', async () => {
    const { c, program } = await clientWithProgram();
    const s = await startSession({ clientId: c.id, program, workoutId: program.workouts[0].id });
    s.entries[0].technique = 'good';
    s.entries[0].sets.forEach((x) => Object.assign(x, { weight: 20, reps: 12, rir: 2, done: true }));
    const { created } = await completeSession(s);
    const inc = created.find((r) => r.type === 'increaseWeight')!;
    await db.recommendations.put({ ...inc, id: 'pain-open', type: 'painCheck', dedupeKey: 'painCheck|x', status: 'pending' });
    const res = await applyRecommendation(inc);
    expect(res.applied).toBe(false);
    expect((await db.recommendations.get(inc.id))?.status).toBe('pending');
    expect((await db.programs.get(program.id))!.version).toBe(1);
  });

  it('after a merge the next save diffs against the version the program holds (no phantom changes)', async () => {
    const { program } = await clientWithProgram();
    const edited: Program = JSON.parse(JSON.stringify(program));
    edited.name = 'שם חדש';
    await saveProgram(edited); // v2
    // simulate a merged-in twin from another device numbered above the stored version
    const v2 = (await db.programVersions.where('programId').equals(program.id).toArray()).find((v) => v.version === 2)!;
    await db.programVersions.put({ ...v2, id: 'other-device', version: 3, snapshot: { ...v2.snapshot, name: 'גרסה אחרת' }, createdAt: v2.createdAt - 1 });
    const stored = (await db.programs.get(program.id))!;
    expect(stored.version).toBe(2);
    const { version } = await saveProgram({ ...stored, notes: 'הערה' });
    expect(version?.version).toBe(4);
    expect(version?.changes.map((ch) => ch.field)).toEqual(['הערות']);
  });

  it('an increase for an exercise swapped in mid-exercise is shifted from its own sets, not the replaced exercise\'s', async () => {
    const c = { ...blankClient(), name: 'נועה' };
    await saveClient(c);
    const p = blankProgram(c.id, 'תוכנית');
    for (const id of ['bench_press_bb', 'chest_press_machine']) {
      const b = blankBlock('main', 'single');
      b.items.push(blankPlannedExercise(id, 3, { repsMin: 8, repsMax: 12, rir: 2 })); // weights null → carry-over
      p.workouts[0].blocks.push(b);
    }
    const { program } = await saveProgram(p);
    const s = await startSession({ clientId: c.id, program, workoutId: program.workouts[0].id });
    const [bench] = s.entries;
    Object.assign(bench.sets[0], { weight: 80, reps: 8, rir: 2, done: true });
    // swapped after the first set: the rest moves to the chest press, which keeps the bench slot
    const moved = bench.sets.slice(1).map((x) => ({ ...x, weight: 50, reps: 12, rir: 2, done: true }));
    s.entries.splice(1, 0, { ...bench, id: 'swapped', exerciseId: 'chest_press_machine', swappedFromId: 'bench_press_bb', technique: 'good', sets: moved });
    bench.sets = bench.sets.slice(0, 1);
    bench.cutShort = true;
    const { created } = await completeSession(s);
    const inc = created.find((r) => r.type === 'increaseWeight' && r.exerciseId === 'chest_press_machine')!;
    expect(inc.suggestion.to).toBe('55');
    expect((await applyRecommendation(inc)).applied).toBe(true);
    const chest = (await db.programs.get(program.id))!.workouts[0].blocks[1].items[0];
    expect(chest.sets.map((x) => x.weight)).toEqual([55, 55, 55]); // not 80 + 5 from the bench set
  });

  it('advice for an exercise swapped in is never applied to another workout\'s slot by guessing', async () => {
    const c = { ...blankClient(), name: 'דנה' };
    await saveClient(c);
    const p = blankProgram(c.id, 'תוכנית');
    const heavy = blankBlock('main', 'single');
    heavy.items.push(blankPlannedExercise('bench_press_bb', 3, { weight: 80, repsMin: 4, repsMax: 6, rir: 2 }));
    p.workouts[0].blocks.push(heavy);
    const b = blankWorkout('B');
    const light = blankBlock('main', 'single');
    light.items.push(blankPlannedExercise('bench_press_db', 3, { weight: 24, repsMin: 10, repsMax: 12, rir: 2 }));
    b.blocks.push(light);
    p.workouts.push(b);
    const { program } = await saveProgram(p);
    // heavy day A: the rack is taken, so dumbbells replace the barbell before the first set
    const { created } = await logWorkout(c.id, program, { weight: 32, reps: 6, rir: 2 }, (s) => {
      s.entries[0].swappedFromId = 'bench_press_bb';
      s.entries[0].exerciseId = 'bench_press_db';
    });
    const inc = created.find((r) => r.type === 'increaseWeight' && r.exerciseId === 'bench_press_db')!;
    expect(inc.suggestion.to).toBe('34');
    expect((await applyRecommendation(inc)).applied).toBe(false);
    const stored = (await db.programs.get(program.id))!;
    expect(stored.version).toBe(1);
    expect(plannedWeights(stored, 'B')).toEqual([24, 24, 24]); // the light day keeps its own load
    expect((await db.recommendations.get(inc.id))!.status).toBe('approved');
  });

  it('correcting a set withdraws its increase even when a later workout only ticked the exercise off', async () => {
    const { c, program } = await clientWithProgram();
    const { s, created } = await logWorkout(c.id, program, { weight: 20, reps: 12, rir: 2 }, (x) => (x.startedAt -= 60_000));
    const inc = created.find((r) => r.type === 'increaseWeight')!;
    await logWorkout(c.id, program, { weight: 20, reps: 12, autoFilled: true }); // ✓ only — not a re-evaluation
    expect((await db.recommendations.get(inc.id))!.status).toBe('pending');
    const stored = (await db.sessions.get(s.id))!;
    stored.entries[0].sets[2].reps = 9;
    await saveSession(stored);
    await runEngine(c.id, s.id);
    expect((await db.recommendations.get(inc.id))!.status).toBe('rejected');
    expect((await applyRecommendation(inc)).applied).toBe(false);
    expect((await db.programs.get(program.id))!.version).toBe(1);
  });

  it('a program duplicated for a demo client is demo data too', async () => {
    const { c, program } = await clientWithProgram();
    await saveClient({ ...c, demo: true });
    const copy = await duplicateProgram(program, c.id);
    expect(copy.demo).toBe(true);
    expect((await latestVersion(copy.id))?.demo).toBe(true);
    expect((await duplicateProgram(program, null)).demo).toBeFalsy(); // a template of her own
  });

  it('carries each slot\'s own last load — two slots of one exercise never get each other\'s weight', async () => {
    const c = { ...blankClient(), name: 'נועה' };
    await saveClient(c);
    const p = blankProgram(c.id, 'תוכנית');
    const main = blankBlock('main', 'single');
    main.items.push(blankPlannedExercise('squat_back_bb', 3, { repsMin: 4, repsMax: 6, rir: 2 }));
    const fin = blankBlock('finisher', 'single');
    fin.items.push(blankPlannedExercise('squat_back_bb', 2, { repsMin: 12, repsMax: 15, rir: 2 }));
    p.workouts[0].blocks.push(main, fin);
    const { program } = await saveProgram(p);
    await logWorkout(c.id, program, {}, (s) =>
      s.entries.forEach((e) => e.sets.forEach((x) => Object.assign(x, { done: true, ...(e.section === 'main' ? { weight: 100, reps: 5 } : { weight: 60, reps: 15 }) }))),
    );
    const next = await startSession({ clientId: c.id, program, workoutId: program.workouts[0].id });
    expect(next.entries.map((e) => e.sets.map((x) => x.weight))).toEqual([[100, 100, 100], [60, 60]]);
  });

  it('deleting a finished workout first takes a snapshot it can be restored from', async () => {
    const { c, program } = await clientWithProgram();
    const { s } = await logWorkout(c.id, program, { weight: 20, reps: 10, rir: 2 });
    await discardSession(s.id);
    expect(alive(await db.sessions.get(s.id))).toBe(false);
    const snap = (await listSnapshots()).find((x) => x.reason.startsWith('לפני מחיקת אימון'))!;
    expect(snap).toBeTruthy();
    await restoreSnapshot(snap.id);
    const back = (await db.sessions.get(s.id))!;
    expect(alive(back)).toBe(true);
    expect(back.status).toBe('completed');
    expect(back.entries[0].sets.every((x) => x.done && x.weight === 20)).toBe(true);
  });

  it('a "next session" note about one exercise waits for the workout that trains it', async () => {
    const { c, program } = await clientWithProgram();
    const createdAt = Date.now() - 60_000;
    const reps = await addNote(c.id, 'next', 'לחיצת חזה במשקולות: לכוון ל-11 חזרות לסט', { exerciseId: 'bench_press_db', createdAt });
    const general = await addNote(c.id, 'next', 'לבדוק כתף', { createdAt });
    await completeSession(await startSession({ clientId: c.id, name: 'אימון רגליים' })); // no bench in it
    expect((await db.notes.get(reps.id))!.done).toBeFalsy();
    expect((await db.notes.get(general.id))!.done).toBe(true);
    await logWorkout(c.id, program, { weight: 20, reps: 11, rir: 2 });
    expect((await db.notes.get(reps.id))!.done).toBe(true);
  });

  it('deleting a workout reopens a note it closed even if an earlier workout showed it before it was kept open', async () => {
    const { c, program } = await clientWithProgram();
    const note = await addNote(c.id, 'next', 'לבדוק כתף לפני לחיצות', { createdAt: Date.now() - 60_000 });
    await logWorkout(c.id, program, { weight: 20, reps: 10, rir: 2 }, (s) => (s.startedAt -= 30_000));
    expect((await db.notes.get(note.id))!.done).toBe(true);
    await resolveNote(note.id, false); // "להשאיר פתוח" in that workout's summary
    const { s: wrong } = await logWorkout(c.id, program, { weight: 20, reps: 10, rir: 2 });
    expect((await db.notes.get(note.id))!.done).toBe(true);
    await discardSession(wrong.id);
    expect((await db.notes.get(note.id))!.done).toBe(false);
  });

  it('deleting a workout does not suppress advice it only triggered (goal rep range)', async () => {
    const c = { ...blankClient(), name: 'נועה' };
    await saveClient(c);
    const p = { ...blankProgram(c.id, 'כוח'), goal: 'strength' as const };
    const b = blankBlock('main', 'single');
    b.items.push(blankPlannedExercise('squat_back_bb', 3, { weight: 60, repsMin: 10, repsMax: 12, rir: 2 }));
    p.workouts[0].blocks.push(b);
    const { program } = await saveProgram(p);
    const goalRecs = async () => (await db.recommendations.toArray()).filter((r) => alive(r) && r.dedupeKey.includes('|goal|')).map((r) => r.status);
    const { s } = await logWorkout(c.id, program, { weight: 60, reps: 10, rir: 2 });
    expect(await goalRecs()).toEqual(['pending']);
    await discardSession(s.id);
    expect(await goalRecs()).toEqual([]);
    await logWorkout(c.id, program, { weight: 60, reps: 10, rir: 2 });
    expect(await goalRecs()).toEqual(['pending']);
  });

  it('deleting or correcting the later workout that withdrew older advice brings that advice back', async () => {
    const { c, program } = await clientWithProgram();
    const earlier = (ms: number) => (s: Session) => (s.startedAt -= ms);
    const first = await logWorkout(c.id, program, { weight: 20, reps: 12, rir: 2 }, earlier(90_000));
    const inc = first.created.find((r) => r.type === 'increaseWeight')!;
    const status = async () => (await db.recommendations.get(inc.id))!.status;

    // pain in a later workout blocks it; that workout was logged on the wrong client and is deleted
    const sore = await logWorkout(c.id, program, { weight: 20, reps: 10, rir: 2 }, (s) => {
      earlier(60_000)(s);
      s.entries[0].pain = { reported: true };
    });
    expect(await status()).toBe('rejected');
    await discardSession(sore.s.id);
    expect(await status()).toBe('pending');

    // a later workout supersedes it; its sets are then corrected to "not done" and re-checked
    const later = await logWorkout(c.id, program, { weight: 20, reps: 10, rir: 2 }, earlier(30_000));
    expect(await status()).toBe('rejected');
    const stored = (await db.sessions.get(later.s.id))!;
    stored.entries[0].sets.forEach((x) => (x.done = false));
    await saveSession(stored);
    await runEngine(c.id, later.s.id);
    expect(await status()).toBe('pending');
    const pending = (await db.recommendations.toArray()).filter((r) => alive(r) && r.status === 'pending' && r.type === 'increaseWeight');
    expect(pending.map((r) => r.id)).toEqual([inc.id]); // no duplicate
  });

  it('a withdrawn increase stays withdrawn while a pain check for the exercise is open', async () => {
    const { c, program } = await clientWithProgram();
    const first = await logWorkout(c.id, program, { weight: 20, reps: 12, rir: 2 }, (s) => (s.startedAt -= 60_000));
    const inc = first.created.find((r) => r.type === 'increaseWeight')!;
    const sore = await logWorkout(c.id, program, { weight: 20, reps: 10, rir: 2 }, (s) => (s.entries[0].pain = { reported: true }));
    const stored = (await db.sessions.get(sore.s.id))!;
    stored.entries[0].pain = { reported: false }; // corrected, but the pain check is closed only by the trainer
    stored.entries[0].sets.forEach((x) => (x.done = false));
    await saveSession(stored);
    await runEngine(c.id, sore.s.id);
    expect((await db.recommendations.toArray()).some((r) => r.type === 'painCheck' && r.status === 'pending')).toBe(true);
    expect((await db.recommendations.get(inc.id))!.status).toBe('rejected');
  });
  it('adding reps cannot be applied while a technique check for that exercise is open', async () => {
    const { c, program } = await clientWithProgram();
    const { created } = await logWorkout(c.id, program, { weight: 20, reps: 12, rir: 2 });
    const inc = created.find((r) => r.type === 'increaseWeight')!;
    const reps = { ...inc, id: 'reps', type: 'addReps' as const, dedupeKey: 'addReps|x', suggestion: { ...inc.suggestion, kind: 'reps' as const } };
    await db.recommendations.put(reps);
    await db.recommendations.put({ ...inc, id: 'tech-open', type: 'techniqueCheck', dedupeKey: 'techniqueCheck|x', status: 'pending' });
    expect((await applyRecommendation(reps)).applied).toBe(false);
    expect((await db.recommendations.get('reps'))?.status).toBe('pending');
    expect((await db.programs.get(program.id))!.version).toBe(1);
  });

  it('a note about one program slot waits for that slot — the light day of the same exercise neither shows nor closes it', async () => {
    const { c, program } = await heavyAndLightDays();
    const [A, B] = program.workouts;
    const note = await addNote(c.id, 'next', 'לחיצת חזה: לכוון ל-8 חזרות לסט', {
      exerciseId: 'bench_press_db',
      plannedExerciseId: A.blocks[0].items[0].id,
      programId: program.id,
      createdAt: Date.now() - 60_000,
    });
    const light = await startSession({ clientId: c.id, program, workoutId: B.id });
    expect(noteShowsIn(note, light)).toBe(false);
    light.entries[0].sets.forEach((x) => Object.assign(x, { weight: 20, reps: 12, rir: 2, done: true }));
    const { session: lightDone } = await completeSession(light);
    expect((await db.notes.get(note.id))!.done).toBeFalsy();
    expect(lightDone.shownNoteIds ?? []).not.toContain(note.id);
    const heavy = await startSession({ clientId: c.id, program, workoutId: A.id });
    expect(noteShowsIn(note, heavy)).toBe(true);
    heavy.entries[0].sets.forEach((x) => Object.assign(x, { weight: 30, reps: 8, rir: 2, done: true }));
    const { session: heavyDone } = await completeSession(heavy);
    expect((await db.notes.get(note.id))!.done).toBe(true);
    expect(heavyDone.shownNoteIds).toContain(note.id);
  });

  it('without an active program a note about an exercise waits for a workout that has it', async () => {
    const c = { ...blankClient(), name: 'נועה' };
    await saveClient(c);
    const createdAt = Date.now() - 60_000;
    const squat = await addNote(c.id, 'next', 'סקוואט: לבדוק עומק', { exerciseId: 'squat_back_bb', createdAt });
    const general = await addNote(c.id, 'next', 'לשאול על שינה', { createdAt });
    const { session } = await completeSession(await startSession({ clientId: c.id, name: 'אימון חופשי' }));
    expect((await db.notes.get(squat.id))!.done).toBeFalsy();
    expect((await db.notes.get(general.id))!.done).toBe(true);
    expect(session.shownNoteIds).toEqual([general.id]); // the summary lists only what the workout showed
  });

  it('library entries the trainer never touched follow fixes to the library data; edited ones are kept', async () => {
    const bench = (await db.exercises.get('bench_press_db'))!;
    expect(bench.increment).toBeUndefined();
    await db.exercises.put({ ...bench, increment: 2.5 }); // a stale value from an older library version
    const squat = (await db.exercises.get('squat_back_bb'))!;
    await db.exercises.put({ ...squat, increment: 5, updatedAt: 5000 }); // the trainer's own value
    await initDatabase();
    expect((await db.exercises.get('bench_press_db'))!.increment).toBeUndefined();
    expect((await db.exercises.get('squat_back_bb'))!.increment).toBe(5);
  });

  it('deleting a workout of the next cycle does not revive advice that cycle already received', async () => {
    const { c, program } = await clientWithProgram();
    const first = await logWorkout(c.id, program, { weight: 20, reps: 12, rir: 2 }, (s) => (s.startedAt -= 60_000));
    const inc = first.created.find((r) => r.type === 'increaseWeight')!;
    const copy = await duplicateProgram(program, c.id, 'מחזור 2'); // every slot gets a new id
    await activateProgram(copy);
    const second = await logWorkout(c.id, copy, { weight: 20, reps: 12, rir: 2 });
    expect((await db.recommendations.get(inc.id))?.status).toBe('rejected');
    const inc2 = second.created.find((r) => r.type === 'increaseWeight')!;
    expect((await applyRecommendation(inc2)).applied).toBe(true);
    await discardSession(second.s.id);
    expect((await db.recommendations.get(inc.id))?.status).toBe('rejected');
  });

  it('deleting a workout does not revive older advice the program already received from it', async () => {
    const { c, program } = await clientWithProgram();
    const log = async () => {
      const s = await startSession({ clientId: c.id, program, workoutId: program.workouts[0].id });
      s.entries[0].technique = 'good';
      s.entries[0].sets.forEach((x) => Object.assign(x, { weight: 20, reps: 12, rir: 2, done: true }));
      const { created } = await completeSession(s);
      return { s, inc: created.find((r) => r.type === 'increaseWeight')! };
    };
    const first = await log();
    const second = await log(); // the same workout logged twice — supersedes the first advice
    expect((await db.recommendations.get(first.inc.id))?.status).toBe('rejected');
    await applyRecommendation(second.inc); // plan goes to 22
    await discardSession(second.s.id); // the duplicate is deleted
    expect((await db.recommendations.get(first.inc.id))?.status).toBe('rejected');
  });
});
