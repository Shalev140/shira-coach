/** Human-readable diff between two program versions (old value → new value). */
import type { Block, Exercise, ID, PlannedSet, PlannedWorkout, Program, ProgramChange } from './types';
import { BLOCK_TYPES, PROGRAM_GOALS, PROGRAM_STATUS, SECTIONS, SET_TYPES } from './labels';

type Snap = Pick<Program, 'name' | 'goal' | 'phase' | 'startDate' | 'endDate' | 'status' | 'workouts' | 'notes'>;

const v = (x: unknown) => (x === null || x === undefined || x === '' ? '—' : String(x));

function setText(s: PlannedSet): string {
  const reps = s.repsMin != null && s.repsMax != null && s.repsMin !== s.repsMax ? `${s.repsMin}–${s.repsMax}` : v(s.repsMin ?? s.repsMax);
  return `${v(s.weight)} ק״ג × ${reps}${s.rir != null ? ` @RIR ${s.rir}` : ''}`;
}

const SET_FIELDS: [keyof PlannedSet, string][] = [
  ['weight', 'משקל'],
  ['repsMin', 'חזרות מינ׳'],
  ['repsMax', 'חזרות מקס׳'],
  ['rir', 'RIR'],
  ['rpe', 'RPE'],
  ['rest', 'מנוחה'],
  ['type', 'סוג סט'],
  ['duration', 'זמן'],
];

export function diffPrograms(prev: Snap | null, next: Snap, exercises: Map<ID, Exercise>): ProgramChange[] {
  const out: ProgramChange[] = [];
  const name = (id: ID) => exercises.get(id)?.nameHe ?? 'תרגיל';
  if (!prev) {
    out.push({ path: 'תוכנית', field: 'נוצרה', from: '—', to: next.name });
    return out;
  }
  const top: [keyof Snap, string, (x: unknown) => string][] = [
    ['name', 'שם', v],
    ['goal', 'מטרה', (x) => PROGRAM_GOALS[x as keyof typeof PROGRAM_GOALS] ?? v(x)],
    ['phase', 'שלב', v],
    ['startDate', 'תאריך התחלה', v],
    ['endDate', 'תאריך סיום', v],
    ['status', 'סטטוס', (x) => PROGRAM_STATUS[x as keyof typeof PROGRAM_STATUS] ?? v(x)],
    ['notes', 'הערות', v],
  ];
  for (const [key, label, fmt] of top) {
    if ((prev[key] ?? '') !== (next[key] ?? '')) out.push({ path: 'תוכנית', field: label, from: fmt(prev[key]), to: fmt(next[key]) });
  }

  const prevW = new Map(prev.workouts.map((w) => [w.id, w]));
  const nextW = new Map(next.workouts.map((w) => [w.id, w]));
  for (const w of prev.workouts) if (!nextW.has(w.id)) out.push({ path: 'אימונים', field: 'אימון הוסר', from: w.name, to: '—' });
  // the workout order drives the "next workout" rotation
  const pOrder = prev.workouts.filter((w) => nextW.has(w.id));
  const nOrder = next.workouts.filter((w) => prevW.has(w.id));
  if (pOrder.map((w) => w.id).join() !== nOrder.map((w) => w.id).join())
    out.push({ path: 'אימונים', field: 'סדר אימונים', from: pOrder.map((w) => w.name).join(' · '), to: nOrder.map((w) => w.name).join(' · ') });
  for (const w of next.workouts) {
    const p = prevW.get(w.id);
    if (!p) {
      out.push({ path: 'אימונים', field: 'אימון נוסף', from: '—', to: w.name });
      continue;
    }
    diffWorkout(p, w, out, name);
  }
  return out;
}

