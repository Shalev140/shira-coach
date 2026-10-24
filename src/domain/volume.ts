/**
 * Weekly volume per muscle group (spec §10).
 *
 * The rule, shown to the trainer in the app:
 *  • Every completed working set gives +1 DIRECT set to each PRIMARY muscle of the exercise.
 *  • It also gives an INDIRECT contribution to each SECONDARY muscle, weighted by a factor:
 *    the exercise's own factor if one was set, otherwise the global factor from settings (default 0.5).
 *  • Effective sets = direct + Σ(indirect × factor).  Targets are compared to EFFECTIVE sets
 *    (or to direct sets only, if the trainer chooses so in settings — `targetBasis`).
 *  • Warm-up sets never count. Drop sets count unless disabled. Optionally only "hard" sets
 *    (RIR ≤ threshold) count.
 */
import type {
  Client,
  Exercise,
  ID,
  MuscleId,
  PerformedSet,
  PlannedSet,
  PlannedWorkout,
  Program,
  Session,
  Settings,
  VolumeTarget,
} from './types';
import { presetTarget } from './labels';
import { addDays, weekStart } from './util';

export interface Contribution {
  exerciseId: ID;
  sessionId?: ID;
  date?: string;
  sets: number;
  factor: number; // 1 for direct
  role: 'primary' | 'secondary';
}

export interface MuscleVolume {
  muscle: MuscleId;
  direct: number;
  indirectRaw: number; // number of sets where muscle was secondary
  indirect: number; // weighted
  effective: number;
  frequency: number; // sessions with ≥1 direct set
  touched: number; // sessions with any contribution
  byDay: Record<string, number>; // date → effective sets
  contributions: Contribution[];
  target?: VolumeTarget;
  status: 'none' | 'under' | 'ok' | 'over';
}

export function setCounts(s: PerformedSet | PlannedSet, settings: Settings, performed: boolean): boolean {
  if (s.type === 'warmup') return false;
  if (s.type === 'drop' && !settings.countDropSets) return false;
  if (performed && !(s as PerformedSet).done) return false;
  if (settings.hardSetMaxRir !== null) {
    // performed and planned sets are judged the same way: RIR, or the RIR an RPE stands for (10 − RPE),
    // so the plan view and doing exactly the plan count the same sets. In RPE mode the RPE is what the
    // trainer sees and edits, so it decides (a hidden leftover RIR default must not). Sets without either count.
    const fromRpe = s.rpe != null ? 10 - s.rpe : null;
    const rir = settings.rirMode === 'rpe' ? fromRpe ?? (performed ? s.rir ?? null : null) : s.rir ?? fromRpe;
    if (rir !== null && rir !== undefined && rir > settings.hardSetMaxRir) return false;
  }
  return true;
}

export function muscleFactors(ex: Exercise, settings: Settings): { muscle: MuscleId; factor: number; role: 'primary' | 'secondary' }[] {
  const out: { muscle: MuscleId; factor: number; role: 'primary' | 'secondary' }[] = ex.primary.map((m) => ({
    muscle: m,
    factor: 1,
    role: 'primary' as const,
  }));
  for (const c of ex.secondary) {
    if (ex.primary.includes(c.muscle)) continue;
    const factor = c.factor ?? settings.indirectFactor;
    if (factor > 0) out.push({ muscle: c.muscle, factor, role: 'secondary' });
  }
  return out;
}

export function clientTarget(client: Client | undefined, muscle: MuscleId): VolumeTarget | undefined {
  if (!client) return undefined;
  const t = client.volumeTargets?.[muscle];
  if (t) return t.max > 0 ? t : undefined; // an explicit 0 target means "not tracked for this client"
  if (client.volumePreset) return presetTarget(client.volumePreset, muscle);
  return undefined;
}

function emptyVolume(muscle: MuscleId): MuscleVolume {
  return {
    muscle,
    direct: 0,
    indirectRaw: 0,
    indirect: 0,
    effective: 0,
    frequency: 0,
    touched: 0,
    byDay: {},
    contributions: [],
    status: 'none',
  };
}

function finalize(map: Map<MuscleId, MuscleVolume>, settings: Settings, client?: Client): MuscleVolume[] {
  const muscles = settings.muscles.filter((m) => !m.hidden).sort((a, b) => a.order - b.order);
  return muscles.map((m) => {
    const v = map.get(m.id) ?? emptyVolume(m.id);
    v.indirect = Math.round(v.indirect * 100) / 100;
    v.effective = Math.round((v.direct + v.indirect) * 100) / 100;
    v.target = clientTarget(client, m.id);
    if (v.target) {
      if (v.effective < v.target.min) v.status = 'under';
      else if (v.effective > v.target.max) v.status = 'over';
      else v.status = 'ok';
    }
    return v;
  });
}

