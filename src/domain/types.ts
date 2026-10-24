// Core data model (spec §13). Every record carries an id + timestamps and is
// soft-deleted (deletedAt) so history is never silently overwritten and a
// future cloud sync can merge records by id / updatedAt without duplicates.

export type ID = string;
export type MuscleId = string;

export interface BaseRecord {
  id: ID;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number | null;
  /** Demo records can be removed in one action from settings. */
  demo?: boolean;
}

/* ---------------------------------------------------------------- muscles */

export interface MuscleGroup {
  id: MuscleId;
  name: string;
  order: number;
  hidden?: boolean;
  custom?: boolean;
}

/* -------------------------------------------------------------- exercises */

export type MovementPattern =
  | 'squat'
  | 'hinge'
  | 'lunge'
  | 'hpush'
  | 'vpush'
  | 'hpull'
  | 'vpull'
  | 'carry'
  | 'core'
  | 'isolation'
  | 'other';

export type Equipment =
  | 'barbell'
  | 'dumbbell'
  | 'machine'
  | 'cable'
  | 'bodyweight'
  | 'kettlebell'
  | 'band'
  | 'smith'
  | 'trx'
  | 'other';

/** A secondary (indirect) muscle. `factor` overrides the global indirect factor. */
export interface MuscleContribution {
  muscle: MuscleId;
  factor?: number;
}

export interface ExerciseData {
  nameHe: string;
  nameEn: string;
  aliases: string[];
  primary: MuscleId[];
  secondary: MuscleContribution[];
  pattern: MovementPattern;
  equipment: Equipment;
  difficulty: 1 | 2 | 3;
  cues: string[];
  mistakes: string[];
  /** ids of alternative / variation exercises */
  alternatives: ID[];
  /** smallest sensible load jump in kg (overrides the equipment default) */
  increment?: number;
  unilateral?: boolean;
  mediaUrl?: string;
  notes?: string;
}

export interface Exercise extends BaseRecord, ExerciseData {
  custom: boolean;
  archived?: boolean;
}

/* ---------------------------------------------------------------- clients */

export type TrainingType = 'personal' | 'couple' | 'group' | 'online' | 'other';

export type GoalKey =
  | 'muscle'
  | 'fatloss'
  | 'strength'
  | 'endurance'
  | 'function'
  | 'return'
  | 'custom';

export type ExperienceLevel = 'none' | 'beginner' | 'intermediate' | 'advanced';

export interface VolumeTarget {
  min: number;
  max: number;
}

export interface ClientTarget {
  id: ID;
  text: string;
  exerciseId?: ID;
  value?: number;
  unit?: string;
  due?: string; // YYYY-MM-DD
  achievedAt?: number | null;
}

export interface Client extends BaseRecord {
  name: string;
  phone?: string;
  email?: string;
  birthDate?: string; // YYYY-MM-DD
  sex?: 'f' | 'm' | '';
  height?: number; // cm
  startDate?: string;
  weeklyFrequency?: number;
  trainingType?: TrainingType;
  plannedDays: number[]; // 0 = Sunday … 6 = Saturday
  goals: GoalKey[];
  customGoal?: string;
  experience?: ExperienceLevel;
  fitnessLevel?: 1 | 2 | 3 | 4 | 5;
  limitations?: string;
  injuries?: string;
  uncomfortableExercises?: string;
  technicalNotes?: string;
  /** Per-muscle weekly set targets; missing muscles fall back to the preset. */
  volumeTargets: Record<MuscleId, VolumeTarget>;
  volumePreset?: VolumePresetKey;
  targets: ClientTarget[];
  archived?: boolean;
  color?: string;
}

export type VolumePresetKey = 'maintenance' | 'beginner' | 'intermediate' | 'advanced';

/** Body measurements are appended, never overwritten (spec §4). */
export interface Measurement extends BaseRecord {
  clientId: ID;
  date: string; // YYYY-MM-DD
  weight?: number;
  bodyFat?: number;
  waist?: number;
  hips?: number;
  chest?: number;
  arm?: number;
  thigh?: number;
  restingHr?: number;
  note?: string;
}

export type NoteKind = 'general' | 'next' | 'task' | 'injury';

/**
 * Notes timeline per client. `next` notes surface prominently at the next
 * session; `task` notes are follow-up tasks with a done state.
 */
export interface ClientNote extends BaseRecord {
  clientId: ID;
  kind: NoteKind;
  text: string;
  pinned?: boolean;
  done?: boolean;
  resolvedAt?: number | null;
  sessionId?: ID;
  exerciseId?: ID;
  /** the program slot (and program) the note is about — an exercise trained on two days is two series */
  plannedExerciseId?: ID | null;
  programId?: ID | null;
}

