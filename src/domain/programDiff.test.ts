import { describe, expect, it } from 'vitest';
import { diffPrograms } from './programDiff';
import { exerciseMap } from './testkit';
import type { Block, PlannedExercise, PlannedSet, Program } from './types';

const ex = exerciseMap();

const pset = (id: string, patch: Partial<PlannedSet> = {}): PlannedSet => ({
  id,
  type: 'working',
  weight: 60,
  repsMin: 8,
  repsMax: 10,
  rir: 2,
  rpe: null,
  rest: 120,
  duration: null,
  ...patch,
});
const item = (id: string, exerciseId: string, sets: PlannedSet[]): PlannedExercise => ({ id, exerciseId, sets, setup: {} });
const block = (id: string, items: PlannedExercise[], patch: Partial<Block> = {}): Block => ({
  id,
  type: items.length > 1 ? 'superset' : 'single',
  section: 'main',
  rounds: null,
  restAfter: null,
  items,
  ...patch,
});

function program(): Program {
  return {
    id: 'p1',
    createdAt: 1,
    updatedAt: 1,
    clientId: 'c1',
    name: 'תוכנית',
    goal: 'hypertrophy',
    status: 'active',
    version: 1,
    workouts: [
      {
        id: 'wA',
        name: 'A',
        days: [0],
        blocks: [
          block('b1', [item('i1', 'bench_press_bb', [pset('s1'), pset('s2')])]),
          block('b2', [item('i2', 'chest_fly_db', [pset('s3')]), item('i3', 'push_up', [pset('s4')])], { type: 'circuit', rounds: 3, restAfter: 90 }),
        ],
      },
      { id: 'wB', name: 'B', days: [3], blocks: [block('b3', [item('i4', 'pec_deck', [pset('s5')])])] },
    ],
  };
}

const edit = (fn: (p: Program) => void): Program => {
  const p = program();
  fn(p);
  return p;
};
const diff = (fn: (p: Program) => void) => diffPrograms(program(), edit(fn), ex);

describe('program version diff', () => {
  it('finds nothing when the content is the same', () => {
    expect(diffPrograms(program(), program(), ex)).toEqual([]);
  });

  it('records group-level changes: circuit rounds, rest after the round, section and type', () => {
    expect(diff((p) => void (p.workouts[0].blocks[1].rounds = 5))).toEqual([
      expect.objectContaining({ field: 'סבבים', from: '3', to: '5' }),
    ]);
    expect(diff((p) => void (p.workouts[0].blocks[1].restAfter = 120))).toEqual([
      expect.objectContaining({ field: 'מנוחה אחרי הסבב', from: '90', to: '120' }),
    ]);
    // the last main group moves to the finisher: the flat exercise order stays the same
    expect(diff((p) => void (p.workouts[0].blocks[1].section = 'finisher'))).toEqual([
      expect.objectContaining({ field: 'חלק באימון', from: 'חלק עיקרי', to: 'סיום' }),
    ]);
    // a two-exercise group changing type is one change, not one per exercise
    expect(diff((p) => void (p.workouts[0].blocks[1].type = 'superset'))).toEqual([
      expect.objectContaining({ field: 'סוג קבוצה', from: 'סבב', to: 'סופר-סט' }),
    ]);
  });

  it('records workout notes and the order of the workouts', () => {
    expect(diff((p) => void (p.workouts[0].notes = 'לשים לב לברכיים'))).toEqual([
      expect.objectContaining({ path: 'אימון A', field: 'הערות', from: '—', to: 'לשים לב לברכיים' }),
    ]);
    expect(diff((p) => p.workouts.reverse())).toEqual([expect.objectContaining({ field: 'סדר אימונים', from: 'A · B', to: 'B · A' })]);
  });

  it('records an exercise moving into another group, even when the group type stays the same', () => {
    // two circuits merged into one: same types, same flat order — only the grouping changed
    const changes = diffPrograms(
      edit((p) => void (p.workouts[0].blocks[0].type = 'circuit')),
      edit((p) => {
        const [b1, b2] = p.workouts[0].blocks;
        b1.type = 'circuit';
        b1.items.push(...b2.items);
        p.workouts[0].blocks = [b1];
      }),
      ex,
    );
    expect(changes.filter((c) => c.field === 'קבוצה')).toHaveLength(2);
    expect(changes.every((c) => c.field === 'קבוצה')).toBe(true);
  });

  it('matches sets by id: deleting the warm-up at the top records only that removal', () => {
    const prev = edit((p) => p.workouts[0].blocks[0].items[0].sets.unshift(pset('w1', { type: 'warmup', weight: 40, repsMin: 10, repsMax: 10, rir: null, rest: 60 })));
    const changes = diffPrograms(prev, program(), ex);
    expect(changes).toHaveLength(1);
    expect(changes[0].field).toBe('סט 1 הוסר');
    expect(changes[0].from).toContain('חימום');
    expect(changes[0].from).toContain('40');
  });

  it('matches sets by id: adding a warm-up at the top records only that addition', () => {
    const changes = diff((p) => p.workouts[0].blocks[0].items[0].sets.unshift(pset('w1', { type: 'warmup', weight: 30 })));
    expect(changes).toHaveLength(1);
    expect(changes[0].field).toBe('סט 1 נוסף');
    expect(changes[0].to).toContain('חימום');
  });

  it('labels an edited set by its new position after another set was removed', () => {
    const changes = diff((p) => {
      const sets = p.workouts[0].blocks[0].items[0].sets;
      sets.splice(0, 1);
      sets[0].weight = 62.5;
    });
    expect(changes.map((c) => [c.field, c.from, c.to])).toEqual([
      ['סט 1 הוסר', 'עבודה · 60 ק״ג × 8–10 @RIR 2', '—'],
      ['סט 1 · משקל', '60', '62.5'],
    ]);
  });

  it('falls back to pairing by position for sets without ids', () => {
    const strip = (p: Program) => p.workouts[0].blocks[0].items[0].sets.forEach((s) => ((s as Partial<PlannedSet>).id = undefined));
    const changes = diffPrograms(
      edit(strip),
      edit((p) => {
        strip(p);
        p.workouts[0].blocks[0].items[0].sets[1].weight = 65;
      }),
      ex,
    );
    expect(changes).toEqual([expect.objectContaining({ field: 'סט 2 · משקל', from: '60', to: '65' })]);
  });
});
