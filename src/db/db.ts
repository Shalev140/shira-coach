import Dexie, { type Table } from 'dexie';
import type {
  Client,
  ClientNote,
  Exercise,
  Measurement,
  Program,
  ProgramVersion,
  Recommendation,
  Session,
  Settings,
  Snapshot,
} from '../domain/types';

export interface MetaRow {
  key: string;
  value: unknown;
}

/**
 * On-device database (IndexedDB). The app is local-first: every write lands
 * here immediately, so it works fully offline and survives closing the tab.
 * Writes use strict durability so a crash right after "save set" keeps the set.
 */
export class CoachDB extends Dexie {
  clients!: Table<Client, string>;
  measurements!: Table<Measurement, string>;
  notes!: Table<ClientNote, string>;
  exercises!: Table<Exercise, string>;
  programs!: Table<Program, string>;
  programVersions!: Table<ProgramVersion, string>;
  sessions!: Table<Session, string>;
  recommendations!: Table<Recommendation, string>;
  settings!: Table<Settings, string>;
  snapshots!: Table<Snapshot, string>;
  meta!: Table<MetaRow, string>;

  constructor(name = 'shira-coach') {
    super(name, { chromeTransactionDurability: 'strict' });
    this.version(1).stores({
      clients: 'id, name, updatedAt',
      measurements: 'id, clientId, date, updatedAt',
      notes: 'id, clientId, kind, updatedAt',
      exercises: 'id, nameHe, updatedAt',
      programs: 'id, clientId, status, updatedAt',
      programVersions: 'id, programId, [programId+version], updatedAt',
      sessions: 'id, clientId, date, status, programId, startedAt, updatedAt',
      recommendations: 'id, clientId, status, type, dedupeKey, updatedAt',
      settings: 'id',
      snapshots: 'id, createdAt',
      meta: 'key',
    });
  }
}

export const db = new CoachDB();

/** Tables that make up the user's data (exported in backups and synced). */
export const DATA_TABLES = [
  'clients',
  'measurements',
  'notes',
  'exercises',
  'programs',
  'programVersions',
  'sessions',
  'recommendations',
  'settings',
] as const;

export type DataTable = (typeof DATA_TABLES)[number];
