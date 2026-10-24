/**
 * All writes go through this module so every record gets ids, timestamps and
 * history (soft deletes, program versions) consistently.
 */
import { db } from './db';
import { SEED_EXERCISES } from '../data/exercises';
import { CLIENT_COLORS, DEFAULT_SETTINGS } from '../domain/labels';
import type {
  Block,
  Client,
  ClientNote,
  Exercise,
  ExerciseData,
  ID,
  Measurement,
  NoteKind,
  PerformedSet,
  PlannedExercise,
  PlannedSet,
  PlannedWorkout,
  Program,
  ProgramVersion,
  Recommendation,
  RecStatus,
  RecSuggestion,
  RecType,
  Session,
  SessionEntry,
  SessionWrapUp,
  Settings,
} from '../domain/types';
import { blockedIncreaseRecs, evaluableLater, isLoadIncrease, reevaluatedLater, runRules, sameSeries, staleProgressionRecs, type RecDraft } from '../domain/engine';
import { noteMatchesEntry, noteShowsIn } from '../domain/agenda';
import { diffPrograms } from '../domain/programDiff';
import { previousOccurrence } from '../domain/progress';
import { deepClone, isoDate, now, uid } from '../domain/util';

export const alive = <T extends { deletedAt?: number | null }>(r: T | undefined | null): r is T => !!r && !r.deletedAt;

/* ---------------------------------------------------------------- settings */

export async function getSettings(): Promise<Settings> {
  const s = await db.settings.get('settings');
  return mergeSettings(s);
}

export function mergeSettings(s?: Partial<Settings> | null): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...(s ?? {}),
    increments: { ...DEFAULT_SETTINGS.increments, ...(s?.increments ?? {}) },
    muscles: s?.muscles?.length ? s.muscles : DEFAULT_SETTINGS.muscles,
  } as Settings;
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const cur = await getSettings();
  const next = { ...cur, ...patch, id: 'settings' as const };
  // re-tapping the selected option changes nothing — keep updatedAt, so a backup merge can't treat this
  // copy as "newer" and revert real changes made on another device
  if (fingerprint({ ...next, updatedAt: 0 }) === fingerprint({ ...cur, updatedAt: 0 })) return;
  await db.settings.put({ ...next, updatedAt: now() });
}

/* -------------------------------------------------------------------- init */

/** Inserts seed exercises that are missing (never overwrites the trainer's edits). */
export async function seedExercises(): Promise<number> {
  const stored = new Map((await db.exercises.toArray()).map((e) => [e.id, e]));
  // updatedAt = 1 so any edit by the trainer (or a backup) always wins a merge. A library entry the trainer
  // never touched also follows fixes to the library data (e.g. a stale per-exercise load jump that would
  // otherwise override the jumps chosen in Settings).
  const put = SEED_EXERCISES.map((e): Exercise => ({ ...e, custom: false, createdAt: 1, updatedAt: 1 })).filter((e) => {
    const cur = stored.get(e.id);
    return !cur || (cur.updatedAt <= 1 && !cur.deletedAt && JSON.stringify(cur) !== JSON.stringify(e));
  });
  if (put.length) await db.exercises.bulkPut(put);
  return put.length;
}

export async function initDatabase(): Promise<void> {
  await db.open();
  const s = await db.settings.get('settings');
  // defaults get updatedAt 0, so settings restored from a backup (merge) always win over them
  if (!s) await db.settings.put({ ...DEFAULT_SETTINGS, updatedAt: 0 });
  else {
    // one-time move of backup bookkeeping out of settings (it used to bump settings.updatedAt)
    for (const key of ['lastExternalBackupAt', 'lastSnapshotAt'] as const) {
      if (s[key] && !(await db.meta.get(key))) await db.meta.put({ key, value: s[key] });
    }
  }
  await seedExercises();
}

/* ----------------------------------------------------------------- clients */

export function blankClient(): Client {
  const t = now();
  return {
    id: uid(),
    createdAt: t,
    updatedAt: t,
    name: '',
    plannedDays: [],
    goals: [],
    volumeTargets: {},
    volumePreset: 'intermediate',
    targets: [],
    startDate: isoDate(),
    trainingType: 'personal',
    weeklyFrequency: 2,
    color: CLIENT_COLORS[Math.floor(Math.random() * CLIENT_COLORS.length)],
  };
}

export async function saveClient(c: Client): Promise<void> {
  await db.clients.put({ ...c, updatedAt: now() });
}

export async function setClientArchived(id: ID, archived: boolean): Promise<void> {
  await db.clients.update(id, { archived, updatedAt: now() });
}

/** Soft-deletes a client and everything linked to it (after a safety snapshot). */
export async function deleteClient(id: ID): Promise<void> {
  const { createSnapshot } = await import('./backup');
  const c = await db.clients.get(id);
  await createSnapshot(`לפני מחיקת ${c?.name ?? 'מתאמן/ת'}`);
  const t = now();
  await db.transaction('rw', [db.clients, db.measurements, db.notes, db.programs, db.sessions, db.recommendations], async () => {
    await db.clients.update(id, { deletedAt: t, updatedAt: t });
    for (const table of [db.measurements, db.notes, db.programs, db.sessions, db.recommendations] as const) {
      await (table as typeof db.notes).where('clientId').equals(id).modify({ deletedAt: t, updatedAt: t });
    }
  });
}

/* ------------------------------------------------------------ measurements */

export async function addMeasurement(m: Omit<Measurement, 'id' | 'createdAt' | 'updatedAt'>): Promise<void> {
  const t = now();
  await db.measurements.put({ ...m, id: uid(), createdAt: t, updatedAt: t });
}

