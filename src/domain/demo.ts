/**
 * Demo data: three example clients with programs and ~6 weeks of logged
 * workouts, so the trainer can explore every screen. Every record carries
 * `demo: true` and is removed in one action without touching real data.
 */
import { db, DATA_TABLES } from '../db/db';
import {
  blankBlock,
  blankClient,
  blankPlannedExercise,
  blankProgram,
  blankWorkout,
  entriesFromWorkout,
  runEngine,
  saveProgram,
  decideRecommendation,
} from '../db/repo';
import type { Block, BlockSection, BlockType, Client, ClientNote, Measurement, PlannedWorkout, Program, Session } from './types';
import { addDays, isoDate, parseDate, uid } from './util';

interface Item {
  ex: string;
  sets: number;
  min: number;
  max: number;
  rir: number | null;
  rest: number;
  /** starting weight (kg) six weeks ago; 0 = bodyweight */
  w: number;
  /** load step when the client tops the range */
  inc: number;
  dur?: number;
}

function workout(name: string, focus: string, days: number[], groups: { section?: BlockSection; type?: BlockType; items: Item[]; restAfter?: number }[]): { w: PlannedWorkout; specs: Map<string, Item> } {
  const w = blankWorkout(name);
  w.focus = focus;
  w.days = days;
  const specs = new Map<string, Item>();
  for (const g of groups) {
    const b: Block = blankBlock(g.section ?? 'main', g.type ?? (g.items.length > 1 ? 'superset' : 'single'));
    b.restAfter = g.restAfter ?? null;
    for (const it of g.items) {
      const pe = blankPlannedExercise(it.ex, it.sets, {
        repsMin: it.dur ? null : it.min,
        repsMax: it.dur ? null : it.max,
        rir: it.rir,
        rest: it.rest,
        duration: it.dur ?? null,
        weight: null,
      });
      b.items.push(pe);
      specs.set(pe.id, it);
    }
    w.blocks.push(b);
  }
  return { w, specs };
}

const dowOffset = (base: number, k: number) => (base + k + 7) % 7;

interface Scenario {
  client: Partial<Client>;
  program: { name: string; goal: Program['goal']; phase: string; workouts: ReturnType<typeof workout>[] };
  weeks: number;
  /** tweak performance: k = occurrence index of this exercise, n = total occurrences */
  perf?: (ex: string, k: number, n: number) => { repsDelta?: number; weightDelta?: number; rirDelta?: number } | null;
  extras?: (sessions: Session[], client: Client) => void;
  notes?: { kind: ClientNote['kind']; text: string }[];
  measurements?: (start: string) => Partial<Measurement>[];
}

