import { describe, expect, it } from 'vitest';
import { adjacentOverlap, explainContributions, performedVolume, plannedVolume } from './volume';
import { client, entry, exerciseMap, session, set, settings } from './testkit';
import type { Program } from './types';

const ex = exerciseMap();
const get = (vols: ReturnType<typeof performedVolume>, m: string) => vols.find((v) => v.muscle === m)!;

describe('weekly volume', () => {
  it('counts direct sets for primary muscles and weighted indirect sets for secondary ones', () => {
    const s = session('2026-10-20', [
      entry('bench_press_bb', [set(60, 10, 2, { type: 'warmup' }), set(60, 10), set(60, 9), set(60, 8)]),
    ]);
    const vols = performedVolume([s], ex, settings());
    expect(get(vols, 'chest').direct).toBe(3); // warm-up excluded
    expect(get(vols, 'triceps').direct).toBe(0);
    expect(get(vols, 'triceps').indirect).toBe(1.5); // 3 × 0.5
    expect(get(vols, 'triceps').effective).toBe(1.5);
    expect(get(vols, 'chest').frequency).toBe(1);
  });

  it('uses the global factor when the exercise has none, and the exercise factor when set', () => {
    const custom = new Map(ex);
    const bench = { ...custom.get('bench_press_bb')! };
    bench.secondary = [{ muscle: 'triceps', factor: 0.25 }, { muscle: 'shoulders' }];
    custom.set(bench.id, bench);
    const s = session('2026-10-20', [entry('bench_press_bb', [set(60, 10), set(60, 10), set(60, 10), set(60, 10)])]);
    const vols = performedVolume([s], custom, settings({ indirectFactor: 0.75 }));
    expect(get(vols, 'triceps').indirect).toBe(1); // 4 × 0.25 (exercise override)
    expect(get(vols, 'shoulders').indirect).toBe(3); // 4 × 0.75 (global)
  });

  it('ignores undone sets, optional drop sets and sets above the hard-set RIR threshold', () => {
    const s = session('2026-10-20', [
      entry('leg_extension', [set(40, 12, 1), set(40, 12, 4), set(30, 10, 0, { type: 'drop' }), set(40, null, null, { done: false })]),
    ]);
    expect(get(performedVolume([s], ex, settings()), 'quads').direct).toBe(3);
    expect(get(performedVolume([s], ex, settings({ countDropSets: false })), 'quads').direct).toBe(2);
    expect(get(performedVolume([s], ex, settings({ hardSetMaxRir: 3 })), 'quads').direct).toBe(2);
  });

  it('compares effective sets with the client target and explains the result', () => {
    const c = client({ volumeTargets: { chest: { min: 4, max: 6 } } });
    const s = session('2026-10-20', [entry('bench_press_bb', [set(60, 10), set(60, 10)])]);
    const chest = get(performedVolume([s], ex, settings(), c), 'chest');
    expect(chest.status).toBe('under');
    expect(explainContributions(chest)).toEqual([{ exerciseId: 'bench_press_bb', role: 'primary', sets: 2, factor: 1, value: 2 }]);
  });

  it('multiplies planned volume by how many days a workout runs per week', () => {
    const program = {
      id: 'p',
      createdAt: 1,
      updatedAt: 1,
      clientId: 'c1',
      name: 'p',
      goal: 'hypertrophy',
      status: 'active',
      version: 1,
      workouts: [
        {
          id: 'w',
          name: 'A',
          days: [0, 3],
          blocks: [{ id: 'b', type: 'single', section: 'main', items: [{ id: 'i', exerciseId: 'squat_back_bb', setup: {}, sets: [1, 2, 3].map((k) => ({ id: `s${k}`, type: 'working' as const })) }] }],
        },
      ],
    } as Program;
    const vols = plannedVolume(program, ex, settings());
    expect(get(vols, 'quads').direct).toBe(6);
    expect(get(vols, 'quads').frequency).toBe(2);
  });

  it('applies the hard-set rule to planned sets too (planned RIR, or 10 − RPE)', () => {
    const program = {
      id: 'p',
      createdAt: 1,
      updatedAt: 1,
      clientId: 'c1',
      name: 'p',
      goal: 'hypertrophy',
      status: 'active',
      version: 1,
      workouts: [
        {
          id: 'w',
          name: 'A',
          days: [0, 3],
          blocks: [
            {
              id: 'b',
              type: 'single',
              section: 'main',
              items: [
                {
                  id: 'i',
                  exerciseId: 'bench_press_bb',
                  setup: {},
                  sets: [
                    { id: 's1', type: 'working' as const, rir: 4 },
                    { id: 's2', type: 'working' as const, rir: 2 },
                    { id: 's3', type: 'working' as const, rpe: 6 }, // = RIR 4
                    { id: 's4', type: 'working' as const }, // no target → always counts
                  ],
                },
              ],
            },
          ],
        },
      ],
    } as Program;
    expect(get(plannedVolume(program, ex, settings()), 'chest').direct).toBe(8);
    expect(get(plannedVolume(program, ex, settings({ hardSetMaxRir: 3 })), 'chest').direct).toBe(4);
  });

  it('flags substantial work on the same muscle on consecutive days', () => {
    const a = session('2026-10-19', [entry('squat_back_bb', [set(80, 8), set(80, 8), set(80, 8), set(80, 8)])]);
    const b = session('2026-10-20', [entry('leg_press', [set(120, 10), set(120, 10), set(120, 10), set(120, 10)])]);
    const flags = adjacentOverlap(performedVolume([a, b], ex, settings()));
    expect(flags.map((f) => f.muscle)).toContain('quads');
  });
});
