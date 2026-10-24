import { describe, expect, it } from 'vitest';
import { blankSet } from '../db/repo';
import type { PlannedSet } from '../domain/types';
import { grownBlockType, matchingSetIds, setQuickField, setsSummary, setWorkingCount } from './ProgramEditor';

const ps = (type: PlannedSet['type'], weight: number | null, patch: Partial<PlannedSet> = {}): PlannedSet =>
  blankSet(type, { weight, repsMin: 4, repsMax: 6, rir: 2, rest: 120, ...patch });
const shape = (sets: PlannedSet[]) => sets.map((s) => `${s.type}:${s.weight}`);

describe('program editor quick fields', () => {
  it('a quick weight change leaves drop and back-off sets at their own load', () => {
    const sets = [ps('working', 82.5), ps('working', 82.5), ps('working', 82.5), ps('working', 82.5), ps('drop', 62, { rest: 0 }), ps('backoff', 70, { repsMin: 10, repsMax: 12 })];
    setQuickField(sets, 'weight', 87.5);
    expect(shape(sets)).toEqual(['working:87.5', 'working:87.5', 'working:87.5', 'working:87.5', 'drop:62', 'backoff:70']);
    setQuickField(sets, 'repsMin', 5);
    setQuickField(sets, 'rest', 150);
    expect(sets.map((s) => `${s.repsMin}/${s.rest}`)).toEqual(['5/150', '5/150', '5/150', '5/150', '4/0', '10/120']);
  });

  it('only the working sets holding the shown value change, so a pyramid keeps its other loads', () => {
    const sets = [ps('warmup', 30), ps('working', 60), ps('working', 70), ps('working', 60)];
    setQuickField(sets, 'weight', 65);
    expect(shape(sets)).toEqual(['warmup:30', 'working:65', 'working:70', 'working:65']);
  });

  it('sets held at focus stay the target while a number is typed through another set’s value', () => {
    const sets = [ps('working', 60), ps('working', 10)];
    const ids = matchingSetIds(sets, 'weight'); // focus
    for (const v of [null, 1, 10, 100]) setQuickField(sets, 'weight', v, ids); // clear, then type "100"
    expect(shape(sets)).toEqual(['working:100', 'working:10']);
  });
});

describe('program editor set count', () => {
  it('adds working sets after the last working set and keeps warm-up, drop and back-off sets', () => {
    const sets = [ps('warmup', 30), ps('working', 60), ps('working', 70), ps('drop', 50)];
    setWorkingCount(sets, 4);
    expect(shape(sets)).toEqual(['warmup:30', 'working:60', 'working:70', 'working:70', 'working:70', 'drop:50']);
    expect(new Set(sets.map((s) => s.id)).size).toBe(sets.length);
  });

  it('removes the last working sets only', () => {
    const sets = [ps('warmup', 30), ps('working', 60), ps('working', 70), ps('working', 80), ps('backoff', 50)];
    setWorkingCount(sets, 2);
    expect(shape(sets)).toEqual(['warmup:30', 'working:60', 'working:70', 'backoff:50']);
    setWorkingCount(sets, 2);
    expect(shape(sets)).toEqual(['warmup:30', 'working:60', 'working:70', 'backoff:50']);
  });

  it('with no working set left, new ones go before the drop sets', () => {
    const sets = [ps('warmup', 30), ps('drop', 50)];
    setWorkingCount(sets, 1);
    expect(sets.map((s) => s.type)).toEqual(['warmup', 'working', 'drop']);
  });
});

describe('program editor summary and groups', () => {
  it('a drop set is not counted as another working set', () => {
    const sets = [ps('working', 82.5), ps('working', 82.5), ps('working', 82.5), ps('working', 82.5), ps('drop', 62)];
    expect(setsSummary(sets)).toBe('4 × 4–6 · 82.5 ק״ג · RIR 2 · מנוחה 120ש׳ · +1 דרופ');
  });

  it('counts warm-up-only exercises in correct Hebrew', () => {
    expect(setsSummary([ps('warmup', null)])).toBe('סט חימום אחד');
    expect(setsSummary([ps('warmup', null), ps('warmup', null)])).toBe('2 סטי חימום');
  });

  it('a 4th exercise makes a tri-set a circuit, as merging groups does', () => {
    expect(grownBlockType('single', 2)).toBe('superset');
    expect(grownBlockType('superset', 3)).toBe('triset');
    expect(grownBlockType('triset', 4)).toBe('circuit');
    expect(grownBlockType('circuit', 3)).toBe('circuit'); // picked by hand: never demoted
    expect(grownBlockType('triset', 2)).toBe('triset');
  });
});
