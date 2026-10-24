import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  Check,
  ChevronDown,
  Copy,
  GitBranch,
  GripVertical,
  History,
  Info,
  Link2,
  MoreHorizontal,
  Play,
  Plus,
  RotateCcw,
  Save,
  Settings2,
  Trash2,
  Unlink,
  X,
  Zap,
} from 'lucide-react';
import { useActiveProgram, useActiveSessions, useClient, useClientSessions, useExercises, useProgram, useProgramVersions, useSettings } from '../db/hooks';
import {
  activateProgram,
  activeSessions,
  blankBlock,
  blankPlannedExercise,
  blankSet,
  blankWorkout,
  blockOrderLabels,
  cloneWorkout,
  duplicateProgram,
  restoreProgramVersion,
  saveProgram,
  softDelete,
  startSession,
} from '../db/repo';
import type { Block, BlockSection, BlockType, Exercise, ID, PlannedExercise, PlannedSet, PlannedWorkout, Program, ProgramGoal, ProgramStatus, Session, SetType } from '../domain/types';
import { BLOCK_TYPES, EQUIPMENT, PROGRAM_GOALS, PROGRAM_STATUS, SECTIONS, SET_TYPES, WEEKDAYS_SHORT } from '../domain/labels';
import { previousOccurrence, formatSet } from '../domain/progress';
import { diffPrograms } from '../domain/programDiff';
import { blockLabel, deepClone, fmtDateTime, plural, relativeDay } from '../domain/util';
import { Empty, Field, NumInput, Seg, Sheet, TopBar, useUi } from '../components/ui';
import { ExercisePicker } from '../components/ExercisePicker';
import { VolumePanel } from '../components/VolumePanel';
import { otherDrafts, removeDraftKey, useDraft } from '../components/useDraft';

export function ProgramEditor() {
  const { id } = useParams();
  const program = useProgram(id);
  if (program === undefined) return null;
  if (program === null)
    return (
      <>
        <TopBar title="תוכנית לא נמצאה" back="/programs" />
        <div className="page">
          <Empty title="התוכנית לא נמצאה" />
        </div>
      </>
    );
  // remount on every new version: after a save / restore / activation / an applied
  // recommendation the editor always starts from what is actually stored
  return <Editor key={`${program.id}:${program.version}`} saved={program} />;
}

const strip = (p: Program) => JSON.stringify({ ...p, updatedAt: 0, version: 0 });


