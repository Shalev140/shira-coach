import { describe, expect, it } from 'vitest';
import { client, entry, exerciseMap, session, set, settings } from '../domain/testkit';
import { weekRange } from '../domain/volume';
import { weekOverlap } from './VolumePanel';

const chest = (date: string) => session(date, [entry('bench_press_db', [1, 2, 3, 4, 5].map(() => set(20, 10)))]);
const flags = (sessions: ReturnType<typeof chest>[], day: string, weekStartsOn: 0 | 1 = 0) =>
  weekOverlap(sessions, weekRange(day, weekStartsOn), exerciseMap(), settings({ weekStartsOn }), client()).map((o) => `${o.muscle} ${o.dayA}/${o.dayB}`);

describe('back-to-back days in the weekly volume', () => {
  it('a Saturday + Sunday pair across the week boundary is flagged in both weeks', () => {
    const s = [chest('2026-10-17'), chest('2026-10-18')];
    expect(flags(s, '2026-10-17')).toEqual(['chest 2026-10-17/2026-10-18']);
    expect(flags(s, '2026-10-18')).toEqual(['chest 2026-10-17/2026-10-18']);
  });

  it('a pair inside one week is flagged there only', () => {
    const s = [chest('2026-10-18'), chest('2026-10-19')];
    expect(flags(s, '2026-10-20')).toEqual(['chest 2026-10-18/2026-10-19']);
    expect(flags(s, '2026-10-14')).toEqual([]);
  });

  it('with weeks starting on Monday, Sunday + Monday is caught too', () => {
    const s = [chest('2026-10-18'), chest('2026-10-19')];
    expect(flags(s, '2026-10-18', 1)).toEqual(['chest 2026-10-18/2026-10-19']);
    expect(flags(s, '2026-10-19', 1)).toEqual(['chest 2026-10-18/2026-10-19']);
  });
});
