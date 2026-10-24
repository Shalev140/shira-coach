/**
 * Backup & restore — several independent layers so no single failure loses data:
 *  1. Backup file (JSON) — download / share to Drive, WhatsApp, mail; restore by merge or replace.
 *  2. Automatic snapshots inside the app (daily + before every risky action) — "time machine".
 *  3. Automatic backup into a folder on the computer (e.g. a OneDrive / Google Drive folder).
 *  4. Excel-friendly CSV export of the training log (readable without the app).
 *  5. Persistent-storage request so the browser does not evict the database.
 */
import { db, DATA_TABLES, type DataTable } from './db';
import { getSettings, mergeSettings, saveProgram, seedExercises } from './repo';
import type { Program, ProgramVersion, Recommendation, Settings, Snapshot, SnapshotKind } from '../domain/types';
import { PROGRAM_STATUS } from '../domain/labels';
import { isoDate, now, uid } from '../domain/util';

export const BACKUP_APP = 'shira-coach';
export const BACKUP_FORMAT = 1;
declare const __APP_VERSION__: string;

export interface BackupPayload {
  app: string;
  format: number;
  appVersion: string;
  exportedAt: string;
  counts: Record<string, number>;
  checksum: string;
  data: Record<DataTable, Record<string, unknown>[]>;
}

/** FNV-1a 32-bit — fast integrity check that detects truncated / edited files. */
export function checksum(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Library exercises the trainer never edited are re-seeded by the app, so they are left out of backups. */
const untouchedSeed = (t: DataTable, r: Record<string, unknown>) => t === 'exercises' && r.custom === false && Number(r.updatedAt) <= 1;

export async function buildBackup(): Promise<BackupPayload> {
  const data = {} as BackupPayload['data'];
  const counts: Record<string, number> = {};
  await db.transaction('r', DATA_TABLES.map((t) => db.table(t)), async () => {
    for (const t of DATA_TABLES) {
      const rows = ((await db.table(t).toArray()) as Record<string, unknown>[]).filter((r) => !untouchedSeed(t, r));
      data[t] = rows;
      counts[t] = rows.filter((r) => !r.deletedAt).length;
    }
  });
  return {
    app: BACKUP_APP,
    format: BACKUP_FORMAT,
    appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev',
    exportedAt: new Date().toISOString(),
    counts,
    checksum: checksum(JSON.stringify(data)),
    data,
  };
}

export interface Validation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  payload?: BackupPayload;
  counts: Record<string, number>;
}

export const TABLE_LABELS: Record<DataTable, string> = {
  clients: 'מתאמנים',
  measurements: 'מדידות',
  notes: 'הערות',
  exercises: 'תרגילים מותאמים / שנערכו',
  programs: 'תוכניות',
  programVersions: 'גרסאות תוכנית',
  sessions: 'אימונים',
  recommendations: 'המלצות',
  settings: 'הגדרות',
};

export function validateBackup(raw: unknown): Validation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const counts: Record<string, number> = {};
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['הקובץ אינו קובץ גיבוי תקין.'], warnings, counts };
  const p = raw as Partial<BackupPayload>;
  if (p.app !== BACKUP_APP) errors.push('הקובץ לא נוצר על ידי האפליקציה הזו.');
  if (typeof p.format !== 'number' || p.format > BACKUP_FORMAT)
    errors.push('גרסת הקובץ חדשה מהאפליקציה — יש לעדכן את האפליקציה קודם.');
  if (!p.data || typeof p.data !== 'object') errors.push('חסרים נתונים בקובץ.');
  if (errors.length) return { ok: false, errors, warnings, counts };
  for (const t of DATA_TABLES) {
    const rows = (p.data as Record<string, unknown>)[t];
    if (rows === undefined) {
      warnings.push(`אין בקובץ ${TABLE_LABELS[t]}.`);
      continue;
    }
    if (!Array.isArray(rows)) {
      errors.push(`המבנה של ${TABLE_LABELS[t]} פגום.`);
      continue;
    }
    const bad = rows.filter((r) => !r || typeof r !== 'object' || typeof (r as { id?: unknown }).id !== 'string');
    if (bad.length) errors.push(`${bad.length} רשומות פגומות ב${TABLE_LABELS[t]}.`);
    counts[t] = rows.filter((r) => !(r as { deletedAt?: unknown }).deletedAt).length;
  }
  if (p.checksum && p.checksum !== checksum(JSON.stringify(p.data)))
    errors.push('בדיקת השלמות נכשלה — הקובץ נערך או נפגם.');
  return { ok: errors.length === 0, errors, warnings, counts, payload: p as BackupPayload };
}

