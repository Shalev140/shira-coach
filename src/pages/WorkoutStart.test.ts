import { describe, expect, it } from 'vitest';
import { blankBlock, blankPlannedExercise, blankWorkout, entriesFromWorkout } from '../db/repo';
import { plannedSetCount } from './WorkoutStart';

describe('workout picker set count', () => {
  it('counts a circuit once per round, as the started workout will', () => {
    const w = blankWorkout('B');
    const circuit = { ...blankBlock('main', 'circuit'), rounds: 3 };
    circuit.items = ['bench_press_db', 'goblet_squat', 'plank', 'push_up'].map((id) => {
      const it = blankPlannedExercise(id);
      return { ...it, sets: it.sets.slice(0, 1) };
    });
    const single = blankBlock('main', 'single');
    single.items = [blankPlannedExercise('squat_back_bb')];
    w.blocks = [single, circuit];
    const started = entriesFromWorkout(w).reduce((n, e) => n + e.sets.length, 0);
    expect(plannedSetCount(w)).toBe(single.items[0].sets.length + 4 * 3);
    expect(plannedSetCount(w)).toBe(started);
  });
});
