import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from './db';
import {
  activateProgram,
  blankBlock,
  blankClient,
  blankPlannedExercise,
  blankProgram,
  deleteClient,
  discardSession,
  getSettings,
  initDatabase,
  saveClient,
  saveProgram,
  saveSettings,
  startSession,
} from './repo';
import { autoSnapshotIfDue, buildBackup, exportCsv, importBackup, readFolderLatest, writeFolderBackup, type BackupPayload } from './backup';
import type { Program, Recommendation } from '../domain/types';
import { uid } from '../domain/util';
import { entry, session, set } from '../domain/testkit';

async function reset() {
  await db.delete();
  await db.open();
  await initDatabase();
}

/** Turns the (single) test database into "another device" holding exactly this backup. */
async function device(payload: BackupPayload) {
  await reset();
  await importBackup(payload, 'replace');
}

const at = (sec: number) => vi.setSystemTime(new Date(2026, 9, 19, 10, 0, sec));
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

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

/** In-memory stand-in for a folder picked with showDirectoryPicker. */
function fakeFolder(files: Record<string, string> = {}) {
  const store = new Map(Object.entries(files));
  const dir = {
    name: 'OneDrive',
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    getFileHandle: async (name: string, o?: { create?: boolean }) => {
      if (!store.has(name) && !o?.create) throw new DOMException('missing', 'NotFoundError');
      return {
        getFile: async () => new File([store.get(name) ?? ''], name),
        createWritable: async () => {
          let text = '';
          return {
            write: async (b: Blob) => void (text = await b.text()),
            close: async () => void store.set(name, text),
          };
        },
      };
    },
    values: async function* () {
      for (const name of [...store.keys()]) yield { kind: 'file', name };
    },
    removeEntry: async (name: string) => void store.delete(name),
  };
  // a real directory handle is stored in meta; functions can't go through IndexedDB here
  const realGet = db.meta.get.bind(db.meta);
  vi.spyOn(db.meta, 'get').mockImplementation(((key: string) =>
    key === 'backupDir' ? Promise.resolve({ key, value: dir }) : realGet(key)) as never);
  return store;
}

const versionsOf = async (programId: string) =>
  Object.fromEntries((await db.programVersions.where('programId').equals(programId).toArray()).map((v) => [v.id, v.version]));

function rec(clientId: string, patch: Partial<Recommendation> = {}): Recommendation {
  const t = Date.now();
  return {
    id: uid(),
    createdAt: t,
    updatedAt: t,
    clientId,
    type: 'volumeLow',
    severity: 'suggest',
    title: 'נפח נמוך',
    detected: '',
    reasoning: '',
    action: '',
    evidence: [],
    suggestion: { kind: 'none' },
    status: 'pending',
    dedupeKey: `volumeLow|${clientId}|2026-10-11`,
    ...patch,
  };
}

const aliveRecs = async (clientId: string) =>
  (await db.recommendations.where('clientId').equals(clientId).toArray()).filter((r) => !r.deletedAt);