export interface ImportResult {
  added: number;
  updated: number;
  skipped: number;
  /** programs moved to the archive because the merge left their client with a second active one */
  archivedPrograms: number;
}

/**
 * merge   — adds missing records and replaces a record only if the file's copy
 *           is newer (updatedAt). Nothing is lost on either side: the settings
 *           record also keeps the muscle groups only the older copy has.
 * replace — the database becomes exactly the file (a snapshot is taken first).
 * Either way, program-version numbers, recommendations and active programs that
 * two devices created in parallel are then repaired (see below).
 */
export async function importBackup(payload: BackupPayload, mode: 'merge' | 'replace'): Promise<ImportResult> {
  await createSnapshot(mode === 'replace' ? 'לפני שחזור מלא מקובץ' : 'לפני מיזוג מקובץ גיבוי');
  const res: ImportResult = { added: 0, updated: 0, skipped: 0, archivedPrograms: 0 };
  const tables = DATA_TABLES.map((t) => db.table(t));
  await db.transaction('rw', tables, async () => {
    for (const t of DATA_TABLES) {
      if (!Array.isArray(payload.data[t])) continue; // never wipe a table the file doesn't contain
      const rows = payload.data[t] as { id: string; updatedAt?: number }[];
      const table = db.table(t);
      if (mode === 'replace') {
        await table.clear();
        await table.bulkPut(rows);
        res.added += rows.length;
        continue;
      }
      const existing = new Map(((await table.bulkGet(rows.map((r) => r.id))) as ({ updatedAt?: number } | undefined)[]).map((r, i) => [rows[i].id, r]));
      const toPut: unknown[] = [];
      for (const r of rows) {
        const cur = existing.get(r.id);
        if (!cur) {
          toPut.push(r);
          res.added++;
        } else if ((r.updatedAt ?? 0) > (cur.updatedAt ?? 0)) {
          toPut.push(t === 'settings' ? unionSettings(r, cur).row : r);
          res.updated++;
        } else {
          // the local copy wins; the settings record still takes the muscle groups only the file has
          const kept = t === 'settings' ? unionSettings(cur, r) : null;
          if (kept?.gained) {
            toPut.push(kept.row);
            res.updated++;
          } else res.skipped++;
        }
      }
      if (toPut.length) await table.bulkPut(toPut);
    }
    const ids = (t: DataTable, key: string) => (Array.isArray(payload.data[t]) ? payload.data[t].map((r) => String(r[key])) : []);
    await renumberClashingVersions(ids('programVersions', 'programId'));
    await dropDuplicateRecommendations(ids('recommendations', 'clientId'));
    res.archivedPrograms = await archiveDuplicateActivePrograms(ids('programs', 'clientId'));
  });
  await seedExercises();
  return res;
}

/**
 * Settings are a single record, so "newer wins" alone would drop a muscle group the trainer
 * added on the other device (its custom exercises would then point at an unknown group and
 * drop out of the weekly volume). Every other field still comes from the newer copy, but muscle
 * groups and weight increments that only the older copy has are kept. A group deleted on either
 * device stays deleted (both copies remember deleted ids).
 */