/* --------------------------------------------------------------- programs */

export type SetType = 'warmup' | 'working' | 'drop' | 'backoff';

export interface PlannedSet {
  id: ID;
  type: SetType;
  weight?: number | null;
  repsMin?: number | null;
  repsMax?: number | null;
  rir?: number | null;
  rpe?: number | null;
  rest?: number | null; // seconds
  /** seconds, for timed holds (plank etc.) */
  duration?: number | null;
}

export interface SetupFields {
  seat?: string;
  bench?: string;
  angle?: string;
  cable?: string;
  grip?: string;
  rom?: string;
  other?: string;
}

export interface PlannedExercise {
  id: ID;
  exerciseId: ID;
  sets: PlannedSet[];
  notes?: string;
  tempo?: string;
  setup: SetupFields;
}

export type BlockType = 'single' | 'superset' | 'triset' | 'circuit';
export type BlockSection = 'warmup' | 'main' | 'finisher';

export interface Block {
  id: ID;
  type: BlockType;
  section: BlockSection;
  /** rounds for circuits */
  rounds?: number | null;
  restAfter?: number | null;
  items: PlannedExercise[];
}

export interface PlannedWorkout {
  id: ID;
  name: string;
  focus?: string;
  days: number[];
  notes?: string;
  warmupNotes?: string;
  blocks: Block[];
}

export type ProgramStatus = 'active' | 'draft' | 'archived';
export type ProgramGoal = 'hypertrophy' | 'strength' | 'endurance' | 'fatloss' | 'general' | 'rehab';

export interface Program extends BaseRecord {
  /** null = a reusable template */
  clientId: ID | null;
  name: string;
  goal: ProgramGoal;
  phase?: string;
  startDate?: string;
  endDate?: string;
  status: ProgramStatus;
  version: number;
  workouts: PlannedWorkout[];
  notes?: string;
}

export interface ProgramChange {
  path: string; // human readable location, e.g. "אימון A › לחיצת חזה › סט 2"
  field: string;
  from: string;
  to: string;
}

/** Immutable snapshot of a program at each saved version (spec §6, §13). */
export interface ProgramVersion extends BaseRecord {
  programId: ID;
  clientId: ID | null;
  version: number;
  reason: string;
  approvedBy: string;
  changes: ProgramChange[];
  snapshot: Pick<Program, 'name' | 'goal' | 'phase' | 'startDate' | 'endDate' | 'status' | 'workouts' | 'notes'>;
  recommendationId?: ID;
}

/* --------------------------------------------------------------- sessions */

export type Technique = 'good' | 'fix' | 'poor' | 'na';
export type EntryStatus = 'pending' | 'done' | 'skipped' | 'notdone';

export interface PerformedSet {
  id: ID;
  plannedSetId?: ID | null;
  type: SetType;
  /** copied from the plan at session start; only a mid-workout swap changes it (the replacement gets no planned load). The session's plannedSnapshot itself is never edited. */
  planned?: {
    weight?: number | null;
    repsMin?: number | null;
    repsMax?: number | null;
    rir?: number | null;
    rpe?: number | null;
    rest?: number | null;
    duration?: number | null;
  } | null;
  weight?: number | null;
  reps?: number | null;
  rir?: number | null;
  rpe?: number | null;
  duration?: number | null;
  restTaken?: number | null;
  done: boolean;
  doneAt?: number | null;
  technique?: Technique | null;
  note?: string;
  /** added during the session (not part of the plan) */
  added?: boolean;
  /** reps / weight were taken from the target on ✓ without being typed — not trusted as evidence */
  autoFilled?: boolean;
}

export interface PainReport {
  reported: boolean;
  location?: string;
  severity?: number; // 1-10
  note?: string;
}

export interface SessionEntry {
  id: ID;
  plannedExerciseId?: ID | null;
  exerciseId: ID;
  /** original exercise when swapped during the session */
  swappedFromId?: ID | null;
  blockId?: ID | null;
  blockLabel: string; // "A", "B1" …
  blockType: BlockType;
  section: BlockSection;
  status: EntryStatus;
  sets: PerformedSet[];
  technique: Technique;
  pain: PainReport;
  notes?: string;
  setup: SetupFields;
  added?: boolean;
  /** stopped early and replaced by another exercise during the workout (its undone sets moved there) */
  cutShort?: boolean;
}

