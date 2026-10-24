import type {
  BlockSection,
  BlockType,
  EntryStatus,
  Equipment,
  ExperienceLevel,
  GoalKey,
  MovementPattern,
  MuscleGroup,
  ProgramGoal,
  ProgramStatus,
  RecStatus,
  RecType,
  SetType,
  Settings,
  Technique,
  TrainingType,
  VolumePresetKey,
  VolumeTarget,
} from './types';

export const DEFAULT_MUSCLES: MuscleGroup[] = [
  { id: 'chest', name: 'חזה', order: 0 },
  { id: 'back', name: 'גב', order: 1 },
  { id: 'shoulders', name: 'כתפיים', order: 2 },
  { id: 'biceps', name: 'יד קדמית', order: 3 },
  { id: 'triceps', name: 'יד אחורית', order: 4 },
  { id: 'quads', name: 'ארבע-ראשי', order: 5 },
  { id: 'hamstrings', name: 'המסטרינגס', order: 6 },
  { id: 'glutes', name: 'ישבן', order: 7 },
  { id: 'calves', name: 'תאומים', order: 8 },
  { id: 'core', name: 'ליבה / בטן', order: 9 },
  { id: 'adductors', name: 'מקרבי ירך', order: 10 },
  { id: 'abductors', name: 'מרחיקי ירך', order: 11 },
];

export const PATTERNS: Record<MovementPattern, string> = {
  squat: 'סקוואט',
  hinge: 'ציר ירך',
  lunge: 'לאנג׳ / רגל אחת',
  hpush: 'דחיפה אופקית',
  vpush: 'דחיפה אנכית',
  hpull: 'משיכה אופקית',
  vpull: 'משיכה אנכית',
  carry: 'נשיאה',
  core: 'ליבה',
  isolation: 'בידוד',
  other: 'אחר',
};

export const EQUIPMENT: Record<Equipment, string> = {
  barbell: 'מוט',
  dumbbell: 'משקולות יד',
  machine: 'מכונה',
  cable: 'כבל',
  bodyweight: 'משקל גוף',
  kettlebell: 'קטלבל',
  band: 'גומייה',
  smith: 'סמית׳',
  trx: 'TRX',
  other: 'אחר',
};

export const DIFFICULTY: Record<1 | 2 | 3, string> = { 1: 'מתחיל', 2: 'בינוני', 3: 'מתקדם' };

export const GOALS: Record<GoalKey, string> = {
  muscle: 'עלייה במסת שריר',
  fatloss: 'ירידה באחוזי שומן',
  strength: 'שיפור כוח',
  endurance: 'סיבולת',
  function: 'תפקוד יומיומי',
  return: 'חזרה לפעילות',
  custom: 'מטרה מותאמת',
};

export const TRAINING_TYPES: Record<TrainingType, string> = {
  personal: 'אישי',
  couple: 'זוגי',
  group: 'קבוצה קטנה',
  online: 'אונליין',
  other: 'אחר',
};

export const EXPERIENCE: Record<ExperienceLevel, string> = {
  none: 'ללא ניסיון',
  beginner: 'מתחיל/ה',
  intermediate: 'בינוני/ת',
  advanced: 'מתקדם/ת',
};

export const PROGRAM_GOALS: Record<ProgramGoal, string> = {
  hypertrophy: 'היפרטרופיה',
  strength: 'כוח',
  endurance: 'סיבולת',
  fatloss: 'חיטוב / ירידה',
  general: 'כושר כללי',
  rehab: 'חזרה / שיקום',
};

/** Typical rep ranges per program goal — used by the range-fit rule. */
export const GOAL_REP_RANGES: Record<ProgramGoal, [number, number]> = {
  strength: [3, 8],
  hypertrophy: [6, 15],
  endurance: [12, 25],
  fatloss: [8, 20],
  general: [6, 15],
  rehab: [8, 20],
};

export const PROGRAM_STATUS: Record<ProgramStatus, string> = {
  active: 'פעילה',
  draft: 'טיוטה',
  archived: 'בארכיון',
};

export const BLOCK_TYPES: Record<BlockType, string> = {
  single: 'תרגיל בודד',
  superset: 'סופר-סט',
  triset: 'טרי-סט',
  circuit: 'סבב',
};

export const SECTIONS: Record<BlockSection, string> = {
  warmup: 'חימום והכנה',
  main: 'חלק עיקרי',
  finisher: 'סיום',
};