function unionSettings(newerRow: object, olderRow: object): { row: Settings; gained: boolean } {
  const newer = newerRow as Partial<Settings>;
  const older = olderRow as Partial<Settings>;
  const deleted = new Set([...(newer.deletedMuscleIds ?? []), ...(older.deletedMuscleIds ?? [])]);
  const muscles = mergeSettings(newer).muscles.filter((m) => !deleted.has(m.id));
  const have = new Set(muscles.map((m) => m.id));
  let order = Math.max(-1, ...muscles.map((m) => m.order));
  const extra = [...mergeSettings(older).muscles]
    .sort((a, b) => a.order - b.order)
    .filter((m) => !have.has(m.id) && !deleted.has(m.id))
    .map((m) => ({ ...m, order: ++order }));
  const extraInc = Object.entries(older.increments ?? {}).filter(([k]) => !(k in (newer.increments ?? {})));
  const removed = mergeSettings(newer).muscles.length !== muscles.length;
  const gainedTombstones = [...deleted].some((id) => !(newer.deletedMuscleIds ?? []).includes(id));
  return {
    row: {
      ...newer,
      id: 'settings',
      muscles: [...muscles, ...extra],
      increments: { ...newer.increments, ...Object.fromEntries(extraInc) },
      deletedMuscleIds: [...deleted],
    } as Settings,
    gained: extra.length > 0 || extraInc.length > 0 || removed || gainedTombstones,
  };
}

/* ------------------------------------------------ repairs after a merge */

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** JSON with sorted keys — compares content regardless of property order. */
const canon = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

const contentOf = (p: Program): ProgramVersion['snapshot'] => ({
  name: p.name, goal: p.goal, phase: p.phase, startDate: p.startDate, endDate: p.endDate, status: p.status, workouts: p.workouts, notes: p.notes,
});

/**
 * Two devices that each saved a change to the same program both write "version n"
 * (different ids). Keeps the earliest at n and moves the others after the program's
 * last version, snapshot untouched so they can still be restored. Deterministic, so
 * merging in either direction gives the same numbers. updatedAt is left as it is:
 * every device repairs the same way, and the version's content did not change.
 */
async function renumberClashingVersions(programIds: string[]): Promise<void> {
  for (const pid of new Set(programIds)) {
    const rows = (await db.programVersions.where('programId').equals(pid).toArray())
      .filter((v) => !v.deletedAt)
      .sort((a, b) => a.version - b.version || a.createdAt - b.createdAt || byId(a, b));
    let top = rows.length ? rows[rows.length - 1].version : 0;
    const taken = new Set<number>();
    const moved = new Map<string, ProgramVersion>();
    for (const v of rows) {
      if (taken.has(v.version)) moved.set(v.id, { ...v, version: ++top });
      else taken.add(v.version);
    }
    if (!moved.size) continue;
    await db.programVersions.bulkPut([...moved.values()]);
    // the program points at the version its current content came from
    const p = await db.programs.get(pid);
    if (!p) continue;
    const content = canon(contentOf(p));
    const match = rows
      .map((v) => moved.get(v.id) ?? v)
      .filter((v) => canon(v.snapshot) === content)
      .sort((a, b) => b.version - a.version)[0];
    if (match && match.version !== p.version) await db.programs.put({ ...p, version: match.version });
  }
}

/**
 * Both devices can run the engine on the same data and create the same recommendation
 * (same dedupeKey) under different ids. A decided one wins over its pending twins; among
 * pending twins the earliest stays. Decided ones are never removed. updatedAt is kept, so
 * a decision taken on the other device for a dropped twin still wins on the next merge.
 */
async function dropDuplicateRecommendations(clientIds: string[]): Promise<void> {
  const t = now();
  for (const cid of new Set(clientIds)) {
    const groups = new Map<string, Recommendation[]>();
    for (const r of await db.recommendations.where('clientId').equals(cid).toArray()) {
      if (r.deletedAt || !r.dedupeKey) continue;
      groups.set(r.dedupeKey, [...(groups.get(r.dedupeKey) ?? []), r]);
    }
    const drop: Recommendation[] = [];
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      const pending = g.filter((r) => r.status === 'pending').sort((a, b) => a.createdAt - b.createdAt || byId(a, b));
      drop.push(...pending.slice(pending.length === g.length ? 1 : 0));
    }
    if (drop.length) await db.recommendations.bulkPut(drop.map((r) => ({ ...r, deletedAt: t })));
  }
}

/**
 * One device switches the client to a new cycle (the old one is archived) while the other,
 * not yet synced, edits the old cycle: that edit is newer, so the old cycle stays active next
 * to the new one. Keeps the program that was activated last and archives the others through
 * saveProgram, so each gets a version like any other status change and its content stays
 * restorable. Deterministic, so merging in either direction keeps the same program.
 * Returns how many programs were archived.
 */