function simulate(sc: Scenario, client: Client, program: Program, specsById: Map<string, Item>): Session[] {
  const today = isoDate();
  const start = addDays(today, -sc.weeks * 7);
  const sessions: Session[] = [];
  const occurrences = new Map<string, number>();
  const totals = new Map<string, number>();
  const plan: { date: string; w: PlannedWorkout }[] = [];
  let rot = 0;
  for (let d = start; d < today; d = addDays(d, 1)) {
    const dow = parseDate(d).getDay();
    if (!client.plannedDays.includes(dow)) continue;
    const w = program.workouts.find((x) => x.days.includes(dow)) ?? program.workouts[rot++ % program.workouts.length];
    plan.push({ date: d, w });
    for (const b of w.blocks) for (const it of b.items) totals.set(it.exerciseId, (totals.get(it.exerciseId) ?? 0) + 1);
  }
  for (const { date, w } of plan) {
    const startedAt = parseDate(date).getTime() + (8 + Math.floor(Math.random() * 9)) * 3600000;
    const entries = entriesFromWorkout(w, sessions);
    for (const e of entries) {
      const it = specsById.get(e.plannedExerciseId!)!;
      const k = occurrences.get(e.exerciseId) ?? 0;
      occurrences.set(e.exerciseId, k + 1);
      const n = totals.get(e.exerciseId) ?? 1;
      const tweak = sc.perf?.(e.exerciseId, k, n) ?? {};
      // double progression: reps climb by 1–2 per session, then weight steps up
      const span = Math.max(1, it.max - it.min);
      const stepsPerLoad = Math.max(2, Math.ceil(span / 2) + 1);
      const loadSteps = Math.floor(k / stepsPerLoad);
      const repStep = k % stepsPerLoad;
      const weight = it.w ? Math.round((it.w + loadSteps * it.inc + (tweak.weightDelta ?? 0)) * 2) / 2 : null;
      e.status = 'done';
      e.technique = Math.random() < 0.75 ? 'good' : 'na';
      e.sets.forEach((s, si) => {
        if (s.type === 'warmup') {
          s.weight = weight ? Math.round(weight * 0.5) : null;
          s.reps = 10;
        } else if (it.dur) {
          s.duration = it.dur + Math.min(30, loadSteps * 5);
        } else {
          const reps = Math.min(it.max, it.min + Math.round((repStep * span) / (stepsPerLoad - 1))) - (si === e.sets.length - 1 && repStep > 0 ? 1 : 0) + (tweak.repsDelta ?? 0);
          s.reps = Math.max(1, reps);
          s.weight = weight;
          s.rir = it.rir === null ? null : Math.max(0, it.rir + (si === 0 ? 1 : 0) + (tweak.rirDelta ?? 0));
        }
        s.done = true;
        s.doneAt = startedAt + (si + 1) * 120000;
      });
    }
    const session: Session = {
      id: uid(),
      createdAt: startedAt,
      updatedAt: startedAt + 3600000,
      clientId: client.id,
      programId: program.id,
      programVersion: program.version,
      plannedWorkoutId: w.id,
      workoutName: w.name,
      plannedSnapshot: JSON.parse(JSON.stringify(w)),
      date,
      startedAt,
      endedAt: startedAt + (50 + Math.floor(Math.random() * 20)) * 60000,
      status: 'completed',
      entries,
      readiness: Math.random() < 0.5 ? { energy: 3 + Math.round(Math.random()), sleep: 3 + Math.round(Math.random()) } : {},
      wrapUp: { effort: 7 + Math.round(Math.random() * 1.4), feeling: 4 },
      demo: true,
    };
    sessions.push(session);
  }
  sc.extras?.(sessions, client);
  return sessions;
}

