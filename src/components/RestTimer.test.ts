import { describe, expect, it } from 'vitest';
import { adjustRest } from './RestTimer';

const NOW = 1_000_000;
const secs = (ms: number) => Math.round(ms / 1000);

describe('rest timer ±15', () => {
  it('adds to the remaining time while the rest is running', () => {
    const rest = { endsAt: NOW + 30_000, total: 90 };
    expect(adjustRest(rest, 15, NOW)).toEqual({ endsAt: NOW + 45_000, total: 105 });
    expect(adjustRest(rest, -15, NOW)).toEqual({ endsAt: NOW + 15_000, total: 75 });
  });

  it('never ends a running rest in the past', () => {
    const next = adjustRest({ endsAt: NOW + 10_000, total: 90 }, -15, NOW);
    expect(next.endsAt).toBe(NOW + 1000);
  });

  // The old code added 15 s to the past end time: 40 s into overtime that left 1 s,
  // and the timer beeped again almost at once.
  it('gives a full 15 s from now when tapped during overtime, with a full bar', () => {
    for (const overtime of [0, 5_000, 14_000, 15_000, 40_000, 120_000]) {
      const rest = { endsAt: NOW - overtime, total: 90 };
      const next = adjustRest(rest, 15, NOW);
      expect(secs(next.endsAt - NOW)).toBe(15);
      expect(next.total).toBe(15);
    }
  });

  it('leaves a finished rest alone on −15', () => {
    const rest = { endsAt: NOW - 40_000, total: 90 };
    expect(adjustRest(rest, -15, NOW)).toBe(rest);
  });
});