function diffWorkout(p: PlannedWorkout, w: PlannedWorkout, out: ProgramChange[], name: (id: ID) => string) {
  const path = `אימון ${w.name}`;
  if (p.name !== w.name) out.push({ path, field: 'שם', from: p.name, to: w.name });
  if ((p.focus ?? '') !== (w.focus ?? '')) out.push({ path, field: 'דגש', from: v(p.focus), to: v(w.focus) });
  if (p.days.join() !== w.days.join()) out.push({ path, field: 'ימים', from: p.days.map((d) => d + 1).join(',') || '—', to: w.days.map((d) => d + 1).join(',') || '—' });
  if ((p.warmupNotes ?? '') !== (w.warmupNotes ?? '')) out.push({ path, field: 'חימום', from: v(p.warmupNotes), to: v(w.warmupNotes) });
  if ((p.notes ?? '') !== (w.notes ?? '')) out.push({ path, field: 'הערות', from: v(p.notes), to: v(w.notes) });

  // group-level fields: rounds multiply a circuit's sets, the section decides warm-up handling, restAfter
  // drives the rest timer. A group that is new shows up through its exercises.
  const groupName = (b: Block) => b.items.map((i) => name(i.exerciseId)).join(' + ') || BLOCK_TYPES[b.type];
  const pBlocks = new Map(p.blocks.map((b) => [b.id, b]));
  for (const b of w.blocks) {
    const a = pBlocks.get(b.id);
    if (!a) continue;
    const bpath = `${path} › ${groupName(b)}`;
    if (a.type !== b.type) out.push({ path: bpath, field: 'סוג קבוצה', from: BLOCK_TYPES[a.type], to: BLOCK_TYPES[b.type] });
    if (a.section !== b.section) out.push({ path: bpath, field: 'חלק באימון', from: SECTIONS[a.section], to: SECTIONS[b.section] });
    if ((a.rounds ?? null) !== (b.rounds ?? null)) out.push({ path: bpath, field: 'סבבים', from: v(a.rounds), to: v(b.rounds) });
    if ((a.restAfter ?? null) !== (b.restAfter ?? null)) out.push({ path: bpath, field: 'מנוחה אחרי הסבב', from: v(a.restAfter), to: v(b.restAfter) });
  }
  const groupText = (b: Block) => (b.items.length > 1 ? `${BLOCK_TYPES[b.type]} · ${groupName(b)}` : BLOCK_TYPES[b.type]);

  const pItems = new Map(p.blocks.flatMap((b) => b.items.map((i) => [i.id, { item: i, block: b }])));
  const nItems = new Map(w.blocks.flatMap((b) => b.items.map((i) => [i.id, { item: i, block: b }])));
  for (const [id, { item }] of pItems) if (!nItems.has(id)) out.push({ path, field: 'תרגיל הוסר', from: name(item.exerciseId), to: '—' });

  const pOrder = p.blocks.flatMap((b) => b.items.map((i) => i.id)).filter((id) => nItems.has(id));
  const nOrder = w.blocks.flatMap((b) => b.items.map((i) => i.id)).filter((id) => pItems.has(id));
  if (pOrder.join() !== nOrder.join()) out.push({ path, field: 'סדר תרגילים', from: 'סדר קודם', to: 'סדר חדש' });

  for (const [id, { item, block }] of nItems) {
    const prevEntry = pItems.get(id);
    if (!prevEntry) {
      out.push({ path, field: 'תרגיל נוסף', from: '—', to: `${name(item.exerciseId)} (${SECTIONS[block.section]})` });
      continue;
    }
    const pi = prevEntry.item;
    const ipath = `${path} › ${name(item.exerciseId)}`;
    if (pi.exerciseId !== item.exerciseId) out.push({ path, field: 'תרגיל הוחלף', from: name(pi.exerciseId), to: name(item.exerciseId) });
    // same group → its type change is listed once above; moved to another group (merge / split) → listed here
    if (prevEntry.block.id !== block.id) out.push({ path: ipath, field: 'קבוצה', from: groupText(prevEntry.block), to: groupText(block) });
    if ((pi.notes ?? '') !== (item.notes ?? '')) out.push({ path: ipath, field: 'הערות', from: v(pi.notes), to: v(item.notes) });
    if ((pi.tempo ?? '') !== (item.tempo ?? '')) out.push({ path: ipath, field: 'טמפו', from: v(pi.tempo), to: v(item.tempo) });
    const setupKeys = new Set([...Object.keys(pi.setup ?? {}), ...Object.keys(item.setup ?? {})]);
    for (const k of setupKeys) {
      const a = (pi.setup as Record<string, string | undefined>)?.[k] ?? '';
      const b = (item.setup as Record<string, string | undefined>)?.[k] ?? '';
      if (a !== b) out.push({ path: ipath, field: `כיוון (${k})`, from: v(a), to: v(b) });
    }
    diffSets(pi.sets, item.sets, ipath, out);
  }
}

/**
 * Sets are matched by their id, so deleting or inserting one (e.g. a warm-up at the top) is recorded as
 * exactly that, not as a chain of shifted edits. Pairing by position is only a fallback for sets without
 * unique ids. Removed sets carry their old position, the rest their new one.
 */
function diffSets(prev: PlannedSet[], next: PlannedSet[], path: string, out: ProgramChange[]) {
  const unique = (l: PlannedSet[]) => l.every((s) => s.id) && new Set(l.map((s) => s.id)).size === l.length;
  const byId = unique(prev) && unique(next);
  const key = (s: PlannedSet, i: number) => (byId ? s.id : String(i));
  const pIdx = new Map(prev.map((s, i) => [key(s, i), i]));
  const nIdx = new Map(next.map((s, i) => [key(s, i), i]));
  const label = (i: number) => `סט ${i + 1}`;

  prev.forEach((a, i) => {
    if (!nIdx.has(key(a, i))) out.push({ path, field: `${label(i)} הוסר`, from: `${SET_TYPES[a.type]} · ${setText(a)}`, to: '—' });
  });
  const pOrder = prev.map(key).filter((k) => nIdx.has(k));
  const nOrder = next.map(key).filter((k) => pIdx.has(k));
  if (pOrder.join() !== nOrder.join()) out.push({ path, field: 'סדר סטים', from: 'סדר קודם', to: 'סדר חדש' });

  next.forEach((b, i) => {
    const j = pIdx.get(key(b, i));
    if (j === undefined) {
      out.push({ path, field: `${label(i)} נוסף`, from: '—', to: `${SET_TYPES[b.type]} · ${setText(b)}` });
      return;
    }
    const a = prev[j];
    for (const [k, lbl] of SET_FIELDS) {
      if ((a[k] ?? null) !== (b[k] ?? null))
        out.push({
          path,
          field: `${label(i)} · ${lbl}`,
          from: k === 'type' ? SET_TYPES[a.type] : v(a[k]),
          to: k === 'type' ? SET_TYPES[b.type] : v(b[k]),
        });
    }
  });
}