async function archiveDuplicateActivePrograms(clientIds: string[]): Promise<number> {
  let archived = 0;
  for (const cid of new Set(clientIds)) {
    const active = (await db.programs.where('clientId').equals(cid).toArray()).filter((p) => !p.deletedAt && p.status === 'active');
    if (active.length < 2) continue;
    const ranked = await Promise.all(active.map(async (p) => ({ p, at: await activatedAt(p) })));
    ranked.sort((a, b) => b.at - a.at || b.p.updatedAt - a.p.updatedAt || byId(a.p, b.p));
    const keep = ranked[0].p;
    for (const { p } of ranked.slice(1)) {
      await saveProgram({ ...p, status: 'archived' }, { reason: `מיזוג גיבוי: הוחלפה בתוכנית "${keep.name}"` });
      archived++;
    }
  }
  return archived;
}

/**
 * When the program last became active: the newest version that moved it into 'active' — its
 * creation, or a status change. Each device diffed its versions against its own history, so an
 * edit made on a device that never saw the program archived does not count as an activation.
 */
async function activatedAt(p: Program): Promise<number> {
  const versions = (await db.programVersions.where('programId').equals(p.id).toArray())
    .filter((v) => !v.deletedAt)
    .sort((a, b) => a.createdAt - b.createdAt || byId(a, b));
  let at = 0;
  versions.forEach((v, i) => {
    const activated = i === 0 || v.changes.some((c) => c.to === PROGRAM_STATUS.active && c.from !== c.to);
    if (v.snapshot.status === 'active' && activated) at = Math.max(at, v.createdAt);
  });
  return at;
}

export async function parseBackupFile(file: File): Promise<Validation> {
  try {
    const text = await file.text();
    return validateBackup(JSON.parse(text));
  } catch {
    return { ok: false, errors: ['לא ניתן לקרוא את הקובץ (JSON לא תקין).'], warnings: [], counts: {} };
  }
}

/* ------------------------------------------------------------- snapshots */

const MAX_SNAPSHOTS = 20;

async function gzip(text: string): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null;
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

/** Restore points kept per kind: daily ones are the time machine, manual ones the trainer saved on purpose. */
const KEEP_DAILY = 12;
const KEEP_MANUAL = 5;

/**
 * `kind`: 'daily' for the automatic daily copy, 'event' for one taken before a single action
 * (deleting a workout or client, restoring, importing), 'manual' for "save now". The newest 12 daily and
 * 5 manual copies are protected; pruning drops the oldest of the rest (event copies, older daily ones)
 * first, so deleting many workouts in a row can't push the daily history or a saved point out.
 */
export async function createSnapshot(reason: string, kind: SnapshotKind = 'event'): Promise<Snapshot> {
  const payload = await buildBackup();
  const json = JSON.stringify(payload);
  const gz = await gzip(json);
  const snap: Snapshot = { id: uid(), createdAt: now(), reason, kind, counts: payload.counts, size: gz?.byteLength ?? json.length, ...(gz ? { gz } : { data: json }) };
  await db.snapshots.put(snap);
  const all = await db.snapshots.orderBy('createdAt').toArray();
  if (all.length > MAX_SNAPSHOTS) {
    const newest = (k: SnapshotKind, n: number) => all.filter((x) => x.kind === k).slice(-n).map((x) => x.id);
    const keep = new Set([...newest('daily', KEEP_DAILY), ...newest('manual', KEEP_MANUAL), snap.id]);
    // oldest first: event copies and surplus daily / manual copies go before the protected ones
    const order = [...all.filter((x) => !keep.has(x.id)), ...all.filter((x) => keep.has(x.id) && x.id !== snap.id)];
    await db.snapshots.bulkDelete(order.slice(0, all.length - MAX_SNAPSHOTS).map((x) => x.id));
  }
  // bookkeeping lives in meta so it never makes settings look "newer" in a merge; only the daily copy
  // resets the daily clock
  if (kind === 'daily') await db.meta.put({ key: 'lastSnapshotAt', value: snap.createdAt });
  return snap;
}