export interface Readiness {
  energy?: number | null; // 1-5
  sleep?: number | null; // 1-5
  fatigue?: number | null; // 1-5 (5 = very tired)
  soreness?: number | null; // 1-5 (DOMS)
  note?: string;
}

export interface SessionWrapUp {
  effort?: number | null; // session RPE 1-10
  feeling?: number | null; // 1-5
  recovery?: string;
  note?: string;
}

export type SessionStatus = 'active' | 'completed' | 'abandoned';

export interface Session extends BaseRecord {
  clientId: ID;
  programId?: ID | null;
  programVersion?: number | null;
  plannedWorkoutId?: ID | null;
  workoutName: string;
  /** frozen copy of the plan at session start — the plan is stored separately from execution */
  plannedSnapshot?: PlannedWorkout | null;
  date: string; // YYYY-MM-DD
  startedAt: number;
  endedAt?: number | null;
  status: SessionStatus;
  entries: SessionEntry[];
  readiness: Readiness;
  wrapUp: SessionWrapUp;
  notes?: string;
  currentIndex?: number;
  /** "next session" notes that were shown during this workout and closed when it ended */
  shownNoteIds?: ID[];
}

/* -------------------------------------------------------- recommendations */

export type RecType =
  | 'increaseWeight'
  | 'addReps'
  | 'adjustRange'
  | 'reduceLoad'
  | 'swapExercise'
  | 'techniqueCheck'
  | 'painCheck'
  | 'recoveryCheck'
  | 'volumeLow'
  | 'volumeHigh'
  | 'adherence';

export type RecStatus = 'pending' | 'approved' | 'edited' | 'rejected' | 'applied';

export interface Evidence {
  label: string;
  value: string;
  date?: string;
  sessionId?: ID;
}

export interface RecSuggestion {
  /** what to change in the active program, when applicable */
  kind: 'weight' | 'reps' | 'range' | 'swap' | 'none';
  exerciseId?: ID;
  /** the program slot the evidence came from — weight/range changes apply only there */
  plannedExerciseId?: ID | null;
  from?: string;
  to?: string;
  weight?: number | null;
  repsMin?: number | null;
  repsMax?: number | null;
  alternativeIds?: ID[];
}

export interface Recommendation extends BaseRecord {
  clientId: ID;
  programId?: ID | null;
  exerciseId?: ID | null;
  muscle?: MuscleId | null;
  type: RecType;
  severity: 'info' | 'suggest' | 'warn';
  title: string;
  detected: string; // what was detected
  reasoning: string; // why, on which data
  action: string; // what can be done
  evidence: Evidence[];
  suggestion: RecSuggestion;
  status: RecStatus;
  dedupeKey: string;
  sourceSessionId?: ID | null;
  decidedAt?: number | null;
  decisionNote?: string;
  editedTo?: string;
  appliedVersion?: number | null;
}

/* --------------------------------------------------------------- settings */

export interface Settings {
  id: 'settings';
  updatedAt: number;
  trainerName: string;
  muscles: MuscleGroup[];
  /** custom muscle groups the trainer deleted (kept so a backup merge doesn't resurrect them) */
  deletedMuscleIds?: string[];
  /** indirect (secondary) sets count as this fraction of a set by default */
  indirectFactor: number;
  /** count only sets with RIR <= this as "hard" sets; null = count all working sets */
  hardSetMaxRir: number | null;
  countDropSets: boolean;
  defaultRest: number;
  increments: Record<Equipment, number>;
  weekStartsOn: 0 | 1;
  stagnationWeeks: number;
  theme: 'system' | 'light' | 'dark';
  rirMode: 'rir' | 'rpe' | 'both';
  sound: boolean;
  vibrate: boolean;
  backupReminderDays: number;
  autoSnapshot: boolean;
  /** last time a backup file left the device (download/share/folder) */
  lastExternalBackupAt?: number | null;
  lastSnapshotAt?: number | null;
  onboarded?: boolean;
}

export type SnapshotKind = 'daily' | 'event' | 'manual';

/** Automatic local snapshot of the whole database (time machine). */
export interface Snapshot {
  id: ID;
  createdAt: number;
  reason: string;
  /** 'daily' = the automatic time-machine copy; 'event' = taken before a single action; 'manual' = "save now" */
  kind?: SnapshotKind;
  counts: Record<string, number>;
  size: number;
  /** gzip-compressed JSON backup payload */
  gz?: Uint8Array;
  /** plain JSON (fallback when compression is unavailable) */
  data?: string;
}