export const SET_TYPES: Record<SetType, string> = {
  warmup: 'חימום',
  working: 'עבודה',
  drop: 'דרופ',
  backoff: 'בק-אוף',
};

export const SET_TYPE_SHORT: Record<SetType, string> = {
  warmup: 'ח',
  working: '',
  drop: 'D',
  backoff: 'B',
};

export const TECHNIQUE: Record<Technique, string> = {
  good: 'טובה',
  fix: 'נדרש תיקון',
  poor: 'לא מספקת',
  na: 'לא תועדה',
};

export const ENTRY_STATUS: Record<EntryStatus, string> = {
  pending: 'ממתין',
  done: 'בוצע',
  skipped: 'דולג',
  notdone: 'לא בוצע',
};

export const REC_TYPES: Record<RecType, string> = {
  increaseWeight: 'העלאת משקל',
  addReps: 'הוספת חזרות',
  adjustRange: 'התאמת טווח חזרות',
  reduceLoad: 'הפחתת עומס',
  swapExercise: 'החלפת תרגיל',
  techniqueCheck: 'בדיקת טכניקה',
  painCheck: 'כאב / אי-נוחות',
  recoveryCheck: 'בדיקת התאוששות',
  volumeLow: 'נפח נמוך מהיעד',
  volumeHigh: 'נפח גבוה מהיעד',
  adherence: 'פער תכנון-ביצוע',
};

export const REC_STATUS: Record<RecStatus, string> = {
  pending: 'ממתינה לאישור',
  approved: 'אושרה',
  edited: 'נערכה',
  rejected: 'נדחתה',
  applied: 'בוצעה',
};

export const WEEKDAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
export const WEEKDAYS_SHORT = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];

/** Weekly direct-set targets per muscle, by training age (evidence-based ranges). */
export const VOLUME_PRESETS: Record<VolumePresetKey, { label: string; hint: string; base: VolumeTarget }> = {
  maintenance: { label: 'שימור', hint: 'מינימום לשמירה על מסה וכוח', base: { min: 4, max: 8 } },
  beginner: { label: 'מתחיל/ה', hint: 'נפח מתון, דגש על טכניקה', base: { min: 6, max: 10 } },
  intermediate: { label: 'בינוני/ת', hint: 'טווח עבודה סטנדרטי לרוב המתאמנים', base: { min: 10, max: 16 } },
  advanced: { label: 'מתקדם/ת', hint: 'נפח גבוה עם התאוששות טובה', base: { min: 12, max: 20 } },
};

/** Smaller muscles / heavily trained indirectly get lower direct targets. */
export const PRESET_MUSCLE_SCALE: Record<string, number> = {
  calves: 0.7,
  core: 0.6,
  adductors: 0.5,
  abductors: 0.5,
  biceps: 0.8,
  triceps: 0.8,
};

export function presetTarget(preset: VolumePresetKey, muscle: string): VolumeTarget {
  const base = VOLUME_PRESETS[preset].base;
  const scale = PRESET_MUSCLE_SCALE[muscle] ?? 1;
  return { min: Math.max(1, Math.round(base.min * scale)), max: Math.max(2, Math.round(base.max * scale)) };
}

export const DEFAULT_SETTINGS: Settings = {
  id: 'settings',
  updatedAt: 0,
  trainerName: 'שירה',
  muscles: DEFAULT_MUSCLES,
  indirectFactor: 0.5,
  hardSetMaxRir: null,
  countDropSets: true,
  defaultRest: 90,
  increments: {
    barbell: 2.5,
    dumbbell: 2,
    machine: 5,
    cable: 2.5,
    bodyweight: 0,
    kettlebell: 4,
    band: 0,
    smith: 2.5,
    trx: 0,
    other: 2.5,
  },
  weekStartsOn: 0,
  stagnationWeeks: 4,
  theme: 'system',
  rirMode: 'rir',
  sound: true,
  vibrate: true,
  backupReminderDays: 7,
  autoSnapshot: true,
  lastExternalBackupAt: null,
  lastSnapshotAt: null,
  onboarded: false,
};

export const CLIENT_COLORS = ['#5B4CF0', '#E0484E', '#17A86B', '#E8930C', '#2F80ED', '#C2418F', '#0F9FA8', '#8A5CF6', '#D9662B', '#4C7A2E'];