export async function updateMeasurement(m: Measurement): Promise<void> {
  await db.measurements.put({ ...m, updatedAt: now() });
}

export async function softDelete(table: 'measurements' | 'notes' | 'programs' | 'sessions' | 'recommendations' | 'exercises', id: ID) {
  const t = now();
  await (db[table] as typeof db.notes).update(id, { deletedAt: t, updatedAt: t });
}

/* ------------------------------------------------------------------- notes */

export async function addNote(clientId: ID, kind: NoteKind, text: string, extra: Partial<ClientNote> = {}): Promise<ClientNote> {
  const t = now();
  const note: ClientNote = { id: uid(), createdAt: t, updatedAt: t, clientId, kind, text: text.trim(), ...extra };
  await db.notes.put(note);
  return note;
}

export async function updateNote(id: ID, patch: Partial<ClientNote>): Promise<void> {
  await db.notes.update(id, { ...patch, updatedAt: now() });
}

export async function resolveNote(id: ID, done = true): Promise<void> {
  await db.notes.update(id, { done, resolvedAt: done ? now() : null, updatedAt: now() });
}

/* --------------------------------------------------------------- exercises */

export async function saveExercise(ex: Exercise): Promise<void> {
  await db.exercises.put({ ...ex, updatedAt: now() });
}

export function blankExercise(data: Partial<ExerciseData> = {}): Exercise {
  const t = now();
  return {
    id: 'cx_' + uid().slice(0, 8),
    createdAt: t,
    updatedAt: t,
    custom: true,
    nameHe: '',
    nameEn: '',
    aliases: [],
    primary: [],
    secondary: [],
    pattern: 'other',
    equipment: 'machine',
    difficulty: 1,
    cues: [],
    mistakes: [],
    alternatives: [],
    ...data,
  };
}

/* ---------------------------------------------------------------- programs */

export function blankSet(type: PlannedSet['type'] = 'working', from?: Partial<PlannedSet>): PlannedSet {
  return { id: uid(), type, weight: null, repsMin: 8, repsMax: 12, rir: 2, rpe: null, rest: 90, duration: null, ...from, ...(from ? { id: uid() } : {}) };
}

export function blankPlannedExercise(exerciseId: ID, sets = 3, template?: Partial<PlannedSet>): PlannedExercise {
  return {
    id: uid(),
    exerciseId,
    sets: Array.from({ length: sets }, () => blankSet('working', template)),
    setup: {},
  };
}

export function blankBlock(section: Block['section'] = 'main', type: Block['type'] = 'single'): Block {
  return { id: uid(), type, section, rounds: null, restAfter: null, items: [] };
}

export function blankWorkout(name: string): PlannedWorkout {
  return { id: uid(), name, days: [], blocks: [] };
}

export function blankProgram(clientId: ID | null, name = 'תוכנית חדשה'): Program {
  const t = now();
  return {
    id: uid(),
    createdAt: t,
    updatedAt: t,
    clientId,
    name,
    goal: 'hypertrophy',
    status: clientId ? 'active' : 'draft',
    version: 0,
    startDate: isoDate(),
    workouts: [blankWorkout('A')],
  };
}

const snapOf = (p: Program): ProgramVersion['snapshot'] =>
  deepClone({ name: p.name, goal: p.goal, phase: p.phase, startDate: p.startDate, endDate: p.endDate, status: p.status, workouts: p.workouts, notes: p.notes });

/** Content fingerprint for "did anything change" checks: key order is ignored and '' / null / undefined count as empty. */
function fingerprint(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x === '' || x === null
      ? undefined
      : x && typeof x === 'object' && !Array.isArray(x)
        ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : x,
  );
}

export async function latestVersion(programId: ID): Promise<ProgramVersion | undefined> {
  const versions = await db.programVersions.where('programId').equals(programId).toArray();
  return versions.filter(alive).sort((a, b) => b.version - a.version)[0];
}

/**
 * Saves a program. When content changed compared with the last version, a new
 * immutable version is written with the diff, date, reason and approver.
 */