export async function loadDemoData(): Promise<void> {
  await removeDemoData();
  const todayDow = new Date().getDay();
  const scenarios: Scenario[] = [
    {
      client: {
        name: 'נועה כהן (הדגמה)',
        phone: '050-0000001',
        birthDate: '1994-03-12',
        height: 166,
        goals: ['muscle', 'strength'],
        experience: 'intermediate',
        fitnessLevel: 4,
        weeklyFrequency: 3,
        plannedDays: [dowOffset(todayDow, 0), dowOffset(todayDow, -2), dowOffset(todayDow, -4)].sort(),
        volumePreset: 'intermediate',
        technicalNotes: 'אוהבת סופר-סטים. לשים לב לנעילת שכמות בלחיצות.',
        color: '#5B4CF0',
      },
      weeks: 6,
      program: {
        name: 'עליון / תחתון — היפרטרופיה',
        goal: 'hypertrophy',
        phase: 'מזו׳ 2 · שבועות 1–6',
        workouts: [
          workout('A', 'פלג גוף עליון', [], [
            { section: 'warmup', items: [{ ex: 'band_pull_apart', sets: 2, min: 15, max: 15, rir: null, rest: 30, w: 0, inc: 0 }] },
            { items: [{ ex: 'bench_press_db', sets: 3, min: 8, max: 12, rir: 2, rest: 0, w: 14, inc: 2 }, { ex: 'row_cable_seated', sets: 3, min: 10, max: 12, rir: 2, rest: 90, w: 35, inc: 2.5 }], restAfter: 90 },
            { items: [{ ex: 'shoulder_press_db', sets: 3, min: 8, max: 12, rir: 2, rest: 0, w: 9, inc: 1 }, { ex: 'lat_pulldown', sets: 3, min: 10, max: 12, rir: 2, rest: 90, w: 35, inc: 5 }], restAfter: 90 },
            { items: [{ ex: 'curl_db', sets: 3, min: 10, max: 15, rir: 1, rest: 0, w: 7, inc: 1 }, { ex: 'triceps_pushdown_cable', sets: 3, min: 10, max: 15, rir: 1, rest: 60, w: 17.5, inc: 2.5 }], restAfter: 60 },
            { items: [{ ex: 'lateral_raise_db', sets: 3, min: 12, max: 15, rir: 1, rest: 45, w: 5, inc: 1 }, { ex: 'face_pull', sets: 3, min: 12, max: 15, rir: 2, rest: 60, w: 15, inc: 2.5 }], restAfter: 60 },
          ]),
          workout('B', 'פלג גוף תחתון', [], [
            { section: 'warmup', items: [{ ex: 'glute_bridge', sets: 2, min: 15, max: 15, rir: null, rest: 30, w: 0, inc: 0 }] },
            { items: [{ ex: 'squat_back_bb', sets: 4, min: 6, max: 10, rir: 2, rest: 150, w: 45, inc: 2.5 }] },
            { items: [{ ex: 'rdl_bb', sets: 3, min: 8, max: 10, rir: 2, rest: 0, w: 40, inc: 2.5 }, { ex: 'leg_curl_seated', sets: 3, min: 10, max: 12, rir: 1, rest: 90, w: 25, inc: 5 }], restAfter: 90 },
            { items: [{ ex: 'hip_thrust_bb', sets: 3, min: 8, max: 12, rir: 2, rest: 90, w: 60, inc: 5 }] },
            { items: [{ ex: 'calf_raise_standing', sets: 3, min: 12, max: 15, rir: 1, rest: 0, w: 30, inc: 5 }, { ex: 'plank', sets: 3, min: 0, max: 0, rir: null, rest: 45, w: 0, inc: 0, dur: 40 }], restAfter: 45 },
          ]),
        ],
      },
      perf: (ex, k, n) => {
        // last session: dumbbell bench topped the range → increase-weight recommendation
        if (ex === 'bench_press_db' && k === n - 1) return { repsDelta: 12, rirDelta: 0 };
        return null;
      },
      extras: (sessions) => {
        const lastWith = (id: string) => [...sessions].reverse().flatMap((s) => s.entries).find((e) => e.exerciseId === id);
        const ohp = lastWith('shoulder_press_db');
        if (ohp) ohp.pain = { reported: true, location: 'כתף ימין, קדמית', severity: 4 };
        const sq = lastWith('squat_back_bb');
        if (sq) {
          sq.technique = 'fix';
          sq.notes = 'ברכיים נכנסות פנימה בחזרות האחרונות';
        }
        for (const s of sessions) for (const e of s.entries) if (e.exerciseId === 'bench_press_db') e.technique = 'good';
      },
      notes: [
        { kind: 'next', text: 'לחיצת כתפיים: לבדוק טווח תנועה — דיווחה על אי-נוחות בכתף ימין' },
        { kind: 'next', text: 'סקוואט: דגש על דחיפת ברכיים החוצה, אפשר גומייה מעל הברך בחימום' },
        { kind: 'task', text: 'לצלם סקוואט מהצד לבדיקת עומק' },
      ],
      measurements: (start) => [
        { date: start, weight: 61.2, bodyFat: 25.5, waist: 72 },
        { date: addDays(start, 21), weight: 61.6, bodyFat: 24.9, waist: 71.5 },
        { date: addDays(start, 40), weight: 62.1, bodyFat: 24.2, waist: 71 },
      ],
    },
    {
      client: {
        name: 'דנה לוי (הדגמה)',
        phone: '050-0000002',
        birthDate: '1979-08-02',
        height: 160,
        goals: ['return', 'function'],
        experience: 'beginner',
        fitnessLevel: 2,
        weeklyFrequency: 2,
        plannedDays: [dowOffset(todayDow, -1), dowOffset(todayDow, -4)].sort(),
        volumePreset: 'maintenance',
        injuries: 'ניתוח מניסקוס בברך שמאל לפני שנה',
        limitations: 'להימנע מכפיפת ברך עמוקה תחת עומס',
        uncomfortableExercises: 'לאנג׳ים בהליכה',
        color: '#17A86B',
      },
      weeks: 5,
      program: {
        name: 'חזרה לפעילות — גוף מלא',
        goal: 'rehab',
        phase: 'שלב בסיס',
        workouts: [
          workout('A', 'גוף מלא', [], [
            { section: 'warmup', items: [{ ex: 'bird_dog', sets: 2, min: 10, max: 10, rir: null, rest: 30, w: 0, inc: 0 }] },
            { items: [{ ex: 'box_squat', sets: 3, min: 10, max: 12, rir: 3, rest: 90, w: 0, inc: 0 }] },
            { items: [{ ex: 'chest_press_machine', sets: 3, min: 10, max: 12, rir: 2, rest: 0, w: 15, inc: 5 }, { ex: 'row_cable_seated', sets: 3, min: 10, max: 12, rir: 2, rest: 75, w: 20, inc: 2.5 }], restAfter: 75 },
            { items: [{ ex: 'glute_bridge', sets: 3, min: 12, max: 15, rir: 2, rest: 60, w: 0, inc: 0 }] },
            { section: 'finisher', items: [{ ex: 'pallof_press', sets: 2, min: 10, max: 12, rir: 2, rest: 45, w: 7.5, inc: 2.5 }] },
          ]),
          workout('B', 'גוף מלא', [], [
            { items: [{ ex: 'step_up', sets: 3, min: 8, max: 10, rir: 3, rest: 90, w: 4, inc: 2 }] },
            { items: [{ ex: 'lat_pulldown', sets: 3, min: 10, max: 12, rir: 2, rest: 0, w: 20, inc: 5 }, { ex: 'shoulder_press_machine', sets: 3, min: 10, max: 12, rir: 2, rest: 75, w: 10, inc: 5 }], restAfter: 75 },
            { items: [{ ex: 'hip_thrust_machine', sets: 3, min: 10, max: 12, rir: 2, rest: 75, w: 20, inc: 5 }] },
            { section: 'finisher', items: [{ ex: 'dead_bug', sets: 2, min: 8, max: 10, rir: null, rest: 45, w: 0, inc: 0 }] },
          ]),
        ],
      },
      perf: (ex, k, n) => {
        // last three sessions: fatigue → small decline in two lifts
        if ((ex === 'row_cable_seated' || ex === 'chest_press_machine') && k >= n - 2) {
          const steps = k - (n - 3);
          return { repsDelta: -2 * steps, weightDelta: -(ex === 'chest_press_machine' ? 5 : 2.5) * steps, rirDelta: -1 };
        }
        return null;
      },
      extras: (sessions) => {
        for (const s of sessions.slice(-3)) s.readiness = { energy: 2, sleep: 2, fatigue: 4, note: 'עומס בעבודה' };
      },
      notes: [{ kind: 'next', text: 'לשאול על השינה — דיווחה על עייפות באימונים האחרונים' }],
      measurements: (start) => [
        { date: start, weight: 68.4, waist: 84 },
        { date: addDays(start, 28), weight: 67.6, waist: 82.5 },
      ],
    },
    {
      client: {
        name: 'אורי מזרחי (הדגמה)',
        phone: '050-0000003',
        birthDate: '1988-11-20',
        height: 181,
        goals: ['strength'],
        experience: 'advanced',
        fitnessLevel: 4,
        weeklyFrequency: 2,
        plannedDays: [dowOffset(todayDow, -3), dowOffset(todayDow, 1)].sort(),
        volumePreset: 'beginner',
        color: '#E8930C',
      },
      weeks: 7,
      program: {
        name: 'כוח — 2 אימונים בשבוע',
        goal: 'strength',
        phase: 'בלוק כוח',
        workouts: [
          workout('A', 'לחיצה + סקוואט', [], [
            { items: [{ ex: 'bench_press_bb', sets: 4, min: 4, max: 6, rir: 2, rest: 180, w: 82.5, inc: 0 }] },
            { items: [{ ex: 'squat_back_bb', sets: 4, min: 4, max: 6, rir: 2, rest: 180, w: 100, inc: 2.5 }] },
            { items: [{ ex: 'pull_up', sets: 3, min: 6, max: 8, rir: 2, rest: 0, w: 0, inc: 0 }, { ex: 'dips', sets: 3, min: 8, max: 10, rir: 2, rest: 120, w: 0, inc: 0 }], restAfter: 120 },
          ]),
          workout('B', 'דדליפט + כתפיים', [], [
            { items: [{ ex: 'deadlift_bb', sets: 3, min: 3, max: 5, rir: 2, rest: 210, w: 130, inc: 5 }] },
            { items: [{ ex: 'ohp_bb', sets: 4, min: 5, max: 7, rir: 2, rest: 150, w: 50, inc: 2.5 }] },
            { items: [{ ex: 'row_bb', sets: 3, min: 6, max: 8, rir: 2, rest: 0, w: 70, inc: 2.5 }, { ex: 'leg_curl_lying', sets: 3, min: 12, max: 15, rir: 2, rest: 90, w: 35, inc: 5 }], restAfter: 90 },
          ]),
        ],
      },
      perf: (ex) => {
        // bench is stuck: same load (inc 0), reps never reach the top → stagnation rule
        if (ex === 'bench_press_bb') return { repsDelta: -1 };
        return null;
      },
      notes: [{ kind: 'general', text: 'מכוון לתחרות פאוורליפטינג באביב' }],
    },
  ];

  for (const sc of scenarios) {
    const client: Client = { ...blankClient(), ...sc.client, demo: true, startDate: addDays(isoDate(), -sc.weeks * 7) } as Client;
    await db.clients.put(client);
    const p = blankProgram(client.id, sc.program.name);
    p.goal = sc.program.goal;
    p.phase = sc.program.phase;
    p.status = 'active';
    p.demo = true;
    p.startDate = client.startDate;
    const specsById = new Map<string, Item>();
    p.workouts = sc.program.workouts.map(({ w, specs }, i) => {
      specs.forEach((v, k) => specsById.set(k, v));
      // spread workouts across the client's planned days
      w.days = client.plannedDays.filter((_, j) => j % sc.program.workouts.length === i);
      return w;
    });
    // planned weights = current working weights
    const { program } = await saveProgram(p, { reason: 'יצירת תוכנית' });
    const sessions = simulate(sc, client, program, specsById);
    await db.sessions.bulkPut(sessions);
    // set planned weights to the latest performed loads so the plan is realistic
    const next = JSON.parse(JSON.stringify(program)) as Program;
    for (const w of next.workouts)
      for (const b of w.blocks)
        for (const it of b.items) {
          const lastE = [...sessions].reverse().flatMap((s) => s.entries).find((e) => e.exerciseId === it.exerciseId);
          const lw = lastE?.sets.find((s) => s.type === 'working')?.weight;
          if (lw) it.sets.forEach((s) => (s.weight = s.type === 'warmup' ? Math.round(lw * 0.5) : lw));
        }
    await saveProgram(next, { reason: 'עדכון משקלי עבודה' });
    const t = Date.now();
    for (const n of sc.notes ?? [])
      await db.notes.put({ id: uid(), createdAt: t - 86400000, updatedAt: t - 86400000, clientId: client.id, kind: n.kind, text: n.text, demo: true });
    for (const m of sc.measurements?.(client.startDate!) ?? [])
      await db.measurements.put({ id: uid(), createdAt: t, updatedAt: t, clientId: client.id, date: m.date!, ...m, demo: true } as Measurement);

    // recommendations: an older session first (decided → some history), then the
    // last session of each workout so every client has fresh pending items
    if (sessions.length > 5) {
      const older = await runEngine(client.id, sessions[sessions.length - 5].id);
      for (const [i, r] of older.entries()) {
        // weekly checks are keyed by week; keep only exercise-level history so this week's checks stay pending
        if (!r.exerciseId) await db.recommendations.delete(r.id);
        else await decideRecommendation(r.id, i % 2 === 0 ? 'applied' : 'rejected', { decisionNote: i % 2 === 0 ? undefined : 'מוקדם מדי' });
      }
    }
    for (const s of sessions.slice(-2)) await runEngine(client.id, s.id);
  }
}

export async function removeDemoData(): Promise<number> {
  let n = 0;
  await db.transaction('rw', DATA_TABLES.filter((t) => t !== 'settings').map((t) => db.table(t)), async () => {
    // anything belonging to a demo client goes too, even a row created later without the flag
    const demoClients = new Set((await db.clients.toArray()).filter((c) => c.demo).map((c) => c.id));
    for (const t of DATA_TABLES) {
      if (t === 'settings') continue;
      const ids = (await db.table(t).toArray())
        .filter((r: { demo?: boolean; clientId?: string | null }) => r.demo || (!!r.clientId && demoClients.has(r.clientId)))
        .map((r: { id: string }) => r.id);
      n += ids.length;
      await db.table(t).bulkDelete(ids);
    }
  });
  return n;
}