export async function listSnapshots(): Promise<Omit<Snapshot, 'data' | 'gz'>[]> {
  const all = await db.snapshots.orderBy('createdAt').reverse().toArray();
  return all.map(({ data: _data, gz: _gz, ...rest }) => rest);
}

export async function snapshotPayload(id: string): Promise<BackupPayload> {
  const snap = await db.snapshots.get(id);
  if (!snap) throw new Error('snapshot missing');
  const json = snap.gz ? await gunzip(snap.gz) : snap.data ?? '';
  const v = validateBackup(JSON.parse(json));
  if (!v.ok || !v.payload) throw new Error(v.errors.join(' '));
  return v.payload;
}

export async function restoreSnapshot(id: string): Promise<void> {
  await importBackup(await snapshotPayload(id), 'replace');
}

let snapshotting: Promise<boolean> | null = null;

/** Daily automatic snapshot (called at app start and after each workout). */
export function autoSnapshotIfDue(reason = 'גיבוי אוטומטי יומי'): Promise<boolean> {
  // one at a time — app start and a finished workout can trigger together
  snapshotting ??= (async () => {
    const s = await getSettings();
    if (!s.autoSnapshot) return false;
    const hasData = (await db.clients.count()) > 0 || (await db.sessions.count()) > 0;
    if (!hasData) return false;
    const last = (await db.meta.get('lastSnapshotAt'))?.value as number | undefined;
    if (last && now() - last < 20 * 3600 * 1000) return false;
    try {
      await createSnapshot(reason, 'daily');
    } catch (e) {
      // e.g. storage almost full — a missed safety copy must never block opening the app or finishing a workout
      console.warn('automatic snapshot failed', e);
      return false;
    }
    return true;
  })().finally(() => (snapshotting = null));
  return snapshotting;
}

/* ---------------------------------------------------------- export files */