function Editor({ saved }: { saved: Program }) {
  const nav = useNavigate();
  const { toast, confirm } = useUi();
  const settings = useSettings();
  const { map: exercises } = useExercises();
  const client = useClient(saved.clientId ?? undefined);
  const sessions = useClientSessions(saved.clientId ?? undefined) ?? [];
  const activeProgram = useActiveProgram(saved.clientId ?? undefined);
  const live = useActiveSessions()?.find((s) => s.clientId === saved.clientId);
  // the draft key carries the version: a draft is only restored on top of the version it was made from
  const draftKey = `program:${saved.id}:v${saved.version}`;
  const draft = useDraft<Program>(draftKey, () => deepClone(saved));
  // an unsaved draft made on an OLDER version is not applied silently (it would undo newer changes) — it's offered
  const [stale, setStale] = useState<{ key: string; value: Program; t: number } | null>(
    () => otherDrafts<Program>(`program:${saved.id}:`, draftKey)[0] ?? null,
  );
  const p = draft.value;
  const [params, setParams] = useSearchParams();
  const wi = Number(params.get('w') ?? 0) || 0;
  const setWi = (i: number) => setParams({ w: String(i) }, { replace: true });
  const busy = useRef(false);
  const [saving, setSaving] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [showMeta, setShowMeta] = useState(false);
  const [showVolume, setShowVolume] = useState(false);
  const [menu, setMenu] = useState(false);
  const dirty = strip(p) !== strip(saved);
  const workout = p.workouts[Math.min(wi, p.workouts.length - 1)];

  const update = (fn: (draft: Program) => void) =>
    draft.setValue((prev) => {
      const next = deepClone(prev);
      fn(next);
      return next;
    });
  const updateWorkout = (fn: (w: PlannedWorkout) => void) =>
    update((d) => {
      const w = d.workouts.find((x) => x.id === workout.id);
      if (w) fn(w);
    });

  const addWorkout = () => {
    update((d) => d.workouts.push(blankWorkout(blockLabel(d.workouts.length))));
    setWi(p.workouts.length);
  };
  const duplicateWorkout = () => {
    update((d) => d.workouts.push(cloneWorkout(workout, `${workout.name} (עותק)`)));
    setWi(p.workouts.length);
    toast('האימון שוכפל');
  };
  const removeWorkout = async () => {
    if (p.workouts.length <= 1) return toast('צריך לפחות אימון אחד', { tone: 'error' });
    if (!(await confirm({ title: `למחוק את אימון ${workout.name}?`, danger: true, confirmLabel: 'מחיקה' }))) return;
    update((d) => {
      d.workouts = d.workouts.filter((w) => w.id !== workout.id);
    });
    setWi(0);
  };

  /**
   * Runs a save that may store a new version. A new version remounts the editor, and a draft key still
   * present at that moment is offered as a stale "unsaved draft" — so the draft is cleared first, and
   * written back if the save fails so no edit is lost.
   */
  const storeVersion = async <T,>(save: () => Promise<T>): Promise<T> => {
    draft.clear();
    try {
      return await save();
    } catch (e) {
      draft.setValue((cur) => deepClone(cur));
      throw e;
    }
  };

  /** Saves the draft; returns the stored program (the editor remounts on the new version). */
  const doSave = async (reason: string): Promise<Program | null> => {
    if (busy.current) return null; // double-tapped "save"
    busy.current = true;
    try {
      const { program: stored, version } = await storeVersion(() => saveProgram({ ...p, version: saved.version }, { reason }));
      // activating through the details sheet must still archive the client's other active program
      if (stored.clientId && stored.status === 'active' && saved.status !== 'active') await activateProgram(stored);
      setSaving(false);
      toast(version ? `נשמר · גרסה ${version.version}` : 'נשמר (ללא שינוי בתוכן)');
      return stored;
    } finally {
      busy.current = false;
    }
  };

  const changes = useMemo(() => (saving ? diffPrograms(saved, p, exercises) : []), [saving]);
  const isTemplate = p.clientId === null;

  return (
    <>
      <TopBar
        title={p.name}
        sub={
          <>
            {isTemplate ? 'תבנית' : client?.name} · {PROGRAM_STATUS[p.status]} · גרסה {saved.version}
            {dirty && <span className="unsaved"> · שינויים לא שמורים</span>}
          </>
        }
        back={saved.clientId ? `/clients/${saved.clientId}?tab=program` : '/programs'}
        actions={
          <>
            <button className="icon-btn" aria-label="גרסאות" onClick={() => setShowVersions(true)}>
              <History />
            </button>
            <button className="icon-btn" aria-label="עוד" onClick={() => setMenu(true)}>
              <MoreHorizontal />
            </button>
            <button className="btn btn-primary btn-sm" disabled={!dirty} onClick={() => setSaving(true)}>
              <Save /> שמירה
            </button>
          </>
        }
      />
      <div className="page stack-lg">
        {draft.restored && dirty && (
          <div className="banner tone-info">
            <RotateCcw />
            <div className="grow small">שוחזרה טיוטה עם שינויים שעוד לא נשמרו.</div>
            <button className="btn btn-sm btn-ghost" onClick={draft.discard}>
              ביטול השינויים
            </button>
          </div>
        )}
        {stale && (
          <div className="banner tone-warn">
            <RotateCcw />
            <div className="grow small">
              נמצאה טיוטה שלא נשמרה מגרסה {stale.value.version} ({fmtDateTime(stale.t)}). התוכנית עודכנה מאז לגרסה {saved.version}, לכן הטיוטה לא נטענה.
            </div>
            <button
              className="btn btn-sm"
              onClick={() => {
                draft.setValue({ ...stale.value, version: saved.version });
                removeDraftKey(stale.key);
                setStale(null);
                toast('הטיוטה נטענה — בדקי את השינויים לפני שמירה', { tone: 'info' });
              }}
            >
              טעינת הטיוטה
            </button>
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => {
                removeDraftKey(stale.key);
                setStale(null);
              }}
            >
              מחיקה
            </button>
          </div>
        )}
        {!isTemplate && p.status !== 'active' && (
          <div className="banner tone-warn">
            <Info />
            <div className="grow small">
              התוכנית {PROGRAM_STATUS[p.status]}. {activeProgram && activeProgram.id !== p.id ? `התוכנית הפעילה כרגע: ${activeProgram.name}.` : ''}
            </div>
            <button
              className="btn btn-sm"
              onClick={async () => {
                if (busy.current) return;
                busy.current = true;
                try {
                  const base = await storeVersion(async () =>
                    dirty ? (await saveProgram({ ...p, version: saved.version }, { reason: 'שמירה לפני הפעלה' })).program : saved,
                  );
                  await activateProgram(base);
                  toast('התוכנית הופעלה');
                } finally {
                  busy.current = false;
                }
              }}
            >
              <Play /> הפעלה
            </button>
          </div>
        )}

        <button className="card card-pad program-meta" onClick={() => setShowMeta(true)}>
          <div className="row between">
            <div className="row row-wrap" style={{ gap: 6 }}>
              <span className="badge tone-accent">{PROGRAM_GOALS[p.goal]}</span>
              {p.phase && <span className="badge">{p.phase}</span>}
              {p.startDate && <span className="small muted">מ-{p.startDate}{p.endDate ? ` עד ${p.endDate}` : ''}</span>}
            </div>
            <Settings2 size={18} className="faint" />
          </div>
          {p.notes && <div className="small muted" style={{ marginTop: 6 }}>{p.notes}</div>}
        </button>

        <div className="workout-tabs">
          {p.workouts.map((w, i) => (
            <button key={w.id} className={`wtab ${w.id === workout.id ? 'on' : ''}`} onClick={() => setWi(i)}>
              <span className="wtab-name">{w.name}</span>
              <span className="tiny">{plural(w.blocks.reduce((n, b) => n + b.items.length, 0), 'תרגיל אחד', 'תרגילים')}</span>
            </button>
          ))}
          <button className="wtab add" onClick={addWorkout} aria-label="אימון חדש">
            <Plus />
          </button>
        </div>

        <WorkoutEditor
          key={workout.id}
          workout={workout}
          exercises={exercises}
          sessions={sessions}
          onChange={updateWorkout}
          onDuplicate={duplicateWorkout}
          onRemove={removeWorkout}
          defaultRest={settings.defaultRest}
        />

        <section className="card card-pad stack">
          <button className="row between" onClick={() => setShowVolume((v) => !v)} style={{ width: '100%' }}>
            <span className="card-title">
              <BarChart3 /> בקרת נפח מתוכנן
            </span>
            <ChevronDown style={{ transform: showVolume ? 'rotate(180deg)' : undefined }} />
          </button>
          {showVolume && (
            // the panel opens on the planned view (its own default is the performed week); the performed
            // view shows the client's real workouts, never an empty list read as "everything under target"
            <VolumePanel
              initialMode="plan"
              client={client ?? { id: 'tmp', createdAt: 0, updatedAt: 0, name: '', plannedDays: [], goals: [], volumeTargets: {}, volumePreset: 'intermediate', targets: [] }}
              sessions={sessions}
              program={p}
              exercises={exercises}
              settings={settings}
            />
          )}
          {showVolume && <p className="tiny muted">מחושב לפי מספר הפעמים בשבוע שכל אימון מתוכנן (ימים שנבחרו), מול יעדי הנפח של המתאמן/ת.</p>}
        </section>

        {dirty && (
          <div className="fab-bottom">
            <button className="btn btn-primary btn-lg btn-block" onClick={() => setSaving(true)}>
              <Save /> שמירת שינויים
            </button>
          </div>
        )}
      </div>

      {saving && (
        <SaveSheet
          changes={changes}
          exercises={exercises}
          onClose={() => setSaving(false)}
          onSave={doSave}
        />
      )}
      {showVersions && (
        <VersionsSheet
          program={saved}
          onClose={() => setShowVersions(false)}
          onRestore={async (v) => {
            if (
              !(await confirm({
                title: `לשחזר לגרסה ${v.version}?`,
                body: `התוכנית תחזור לתוכן של הגרסה הזו, והשחזור יישמר כגרסה חדשה — שום דבר לא נמחק.${dirty ? ' שינויים שלא נשמרו יבוטלו.' : ''}`,
              }))
            )
              return;
            setShowVersions(false);
            const restored = await storeVersion(() => restoreProgramVersion(saved, v)); // new version → the editor reloads from it
            // a restore whose content equals the current one stores no new version and nothing remounts,
            // so the edits she just confirmed discarding are dropped here as well
            draft.setValue(deepClone(restored));
            draft.clear();
            toast(`שוחזר לגרסה ${v.version}`);
          }}
        />
      )}
      {showMeta && <MetaSheet program={p} onClose={() => setShowMeta(false)} onChange={(patch) => update((d) => Object.assign(d, patch))} />}
      {menu && (
        <Sheet title="פעולות" onClose={() => setMenu(false)}>
          <div className="list card">
            {!isTemplate &&
              (live ? (
                // a client has one workout at a time: startSession would return this one, so "start B" would land in A
                <button
                  className="list-item"
                  onClick={() => {
                    setMenu(false);
                    nav(`/session/${live.id}`);
                  }}
                >
                  <Zap size={18} /> <span className="grow">המשך האימון הפעיל ({live.workoutName})</span>
                </button>
              ) : (
                <button
                  className="list-item"
                  onClick={async () => {
                    setMenu(false);
                    // checked before saving: a workout opened meanwhile is the one startSession would return
                    const open = (await activeSessions()).find((s) => s.clientId === saved.clientId);
                    if (open) {
                      toast(`יש כבר אימון פעיל (${open.workoutName})`, { tone: 'info' });
                      nav(`/session/${open.id}`);
                      return;
                    }
                    // the session must reference the version actually stored
                    const stored = dirty ? await doSave('שמירה לפני התחלת אימון') : saved;
                    if (!stored) return;
                    const s = await startSession({ clientId: stored.clientId!, program: stored, workoutId: workout.id });
                    nav(`/session/${s.id}`);
                  }}
                >
                  <Play size={18} /> <span className="grow">התחלת אימון {workout.name}</span>
                </button>
              ))}
            <button
              className="list-item"
              onClick={async () => {
                const t = await duplicateProgram(p, null, `${p.name} — תבנית`);
                setMenu(false);
                toast('נשמרה כתבנית');
                nav(`/programs/${t.id}`);
              }}
            >
              <Copy size={18} /> <span className="grow">שמירה כתבנית</span>
            </button>
            <button
              className="list-item"
              onClick={async () => {
                const t = await duplicateProgram(p, p.clientId, `${p.name} (עותק)`);
                setMenu(false);
                toast('התוכנית שוכפלה כטיוטה');
                nav(`/programs/${t.id}`);
              }}
            >
              <GitBranch size={18} /> <span className="grow">שכפול כתוכנית חדשה (למחזור הבא)</span>
            </button>
            {!isTemplate && p.status !== 'archived' && (
              <button
                className="list-item"
                onClick={async () => {
                  setMenu(false);
                  if (dirty && !(await confirm({ title: 'להעביר לארכיון?', body: 'יש שינויים שלא נשמרו — הם לא יישמרו.', confirmLabel: 'העברה לארכיון' }))) return;
                  // archive what is stored (not unsaved edits); the editor reloads on the new version
                  await storeVersion(() => saveProgram({ ...saved, status: 'archived' }, { reason: 'העברה לארכיון' }));
                  toast('התוכנית הועברה לארכיון');
                }}
              >
                <History size={18} /> <span className="grow">העברה לארכיון</span>
              </button>
            )}
            <button
              className="list-item"
              style={{ color: 'var(--danger)' }}
              onClick={async () => {
                setMenu(false);
                if (!(await confirm({ title: 'למחוק את התוכנית?', body: 'אימונים שכבר בוצעו לפיה נשמרים בהיסטוריה.', danger: true, confirmLabel: 'מחיקה' }))) return;
                await softDelete('programs', p.id);
                draft.clear();
                toast('התוכנית נמחקה');
                nav(saved.clientId ? `/clients/${saved.clientId}?tab=program` : '/programs');
              }}
            >
              <Trash2 size={18} /> <span className="grow">מחיקת התוכנית</span>
            </button>
          </div>
        </Sheet>
      )}
    </>
  );
}

