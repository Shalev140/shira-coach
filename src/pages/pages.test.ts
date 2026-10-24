import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/db';
import { blankClient, getSettings, initDatabase, saveClient } from '../db/repo';
import type { Client, Session } from '../domain/types';
import { moveMuscle, updateSettings } from './Settings';
import { patchStoredSession } from './SessionSummary';
import { mergeClientForm } from './ClientEdit';

async function reset() {
  await db.delete();
  await db.open();
  await initDatabase();
}

describe('settings writes from one render', () => {
  beforeEach(reset);

  it('a muscle rename on blur and a move tapped in the same task both stay', async () => {
    const before = await getSettings();
    const target = [...before.muscles].sort((a, b) => a.order - b.order)[1];
    // what the screen does: blur commits the rename, the click moves the row, no await in between
    const rename = updateSettings((cur) => ({ muscles: cur.muscles.map((x) => (x.id === target.id ? { ...x, name: 'גב עליון' } : x)) }));
    const move = updateSettings((cur) => ({ muscles: moveMuscle(cur.muscles, target.id, -1) ?? cur.muscles }));
    await Promise.all([rename, move]);
    const after = await getSettings();
    const row = after.muscles.find((m) => m.id === target.id)!;
    expect(row.name).toBe('גב עליון');
    expect(row.order).toBe(0);
  });

  it('a trainer name and a theme saved in the same task both stay', async () => {
    await Promise.all([updateSettings(() => ({ trainerName: 'שירה כהן' })), updateSettings(() => ({ theme: 'dark' }))]);
    const after = await getSettings();
    expect(after.trainerName).toBe('שירה כהן');
    expect(after.theme).toBe('dark');
  });

  it('moves a muscle by id and renumbers the order', () => {
    const list = [
      { id: 'a', name: 'א', order: 0 },
      { id: 'b', name: 'ב', order: 2 },
      { id: 'c', name: 'ג', order: 5 },
    ];
    expect(moveMuscle(list, 'c', -1)?.map((m) => `${m.id}${m.order}`)).toEqual(['a0', 'c1', 'b2']);
    expect(moveMuscle(list, 'a', -1)).toBeNull();
    expect(moveMuscle(list, 'missing', 1)).toBeNull();
  });
});

describe('session summary writes', () => {
  beforeEach(reset);

  const session = (): Session =>
    ({
      id: 's1',
      createdAt: 1,
      updatedAt: 1,
      clientId: 'c1',
      programId: null,
      programVersion: null,
      plannedWorkoutId: null,
      workoutName: 'A',
      plannedSnapshot: null,
      date: '2026-10-24',
      startedAt: 1,
      endedAt: 2,
      status: 'completed',
      entries: [
        {
          id: 'e1',
          exerciseId: 'bench_press_db',
          status: 'done',
          sets: [{ id: 'x1', type: 'working', weight: 20, reps: 10, rir: 2, done: true, autoFilled: true }],
          technique: 'na',
          pain: { reported: false },
          notes: '',
        },
      ],
      readiness: {},
      wrapUp: {},
      currentIndex: 0,
    }) as unknown as Session;

  it('leaving the note by tapping a rating keeps both the note and the rating', async () => {
    await db.sessions.put(session());
    // blur (note) and click (effort) in one task, before any re-render
    const note = patchStoredSession('s1', (cur) => void (cur.wrapUp = { ...cur.wrapUp, note: 'הגיעה עייפה אחרי משמרת' }));
    const effort = patchStoredSession('s1', (cur) => void (cur.wrapUp = { ...cur.wrapUp, effort: 8 }));
    await Promise.all([note, effort]);
    const s = await db.sessions.get('s1');
    expect(s?.wrapUp).toEqual({ note: 'הגיעה עייפה אחרי משמרת', effort: 8 });
  });

  it('confirming auto-filled sets keeps a note saved in the same task', async () => {
    await db.sessions.put(session());
    const note = patchStoredSession('s1', (cur) => void (cur.wrapUp = { ...cur.wrapUp, note: 'כאב קל בכתף' }));
    const confirm = patchStoredSession('s1', (cur) => {
      cur.entries = cur.entries.map((e) => ({ ...e, sets: e.sets.map((x) => (x.autoFilled ? { ...x, autoFilled: false } : x)) }));
    });
    await Promise.all([note, confirm]);
    const s = await db.sessions.get('s1');
    expect(s?.wrapUp.note).toBe('כאב קל בכתף');
    expect(s?.entries[0].sets[0].autoFilled).toBe(false);
    expect(s?.entries[0].sets[0].reps).toBe(10);
    expect(s!.updatedAt).toBeGreaterThan(1);
  });
});

describe('client edit draft', () => {
  beforeEach(reset);

  it('saving a restored draft keeps goals added on the overview since the draft was made', async () => {
    const stored: Client = { ...blankClient(), name: 'נועה' };
    await saveClient(stored);
    // the draft: a phone change, made before a goal was added elsewhere
    const draft: Client = { ...stored, phone: '050-1234567' };
    await saveClient({ ...stored, targets: [{ id: 't1', text: 'סקוואט 60 ק״ג' }] });

    const latest = await db.clients.get(stored.id);
    await saveClient(mergeClientForm({ ...draft, name: draft.name.trim() }, latest));
    const saved = await db.clients.get(stored.id);
    expect(saved?.phone).toBe('050-1234567');
    expect(saved?.targets.map((t) => t.id)).toEqual(['t1']);
  });

  it('a new client is saved as filled in', () => {
    const form: Client = { ...blankClient(), name: 'דנה' };
    expect(mergeClientForm(form, undefined)).toBe(form);
  });
});