export function backupFileName(prefix = 'shira-coach-backup'): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${prefix}-${isoDate(d)}-${hh}${mm}.json`;
}

export async function backupBlob(): Promise<Blob> {
  const payload = await buildBackup();
  return new Blob([JSON.stringify(payload)], { type: 'application/json' });
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export async function markExternalBackup() {
  await db.meta.put({ key: 'lastExternalBackupAt', value: now() });
}

export async function downloadBackup(): Promise<void> {
  downloadBlob(await backupBlob(), backupFileName());
  await markExternalBackup();
}

export function canShareFiles(): boolean {
  try {
    const f = new File(['{}'], 'x.json', { type: 'application/json' });
    return typeof navigator !== 'undefined' && !!navigator.canShare && navigator.canShare({ files: [f] });
  } catch {
    return false;
  }
}

/** Shares the backup file through the phone's share sheet (Drive, WhatsApp, mail…). */
export async function shareBackup(): Promise<'shared' | 'cancelled' | 'unsupported'> {
  const blob = await backupBlob();
  const file = new File([blob], backupFileName(), { type: 'application/json' });
  if (!navigator.canShare?.({ files: [file] })) return 'unsupported';
  try {
    await navigator.share({ files: [file], title: 'גיבוי Shira Coach', text: 'קובץ גיבוי של נתוני האימונים' });
    await markExternalBackup();
    return 'shared';
  } catch (e) {
    if ((e as DOMException)?.name === 'AbortError') return 'cancelled';
    throw e;
  }
}

/* ------------------------------------------------------- folder auto-backup */

type PermState = 'granted' | 'denied' | 'prompt';
interface DirHandle extends FileSystemDirectoryHandle {
  queryPermission(o: { mode: 'readwrite' }): Promise<PermState>;
  requestPermission(o: { mode: 'readwrite' }): Promise<PermState>;
}

export function folderBackupSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

export async function getBackupFolder(): Promise<DirHandle | null> {
  const row = await db.meta.get('backupDir');
  return (row?.value as DirHandle) ?? null;
}

export async function pickBackupFolder(): Promise<{ name: string; result: FolderResult }> {
  const picker = (window as unknown as { showDirectoryPicker: (o: object) => Promise<DirHandle> }).showDirectoryPicker;
  const handle = await picker({ id: 'shira-coach-backup', mode: 'readwrite', startIn: 'documents' });
  await db.meta.put({ key: 'backupDir', value: handle });
  return { name: handle.name, result: await writeFolderBackup(true) };
}

export async function forgetBackupFolder() {
  await db.meta.delete('backupDir');
}

/** `empty` — nothing real to back up yet, so the files already in the folder were left untouched. */
export type FolderResult = 'ok' | 'empty' | 'no-folder' | 'needs-permission' | 'error';

const AUTO_FILE = /^shira-coach-auto-\d{4}-\d{2}-\d{2}\.json$/;
const LATEST_FILE = 'shira-coach-latest.json';

const real = (r: { demo?: boolean; deletedAt?: number | null }) => !r.demo && !r.deletedAt;

/**
 * True when the device holds real (non-demo, not deleted) data. A fresh, wiped or demo-only
 * database — or one holding only a deleted test client — must never overwrite the backups
 * in the folder: they may be the only copy.
 */
async function hasRealData(): Promise<boolean> {
  // every workout / client program hangs on a client, so a real (non-demo, alive) client is the main test
  if (await db.clients.filter(real).first()) return true;
  // templates are real data without a client — once they hold an exercise (a blank new template is not)
  if (await db.programs.filter((p) => real(p) && p.clientId === null && p.workouts.some((w) => w.blocks.some((b) => b.items.length > 0))).first())
    return true;
  // the trainer's own library work: custom exercises, edited library entries, custom muscle groups
  if (await db.exercises.filter((e) => real(e) && (e.custom || e.updatedAt > 1)).first()) return true;
  return (await getSettings()).muscles.some((m) => m.custom);
}

/** Real clients in the folder's latest file — a device without any must not replace a copy that has them. */
async function folderClients(dir: DirHandle): Promise<number> {
  try {
    const v = await parseBackupFile(await (await dir.getFileHandle(LATEST_FILE)).getFile());
    return (v.payload?.data.clients ?? []).filter((c) => real(c as { demo?: boolean; deletedAt?: number | null })).length;
  } catch {
    return 0; // no backup file in the folder yet
  }
}

/**
 * Writes today's backup file into the chosen folder and keeps the 30 most recent.
 * Browsers require a click to re-grant folder access after a restart, so
 * non-interactive calls report `needs-permission` instead of prompting.
 */
export async function writeFolderBackup(interactive = false): Promise<FolderResult> {
  const dir = await getBackupFolder();
  if (!dir) return 'no-folder';
  try {
    let perm = await dir.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted' && interactive) perm = await dir.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') return 'needs-permission';
    if (!(await hasRealData())) return 'empty';
    if (!(await db.clients.filter(real).first()) && (await folderClients(dir)) > 0) return 'empty';
    const blob = await backupBlob();
    for (const name of [`shira-coach-auto-${isoDate()}.json`, LATEST_FILE]) {
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(blob);
      await w.close();
    }
    const autos: string[] = [];
    for await (const h of dir.values()) if (h.kind === 'file' && AUTO_FILE.test(h.name)) autos.push(h.name);
    autos.sort();
    for (const old of autos.slice(0, Math.max(0, autos.length - 30))) await dir.removeEntry(old);
    await db.meta.put({ key: 'lastFolderBackupAt', value: now() });
    await markExternalBackup();
    return 'ok';
  } catch (e) {
    console.warn('folder backup failed', e);
    return 'error';
  }
}

/** The latest backup in the chosen folder — offered as a restore when the device has no data yet. */
export async function readFolderLatest(): Promise<Validation | null> {
  const dir = await getBackupFolder();
  if (!dir) return null;
  try {
    if ((await dir.queryPermission({ mode: 'readwrite' })) !== 'granted') return null;
    return await parseBackupFile(await (await dir.getFileHandle(LATEST_FILE)).getFile());
  } catch {
    return null; // no backup file in the folder yet
  }
}

/* ------------------------------------------------------------- CSV export */

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: unknown[][]): Blob {
  const text = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  return new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }); // BOM → Hebrew opens correctly in Excel
}

export async function exportCsv(kind: 'sets' | 'clients' | 'measurements'): Promise<void> {
  const clients = new Map((await db.clients.toArray()).filter((c) => !c.deletedAt).map((c) => [c.id, c]));
  const exercises = new Map((await db.exercises.toArray()).map((e) => [e.id, e]));
  const TECH: Record<string, string> = { good: 'טובה', fix: 'נדרש תיקון', poor: 'לא מספקת', na: '' };
  let rows: unknown[][] = [];
  if (kind === 'sets') {
    rows.push([
      'תאריך', 'מתאמן/ת', 'אימון', 'קבוצה', 'תרגיל', 'סט', 'סוג', 'משקל מתוכנן', 'חזרות מתוכננות', 'שניות מתוכננות', 'RIR מתוכנן',
      'משקל', 'חזרות', 'שניות', 'RIR', 'RPE', 'בוצע', 'טכניקה', 'כאב', 'הערות',
    ]);
    const sessions = (await db.sessions.toArray()).filter((s) => !s.deletedAt && s.status === 'completed').sort((a, b) => a.startedAt - b.startedAt);
    for (const s of sessions) {
      const c = clients.get(s.clientId);
      if (!c) continue;
      for (const e of s.entries) {
        e.sets.forEach((set, i) => {
          const p = set.planned;
          const range = p ? (p.repsMin != null && p.repsMax != null && p.repsMin !== p.repsMax ? `${p.repsMin}-${p.repsMax}` : p.repsMin ?? p.repsMax ?? '') : '';
          rows.push([
            s.date, c.name, s.workoutName, e.blockLabel, exercises.get(e.exerciseId)?.nameHe ?? e.exerciseId, i + 1, set.type,
            p?.weight ?? '', range, p?.duration ?? '', p?.rir ?? '', set.weight ?? '', set.reps ?? '', set.duration ?? '', set.rir ?? '', set.rpe ?? '',
            set.done ? 'כן' : 'לא', TECH[set.technique ?? e.technique] ?? '', e.pain?.reported ? e.pain.location || 'כן' : '', [e.notes, set.note].filter(Boolean).join(' | '),
          ]);
        });
      }
    }
  } else if (kind === 'clients') {
    rows.push(['שם', 'טלפון', 'דוא״ל', 'תאריך לידה', 'גובה', 'תאריך התחלה', 'תדירות שבועית', 'מטרות', 'מגבלות', 'פציעות', 'הערות טכניות']);
    for (const c of clients.values())
      rows.push([c.name, c.phone, c.email, c.birthDate, c.height, c.startDate, c.weeklyFrequency, c.goals.join(' '), c.limitations, c.injuries, c.technicalNotes]);
  } else {
    rows.push(['תאריך', 'מתאמן/ת', 'משקל', 'אחוז שומן', 'מותן', 'ירכיים', 'חזה', 'זרוע', 'ירך', 'דופק מנוחה', 'הערה']);
    const ms = (await db.measurements.toArray()).filter((m) => !m.deletedAt).sort((a, b) => a.date.localeCompare(b.date));
    for (const m of ms) {
      const c = clients.get(m.clientId);
      if (c) rows.push([m.date, c.name, m.weight, m.bodyFat, m.waist, m.hips, m.chest, m.arm, m.thigh, m.restingHr, m.note]);
    }
  }
  const names = { sets: 'יומן-סטים', clients: 'מתאמנים', measurements: 'מדידות' };
  downloadBlob(toCsv(rows), `shira-coach-${names[kind]}-${isoDate()}.csv`);
  rows = [];
}

/* --------------------------------------------------------------- storage */

export async function requestPersistence(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function storageInfo(): Promise<{ persisted: boolean; usage: number; quota: number }> {
  try {
    const [persisted, est] = await Promise.all([navigator.storage?.persisted?.() ?? false, navigator.storage?.estimate?.() ?? {}]);
    return { persisted, usage: (est as StorageEstimate).usage ?? 0, quota: (est as StorageEstimate).quota ?? 0 };
  } catch {
    return { persisted: false, usage: 0, quota: 0 };
  }
}