/* ---------------------------------------------------------------- workout */

const SECTION_LIST: BlockSection[] = ['warmup', 'main', 'finisher'];
const GROUP_ORDER: BlockType[] = ['single', 'superset', 'triset', 'circuit'];

/**
 * A group's type once an exercise joins it: promoted by size the way merging groups does (4+ is a
 * circuit), never demoted from a type picked by hand (a circuit of 3 stays a circuit).
 */
export function grownBlockType(type: BlockType, count: number): BlockType {
  const bySize: BlockType = count >= 4 ? 'circuit' : count === 3 ? 'triset' : count === 2 ? 'superset' : 'single';
  return GROUP_ORDER.indexOf(bySize) > GROUP_ORDER.indexOf(type) ? bySize : type;
}

function WorkoutEditor({
  workout,
  exercises,
  sessions,
  onChange,
  onDuplicate,
  onRemove,
  defaultRest,
}: {
  workout: PlannedWorkout;
  exercises: Map<ID, Exercise>;
  sessions: Session[];
  onChange: (fn: (w: PlannedWorkout) => void) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  defaultRest: number;
}) {
  const [picker, setPicker] = useState<{ section: BlockSection; blockId?: ID } | null>(null);
  const { rirMode } = useSettings();
  const labels = blockOrderLabels(workout);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  const onDragEnd = (section: BlockSection) => (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    onChange((w) => {
      const inSection = w.blocks.filter((b) => b.section === section);
      const from = inSection.findIndex((b) => b.id === e.active.id);
      const to = inSection.findIndex((b) => b.id === e.over!.id);
      const moved = arrayMove(inSection, from, to);
      const others = w.blocks.filter((b) => b.section !== section);
      w.blocks = [...others, ...moved].sort((a, b) => SECTION_LIST.indexOf(a.section) - SECTION_LIST.indexOf(b.section));
    });
  };

  const addExercise = (exerciseId: ID) => {
    if (!picker) return;
    const ex = exercises.get(exerciseId);
    const isWarm = picker.section === 'warmup';
    const template: Partial<PlannedSet> = {
      repsMin: isWarm ? 10 : 8,
      repsMax: isWarm ? 12 : 12,
      // the default effort target in the scale the trainer works with (an unseen RIR must not linger in RPE mode)
      rir: isWarm || rirMode === 'rpe' ? null : 2,
      rpe: !isWarm && rirMode === 'rpe' ? 8 : null,
      rest: isWarm ? 45 : defaultRest,
      duration: ex?.pattern === 'core' && /פלאנק|plank|wall|קיר/i.test(`${ex.nameHe} ${ex.nameEn}`) ? 30 : null,
    };
    if (template.duration) {
      template.repsMin = null;
      template.repsMax = null;
    }
    const item = blankPlannedExercise(exerciseId, isWarm ? 2 : 3, template);
    onChange((w) => {
      if (picker.blockId) {
        const b = w.blocks.find((x) => x.id === picker.blockId);
        if (b) {
          b.items.push(item);
          b.type = grownBlockType(b.type, b.items.length);
          return;
        }
      }
      const block = blankBlock(picker.section, 'single');
      block.items.push(item);
      const lastIdx = w.blocks.map((b) => b.section).lastIndexOf(picker.section);
      if (lastIdx === -1) {
        w.blocks.push(block);
        w.blocks.sort((a, b) => SECTION_LIST.indexOf(a.section) - SECTION_LIST.indexOf(b.section));
      } else w.blocks.splice(lastIdx + 1, 0, block);
    });
  };

  return (
    <div className="stack-lg">
      <div className="card card-pad stack">
        <div className="grid-2">
          <Field label="שם האימון">
            <input className="input" value={workout.name} onChange={(e) => onChange((w) => void (w.name = e.target.value))} />
          </Field>
          <Field label="דגש / מטרה" optional>
            <input className="input" value={workout.focus ?? ''} placeholder="למשל: פלג גוף עליון" onChange={(e) => onChange((w) => void (w.focus = e.target.value))} />
          </Field>
        </div>
        <div className="field">
          <span className="label">ימים בשבוע</span>
          <div className="week-days">
            {WEEKDAYS_SHORT.map((d, i) => (
              <button
                key={i}
                className={workout.days.includes(i) ? 'on' : ''}
                onClick={() => onChange((w) => void (w.days = w.days.includes(i) ? w.days.filter((x) => x !== i) : [...w.days, i].sort()))}
              >
                {d}
              </button>
            ))}
          </div>
        </div>
        <Field label="הנחיות חימום / הערות לאימון" optional>
          <textarea className="textarea" style={{ minHeight: 60 }} value={workout.warmupNotes ?? ''} onChange={(e) => onChange((w) => void (w.warmupNotes = e.target.value))} />
        </Field>
        <div className="row row-wrap">
          <button className="btn btn-sm" onClick={onDuplicate}>
            <Copy /> שכפול אימון
          </button>
          <button className="btn btn-sm btn-ghost" onClick={onRemove}>
            <Trash2 /> מחיקת אימון
          </button>
        </div>
      </div>

      {SECTION_LIST.map((section) => {
        const blocks = workout.blocks.filter((b) => b.section === section);
        return (
          <section key={section} className="section">
            <div className="section-head">
              <div className="section-title">{SECTIONS[section]}</div>
              <button className="link-btn" onClick={() => setPicker({ section })}>
                <Plus /> תרגיל
              </button>
            </div>
            {blocks.length === 0 ? (
              <button className="card add-slot" onClick={() => setPicker({ section })}>
                <Plus size={18} /> הוספת תרגיל {section === 'warmup' ? 'חימום / הכנה' : section === 'finisher' ? 'סיום' : ''}
              </button>
            ) : (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd(section)}>
                <SortableContext items={blocks.map((b) => b.id)} strategy={verticalListSortingStrategy}>
                  <div className="stack">
                    {blocks.map((b, bi) => (
                      <SortableBlock
                        key={b.id}
                        block={b}
                        label={labels.get(b.id) ?? ''}
                        isLast={bi === blocks.length - 1}
                        exercises={exercises}
                        sessions={sessions}
                        onChange={(fn) =>
                          onChange((w) => {
                            const t = w.blocks.find((x) => x.id === b.id);
                            if (t) fn(t);
                            w.blocks = w.blocks.filter((x) => x.items.length > 0);
                          })
                        }
                        onAddToBlock={() => setPicker({ section, blockId: b.id })}
                        onMergeNext={() =>
                          onChange((w) => {
                            const list = w.blocks.filter((x) => x.section === section);
                            const next = list[bi + 1];
                            const cur = w.blocks.find((x) => x.id === b.id)!;
                            if (!next) return;
                            cur.items.push(...next.items);
                            cur.type = cur.items.length >= 4 ? 'circuit' : cur.items.length === 3 ? 'triset' : 'superset';
                            w.blocks = w.blocks.filter((x) => x.id !== next.id);
                          })
                        }
                        onSplit={() =>
                          onChange((w) => {
                            const idx = w.blocks.findIndex((x) => x.id === b.id);
                            const cur = w.blocks[idx];
                            const singles = cur.items.map((it) => ({ ...blankBlock(section, 'single'), items: [it] }));
                            w.blocks.splice(idx, 1, ...singles);
                          })
                        }
                        onMoveSection={(to) =>
                          onChange((w) => {
                            const cur = w.blocks.find((x) => x.id === b.id)!;
                            cur.section = to;
                            w.blocks = [...w.blocks.filter((x) => x.id !== b.id), cur].sort(
                              (a, c) => SECTION_LIST.indexOf(a.section) - SECTION_LIST.indexOf(c.section),
                            );
                          })
                        }
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            )}
          </section>
        );
      })}

      {picker && (
        <ExercisePicker
          title={picker.blockId ? 'הוספה לסופר-סט' : `הוספת תרגיל — ${SECTIONS[picker.section]}`}
          multi={!picker.blockId}
          onClose={() => setPicker(null)}
          onPick={(id) => {
            addExercise(id);
            if (picker.blockId) setPicker(null);
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ block */

function SortableBlock(props: {
  block: Block;
  label: string;
  isLast: boolean;
  exercises: Map<ID, Exercise>;
  sessions: Session[];
  onChange: (fn: (b: Block) => void) => void;
  onAddToBlock: () => void;
  onMergeNext: () => void;
  onSplit: () => void;
  onMoveSection: (s: BlockSection) => void;
}) {
  const { block, label, exercises, sessions, onChange } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: block.id });
  const [menu, setMenu] = useState(false);
  const multi = block.items.length > 1;
  const style = { transform: CSS.Transform.toString(transform), transition };

  return (
    <div ref={setNodeRef} style={style} className={`card block-card ${multi ? 'multi' : ''} ${isDragging ? 'dragging' : ''}`}>
      <div className="block-head">
        <button className="drag-handle" {...attributes} {...listeners} aria-label="גרירה לשינוי סדר">
          <GripVertical />
        </button>
        <span className="block-label">{label}</span>
        <span className="small strong grow">{multi ? BLOCK_TYPES[block.type] : ''}</span>
        {block.type === 'circuit' && (
          <span className="row small" style={{ gap: 4 }}>
            סבבים
            <NumInput value={block.rounds ?? null} placeholder="1" onChange={(v) => onChange((b) => void (b.rounds = v))} className="w-60" ariaLabel="סבבים" />
          </span>
        )}
        <button className="icon-btn" aria-label="אפשרויות קבוצה" onClick={() => setMenu(true)}>
          <MoreHorizontal />
        </button>
      </div>
      <div className="block-items">
        {block.items.map((item, i) => (
          <ItemEditor
            key={item.id}
            item={item}
            sub={multi ? `${label}${i + 1}` : undefined}
            exercise={exercises.get(item.exerciseId)}
            sessions={sessions}
            canUp={i > 0}
            canDown={i < block.items.length - 1}
            onMove={(dir) =>
              onChange((b) => {
                const j = i + dir;
                [b.items[i], b.items[j]] = [b.items[j], b.items[i]];
              })
            }
            onChange={(fn) =>
              onChange((b) => {
                const t = b.items.find((x) => x.id === item.id);
                if (t) fn(t);
              })
            }
            onRemove={() =>
              onChange((b) => {
                b.items = b.items.filter((x) => x.id !== item.id);
                if (b.items.length === 1) b.type = 'single';
                if (b.items.length === 2 && b.type === 'triset') b.type = 'superset';
              })
            }
          />
        ))}
      </div>
      <button className="add-inline" onClick={props.onAddToBlock}>
        <Link2 size={16} /> {multi ? `הוספת תרגיל ל${BLOCK_TYPES[block.type]}` : 'יצירת סופר-סט'}
      </button>
      {menu && (
        <Sheet title={`קבוצה ${label}`} onClose={() => setMenu(false)}>
          <div className="stack">
            {multi && (
              <Field label="סוג הקבוצה">
                <Seg
                  value={block.type}
                  onChange={(v) => onChange((b) => void (b.type = v as BlockType))}
                  options={(['superset', 'triset', 'circuit'] as BlockType[]).map((t) => ({ value: t, label: BLOCK_TYPES[t] }))}
                />
              </Field>
            )}
            <Field label="מנוחה אחרי הסבב (שניות)" optional hint="בין תרגילים בתוך סופר-סט אין מנוחה; המנוחה נלקחת בסוף הסבב">
              <NumInput className="input" value={block.restAfter ?? null} onChange={(v) => onChange((b) => void (b.restAfter = v))} />
            </Field>
            <div className="list card">
              {!props.isLast && (
                <button className="list-item" onClick={() => (props.onMergeNext(), setMenu(false))}>
                  <Link2 size={18} /> <span className="grow">חיבור לקבוצה הבאה (סופר-סט)</span>
                </button>
              )}
              {multi && (
                <button className="list-item" onClick={() => (props.onSplit(), setMenu(false))}>
                  <Unlink size={18} /> <span className="grow">פירוק לתרגילים בודדים</span>
                </button>
              )}
              {SECTION_LIST.filter((s) => s !== block.section).map((s) => (
                <button key={s} className="list-item" onClick={() => (props.onMoveSection(s), setMenu(false))}>
                  <ArrowDown size={18} /> <span className="grow">העברה ל{SECTIONS[s]}</span>
                </button>
              ))}
              <button
                className="list-item"
                style={{ color: 'var(--danger)' }}
                onClick={() => {
                  onChange((b) => void (b.items = []));
                  setMenu(false);
                }}
              >
                <Trash2 size={18} /> <span className="grow">מחיקת הקבוצה</span>
              </button>
            </div>
          </div>
        </Sheet>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- exercise */

const SETUP_FIELDS: { key: keyof PlannedExercise['setup']; label: string }[] = [
  { key: 'seat', label: 'גובה כיסא / משענת' },
  { key: 'bench', label: 'מיקום ספסל' },
  { key: 'angle', label: 'זווית מכשיר' },
  { key: 'cable', label: 'גובה כבלים' },
  { key: 'grip', label: 'סוג אחיזה' },
  { key: 'rom', label: 'טווח תנועה' },
  { key: 'other', label: 'ציוד / התאמה אחרת' },
];

const isWorking = (s: PlannedSet) => s.type === 'working';

/** The sets the quick fields edit: the working sets. Drop, back-off and warm-up sets keep their own values. */
function quickSets(sets: PlannedSet[]): PlannedSet[] {
  const work = sets.filter(isWorking);
  return work.length ? work : sets; // no working set at all: the fields still edit something
}

type QuickKey = 'weight' | 'repsMin' | 'repsMax' | 'rir' | 'rpe' | 'rest' | 'duration';

/** The quick sets that carry the value a quick field shows (the first one's): the sets an edit there changes. */
export function matchingSetIds(sets: PlannedSet[], key: QuickKey): ID[] {
  const q = quickSets(sets);
  const shown = q[0]?.[key] ?? null;
  return q.filter((s) => (s[key] ?? null) === shown).map((s) => s.id);
}

/** A quick-field edit: only the matching sets change, so a pyramid's other loads and a drop set's weight stay. */
export function setQuickField(sets: PlannedSet[], key: QuickKey, value: number | null, ids = matchingSetIds(sets, key)): void {
  for (const s of sets) if (ids.includes(s.id)) s[key] = value;
}

/** Sets the number of working sets. Warm-up, drop and back-off sets stay as they are; the last working sets go first. */
export function setWorkingCount(sets: PlannedSet[], n: number): void {
  const work = sets.filter(isWorking);
  if (work.length < n) {
    const last = work[work.length - 1] ?? sets[sets.length - 1];
    // new working sets follow the last one, so a drop / back-off set stays after them
    const firstOther = sets.findIndex((s) => s.type !== 'warmup');
    let at = work.length ? sets.indexOf(last) + 1 : firstOther === -1 ? sets.length : firstOther;
    for (let k = work.length; k < n; k++) sets.splice(at++, 0, blankSet('working', { ...last, type: 'working' }));
  } else {
    let remove = work.length - n;
    for (let k = sets.length - 1; k >= 0 && remove > 0; k--) {
      if (isWorking(sets[k])) {
        sets.splice(k, 1);
        remove--;
      }
    }
  }
}

export function setsSummary(sets: PlannedSet[]): string {
  const working = sets.filter(isWorking);
  // drop / back-off sets are listed apart: they are not more sets of the working load
  const work = working.length ? working : sets.filter((s) => s.type !== 'warmup');
  const warm = sets.filter((s) => s.type === 'warmup').length;
  if (!work.length) return plural(sets.length, 'סט חימום אחד', 'סטי חימום');
  const f = work[0];
  const same = work.every((s) => s.weight === f.weight && s.repsMin === f.repsMin && s.repsMax === f.repsMax && s.rir === f.rir && s.duration === f.duration);
  const reps = f.duration ? `${f.duration} שנ׳` : f.repsMin != null && f.repsMax != null && f.repsMin !== f.repsMax ? `${f.repsMin}–${f.repsMax}` : `${f.repsMin ?? f.repsMax ?? '?'}`;
  const parts = [`${work.length} × ${reps}${same ? '' : ' (משתנה)'}`];
  if (same && f.weight) parts.push(`${f.weight} ק״ג`);
  if (same && f.rir != null) parts.push(`RIR ${f.rir}`);
  if (f.rest) parts.push(`מנוחה ${f.rest}ש׳`);
  if (working.length) {
    for (const t of ['drop', 'backoff'] as const) {
      const n = sets.filter((s) => s.type === t).length;
      if (n) parts.push(`+${n} ${SET_TYPES[t]}`);
    }
  }
  if (warm) parts.push(`+${warm} חימום`);
  return parts.join(' · ');
}

/**
 * The set count is typed locally and applied on blur / Enter. Applied per keystroke, clearing the field
 * (or the "1" on the way to "10") cut the exercise to one set and lost the other sets' loads.
 */
function SetCountInput({ value, onCommit }: { value: number; onCommit: (n: number) => void }) {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(String(value));
  }, [value]);
  const commit = () => {
    const n = Math.min(12, Number(text));
    if (text !== '' && Number.isInteger(n) && n >= 1 && n !== value) onCommit(n);
    else setText(String(value));
  };
  return (
    <input
      className="input input-sm num"
      inputMode="numeric"
      value={text}
      aria-label="מספר סטים"
      onFocus={(e) => {
        focused.current = true;
        e.target.select();
      }}
      onBlur={() => {
        focused.current = false;
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
      onChange={(e) => setText(e.target.value.replace(/\D/g, ''))}
    />
  );
}

function ItemEditor({
  item,
  sub,
  exercise,
  sessions,
  canUp,
  canDown,
  onMove,
  onChange,
  onRemove,
}: {
  item: PlannedExercise;
  sub?: string;
  exercise?: Exercise;
  sessions: Session[];
  canUp: boolean;
  canDown: boolean;
  onMove: (dir: 1 | -1) => void;
  onChange: (fn: (i: PlannedExercise) => void) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [setup, setSetup] = useState(false);
  const { rirMode } = useSettings();
  // this slot's own last performance first (a heavy and a light day of the same lift are different slots)
  const prev = useMemo(() => previousOccurrence(sessions, item.exerciseId, undefined, item.id), [sessions, item.exerciseId, item.id]);
  const setupCount = Object.values(item.setup ?? {}).filter(Boolean).length;
  const work = item.sets.filter(isWorking);
  const first = quickSets(item.sets)[0];

  // the sets a quick field edits are fixed when it gains focus: matched again on every keystroke, a
  // half-typed number (the 10 of 100) would also catch another set that holds that value
  const held = useRef<Partial<Record<QuickKey, ID[]>>>({});
  const hold = (...keys: QuickKey[]) => ({
    onFocus: () => (held.current = Object.fromEntries(keys.map((k) => [k, matchingSetIds(item.sets, k)]))),
    onBlur: () => (held.current = {}),
  });
  const setField = (key: QuickKey, v: number | null) => {
    const ids = held.current[key];
    onChange((i) => setQuickField(i.sets, key, v, ids));
  };

  return (
    <div className="item">
      <div className="item-head">
        {sub && <span className="sub-label">{sub}</span>}
        <div className="grow">
          <div className="strong">{exercise?.nameHe ?? 'תרגיל לא ידוע'}</div>
          <button className="item-summary" onClick={() => setOpen((o) => !o)}>
            <span>{setsSummary(item.sets)}</span>
            <ChevronDown size={15} style={{ transform: open ? 'rotate(180deg)' : undefined }} />
          </button>
        </div>
        <div className="row" style={{ gap: 0 }}>
          {canUp && (
            <button className="icon-btn" aria-label="למעלה" onClick={() => onMove(-1)}>
              <ArrowUp size={18} />
            </button>
          )}
          {canDown && (
            <button className="icon-btn" aria-label="למטה" onClick={() => onMove(1)}>
              <ArrowDown size={18} />
            </button>
          )}
          <button className="icon-btn" aria-label="הסרת תרגיל" onClick={onRemove}>
            <X size={18} />
          </button>
        </div>
      </div>

      {prev && (
        <div className="prev-line">
          <History size={14} />
          <span className="muted">פעם קודמת ({relativeDay(prev.session.date)}):</span>
          <span className="num strong">
            {prev.entry.sets
              .filter((s) => s.done && s.type !== 'warmup')
              .map((s) => formatSet(s))
              .join(' · ')}
          </span>
        </div>
      )}

      {/* quick editor: edits the working sets that hold the value shown; drop / back-off / warm-up sets keep theirs */}
      <div className="quick-grid">
        <div>
          <div className="stepper-label">סטים</div>
          <SetCountInput value={work.length} onCommit={(n) => onChange((i) => setWorkingCount(i.sets, n))} />
        </div>
        <div {...hold('weight')}>
          <div className="stepper-label">משקל</div>
          <NumInput decimal value={first?.weight ?? null} placeholder={exercise ? EQUIPMENT[exercise.equipment] === 'משקל גוף' ? 'BW' : 'ק״ג' : ''} onChange={(v) => setField('weight', v)} ariaLabel="משקל" />
        </div>
        {first?.duration ? (
          <div {...hold('duration')}>
            <div className="stepper-label">שניות</div>
            {/* an emptied field changes nothing (blur restores it): only "חזרות ↔ זמן" turns a hold into reps */}
            <NumInput
              value={first.duration}
              onChange={(v) => {
                if (v) setField('duration', v);
              }}
              ariaLabel="זמן"
            />
          </div>
        ) : (
          <div {...hold('repsMin', 'repsMax')}>
            <div className="stepper-label">חזרות</div>
            <div className="range-in">
              <NumInput value={first?.repsMin ?? null} onChange={(v) => setField('repsMin', v)} ariaLabel="חזרות מינימום" />
              <span>–</span>
              <NumInput value={first?.repsMax ?? null} onChange={(v) => setField('repsMax', v)} ariaLabel="חזרות מקסימום" />
            </div>
          </div>
        )}
        {rirMode !== 'rpe' && (
          <div {...hold('rir')}>
            <div className="stepper-label">RIR יעד</div>
            <NumInput value={first?.rir ?? null} onChange={(v) => setField('rir', v)} ariaLabel="RIR" />
          </div>
        )}
        {rirMode !== 'rir' && (
          <div {...hold('rpe')}>
            <div className="stepper-label">RPE יעד</div>
            <NumInput decimal value={first?.rpe ?? null} onChange={(v) => setField('rpe', v)} ariaLabel="RPE" />
          </div>
        )}
        <div {...hold('rest')}>
          <div className="stepper-label">מנוחה</div>
          <NumInput value={first?.rest ?? null} onChange={(v) => setField('rest', v)} ariaLabel="מנוחה בשניות" />
        </div>
      </div>

      {open && <SetsTable item={item} onChange={onChange} rirMode={rirMode} />}

      <div className="row row-wrap" style={{ gap: 6 }}>
        <button className={`chip chip-sm ${setup ? 'on' : ''}`} onClick={() => setSetup((s) => !s)}>
          <Settings2 /> כיוונים והערות{setupCount ? ` (${setupCount})` : ''}
        </button>
        {!open && (
          <button className="chip chip-sm" onClick={() => setOpen(true)}>
            עריכה לפי סט
          </button>
        )}
      </div>
      {setup && (
        <div className="stack-sm">
          <div className="grid-2">
            {SETUP_FIELDS.map((f) => (
              <Field key={f.key} label={f.label} optional>
                <input className="input input-sm" value={item.setup?.[f.key] ?? ''} onChange={(e) => onChange((i) => void (i.setup = { ...i.setup, [f.key]: e.target.value }))} />
              </Field>
            ))}
            <Field label="טמפו" optional>
              <input className="input input-sm ltr" dir="ltr" placeholder="3-1-1-0" value={item.tempo ?? ''} onChange={(e) => onChange((i) => void (i.tempo = e.target.value))} />
            </Field>
          </div>
          <Field label="הערות טכניות לתרגיל" optional>
            <textarea className="textarea" style={{ minHeight: 60 }} value={item.notes ?? ''} onChange={(e) => onChange((i) => void (i.notes = e.target.value))} />
          </Field>
        </div>
      )}
    </div>
  );
}

const SET_TYPE_ORDER: SetType[] = ['working', 'warmup', 'drop', 'backoff'];

function SetsTable({ item, onChange, rirMode }: { item: PlannedExercise; onChange: (fn: (i: PlannedExercise) => void) => void; rirMode: 'rir' | 'rpe' | 'both' }) {
  const upd = (idx: number, patch: Partial<PlannedSet>) => onChange((i) => Object.assign(i.sets[idx], patch));
  return (
    <div className="sets-table">
      <div className="st-row st-head">
        <span>#</span>
        <span>סוג</span>
        <span>משקל</span>
        <span>חזרות</span>
        <span>{rirMode === 'rpe' ? 'RPE' : rirMode === 'both' ? 'RIR/RPE' : 'RIR'}</span>
        <span>מנוחה</span>
        <span />
      </div>
      {item.sets.map((s, idx) => (
        <div key={s.id} className={`st-row ${s.type}`}>
          <span className="num muted">{idx + 1}</span>
          <button
            className={`set-type t-${s.type}`}
            onClick={() => upd(idx, { type: SET_TYPE_ORDER[(SET_TYPE_ORDER.indexOf(s.type) + 1) % SET_TYPE_ORDER.length] })}
            title="החלפת סוג סט"
          >
            {SET_TYPES[s.type]}
          </button>
          <NumInput decimal value={s.weight ?? null} onChange={(v) => upd(idx, { weight: v })} ariaLabel={`משקל סט ${idx + 1}`} />
          {s.duration != null ? (
            // emptying the seconds changes nothing: the set stays timed (only "חזרות ↔ זמן" switches it)
            <NumInput
              value={s.duration}
              onChange={(v) => {
                if (v) upd(idx, { duration: v });
              }}
              ariaLabel="שניות"
            />
          ) : (
            <div className="range-in">
              <NumInput value={s.repsMin ?? null} onChange={(v) => upd(idx, { repsMin: v })} ariaLabel="מינ׳" />
              <span>–</span>
              <NumInput value={s.repsMax ?? null} onChange={(v) => upd(idx, { repsMax: v })} ariaLabel="מקס׳" />
            </div>
          )}
          <div className="effort-in">
            {rirMode !== 'rpe' && <NumInput value={s.rir ?? null} onChange={(v) => upd(idx, { rir: v })} ariaLabel="RIR" />}
            {rirMode !== 'rir' && <NumInput decimal value={s.rpe ?? null} onChange={(v) => upd(idx, { rpe: v })} ariaLabel="RPE" />}
          </div>
          <NumInput value={s.rest ?? null} onChange={(v) => upd(idx, { rest: v })} ariaLabel="מנוחה" />
          <button className="icon-btn" aria-label="מחיקת סט" onClick={() => onChange((i) => void i.sets.splice(idx, 1))} disabled={item.sets.length <= 1}>
            <X size={16} />
          </button>
        </div>
      ))}
      <div className="row row-wrap" style={{ gap: 6, marginTop: 6 }}>
        <button className="btn btn-sm" onClick={() => onChange((i) => void i.sets.push(blankSet('working', { ...i.sets[i.sets.length - 1], type: i.sets[i.sets.length - 1]?.type === 'warmup' ? 'working' : i.sets[i.sets.length - 1]?.type })))}>
          <Plus /> סט
        </button>
        <button className="btn btn-sm" onClick={() => onChange((i) => void i.sets.unshift(blankSet('warmup', { ...i.sets[0], type: 'warmup', rir: null, weight: i.sets[0]?.weight ? Math.round(i.sets[0].weight * 0.5) : null, rest: 60 })))}>
          <Plus /> סט חימום
        </button>
        <button className="btn btn-sm" onClick={() => onChange((i) => void i.sets.push(blankSet('drop', { ...i.sets[i.sets.length - 1], type: 'drop', rest: 0, weight: i.sets[i.sets.length - 1]?.weight ? Math.round(i.sets[i.sets.length - 1].weight! * 0.75) : null })))}>
          <Plus /> דרופ-סט
        </button>
        <button className="btn btn-sm btn-ghost" onClick={() => onChange((i) => i.sets.forEach((s) => (s.duration = s.duration == null ? 30 : null)))}>
          חזרות ↔ זמן
        </button>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- sheets */

function SaveSheet({ changes, exercises, onClose, onSave }: { changes: ReturnType<typeof diffPrograms>; exercises: Map<ID, Exercise>; onClose: () => void; onSave: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  void exercises;
  const quick = ['התקדמות מתוכננת', 'התאמה לכאב / מגבלה', 'שינוי מטרה', 'החלפת תרגיל', 'תיקון / סידור'];
  return (
    <Sheet
      title="שמירת גרסה חדשה"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>ביטול</button>
          <button className="btn btn-primary" onClick={() => onSave(reason)}>
            <Check /> שמירה
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="סיבת השינוי" optional hint="נשמרת בהיסטוריית הגרסאות">
          {/* no autofocus: on a phone the keyboard would cover the "שמירה" button; Return saves */}
          <input
            className="input"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onSave(reason)}
            enterKeyHint="done"
            placeholder="למשל: מעבר לשלב כוח"
          />
        </Field>
        <div className="chips">
          {quick.map((q) => (
            <button key={q} className="chip chip-sm" onClick={() => setReason(q)}>
              {q}
            </button>
          ))}
        </div>
        <div>
          <div className="label" style={{ marginBottom: 6 }}>
            {plural(changes.length, "שינוי אחד", "שינויים")}
          </div>
          <ChangesList changes={changes} />
        </div>
      </div>
    </Sheet>
  );
}

function ChangesList({ changes }: { changes: ReturnType<typeof diffPrograms> }) {
  if (!changes.length) return <div className="small muted">אין שינויים בתוכן</div>;
  return (
    <div className="changes">
      {changes.slice(0, 40).map((c, i) => (
        <div key={i} className="change">
          <div className="tiny muted">{c.path}</div>
          <div className="small">
            {/* isolated values: a Latin value (RIR, a workout named A) must not pull the arrow into its LTR run */}
            <b>{c.field}:</b> <bdi className="from">{c.from}</bdi> ← <bdi className="to">{c.to}</bdi>
          </div>
        </div>
      ))}
      {changes.length > 40 && <div className="tiny muted">ועוד {changes.length - 40}…</div>}
    </div>
  );
}

function VersionsSheet({ program, onClose, onRestore }: { program: Program; onClose: () => void; onRestore: (v: NonNullable<ReturnType<typeof useProgramVersions>>[number]) => void }) {
  const versions = useProgramVersions(program.id) ?? [];
  const [open, setOpen] = useState<string | null>(versions[0]?.id ?? null);
  return (
    <Sheet title="היסטוריית גרסאות" onClose={onClose} wide>
      <div className="stack">
        {versions.map((v) => (
          <div key={v.id} className="card card-pad version">
            <button className="row between" style={{ width: '100%' }} onClick={() => setOpen(open === v.id ? null : v.id)}>
              <div className="row" style={{ gap: 10 }}>
                <span className={`badge ${v.version === program.version ? 'tone-accent' : ''}`}>גרסה {v.version}</span>
                <div style={{ textAlign: 'start' }}>
                  <div className="small strong">{v.reason}</div>
                  <div className="tiny muted">
                    {fmtDateTime(v.createdAt)} · אושר ע״י {v.approvedBy} · {plural(v.changes.length, "שינוי אחד", "שינויים")}
                  </div>
                </div>
              </div>
              <ChevronDown size={16} style={{ transform: open === v.id ? 'rotate(180deg)' : undefined }} />
            </button>
            {open === v.id && (
              <div className="stack-sm" style={{ marginTop: 10 }}>
                <ChangesList changes={v.changes} />
                {v.version !== program.version && (
                  <button className="btn btn-sm" onClick={() => onRestore(v)}>
                    <RotateCcw /> שחזור לגרסה הזו
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
        {!versions.length && <div className="empty small">אין עדיין גרסאות</div>}
      </div>
    </Sheet>
  );
}

function MetaSheet({ program, onClose, onChange }: { program: Program; onClose: () => void; onChange: (patch: Partial<Program>) => void }) {
  return (
    <Sheet title="פרטי התוכנית" onClose={onClose} footer={<button className="btn btn-primary" onClick={onClose}>סיום</button>}>
      <div className="stack">
        <Field label="שם">
          <input className="input" value={program.name} onChange={(e) => onChange({ name: e.target.value })} />
        </Field>
        <Field label="מטרה">
          <select className="select" value={program.goal} onChange={(e) => onChange({ goal: e.target.value as ProgramGoal })}>
            {(Object.keys(PROGRAM_GOALS) as ProgramGoal[]).map((g) => (
              <option key={g} value={g}>{PROGRAM_GOALS[g]}</option>
            ))}
          </select>
        </Field>
        <Field label="שלב / מחזור" optional hint="למשל: שבועות 1–4, בסיס">
          <input className="input" value={program.phase ?? ''} onChange={(e) => onChange({ phase: e.target.value })} />
        </Field>
        <div className="grid-2">
          <Field label="תאריך התחלה">
            <input type="date" className="input" value={program.startDate ?? ''} onChange={(e) => onChange({ startDate: e.target.value })} />
          </Field>
          <Field label="תאריך סיום" optional>
            <input type="date" className="input" value={program.endDate ?? ''} onChange={(e) => onChange({ endDate: e.target.value })} />
          </Field>
        </div>
        {program.clientId && (
          <Field label="סטטוס">
            <Seg
              value={program.status}
              onChange={(v) => onChange({ status: v as ProgramStatus })}
              options={(Object.keys(PROGRAM_STATUS) as ProgramStatus[]).map((s) => ({ value: s, label: PROGRAM_STATUS[s] }))}
            />
          </Field>
        )}
        <Field label="הערות" optional>
          <textarea className="textarea" value={program.notes ?? ''} onChange={(e) => onChange({ notes: e.target.value })} />
        </Field>
      </div>
    </Sheet>
  );
}
