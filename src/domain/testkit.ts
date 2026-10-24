/* Builders shared by the unit tests. */
import type { Client, Exercise, PerformedSet, Session, SessionEntry, Settings, Technique } from './types';
import { DEFAULT_SETTINGS } from './labels';
import { SEED_EXERCISES } from '../data/exercises';

export const settings = (patch: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...patch });

export const exerciseMap = (): Map<string, Exercise> =>
  new Map(SEED_EXERCISES.map((e) => [e.id, { ...e, custom: false, createdAt: 1, updatedAt: 1 } as Exercise]));

export const client = (patch: Partial<Client> = {}): Client => ({
  id: 'c1',
  createdAt: 1,
  updatedAt: 1,
  name: 'Test',
  plannedDays: [],
  goals: [],
  volumeTargets: {},
  volumePreset: 'intermediate',
  targets: [],
  ...patch,
});

let n = 0;
export function set(weight: number | null, reps: number | null, rir: number | null = 2, opts: Partial<PerformedSet> = {}): PerformedSet {
  return {
    id: `s${++n}`,
    type: 'working',
    planned: { weight, repsMin: 8, repsMax: 12, rir: 2, rest: 90 },
    weight,
    reps,
    rir,
    done: true,
    ...opts,
  };
}

export function entry(exerciseId: string, sets: PerformedSet[], patch: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id: `e${++n}`,
    exerciseId,
    blockLabel: 'A',
    blockType: 'single',
    section: 'main',
    status: 'done',
    sets,
    technique: 'good' as Technique,
    pain: { reported: false },
    setup: {},
    ...patch,
  };
}

export function session(date: string, entries: SessionEntry[], patch: Partial<Session> = {}): Session {
  const startedAt = new Date(`${date}T10:00:00`).getTime();
  return {
    id: `x${++n}`,
    createdAt: startedAt,
    updatedAt: startedAt,
    clientId: 'c1',
    workoutName: 'A',
    date,
    startedAt,
    endedAt: startedAt + 3600000,
    status: 'completed',
    entries,
    readiness: {},
    wrapUp: {},
    ...patch,
  };
}
