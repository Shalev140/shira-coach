import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/db';
import { blankExercise, getSettings, initDatabase, saveExercise } from '../db/repo';
import { exerciseMap } from '../domain/testkit';
import type { Exercise } from '../domain/types';
import { DELETED_MUSCLE, filterExercises, muscleSummary, searchHiddenByFilters, type ExerciseFilter } from '../components/ExercisePicker';
import { deleteMuscle, exercisesUsingMuscle, updateSettings } from './Settings';
import { latestWeighIn, shouldRecordWeight } from './ClientEdit';

async function reset() {
  await db.delete();
  await db.open();
  await initDatabase();
}

describe('exercise picker search with a preselected muscle', () => {
  const list = [...exerciseMap().values()];
  const filter = (patch: Partial<ExerciseFilter>): ExerciseFilter => ({ q: '', muscle: null, equipment: null, pattern: null, difficulty: null, ...patch });

  it('reports exercises that match the search but are hidden by the muscle filter', () => {
    // a swap picker for a quads exercise, searching for a row
    const f = filter({ q: 'חתירה', muscle: 'quads' });
    const shown = filterExercises(list, f);
    expect(shown).toHaveLength(0);
    const hidden = searchHiddenByFilters(list, f, shown.length);
    expect(hidden).toBeGreaterThan(0);
    expect(hidden).toBe(filterExercises(list, filter({ q: 'חתירה' })).length);
  });

  it('reports nothing without a search or without a filter', () => {
    const byMuscle = filter({ muscle: 'quads' });
    expect(searchHiddenByFilters(list, byMuscle, filterExercises(list, byMuscle).length)).toBe(0);
    const bySearch = filter({ q: 'חתירה' });
    expect(searchHiddenByFilters(list, bySearch, filterExercises(list, bySearch).length)).toBe(0);
  });

  it('names a muscle id that is no longer in the settings instead of printing the raw id', () => {
    const ex = { ...list[0], primary: ['m_gone'] } as Exercise;
    expect(muscleSummary(ex, new Map())).toBe(DELETED_MUSCLE);
  });
});

describe('deleting a custom muscle group', () => {
  beforeEach(reset);

  it('removes the group and strips it from every exercise that used it', async () => {
    await updateSettings((cur) => ({ muscles: [...cur.muscles, { id: 'm_traps', name: 'טרפזים', custom: true, order: 99 }] }));
    const shrug = blankExercise({ nameHe: 'שראגס', primary: ['m_traps'], secondary: [{ muscle: 'shoulders' }] });
    const row = blankExercise({ nameHe: 'חתירה גבוהה', primary: ['back'], secondary: [{ muscle: 'm_traps', factor: 0.5 }] });
    await saveExercise(shrug);
    await saveExercise(row);
    const before = (await db.exercises.get(row.id))!.updatedAt;

    expect(exercisesUsingMuscle(await db.exercises.toArray(), 'm_traps').map((e) => e.id).sort()).toEqual([shrug.id, row.id].sort());

    await deleteMuscle('m_traps');

    expect((await getSettings()).muscles.some((m) => m.id === 'm_traps')).toBe(false);
    const s = (await db.exercises.get(shrug.id))!;
    expect(s.primary).toEqual([]);
    expect(s.secondary).toEqual([{ muscle: 'shoulders' }]);
    const r = (await db.exercises.get(row.id))!;
    expect(r.primary).toEqual(['back']);
    expect(r.secondary).toEqual([]);
    expect(r.updatedAt).toBeGreaterThanOrEqual(before);
    expect(exercisesUsingMuscle(await db.exercises.toArray(), 'm_traps')).toHaveLength(0);
  });

  it('leaves exercises that never used the group untouched', async () => {
    await updateSettings((cur) => ({ muscles: [...cur.muscles, { id: 'm_x', name: 'x', custom: true, order: 99 }] }));
    const seedBefore = await db.exercises.toArray();
    await deleteMuscle('m_x');
    const seedAfter = await db.exercises.toArray();
    expect(seedAfter.map((e) => e.updatedAt)).toEqual(seedBefore.map((e) => e.updatedAt));
  });
});

describe('client weigh-ins from the edit form', () => {
  it('records a weight equal to the last one when that weigh-in is from another day', () => {
    expect(shouldRecordWeight(70, { date: '2026-07-01', weight: 70 }, '2026-10-24')).toBe(true);
  });

  it('skips only the same value entered again on the same day', () => {
    expect(shouldRecordWeight(70, { date: '2026-10-24', weight: 70 }, '2026-10-24')).toBe(false);
    expect(shouldRecordWeight(68, { date: '2026-10-24', weight: 70 }, '2026-10-24')).toBe(true);
    expect(shouldRecordWeight(70, null, '2026-10-24')).toBe(true);
    expect(shouldRecordWeight(null, null, '2026-10-24')).toBe(false);
  });

  it('the newest weigh-in is the last one entered on the latest date, whatever the row order', () => {
    const typo = { date: '2026-10-24', createdAt: 100, weight: 70 };
    const fixed = { date: '2026-10-24', createdAt: 200, weight: 68 };
    const older = { date: '2026-10-01', createdAt: 300, weight: 71 };
    const noWeight = { date: '2026-10-25', createdAt: 400, weight: undefined };
    expect(latestWeighIn([typo, fixed, older, noWeight])).toBe(fixed);
    expect(latestWeighIn([fixed, typo, noWeight, older])).toBe(fixed);
    expect(latestWeighIn([noWeight])).toBeNull();
  });
});