describe('backup safety', () => {
  beforeEach(reset);
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('never overwrites the folder backups from an empty or demo-only device, and offers the latest one instead', async () => {
    await clientWithProgram();
    const good = JSON.stringify(await buildBackup());
    await reset(); // browser data lost — a new computer
    const store = fakeFolder({ 'shira-coach-latest.json': good, 'shira-coach-auto-2026-10-19.json': good });

    expect(await writeFolderBackup(true)).toBe('empty');
    expect(store.get('shira-coach-latest.json')).toBe(good);
    expect(store.get('shira-coach-auto-2026-10-19.json')).toBe(good);
    const latest = await readFolderLatest();
    expect(latest?.ok).toBe(true);
    expect(latest?.counts.clients).toBe(1);

    await saveClient({ ...blankClient(), name: 'הדגמה', demo: true });
    expect(await writeFolderBackup(false)).toBe('empty');
    expect(store.get('shira-coach-latest.json')).toBe(good);

    await saveClient({ ...blankClient(), name: 'אמיתית' });
    expect(await writeFolderBackup(false)).toBe('ok');
    expect(JSON.parse(store.get('shira-coach-latest.json')!).counts.clients).toBe(2);
  });

  it('a new device holding only a deleted test client never overwrites the folder backups either', async () => {
    await clientWithProgram();
    const good = JSON.stringify(await buildBackup());
    await reset(); // a new computer
    const store = fakeFolder({ 'shira-coach-latest.json': good, 'shira-coach-auto-2026-10-19.json': good });

    // trying the app out: a test client, a discarded workout, then the client is deleted
    const { c, program } = await clientWithProgram();
    const s = await startSession({ clientId: c.id, program, workoutId: program.workouts[0].id });
    await discardSession(s.id);
    await deleteClient(c.id);

    expect(await writeFolderBackup(true)).toBe('empty');
    expect(store.get('shira-coach-latest.json')).toBe(good);
    expect(store.get('shira-coach-auto-2026-10-19.json')).toBe(good);
    expect((await readFolderLatest())?.counts.clients).toBe(1); // the restore is still offered
  });

  it('a failed automatic snapshot (storage full) never rejects — the app keeps opening', async () => {
    await saveClient({ ...blankClient(), name: 'נועה' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const put = vi.spyOn(db.snapshots, 'put').mockRejectedValue(new DOMException('full', 'QuotaExceededError'));
    await expect(autoSnapshotIfDue()).resolves.toBe(false);
    await expect(autoSnapshotIfDue()).resolves.toBe(false); // still due on the next launch, still no rejection
    put.mockRestore();
    await expect(autoSnapshotIfDue()).resolves.toBe(true);
  });

  it('merging program versions saved in parallel on two devices keeps every (program, version) unique — in both directions', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(0);
    const { program } = await clientWithProgram();
    const v1 = (await db.programVersions.where('programId').equals(program.id).first())!;
    const base = await buildBackup();

    at(10); // device A raises the weight
    const a: Program = clone(program);
    a.workouts[0].blocks[0].items[0].sets[0].weight = 22;
    const va = (await saveProgram(a)).version!;
    const fileA = await buildBackup();

    await device(base);
    at(20); // device B, from the same base, widens the rep range
    const b: Program = clone(program);
    b.workouts[0].blocks[0].items[0].sets[0].repsMax = 15;
    const vb = (await saveProgram(b)).version!;
    expect(va.version).toBe(2);
    expect(vb.version).toBe(2);
    const fileB = await buildBackup();

    const expected = { [v1.id]: 1, [va.id]: 2, [vb.id]: 3 };
    at(30);
    await importBackup(fileA, 'merge');
    expect(await versionsOf(program.id)).toEqual(expected);
    const onB = (await db.programs.get(program.id))!;
    expect(onB.workouts[0].blocks[0].items[0].sets[0].repsMax).toBe(15); // B's newer program row stays
    expect(onB.version).toBe(3); // …and points at the version it came from
    // the next save diffs against the right version, so nothing phantom is recorded
    expect((await saveProgram(onB)).version).toBeNull();
    await importBackup(fileA, 'merge'); // merging again changes nothing
    expect(await versionsOf(program.id)).toEqual(expected);

    await device(fileA);
    at(40);
    await importBackup(fileB, 'merge');
    expect(await versionsOf(program.id)).toEqual(expected);
    expect((await db.programs.get(program.id))!.version).toBe(3);
  });

  it('a restored file that already holds clashing version numbers is repaired', async () => {
    const { program } = await clientWithProgram();
    const file = await buildBackup();
    const v1 = file.data.programVersions[0];
    file.data.programVersions.push({ ...v1, id: 'twin', createdAt: Number(v1.createdAt) + 1 });
    await importBackup(file, 'replace');
    expect(Object.values(await versionsOf(program.id)).sort()).toEqual([1, 2]);
  });

  it('merging never duplicates a recommendation both devices generated (same dedupeKey)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(0);
    const c = { ...blankClient(), name: 'נועה' };
    await saveClient(c);
    const base = await buildBackup();

    at(10);
    const ra = rec(c.id);
    await db.recommendations.put(ra);
    const fileA = await buildBackup();

    await device(base);
    at(20);
    const rb = rec(c.id);
    await db.recommendations.put(rb);
    const fileB = await buildBackup();

    await importBackup(fileA, 'merge');
    expect((await aliveRecs(c.id)).map((r) => r.id)).toEqual([ra.id]); // the earliest twin stays
    await importBackup(fileA, 'merge');
    expect(await aliveRecs(c.id)).toHaveLength(1);

    // the other direction keeps the same one
    await device(fileA);
    await importBackup(fileB, 'merge');
    expect((await aliveRecs(c.id)).map((r) => r.id)).toEqual([ra.id]);
  });

  it('a decision is never lost to a pending twin — on either side of the merge', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(0);
    const c = { ...blankClient(), name: 'נועה' };
    await saveClient(c);
    const base = await buildBackup();

    at(10);
    const ra = rec(c.id);
    await db.recommendations.put(ra);
    const fileA = await buildBackup();

    await device(base);
    at(20);
    const rb = rec(c.id);
    await db.recommendations.put(rb);
    const fileB = await buildBackup();

    // A merges B first: B's twin is dropped there (A's is earlier)
    await device(fileA);
    await importBackup(fileB, 'merge');
    expect((await aliveRecs(c.id)).map((r) => r.id)).toEqual([ra.id]);
    const fileA2 = await buildBackup();

    // meanwhile the trainer rejected B's copy on device B
    await device(fileB);
    at(40);
    await db.recommendations.put({ ...rb, status: 'rejected', decidedAt: Date.now(), updatedAt: Date.now() });
    const fileB2 = await buildBackup();

    // the decision wins on A, and the pending twin goes
    await device(fileA2);
    await importBackup(fileB2, 'merge');
    let alive = await aliveRecs(c.id);
    expect(alive.map((r) => [r.id, r.status])).toEqual([[rb.id, 'rejected']]);

    // and B, merging A's file, ends up the same
    await device(fileB2);
    await importBackup(fileA2, 'merge');
    alive = await aliveRecs(c.id);
    expect(alive.map((r) => [r.id, r.status])).toEqual([[rb.id, 'rejected']]);

    // two decided twins are both kept — they are history, not open work
    await db.recommendations.put({ ...ra, status: 'approved', decidedAt: Date.now(), updatedAt: Date.now() + 1, deletedAt: null });
    await importBackup(fileA2, 'merge');
    expect((await aliveRecs(c.id)).filter((r) => r.status === 'pending')).toHaveLength(0);
    expect(await aliveRecs(c.id)).toHaveLength(2);
  });

  it('a merge never leaves a client with two active programs — the newly activated cycle stays, in both directions', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(0);
    const { c, program: p1 } = await clientWithProgram();
    const base = await buildBackup();

    at(10); // device A starts the next cycle (the old one is archived)
    const { program: p2 } = await saveProgram({ ...blankProgram(c.id, 'מחזור 2'), status: 'draft' });
    at(11);
    await activateProgram(p2);
    const fileA = await buildBackup();

    await device(base);
    at(20); // device B, not synced yet, still edits the old cycle
    const b: Program = clone(p1);
    b.workouts[0].blocks[0].items[0].sets[0].weight = 22;
    await saveProgram(b);
    const fileB = await buildBackup();

    const expectOneActive = async () => {
      const progs = (await db.programs.where('clientId').equals(c.id).toArray()).filter((p) => !p.deletedAt);
      expect(progs.filter((p) => p.status === 'active').map((p) => p.id)).toEqual([p2.id]);
      const old = progs.find((p) => p.id === p1.id)!;
      expect(old.status).toBe('archived');
      expect(old.workouts[0].blocks[0].items[0].sets[0].weight).toBe(22); // B's edit is kept
      // archived like any status change: a new version, and the program points at it
      const last = (await db.programVersions.where('programId').equals(p1.id).toArray()).sort((x, y) => y.version - x.version)[0];
      expect(last.snapshot.status).toBe('archived');
      expect(last.reason).toContain('מיזוג גיבוי');
      expect(old.version).toBe(last.version);
    };

    at(30);
    expect((await importBackup(fileA, 'merge')).archivedPrograms).toBe(1); // on B
    await expectOneActive();
    const fileB2 = await buildBackup();

    await device(fileA);
    at(40);
    expect((await importBackup(fileB, 'merge')).archivedPrograms).toBe(1); // on A, B's unrepaired file
    await expectOneActive();

    await device(fileA);
    expect((await importBackup(fileB2, 'merge')).archivedPrograms).toBe(0); // B's repaired file: nothing left to fix
    await expectOneActive();
  });

  it('a merge keeps the muscle groups each device added — whichever settings copy is newer', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(0);
    await saveSettings({ trainerName: 'שירה' });
    const base = await buildBackup();

    at(10); // the computer adds a custom group
    const muscles = (await getSettings()).muscles;
    await saveSettings({ muscles: [...muscles, { id: 'm_trap', name: 'טרפזים', order: muscles.length, custom: true }] });
    const computer = await buildBackup();

    await device(base);
    at(20); // later, the phone changes an unrelated setting
    await saveSettings({ defaultRest: 120 });
    const phone = await buildBackup();

    const expectBoth = async () => {
      const s = await getSettings();
      expect(s.muscles.find((m) => m.id === 'm_trap')?.name).toBe('טרפזים');
      expect(s.defaultRest).toBe(120);
      expect(new Set(s.muscles.map((m) => m.id)).size).toBe(s.muscles.length);
      expect(new Set(s.muscles.map((m) => m.order)).size).toBe(s.muscles.length);
    };

    at(30);
    await importBackup(computer, 'merge'); // the phone's own row is newer
    await expectBoth();
    expect((await importBackup(computer, 'merge')).updated).toBe(0); // merging again changes nothing

    await device(computer);
    await importBackup(phone, 'merge'); // the file's row is newer
    await expectBoth();
  });

  it('the Excel training log carries the seconds of timed sets', async () => {
    const c = { ...blankClient(), name: 'נועה' };
    await saveClient(c);
    const plank = set(null, null, null, { planned: { duration: 40 }, duration: 45 });
    await db.sessions.put(session('2026-10-19', [entry('plank', [plank])], { clientId: c.id }));

    let blob: Blob | undefined;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => ((blob = b as Blob), 'blob:csv'));
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.stubGlobal('document', { createElement: () => ({ click() {}, remove() {} }), body: { appendChild() {} } });
    await exportCsv('sets');

    const [head, row] = (await blob!.text()).replace(/^﻿/, '').split('\r\n').map((l) => l.split(','));
    const col = (name: string) => row[head.indexOf(name)];
    expect(col('תרגיל')).toBe('פלאנק');
    expect(col('שניות מתוכננות')).toBe('40');
    expect(col('שניות')).toBe('45');
    expect(col('חזרות')).toBe('');
  });
  it('a custom muscle group deleted on one device stays deleted after merging the other device\'s backup', async () => {
    const s0 = await getSettings();
    await saveSettings({ muscles: [...s0.muscles, { id: 'm_traps', name: 'טרפזים', order: 99, custom: true }] });
    const withTraps = await buildBackup(); // the other device still has the group
    const s1 = await getSettings();
    await saveSettings({ muscles: s1.muscles.filter((m) => m.id !== 'm_traps'), deletedMuscleIds: ['m_traps'] });
    await importBackup(clone(withTraps), 'merge');
    expect((await getSettings()).muscles.some((m) => m.id === 'm_traps')).toBe(false);
  });

  it('re-selecting a setting that is already set does not make the record "newer"', async () => {
    await saveSettings({ trainerName: 'שירה' });
    const before = (await db.settings.get('settings'))!.updatedAt;
    await saveSettings({ trainerName: 'שירה' });
    expect((await db.settings.get('settings'))!.updatedAt).toBe(before);
  });

  it('a "save now" restore point is kept while restore points before single actions roll over', async () => {
    await saveClient({ ...blankClient(), name: 'נועה' });
    const { createSnapshot } = await import('./backup');
    for (let i = 0; i < 12; i++) await createSnapshot(`יומי ${i}`, 'daily');
    await createSnapshot('גיבוי ידני', 'manual');
    for (let i = 0; i < 10; i++) await createSnapshot(`לפני מחיקה ${i}`, 'event');
    const all = await db.snapshots.toArray();
    expect(all.length).toBe(20);
    expect(all.some((x) => x.reason === 'גיבוי ידני')).toBe(true);
    expect(all.filter((x) => x.kind === 'daily').length).toBe(12);
  });

  it('library work alone (own exercise, edited library entry, own muscle group) is real data for the folder backup', async () => {
    const setups = [
      async () => void (await db.exercises.put({ ...(await db.exercises.get('bench_press_db'))!, id: 'my_press', nameHe: 'לחיצה שלי', custom: true, updatedAt: Date.now() })),
      async () => void (await db.exercises.update('bench_press_db', { nameHe: 'לחיצת חזה (ספסל 3)', updatedAt: Date.now() })),
      async () => saveSettings({ muscles: [...(await getSettings()).muscles, { id: 'm_neck', name: 'צוואר', order: 99, custom: true }] }),
    ];
    for (const setup of setups) {
      vi.restoreAllMocks();
      await reset();
      const store = fakeFolder();
      expect(await writeFolderBackup(true)).toBe('empty');
      await setup();
      expect(await writeFolderBackup(true)).toBe('ok');
      expect(store.has('shira-coach-latest.json')).toBe(true);
    }
  });

  it('a blank template is not data, and a device with templates but no clients never replaces a folder backup that has clients', async () => {
    await clientWithProgram();
    const good = JSON.stringify(await buildBackup());
    await reset(); // a new computer
    const template = () => {
      const t = blankProgram(null, 'תבנית');
      const b = blankBlock('main', 'single');
      b.items.push(blankPlannedExercise('squat_back_bb', 3, { repsMin: 8, repsMax: 10 }));
      t.workouts[0].blocks.push(b);
      return t;
    };
    let store = fakeFolder();
    await saveProgram(blankProgram(null, 'תבנית ריקה'));
    expect(await writeFolderBackup(true)).toBe('empty');
    await saveProgram(template());
    expect(await writeFolderBackup(true)).toBe('ok'); // an empty folder gets the template

    vi.restoreAllMocks();
    store = fakeFolder({ 'shira-coach-latest.json': good });
    expect(await writeFolderBackup(true)).toBe('empty');
    expect(store.get('shira-coach-latest.json')).toBe(good);
  });

  it('restore points taken before single actions never push the daily time-machine copies out', async () => {
    await saveClient({ ...blankClient(), name: 'נועה' });
    const { createSnapshot } = await import('./backup');
    for (let i = 0; i < 5; i++) await createSnapshot(`יומי ${i}`, 'daily');
    for (let i = 0; i < 30; i++) await createSnapshot(`לפני מחיקה ${i}`, 'event');
    const all = await db.snapshots.toArray();
    expect(all.length).toBe(20);
    expect(all.filter((x) => x.kind === 'daily').length).toBe(5);
  });
});