export async function saveProgram(
  program: Program,
  opts: { reason?: string; recommendationId?: ID } = {},
): Promise<{ program: Program; version: ProgramVersion | null }> {
  const exercises = new Map((await db.exercises.toArray()).map((e) => [e.id, e]));
  const settings = await getSettings();
  let version: ProgramVersion | null = null;
  let next = program;
  // read the latest version INSIDE the write transaction so two quick saves can't both become "version n+1"
  await db.transaction('rw', [db.programs, db.programVersions], async () => {
    const versions = (await db.programVersions.where('programId').equals(program.id).toArray())
      .filter(alive)
      .sort((a, b) => b.version - a.version || b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
    const top = versions[0];
    // diff against the version the STORED program actually holds (after a backup merge the highest
    // number can belong to another device's branch), falling back to the highest one
    const stored = await db.programs.get(program.id);
    const prev = (stored && versions.find((v) => v.version === stored.version)) ?? top;
    const changes = diffPrograms(prev?.snapshot ?? null, snapOf(program), exercises);
    const t = now();
    next = { ...program, updatedAt: t, version: stored?.version ?? prev?.version ?? program.version };
    if (!prev || changes.length) {
      const n = (top?.version ?? 0) + 1;
      next = { ...next, version: n };
      version = {
        id: uid(),
        createdAt: t,
        updatedAt: t,
        programId: program.id,
        clientId: program.clientId,
        version: n,
        reason: opts.reason?.trim() || (prev ? 'עדכון תוכנית' : 'יצירת תוכנית'),
        approvedBy: settings.trainerName || 'המאמנת',
        changes,
        snapshot: snapOf(next),
        recommendationId: opts.recommendationId,
        demo: program.demo,
      };
      await db.programVersions.put(version);
    } else {
      // a save that changed nothing keeps the stored timestamp, so a backup merge can't let this
      // untouched copy win over a newer plan from another device
      if (stored && fingerprint({ ...stored, updatedAt: 0 }) === fingerprint({ ...next, updatedAt: 0 })) next = { ...next, updatedAt: stored.updatedAt };
    }
    await db.programs.put(next);
  });
  return { program: next, version };
}

/** Makes a program the client's active one; other active programs are archived. */
export async function activateProgram(program: Program): Promise<void> {
  if (program.clientId) {
    const others = (await db.programs.where('clientId').equals(program.clientId).toArray()).filter(
      (p) => alive(p) && p.id !== program.id && p.status === 'active',
    );
    for (const o of others) await saveProgram({ ...o, status: 'archived' }, { reason: `הוחלפה בתוכנית "${program.name}"` });
  }
  await saveProgram({ ...program, status: 'active' }, { reason: 'הפעלת תוכנית' });
}

/** Deep copy with fresh ids — used for templates, duplicating and "copy previous workout". */
export function cloneWorkout(w: PlannedWorkout, name?: string): PlannedWorkout {
  return {
    ...deepClone(w),
    id: uid(),
    name: name ?? w.name,
    blocks: w.blocks.map((b) => ({
      ...deepClone(b),
      id: uid(),
      items: b.items.map((i) => ({ ...deepClone(i), id: uid(), sets: i.sets.map((s) => ({ ...s, id: uid() })) })),
    })),
  };
}

export async function duplicateProgram(src: Program, clientId: ID | null, name?: string): Promise<Program> {
  // a copy for a demo client is demo data too, so "מחיקת נתוני הדגמה" removes it with its client
  const demo = clientId ? (await db.clients.get(clientId))?.demo : undefined;
  const t = now();
  const p: Program = {
    ...deepClone(src),
    id: uid(),
    createdAt: t,
    updatedAt: t,
    clientId,
    name: name ?? `${src.name} (עותק)`,
    status: clientId ? 'draft' : 'draft',
    version: 0,
    workouts: src.workouts.map((w) => cloneWorkout(w)),
    demo,
    deletedAt: null,
  };
  const { program } = await saveProgram(p, { reason: src.clientId === null ? `נוצרה מתבנית "${src.name}"` : `שוכפלה מ"${src.name}"` });
  return program;
}

/** Restores a version's content. The status stays as it is now (restoring must never create a second active program). */
export async function restoreProgramVersion(program: Program, v: ProgramVersion): Promise<Program> {
  const current = (await db.programs.get(program.id)) ?? program;
  const s = deepClone(v.snapshot);
  // every snapshot field is set explicitly: one missing from the snapshot (a JSON backup drops
  // undefined keys) must clear the current value, not keep it
  const { program: saved } = await saveProgram(
    { ...current, name: s.name, goal: s.goal, phase: s.phase, startDate: s.startDate, endDate: s.endDate, notes: s.notes, workouts: s.workouts, status: current.status },
    { reason: `שחזור לגרסה ${v.version}` },
  );
  return saved;
}

/* ---------------------------------------------------------------- sessions */

const SECTION_ORDER = { warmup: 0, main: 1, finisher: 2 } as const;

function labelBlocks(w: PlannedWorkout): { block: Block; label: string }[] {
  const ordered = [...w.blocks].sort((a, b) => SECTION_ORDER[a.section] - SECTION_ORDER[b.section]);
  let main = 0;
  let warm = 0;
  let fin = 0;
  return ordered.map((block) => {
    if (block.section === 'warmup') return { block, label: `ח${++warm}` };
    if (block.section === 'finisher') return { block, label: `ס${++fin}` };
    return { block, label: String.fromCharCode(65 + (main++ % 26)) };
  });
}

export function blockOrderLabels(w: PlannedWorkout): Map<ID, string> {
  return new Map(labelBlocks(w).map(({ block, label }) => [block.id, label]));
}

function performedFromPlan(s: PlannedSet): PerformedSet {
  return {
    id: uid(),
    plannedSetId: s.id,
    type: s.type,
    planned: { weight: s.weight, repsMin: s.repsMin, repsMax: s.repsMax, rir: s.rir, rpe: s.rpe, rest: s.rest, duration: s.duration },
    weight: s.weight ?? null,
    reps: null,
    rir: null,
    rpe: null,
    duration: null,
    done: false,
  };
}

export function entriesFromWorkout(w: PlannedWorkout, history: Session[] = []): SessionEntry[] {
  const out: SessionEntry[] = [];
  for (const { block, label } of labelBlocks(w)) {
    const multi = block.items.length > 1;
    block.items.forEach((item, idx) => {
      const rounds = block.type === 'circuit' && block.rounds && block.rounds > 1 ? block.rounds : 1;
      const sets: PerformedSet[] = [];
      for (let r = 0; r < rounds; r++) for (const s of item.sets) sets.push(performedFromPlan(s));
      // no planned weight → carry over the last performed weight of the same set type, by position
      // (a warm-up weight must never land on a working set), from this slot's own last time first
      // (a heavy and a light day, or a main and a finisher slot, must not get each other's load)
      const prev = previousOccurrence(history, item.exerciseId, undefined, item.id);
      if (prev) {
        const seen: Partial<Record<PerformedSet['type'], number>> = {};
        for (const s of sets) {
          const k = (seen[s.type] = (seen[s.type] ?? -1) + 1);
          if (s.weight != null) continue;
          const same = prev.entry.sets.filter((p) => p.done && p.type === s.type && p.weight != null);
          s.weight = same.length ? same[Math.min(k, same.length - 1)].weight ?? null : null;
        }
      }
      out.push({
        id: uid(),
        plannedExerciseId: item.id,
        exerciseId: item.exerciseId,
        blockId: block.id,
        blockLabel: multi ? `${label}${idx + 1}` : label,
        blockType: block.type,
        section: block.section,
        status: 'pending',
        sets,
        technique: 'na',
        pain: { reported: false },
        notes: '',
        setup: deepClone(item.setup ?? {}),
      });
    });
  }
  return out;
}

export async function activeSessions(): Promise<Session[]> {
  return (await db.sessions.where('status').equals('active').toArray()).filter(alive);
}

export async function startSession(opts: { clientId: ID; program?: Program | null; workoutId?: ID | null; name?: string }): Promise<Session> {
  // check + insert in ONE write transaction: a double-tapped start button must never open two workouts
  return db.transaction('rw', [db.sessions, db.clients], async () => {
    const existing = (await activeSessions()).find((s) => s.clientId === opts.clientId);
    if (existing) return existing;
    const history = (await db.sessions.where('clientId').equals(opts.clientId).toArray()).filter(alive);
    const client = await db.clients.get(opts.clientId);
    const workout = opts.program?.workouts.find((w) => w.id === opts.workoutId) ?? null;
    const t = now();
    const session: Session = {
      id: uid(),
      createdAt: t,
      updatedAt: t,
      clientId: opts.clientId,
      programId: opts.program?.id ?? null,
      programVersion: opts.program?.version ?? null,
      plannedWorkoutId: workout?.id ?? null,
      workoutName: workout?.name ?? opts.name ?? 'אימון חופשי',
      plannedSnapshot: workout ? deepClone(workout) : null,
      date: isoDate(),
      startedAt: t,
      status: 'active',
      entries: workout ? entriesFromWorkout(workout, history) : [],
      readiness: {},
      wrapUp: {},
      currentIndex: 0,
      demo: client?.demo,
    };
    await db.sessions.put(session);
    return session;
  });
}

/** Autosave — called on every meaningful change during a workout. */
export async function saveSession(s: Session): Promise<void> {
  await db.sessions.put({ ...s, updatedAt: now() });
}

export async function completeSession(s: Session, wrapUp?: SessionWrapUp): Promise<{ session: Session; created: Recommendation[] }> {
  const t = now();
  // notes for "the next session" that this workout showed are closed (the summary can reopen); a note
  // about one exercise waits for the workout that actually trains it (in its slot) — unless the client's
  // active program no longer has that exercise / slot (swapped out / removed), so it would wait forever.
  // Only notes the workout displayed are touched — the summary lists exactly these as "shown".
  const active = (await db.programs.where('clientId').equals(s.clientId).toArray()).find((p) => alive(p) && p.status === 'active');
  const items = active ? active.workouts.flatMap((w) => w.blocks.flatMap((b) => b.items)) : [];
  const stillPlanned = (n: ClientNote) =>
    !active ||
    items.some((i) => i.exerciseId === n.exerciseId && (!n.plannedExerciseId || n.programId !== active.id || i.id === n.plannedExerciseId));
  const shown = (await db.notes.where('clientId').equals(s.clientId).toArray()).filter(
    (n) =>
      noteShowsIn(n, s) &&
      (!n.exerciseId || !stillPlanned(n) || s.entries.some((e) => noteMatchesEntry(n, e, s) && e.sets.some((x) => x.done))),
  );
  for (const n of shown) await db.notes.update(n.id, { done: true, resolvedAt: t, updatedAt: t });
  const done: Session = {
    ...s,
    shownNoteIds: [...(s.shownNoteIds ?? []), ...shown.map((n) => n.id)],
    status: 'completed',
    endedAt: s.endedAt ?? t,
    wrapUp: { ...s.wrapUp, ...(wrapUp ?? {}) },
    entries: s.entries.map((e) => {
      if (e.status !== 'pending') return e;
      const any = e.sets.some((x) => x.done);
      return { ...e, status: any ? 'done' : 'notdone' };
    }),
    updatedAt: t,
  };
  await db.sessions.put(done);
  // the workout is saved as completed at this point — advice failing must not make "finish" fail
  let created: Recommendation[] = [];
  try {
    created = await runEngine(done.clientId, done.id);
  } catch (e) {
    console.warn('post-workout recommendations failed', e);
  }
  // background safety copies; failures here must never block finishing a workout
  void import('./backup')
    .then(async (b) => {
      await b.autoSnapshotIfDue('גיבוי אוטומטי אחרי אימון');
      await b.writeFolderBackup(false);
    })
    .catch((e) => console.warn('post-workout backup failed', e));
  return { session: done, created };
}

/**
 * Deletes a workout (soft). Deleting a FINISHED workout first takes a safety snapshot (its logged sets
 * stay restorable from the backup screen) and takes back what it caused: its open recommendations are
 * withdrawn, older advice it withdrew comes back, and the "next session" notes it closed are open again.
 */
export async function discardSession(id: ID): Promise<void> {
  const before = await db.sessions.get(id);
  if (alive(before) && before.status === 'completed') {
    const { createSnapshot } = await import('./backup');
    try {
      await createSnapshot(`לפני מחיקת אימון ${before.workoutName} ${before.date}`, 'event');
    } catch (e) {
      // the confirm promised a restore point — without one, nothing is deleted
      console.error('snapshot before delete failed', e);
      throw new Error('לא הצלחתי לשמור נקודת שחזור לפני המחיקה, ולכן האימון לא נמחק. כדאי לפנות מקום באחסון ולנסות שוב.');
    }
  }
  const t = now();
  await db.transaction('rw', [db.sessions, db.recommendations, db.notes], async () => {
    const s = await db.sessions.get(id);
    await db.sessions.update(id, { status: 'abandoned', deletedAt: t, updatedAt: t });
    if (!alive(s) || s.status !== 'completed') return;
    const recs = (await db.recommendations.where('clientId').equals(s.clientId).toArray()).filter((r) => alive(r) && r.status === 'pending' && r.sourceSessionId === id);
    for (const r of recs) {
      // advice computed from this workout's numbers is withdrawn; advice it only triggered (goal range,
      // stagnation, weekly checks — their key has no session) is retired, so a later workout can raise it again
      if (r.dedupeKey.endsWith(`|${id}`)) await db.recommendations.update(r.id, { status: 'rejected', decidedAt: t, updatedAt: t, decisionNote: SOURCE_DELETED });
      else await db.recommendations.update(r.id, { deletedAt: t, updatedAt: t });
    }
    const others = (await db.sessions.where('clientId').equals(s.clientId).toArray()).filter((o) => alive(o) && o.id !== id);
    await reviveWithdrawn(s.clientId, id, others, t);
    // a note that a LATER (still existing) workout showed again stays closed — an earlier one could only
    // have closed it before it was reopened
    const shownLater = new Set(others.filter((o) => o.startedAt > s.startedAt).flatMap((o) => o.shownNoteIds ?? []));
    for (const nid of s.shownNoteIds ?? []) {
      const n = await db.notes.get(nid);
      if (alive(n) && n.done && !shownLater.has(nid)) await db.notes.update(nid, { done: false, resolvedAt: null, updatedAt: t });
    }
  });
}

/* --------------------------------------------------------- recommendations */

// pain / technique checks are closed only by the trainer — never withdrawn automatically
const SAFETY_TYPES: RecType[] = ['painCheck', 'techniqueCheck'];
const WITHDRAWN_AFTER_FIX = 'בוטלה אוטומטית: נתוני האימון תוקנו והם כבר לא תומכים בהמלצה';
// advice computed from the logged numbers of one session (what a corrected set can invalidate)
const NUMBER_BASED: RecType[] = ['increaseWeight', 'addReps', 'reduceLoad', 'adjustRange'];
const SOURCE_DELETED = 'בוטלה: האימון שממנו נוצרה נמחק';
// older advice withdrawn automatically by a newer workout
const BLOCKED_LATER = 'בוטלה אוטומטית: דווח כאב / טכניקה לא תקינה באימון מאוחר יותר';
const SUPERSEDED_LATER = 'הוחלפה בהערכה מאימון מאוחר יותר';

/** A recommendation withdrawn automatically remembers the workout that did it, so deleting / correcting that workout can undo it. */
type WithdrawableRec = Recommendation & { withdrawnBySessionId?: ID | null };

/**
 * Older advice that workout `by` withdrew automatically (superseded / blocked) is pending again once `by`
 * no longer does that (it was deleted, or its sets were corrected) — unless another newer workout still
 * does, which then owns the withdrawal. `sessions` are the client's alive sessions. Runs inside a write
 * transaction on recommendations.
 */
async function reviveWithdrawn(clientId: ID, by: ID, sessions: Session[], t: number): Promise<void> {
  const recs = (await db.recommendations.where('clientId').equals(clientId).toArray()).filter(alive) as WithdrawableRec[];
  // an open pain / technique check keeps a load increase for its exercise withdrawn until the trainer closes it
  const openChecks = new Set(recs.filter((x) => x.status === 'pending' && SAFETY_TYPES.includes(x.type)).map((x) => x.exerciseId));
  const byId = new Map(sessions.map((o) => [o.id, o]));
  for (const r of recs) {
    if (r.withdrawnBySessionId !== by || r.status !== 'rejected' || (r.decisionNote !== BLOCKED_LATER && r.decisionNote !== SUPERSEDED_LATER)) continue;
    const src = r.sourceSessionId ? byId.get(r.sourceSessionId) : undefined;
    if (!src) continue; // its own workout is gone too — it stays withdrawn
    if (r.type !== 'reduceLoad' && openChecks.has(r.exerciseId)) continue;
    // the same advice for the same series was already acted on from a newer workout → nothing to revive
    const series = (x: Recommendation) => ({
      slot: x.suggestion?.plannedExerciseId,
      programId: (x.sourceSessionId ? byId.get(x.sourceSessionId)?.programId : undefined) ?? x.programId,
    });
    const actedOnLater = recs.some(
      (x) =>
        x.id !== r.id &&
        x.type === r.type &&
        x.exerciseId === r.exerciseId &&
        sameSeries(series(r), series(x)) &&
        (x.status === 'applied' || x.status === 'approved' || x.status === 'edited') &&
        x.createdAt > r.createdAt,
    );
    if (actedOnLater) continue;
    const asPending: Recommendation = { ...r, status: 'pending' };
    const reason = (o: Session) =>
      blockedIncreaseRecs([asPending], o, byId).length ? BLOCKED_LATER : staleProgressionRecs([asPending], o, byId).length ? SUPERSEDED_LATER : null;
    const still = sessions
      .filter((o) => o.status === 'completed' && o.startedAt > src.startedAt)
      .sort((a, b) => a.startedAt - b.startedAt)
      .find((o) => !!reason(o));
    const note = still ? reason(still) : null;
    if (!still) await db.recommendations.update(r.id, { status: 'pending', decidedAt: null, decisionNote: undefined, withdrawnBySessionId: null, updatedAt: t } as Partial<WithdrawableRec>);
    else if (still.id !== by || note !== r.decisionNote)
      await db.recommendations.update(r.id, { decisionNote: note ?? r.decisionNote, withdrawnBySessionId: still.id, updatedAt: t } as Partial<WithdrawableRec>);
  }
}

export async function runEngine(clientId: ID, sessionId?: ID | null): Promise<Recommendation[]> {
  const [client, sessions, exercisesArr, programs, settings, existing] = await Promise.all([
    db.clients.get(clientId),
    db.sessions.where('clientId').equals(clientId).toArray(),
    db.exercises.toArray(),
    db.programs.where('clientId').equals(clientId).toArray(),
    getSettings(),
    db.recommendations.where('clientId').equals(clientId).toArray(),
  ]);
  if (!alive(client)) return [];
  const program = programs.filter(alive).find((p) => p.status === 'active') ?? null;
  const live = sessions.filter(alive);
  const drafts = runRules({
    client,
    sessions: live,
    exercises: new Map(exercisesArr.map((e) => [e.id, e])),
    program,
    settings,
    today: isoDate(),
    sessionId,
    existing: existing.filter(alive),
  });
  const t = now();
  const focus = sessionId ? live.find((s) => s.id === sessionId) : null;
  const byId = new Map(live.map((s) => [s.id, s]));
  const created: Recommendation[] = [];
  // dedupe + supersede against the CURRENT rows inside the write transaction, so a
  // double-tapped "finish" or "re-check" can never create the same recommendation twice
  await db.transaction('rw', db.recommendations, async () => {
    const current = (await db.recommendations.where('clientId').equals(clientId).toArray()).filter(alive);
    const keys = new Set(current.map((r) => r.dedupeKey));
    // re-checking a finished session (e.g. after a set was corrected in the summary) refreshes its own
    // open recommendations in place instead of keeping advice based on the old numbers
    const own = new Map<string, Recommendation>();
    if (focus?.status === 'completed')
      for (const r of current)
        if (r.sourceSessionId === focus.id && (r.status === 'pending' || (r.status === 'rejected' && r.decisionNote === WITHDRAWN_AFTER_FIX)))
          own.set(r.dedupeKey, r);
    for (const d of drafts) {
      const mine = own.get(d.dedupeKey);
      if (mine) {
        own.delete(d.dedupeKey); // the first draft per key wins, as when it was created
        const revive = mine.status !== 'pending';
        const before = Object.fromEntries(Object.keys(d).map((k) => [k, mine[k as keyof RecDraft]]));
        if (revive || fingerprint(d) !== fingerprint(before)) {
          const patch: Partial<Recommendation> = { ...d, updatedAt: t, ...(revive ? { status: 'pending', decidedAt: null, decisionNote: undefined } : {}) };
          await db.recommendations.update(mine.id, patch);
          if (revive) created.push({ ...mine, ...patch });
        }
        continue;
      }
      if (keys.has(d.dedupeKey)) continue;
      keys.add(d.dedupeKey);
      created.push({ ...d, id: uid(), createdAt: t, updatedAt: t, status: 'pending', demo: client.demo });
    }
    // ...and withdraws the ones tied to this session's numbers that the corrected data no longer supports.
    // Only set-number advice can be "corrected away"; swap / safety advice stays, and an exercise that a
    // newer session re-evaluated isn't re-evaluated here at all (so silence is not a correction).
    // (slot-aware: the same criterion the engine uses to skip re-evaluation)
    for (const r of own.values())
      if (
        r.status === 'pending' &&
        r.exerciseId &&
        NUMBER_BASED.includes(r.type) &&
        // a load reduction is still judged on these numbers after a newer safety flag (that only blocks pushing forward)
        !(focus && (r.type === 'reduceLoad' ? evaluableLater : reevaluatedLater)(live, focus, r.exerciseId, r.suggestion?.plannedExerciseId)) &&
        r.dedupeKey.endsWith(`|${r.sourceSessionId}`)
      )
        await db.recommendations.update(r.id, { status: 'rejected', decidedAt: t, updatedAt: t, decisionNote: WITHDRAWN_AFTER_FIX });
    if (focus) {
      const blocked = new Set(blockedIncreaseRecs(current, focus, byId).map((r) => r.id));
      const stale = staleProgressionRecs(current, focus, byId).filter((r) => !blocked.has(r.id));
      const withdraw = (decisionNote: string): Partial<WithdrawableRec> => ({ status: 'rejected', decidedAt: t, updatedAt: t, decisionNote, withdrawnBySessionId: focus.id });
      for (const r of current.filter((x) => blocked.has(x.id))) await db.recommendations.update(r.id, withdraw(BLOCKED_LATER));
      for (const r of stale) await db.recommendations.update(r.id, withdraw(SUPERSEDED_LATER));
    }
    if (created.length) await db.recommendations.bulkPut(created);
    // re-checking a corrected session: older advice it withdrew earlier comes back if it no longer does
    if (focus?.status === 'completed') await reviveWithdrawn(clientId, focus.id, live, t);
  });
  return created;
}

export async function decideRecommendation(id: ID, status: RecStatus, patch: Partial<Recommendation> = {}): Promise<void> {
  await db.recommendations.update(id, { ...patch, status, decidedAt: now(), updatedAt: now() });
}

/**
 * Applies an approved recommendation to the client's active program, creating a
 * new program version that references the recommendation (closing the loop).
 */
export async function applyRecommendation(
  rec: Recommendation,
  override?: RecOverride,
): Promise<{ applied: boolean; message: string }> {
  // claim it atomically BEFORE any side effect: a double tap (or a second open screen) must not apply
  // the same recommendation twice, nor overwrite the first call's result
  const t = now();
  let blockedBySafety = false;
  const fresh = await db.transaction('rw', db.recommendations, async () => {
    const r = await db.recommendations.get(rec.id);
    if (!alive(r) || r.status !== 'pending') return null;
    // safety gate (defence in depth): no load increase while a pain / technique check on the
    // same exercise is still open — the trainer resolves the check first
    if (isLoadIncrease(r) && r.exerciseId) {
      const open = await db.recommendations
        .where('clientId')
        .equals(r.clientId)
        .filter((x) => alive(x) && x.status === 'pending' && SAFETY_TYPES.includes(x.type) && x.exerciseId === r.exerciseId)
        .count();
      if (open) {
        blockedBySafety = true;
        return null;
      }
    }
    await db.recommendations.update(r.id, { status: 'applied', decidedAt: t, updatedAt: t });
    return r;
  });
  if (blockedBySafety) return { applied: false, message: 'יש בדיקת כאב / טכניקה פתוחה לתרגיל — יש לטפל בה לפני העלאת עומס' };
  if (!fresh) return { applied: false, message: 'ההמלצה כבר טופלה' };
  try {
    return await applyClaimed(fresh, override);
  } catch (e) {
    // nothing was applied → release the claim so the trainer can try again
    await db.recommendations.update(fresh.id, { status: 'pending', decidedAt: null, updatedAt: now() });
    throw e;
  }
}

type RecOverride = { weight?: number | null; repsMin?: number | null; repsMax?: number | null; reps?: number | null; alternativeId?: ID | null; note?: string };

const isWork = (st: PlannedSet) => st.type === 'working' || st.type === 'backoff';
const topOf = (i: PlannedExercise) => Math.max(0, ...i.sets.filter(isWork).map((st) => st.weight ?? 0));

/**
 * The program slot for a weight / range recommendation whose own slot no longer exists (program
 * duplicated for a new cycle, exercise re-added, a free workout). Returns undefined
 * rather than guessing: a heavy and a light day must never be mixed up.
 */
function fallbackSlot(workouts: PlannedWorkout[], items: PlannedExercise[], s: RecSuggestion, src: Session | undefined, target: number | null) {
  // the workout the evidence came from — by id, or by a unique name after a "next cycle" duplicate
  const inWorkout = (w: PlannedWorkout | undefined) => (w ? items.filter((i) => w.blocks.some((b) => b.items.includes(i))) : []);
  const named = src?.plannedWorkoutId ? workouts.filter((w) => w.name === src.workoutName) : [];
  const home = workouts.find((w) => w.id === src?.plannedWorkoutId) ?? (named.length === 1 ? named[0] : undefined);
  const narrowed = inWorkout(home);
  // that workout has no slot of this exercise (it was swapped in there for another one): another
  // workout's slot would be a guess, judged against a different plan
  if (home && !narrowed.length) return undefined;
  if (narrowed.length === 1) return narrowed[0];
  const pool = narrowed.length ? narrowed : items;
  if (s.kind === 'range') {
    if (pool.length === 1) return pool[0];
    // the slot whose planned range is the one the recommendation starts from
    const [min, max] = (s.from ?? '').split(/[–-]/).map(Number);
    const match = pool.filter((i) => {
      const ws = i.sets.filter(isWork);
      return (
        ws.length > 0 &&
        Math.min(...ws.map((x) => x.repsMin ?? Infinity)) === min &&
        Math.max(...ws.map((x) => x.repsMax ?? x.repsMin ?? -Infinity)) === max
      );
    });
    return match.length === 1 ? match[0] : undefined;
  }
  // weight: compare loads only with slots that have planned weights, and never let an increase
  // lower a slot (or a decrease raise one)
  const from = Number(s.from);
  if (target == null || !Number.isFinite(from)) return pool.length === 1 ? pool[0] : undefined;
  const fits = (i: PlannedExercise) => {
    const top = topOf(i);
    if (!top) return pool.length === 1;
    return target >= from ? top <= target : top >= target;
  };
  const dist = (i: PlannedExercise) => Math.abs(topOf(i) - from);
  const ok = pool.filter(fits).sort((a, b) => dist(a) - dist(b));
  return ok.length > 1 && dist(ok[0]) === dist(ok[1]) ? undefined : ok[0];
}

async function applyClaimed(rec: Recommendation, override?: RecOverride): Promise<{ applied: boolean; message: string }> {
  const s = rec.suggestion;
  // evidence from a workout that was deleted afterwards must not change anything
  const src = rec.sourceSessionId ? await db.sessions.get(rec.sourceSessionId) : undefined;
  if (rec.sourceSessionId && !alive(src)) {
    await decideRecommendation(rec.id, 'rejected', {
      decisionNote: SOURCE_DELETED,
      // advice the workout only triggered (no session in its key) is retired, so a later workout can raise it again
      ...(rec.dedupeKey.endsWith(`|${rec.sourceSessionId}`) ? {} : { deletedAt: now() }),
    });
    return { applied: false, message: 'האימון שממנו נוצרה ההמלצה נמחק — ההמלצה בוטלה' };
  }
  const edited =
    !!override &&
    ((override.weight !== undefined && String(override.weight) !== s.to) ||
      (override.reps !== undefined && String(override.reps) !== s.to) ||
      override.repsMin !== undefined ||
      (override.alternativeId !== undefined && override.alternativeId !== s.alternativeIds?.[0]));
  const finish = async (msg: string, version?: number | null) => {
    await decideRecommendation(rec.id, 'applied', {
      appliedVersion: version ?? null,
      decisionNote: override?.note ?? rec.decisionNote,
      editedTo: edited ? JSON.stringify(override) : rec.editedTo,
    });
    return { applied: true, message: msg };
  };

  if (s.kind === 'reps') {
    const ex = s.exerciseId ? await db.exercises.get(s.exerciseId) : null;
    await addNote(rec.clientId, 'next', `${ex?.nameHe ?? ''}: לכוון ל-${override?.reps ?? s.to} חזרות לסט`, {
      exerciseId: s.exerciseId,
      plannedExerciseId: s.plannedExerciseId ?? null,
      programId: src?.programId ?? rec.programId ?? null,
      demo: rec.demo,
    });
    return finish('נוסף דגש לאימון הבא');
  }
  if (s.kind === 'none') {
    await decideRecommendation(rec.id, 'approved', { decisionNote: override?.note });
    return { applied: false, message: 'ההמלצה אושרה' };
  }

  const program = (await db.programs.where('clientId').equals(rec.clientId).toArray()).find((p) => alive(p) && p.status === 'active');
  if (!program || !s.exerciseId) {
    await decideRecommendation(rec.id, 'approved', { decisionNote: 'אין תוכנית פעילה לעדכון' });
    return { applied: false, message: 'אושרה — אין תוכנית פעילה לעדכון' };
  }
  const next = deepClone(program);
  const items = next.workouts.flatMap((w) => w.blocks.flatMap((b) => b.items)).filter((i) => i.exerciseId === s.exerciseId);
  const target = s.kind === 'weight' ? (override?.weight ?? s.weight ?? null) : null;
  // weight / range changes go to the program slot the evidence came from (a heavy and a light day
  // must not both get the same weight)
  let targets: PlannedExercise[] = items;
  if (s.kind === 'weight' || s.kind === 'range') {
    const slot = items.find((i) => i.id === s.plannedExerciseId) ?? fallbackSlot(next.workouts, items, s, src, target);
    if (!slot && items.length) {
      await decideRecommendation(rec.id, 'approved', { decisionNote: 'לא ברור לאיזה אימון בתוכנית להחיל — לא עודכן אוטומטית' });
      return { applied: false, message: 'אושרה — לא ברור לאיזה אימון בתוכנית להחיל. אפשר לעדכן ידנית בעורך התוכנית' };
    }
    targets = slot ? [slot] : [];
  }
  // the performed sets the evidence came from (a slot without planned weights is shifted from them) — the
  // slot AND the exercise: an exercise swapped in mid-exercise shares its slot with the one it replaced
  const srcEntry =
    src?.entries.find((e) => !!s.plannedExerciseId && e.plannedExerciseId === s.plannedExerciseId && e.exerciseId === s.exerciseId) ??
    src?.entries.find((e) => e.exerciseId === s.exerciseId && e.section !== 'warmup');
  const shift = (w: number, by: number) => Math.max(0, Math.round((w + by) * 100) / 100);
  for (const item of targets) {
    if (s.kind === 'swap') {
      const alt = override?.alternativeId ?? s.alternativeIds?.[0];
      if (alt) {
        item.exerciseId = alt;
        // the old exercise's loads don't apply to the new one — the next session carries over its own history
        for (const st of item.sets) st.weight = null;
      }
      continue;
    }
    if (s.kind === 'weight') {
      if (target == null) continue;
      // shift relative to the PLANNED top set (keeps pyramids / back-off structure); a set without a
      // planned weight is shifted from what was performed in it (same set type and position as the
      // carry-over), so a back-off set never jumps to the top-set target
      const plannedTop = topOf(item);
      const from = Number(s.from);
      const seen: Partial<Record<PlannedSet['type'], number>> = {};
      for (const set of item.sets) {
        const k = (seen[set.type] = (seen[set.type] ?? -1) + 1);
        if (set.type === 'warmup') continue;
        if (set.weight != null && plannedTop > 0) {
          set.weight = shift(set.weight, target - plannedTop);
          continue;
        }
        const same = srcEntry?.sets.filter((p) => p.done && p.type === set.type && p.weight != null) ?? [];
        const performed = same.length ? same[Math.min(k, same.length - 1)].weight : null;
        if (performed != null && Number.isFinite(from)) set.weight = shift(performed, target - from);
        else if (set.type === 'working') set.weight = target;
      }
    }
    if (s.kind === 'range') {
      for (const set of item.sets) {
        if (!isWork(set)) continue;
        set.repsMin = override?.repsMin ?? s.repsMin ?? set.repsMin;
        set.repsMax = override?.repsMax ?? s.repsMax ?? set.repsMax;
      }
    }
  }
  const touched = targets.length;
  if (!touched) {
    await decideRecommendation(rec.id, 'approved', { decisionNote: 'התרגיל לא נמצא בתוכנית הפעילה' });
    return { applied: false, message: 'אושרה — התרגיל לא נמצא בתוכנית הפעילה' };
  }
  const { version } = await saveProgram(next, { reason: `המלצה: ${rec.title}`, recommendationId: rec.id });
  return finish(`התוכנית עודכנה (גרסה ${version?.version ?? next.version})`, version?.version);
}
