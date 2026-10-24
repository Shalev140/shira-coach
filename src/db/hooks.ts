import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo } from 'react';
import { db } from './db';
import { alive, mergeSettings } from './repo';
import type { Client, Exercise, ID, Program, Recommendation, Session, Settings } from '../domain/types';

export function useSettings(): Settings {
  const s = useLiveQuery(() => db.settings.get('settings'), []);
  return useMemo(() => mergeSettings(s), [s]);
}

export function useClients(includeArchived = false): Client[] | undefined {
  return useLiveQuery(async () => {
    const all = (await db.clients.toArray()).filter(alive);
    return all
      .filter((c) => includeArchived || !c.archived)
      .sort((a, b) => a.name.localeCompare(b.name, 'he'));
  }, [includeArchived]);
}

export function useClient(id?: ID): Client | null | undefined {
  return useLiveQuery(async () => {
    if (!id) return null;
    const c = await db.clients.get(id);
    return alive(c) ? c : null;
  }, [id]);
}

export function useExercises(): { list: Exercise[]; map: Map<ID, Exercise>; loaded: boolean } {
  const list = useLiveQuery(() => db.exercises.toArray(), []);
  return useMemo(() => {
    const live = (list ?? []).filter(alive);
    return {
      list: live.filter((e) => !e.archived).sort((a, b) => a.nameHe.localeCompare(b.nameHe, 'he')),
      map: new Map(live.map((e) => [e.id, e])),
      loaded: !!list,
    };
  }, [list]);
}

export function useClientSessions(clientId?: ID): Session[] | undefined {
  return useLiveQuery(async () => {
    if (!clientId) return [];
    const rows = await db.sessions.where('clientId').equals(clientId).toArray();
    return rows.filter(alive).sort((a, b) => b.startedAt - a.startedAt);
  }, [clientId]);
}

export function useAllSessions(): Session[] | undefined {
  return useLiveQuery(async () => (await db.sessions.toArray()).filter(alive).sort((a, b) => b.startedAt - a.startedAt), []);
}

export function useActiveSessions(): Session[] | undefined {
  return useLiveQuery(async () => (await db.sessions.where('status').equals('active').toArray()).filter(alive), []);
}

export function useSession(id?: ID): Session | null | undefined {
  return useLiveQuery(async () => {
    if (!id) return null;
    const s = await db.sessions.get(id);
    return alive(s) ? s : null;
  }, [id]);
}

export function usePrograms(clientId?: ID | null): Program[] | undefined {
  return useLiveQuery(async () => {
    const rows = clientId === undefined ? await db.programs.toArray() : (await db.programs.toArray()).filter((p) => p.clientId === clientId);
    return rows.filter(alive).sort((a, b) => b.updatedAt - a.updatedAt);
  }, [clientId]);
}

export function useProgram(id?: ID): Program | null | undefined {
  return useLiveQuery(async () => {
    if (!id) return null;
    const p = await db.programs.get(id);
    return alive(p) ? p : null;
  }, [id]);
}

export function useActiveProgram(clientId?: ID): Program | null | undefined {
  return useLiveQuery(async () => {
    if (!clientId) return null;
    const rows = (await db.programs.where('clientId').equals(clientId).toArray()).filter(alive);
    return rows.find((p) => p.status === 'active') ?? null;
  }, [clientId]);
}

export function useProgramVersions(programId?: ID) {
  return useLiveQuery(async () => {
    if (!programId) return [];
    return (await db.programVersions.where('programId').equals(programId).toArray()).filter(alive).sort((a, b) => b.version - a.version);
  }, [programId]);
}

export function useRecommendations(clientId?: ID): Recommendation[] | undefined {
  return useLiveQuery(async () => {
    const rows = clientId ? await db.recommendations.where('clientId').equals(clientId).toArray() : await db.recommendations.toArray();
    const liveClients = new Set((await db.clients.toArray()).filter((c) => alive(c)).map((c) => c.id));
    return rows.filter((r) => alive(r) && liveClients.has(r.clientId)).sort((a, b) => b.createdAt - a.createdAt);
  }, [clientId]);
}

export function useNotes(clientId?: ID) {
  return useLiveQuery(async () => {
    const rows = clientId ? await db.notes.where('clientId').equals(clientId).toArray() : await db.notes.toArray();
    return rows.filter(alive).sort((a, b) => b.createdAt - a.createdAt);
  }, [clientId]);
}

export function useMeasurements(clientId?: ID) {
  return useLiveQuery(async () => {
    if (!clientId) return [];
    return (await db.measurements.where('clientId').equals(clientId).toArray()).filter(alive).sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt);
  }, [clientId]);
}

export function useMeta<T>(key: string): T | undefined {
  return useLiveQuery(async () => (await db.meta.get(key))?.value as T | undefined, [key]);
}