/** Volume actually performed in the given sessions. */
export function performedVolume(
  sessions: Session[],
  exercises: Map<ID, Exercise>,
  settings: Settings,
  client?: Client,
): MuscleVolume[] {
  const map = new Map<MuscleId, MuscleVolume>();
  const get = (m: MuscleId) => {
    let v = map.get(m);
    if (!v) map.set(m, (v = emptyVolume(m)));
    return v;
  };
  for (const session of sessions) {
    if (session.deletedAt || session.status === 'abandoned') continue;
    const directIn = new Set<MuscleId>();
    const touchedIn = new Set<MuscleId>();
    for (const entry of session.entries) {
      const ex = exercises.get(entry.exerciseId);
      if (!ex) continue;
      const n = entry.sets.filter((s) => setCounts(s, settings, true)).length;
      if (!n) continue;
      for (const { muscle, factor, role } of muscleFactors(ex, settings)) {
        const v = get(muscle);
        if (role === 'primary') {
          v.direct += n;
          directIn.add(muscle);
        } else {
          v.indirectRaw += n;
          v.indirect += n * factor;
        }
        touchedIn.add(muscle);
        v.byDay[session.date] = (v.byDay[session.date] ?? 0) + n * factor;
        v.contributions.push({ exerciseId: ex.id, sessionId: session.id, date: session.date, sets: n, factor, role });
      }
    }
    directIn.forEach((m) => get(m).frequency++);
    touchedIn.forEach((m) => get(m).touched++);
  }
  return finalize(map, settings, client);
}

/** How many times per week a planned workout is expected to run. */
export function workoutsPerWeek(w: PlannedWorkout, program: Program): number {
  if (w.days.length) return w.days.length;
  return program.workouts.length ? 1 : 0;
}

/** Volume the program intends per week (planned working sets). */
export function plannedVolume(
  program: Program,
  exercises: Map<ID, Exercise>,
  settings: Settings,
  client?: Client,
): MuscleVolume[] {
  const map = new Map<MuscleId, MuscleVolume>();
  const get = (m: MuscleId) => {
    let v = map.get(m);
    if (!v) map.set(m, (v = emptyVolume(m)));
    return v;
  };
  for (const w of program.workouts) {
    const times = workoutsPerWeek(w, program);
    if (!times) continue;
    const directIn = new Set<MuscleId>();
    for (const block of w.blocks) {
      const rounds = block.type === 'circuit' && block.rounds ? block.rounds : 1;
      for (const item of block.items) {
        const ex = exercises.get(item.exerciseId);
        if (!ex) continue;
        const n = item.sets.filter((s) => setCounts(s, settings, false)).length * rounds * times;
        if (!n) continue;
        for (const { muscle, factor, role } of muscleFactors(ex, settings)) {
          const v = get(muscle);
          if (role === 'primary') {
            v.direct += n;
            directIn.add(muscle);
          } else {
            v.indirectRaw += n;
            v.indirect += n * factor;
          }
          v.contributions.push({ exerciseId: ex.id, sets: n, factor, role });
        }
      }
    }
    directIn.forEach((m) => (get(m).frequency += times));
  }
  return finalize(map, settings, client);
}

export interface WeekRange {
  start: string;
  end: string; // inclusive
}

export function weekRange(date: string, startsOn: 0 | 1): WeekRange {
  const start = weekStart(date, startsOn);
  return { start, end: addDays(start, 6) };
}

export function sessionsInRange(sessions: Session[], range: WeekRange): Session[] {
  return sessions.filter(
    (s) => !s.deletedAt && s.status !== 'abandoned' && s.date >= range.start && s.date <= range.end,
  );
}

export interface OverlapFlag {
  muscle: MuscleId;
  dayA: string;
  dayB: string;
  setsA: number;
  setsB: number;
}

/**
 * Load distribution: flags muscles that received substantial work on two
 * consecutive days (≤ 1 day apart) — little recovery between sessions.
 */
export function adjacentOverlap(volumes: MuscleVolume[], minSets = 4): OverlapFlag[] {
  const flags: OverlapFlag[] = [];
  for (const v of volumes) {
    const days = Object.keys(v.byDay).sort();
    for (let i = 1; i < days.length; i++) {
      const a = days[i - 1];
      const b = days[i];
      if (addDays(a, 1) !== b) continue;
      if (v.byDay[a] >= minSets && v.byDay[b] >= minSets)
        flags.push({ muscle: v.muscle, dayA: a, dayB: b, setsA: v.byDay[a], setsB: v.byDay[b] });
    }
  }
  return flags;
}

/** Groups contributions by exercise for the "how was this calculated" panel. */
export function explainContributions(v: MuscleVolume): { exerciseId: ID; role: 'primary' | 'secondary'; sets: number; factor: number; value: number }[] {
  const map = new Map<string, { exerciseId: ID; role: 'primary' | 'secondary'; sets: number; factor: number; value: number }>();
  for (const c of v.contributions) {
    const key = `${c.exerciseId}|${c.role}|${c.factor}`;
    const cur = map.get(key) ?? { exerciseId: c.exerciseId, role: c.role, sets: 0, factor: c.factor, value: 0 };
    cur.sets += c.sets;
    cur.value = Math.round(cur.sets * c.factor * 100) / 100;
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => (a.role === b.role ? b.value - a.value : a.role === 'primary' ? -1 : 1));
}
