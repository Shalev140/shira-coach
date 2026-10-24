import { useState } from 'react';
import { Archive, ArchiveRestore, ExternalLink, Pencil, Plus, RotateCcw, X } from 'lucide-react';
import { db } from '../db/db';
import { blankExercise, saveExercise } from '../db/repo';
import { useExercises, useSettings } from '../db/hooks';
import { SEED_EXERCISES } from '../data/exercises';
import type { Equipment, Exercise, ExerciseData, ID, MovementPattern } from '../domain/types';
import { DIFFICULTY, EQUIPMENT, PATTERNS } from '../domain/labels';
import { Field, NumInput, Seg, Sheet, Switch, useUi } from './ui';
import { DELETED_MUSCLE, ExercisePicker } from './ExercisePicker';

const FACTORS = [0.25, 0.5, 0.75, 1];

export function ExerciseEditSheet({
  exercise,
  initial,
  onClose,
  onSaved,
}: {
  exercise?: Exercise;
  initial?: Partial<ExerciseData>;
  onClose: () => void;
  onSaved?: (id: ID) => void;
}) {
  const { toast } = useUi();
  const settings = useSettings();
  const { map } = useExercises();
  const [ex, setEx] = useState<Exercise>(() => exercise ?? blankExercise(initial));
  const [aliases, setAliases] = useState(ex.aliases.join(', '));
  const [cues, setCues] = useState(ex.cues.join('\n'));
  const [mistakes, setMistakes] = useState(ex.mistakes.join('\n'));
  const [picking, setPicking] = useState(false);
  const muscles = settings.muscles.filter((m) => !m.hidden);
  // ids of muscle groups deleted from the settings get their own chip, so they can still be removed
  const known = new Set(settings.muscles.map((m) => m.id));
  const deletedPrimary = ex.primary.filter((m) => !known.has(m));
  const deletedSecondary = ex.secondary.filter((s) => !known.has(s.muscle)).map((s) => s.muscle);
  const set = (patch: Partial<Exercise>) => setEx((e) => ({ ...e, ...patch }));

  const togglePrimary = (m: string) =>
    set({
      primary: ex.primary.includes(m) ? ex.primary.filter((x) => x !== m) : [...ex.primary, m],
      secondary: ex.secondary.filter((s) => s.muscle !== m),
    });
  const toggleSecondary = (m: string) =>
    set({
      secondary: ex.secondary.some((s) => s.muscle === m) ? ex.secondary.filter((s) => s.muscle !== m) : [...ex.secondary, { muscle: m }],
      primary: ex.primary.filter((x) => x !== m),
    });

  const save = async () => {
    if (!ex.nameHe.trim()) return toast('צריך שם לתרגיל', { tone: 'error' });
    if (!ex.primary.some((m) => known.has(m))) return toast('צריך לבחור לפחות שריר עיקרי אחד', { tone: 'error' });
    const lines = (t: string) => t.split('\n').map((x) => x.trim()).filter(Boolean);
    const next: Exercise = {
      ...ex,
      nameHe: ex.nameHe.trim(),
      nameEn: ex.nameEn.trim(),
      aliases: aliases.split(',').map((x) => x.trim()).filter(Boolean),
      cues: lines(cues),
      mistakes: lines(mistakes),
    };
    await saveExercise(next);
    toast(exercise ? 'התרגיל עודכן' : 'התרגיל נוצר');
    onSaved?.(next.id);
    onClose();
  };

  return (
    <Sheet
      title={exercise ? 'עריכת תרגיל' : 'תרגיל חדש'}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>ביטול</button>
          <button className="btn btn-primary" onClick={save}>שמירה</button>
        </>
      }
    >
      <div className="stack">
        <div className="grid-2">
          <Field label="שם בעברית">
            <input className="input" value={ex.nameHe} onChange={(e) => set({ nameHe: e.target.value })} />
          </Field>
          <Field label="שם באנגלית" optional>
            <input className="input ltr" dir="ltr" value={ex.nameEn} onChange={(e) => set({ nameEn: e.target.value })} />
          </Field>
        </div>
        <Field label="שמות חלופיים" optional hint="מופרדים בפסיק — עוזרים בחיפוש">
          <input className="input" value={aliases} onChange={(e) => setAliases(e.target.value)} />
        </Field>

        <div className="field">
          <span className="label">שרירים עיקריים — סט ישיר</span>
          <div className="chips">
            {muscles.map((m) => (
              <button key={m.id} type="button" className={`chip chip-sm ${ex.primary.includes(m.id) ? 'on' : ''}`} onClick={() => togglePrimary(m.id)}>
                {m.name}
              </button>
            ))}
            {deletedPrimary.map((m) => (
              <button key={m} type="button" className="chip chip-sm on" onClick={() => togglePrimary(m)} aria-label={`הסרת ${DELETED_MUSCLE}`}>
                {DELETED_MUSCLE} <X size={14} />
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span className="label">שרירים משניים — תרומה עקיפה</span>
          <span className="hint">כל סט נספר לשריר משני לפי המקדם. "ברירת מחדל" = {settings.indirectFactor} (מההגדרות).</span>
          <div className="chips">
            {muscles
              .filter((m) => !ex.primary.includes(m.id))
              .map((m) => (
                <button key={m.id} type="button" className={`chip chip-sm ${ex.secondary.some((s) => s.muscle === m.id) ? 'on' : ''}`} onClick={() => toggleSecondary(m.id)}>
                  {m.name}
                </button>
              ))}
            {deletedSecondary.map((m) => (
              <button key={m} type="button" className="chip chip-sm on" onClick={() => toggleSecondary(m)} aria-label={`הסרת ${DELETED_MUSCLE}`}>
                {DELETED_MUSCLE} <X size={14} />
              </button>
            ))}
          </div>
          {ex.secondary.length > 0 && (
            <div className="stack-sm" style={{ marginTop: 6 }}>
              {ex.secondary.map((s) => (
                <div key={s.muscle} className="row between">
                  <span className="small strong">{settings.muscles.find((m) => m.id === s.muscle)?.name ?? DELETED_MUSCLE}</span>
                  <Seg
                    value={s.factor ?? 0}
                    options={[{ value: 0, label: 'ברירת מחדל' }, ...FACTORS.map((f) => ({ value: f, label: <span className="num">{f}</span> }))]}
                    onChange={(v) => set({ secondary: ex.secondary.map((x) => (x.muscle === s.muscle ? { ...x, factor: v || undefined } : x)) })}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="grid-2">
          <Field label="דפוס תנועה">
            <select className="select" value={ex.pattern} onChange={(e) => set({ pattern: e.target.value as MovementPattern })}>
              {(Object.keys(PATTERNS) as MovementPattern[]).map((k) => (
                <option key={k} value={k}>{PATTERNS[k]}</option>
              ))}
            </select>
          </Field>
          <Field label="ציוד">
            <select className="select" value={ex.equipment} onChange={(e) => set({ equipment: e.target.value as Equipment })}>
              {(Object.keys(EQUIPMENT) as Equipment[]).map((k) => (
                <option key={k} value={k}>{EQUIPMENT[k]}</option>
              ))}
            </select>
          </Field>
        </div>
        <div className="grid-2">
          <Field label="רמת קושי">
            <Seg value={ex.difficulty} options={([1, 2, 3] as const).map((d) => ({ value: d, label: DIFFICULTY[d] }))} onChange={(v) => set({ difficulty: v })} block />
          </Field>
          <Field label="קפיצת משקל (ק״ג)" optional hint={`ברירת מחדל לציוד: ${settings.increments[ex.equipment]} ק״ג`}>
            {/* keeps the typed text, so "1." / "2,5" can be typed on the way to 1.25 / 2.5; empty = the equipment default */}
            <NumInput
              className="input"
              decimal
              value={ex.increment ?? null}
              placeholder={String(settings.increments[ex.equipment])}
              onChange={(v) => set({ increment: v ?? undefined })}
            />
          </Field>
        </div>
        <label className="row between">
          <span className="label">תרגיל חד-צדדי (יד/רגל אחת)</span>
          <Switch on={!!ex.unilateral} onChange={(v) => set({ unilateral: v })} />
        </label>
        <Field label="דגשים לביצוע" optional hint="שורה לכל דגש">
          <textarea className="textarea" value={cues} onChange={(e) => setCues(e.target.value)} />
        </Field>
        <Field label="טעויות נפוצות" optional hint="שורה לכל טעות">
          <textarea className="textarea" value={mistakes} onChange={(e) => setMistakes(e.target.value)} />
        </Field>
        <Field label="קישור לתמונה / סרטון הדגמה" optional>
          <input className="input ltr" dir="ltr" value={ex.mediaUrl ?? ''} placeholder="https://…" onChange={(e) => set({ mediaUrl: e.target.value || undefined })} />
        </Field>
        <div className="field">
          <span className="label">חלופות ווריאציות</span>
          <div className="chips">
            {ex.alternatives.map((id) => (
              <span key={id} className="chip chip-sm">
                {map.get(id)?.nameHe ?? id}
                <button aria-label="הסרה" onClick={() => set({ alternatives: ex.alternatives.filter((x) => x !== id) })}>
                  <X size={14} />
                </button>
              </span>
            ))}
            <button className="chip chip-sm" onClick={() => setPicking(true)}>
              <Plus /> הוספה
            </button>
          </div>
        </div>
        <Field label="הערות המאמנת" optional>
          <textarea className="textarea" value={ex.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} />
        </Field>
      </div>
      {picking && (
        <ExercisePicker
          title="הוספת חלופה"
          initialMuscle={ex.primary[0]}
          onClose={() => setPicking(false)}
          onPick={(id) => {
            if (id !== ex.id && !ex.alternatives.includes(id)) set({ alternatives: [...ex.alternatives, id] });
            setPicking(false);
          }}
        />
      )}
    </Sheet>
  );
}

export function ExerciseDetailSheet({ exercise, onClose }: { exercise: Exercise; onClose: () => void }) {
  const { toast, confirm } = useUi();
  const settings = useSettings();
  const { map } = useExercises();
  const [editing, setEditing] = useState(false);
  const [current, setCurrent] = useState<Exercise>(exercise);
  const names = new Map(settings.muscles.map((m) => [m.id, m.name]));
  const seed = SEED_EXERCISES.find((s) => s.id === current.id);
  const ex = map.get(current.id) ?? current;
  // the English name is optional, so no separator may be left hanging
  const otherNames = [ex.nameEn, ...ex.aliases].filter(Boolean).join(' · ');

  const archive = async () => {
    if (
      !(await confirm({
        title: 'להעביר את התרגיל לארכיון?',
        body: 'התרגיל יוסתר מהספרייה ומבחירת התרגילים. היסטוריית אימונים שבה הוא מופיע נשמרת, ואפשר להחזיר אותו מהארכיון שבספרייה.',
        confirmLabel: 'העברה לארכיון',
        danger: true,
      }))
    )
      return;
    await saveExercise({ ...ex, archived: true });
    toast('התרגיל הועבר לארכיון', { action: { label: 'ביטול', run: () => void saveExercise({ ...ex, archived: false }) } });
    onClose();
  };
  const unarchive = async () => {
    await saveExercise({ ...ex, archived: false });
    toast('התרגיל הוחזר לספרייה');
    onClose();
  };
  const reset = async () => {
    if (!seed) return;
    if (!(await confirm({ title: 'לשחזר את הגדרות ברירת המחדל?', body: 'שמות, שרירים ומקדמים יחזרו לברירת המחדל של הספרייה.' }))) return;
    const { id, ...data } = seed;
    await db.exercises.put({ ...ex, ...data, id, updatedAt: Date.now() });
    setCurrent({ ...ex, ...data });
    toast('שוחזר לברירת המחדל');
  };

  return (
    <Sheet
      title={ex.nameHe}
      onClose={onClose}
      wide
      footer={
        <>
          {/* the secondary actions are icon-only on phones, so the three buttons fit a 360px footer */}
          {ex.archived ? (
            <button className="btn btn-ghost" onClick={unarchive} aria-label="החזרה מהארכיון" title="החזרה מהארכיון">
              <ArchiveRestore /><span className="hide-mobile">החזרה מהארכיון</span>
            </button>
          ) : (
            <button className="btn btn-ghost" onClick={archive} aria-label="ארכיון" title="ארכיון">
              <Archive /><span className="hide-mobile">ארכיון</span>
            </button>
          )}
          {seed && (
            <button className="btn btn-ghost" onClick={reset} aria-label="ברירת מחדל" title="ברירת מחדל">
              <RotateCcw /><span className="hide-mobile">ברירת מחדל</span>
            </button>
          )}
          <button className="btn btn-primary" onClick={() => setEditing(true)}>
            <Pencil /> עריכה
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="row row-wrap" style={{ gap: 6 }}>
          <span className="badge">{PATTERNS[ex.pattern]}</span>
          <span className="badge">{EQUIPMENT[ex.equipment]}</span>
          <span className="badge">{DIFFICULTY[ex.difficulty]}</span>
          {ex.unilateral && <span className="badge">חד-צדדי</span>}
          {ex.custom && <span className="badge tone-accent">תרגיל מותאם</span>}
        </div>
        {otherNames && (
          <div className="muted ltr" style={{ textAlign: 'right' }}>
            {otherNames}
          </div>
        )}
        <div className="card card-pad">
          <div className="card-title" style={{ marginBottom: 8 }}>חישוב נפח — איך התרגיל נספר</div>
          <div className="stack-sm small">
            {ex.primary.map((m) => (
              <div key={m} className="row between">
                <span>{names.get(m) ?? DELETED_MUSCLE}</span>
                {names.has(m) ? <span className="badge tone-accent">ישיר · 1 סט</span> : <span className="badge">לא נספר</span>}
              </div>
            ))}
            {ex.secondary.map((s) => (
              <div key={s.muscle} className="row between">
                <span>{names.get(s.muscle) ?? DELETED_MUSCLE}</span>
                {names.has(s.muscle) ? (
                  <span className="badge">
                    עקיף · <span className="num">{s.factor ?? settings.indirectFactor}</span> סט{s.factor === undefined ? ' (ברירת מחדל)' : ''}
                  </span>
                ) : (
                  <span className="badge">לא נספר</span>
                )}
              </div>
            ))}
          </div>
        </div>
        {ex.cues.length > 0 && (
          <div>
            <h3 style={{ marginBottom: 6 }}>דגשים לביצוע</h3>
            <ul className="bullets">{ex.cues.map((c, i) => <li key={i}>{c}</li>)}</ul>
          </div>
        )}
        {ex.mistakes.length > 0 && (
          <div>
            <h3 style={{ marginBottom: 6 }}>טעויות נפוצות</h3>
            <ul className="bullets bullets-warn">{ex.mistakes.map((c, i) => <li key={i}>{c}</li>)}</ul>
          </div>
        )}
        {ex.alternatives.length > 0 && (
          <div>
            <h3 style={{ marginBottom: 6 }}>חלופות ווריאציות</h3>
            <div className="chips">
              {ex.alternatives.map((id) => {
                const alt = map.get(id);
                return alt ? (
                  <button key={id} className="chip chip-sm" onClick={() => setCurrent(alt)}>
                    {alt.nameHe}
                  </button>
                ) : null;
              })}
            </div>
          </div>
        )}
        {ex.mediaUrl && (
          <a className="btn btn-soft" href={ex.mediaUrl} target="_blank" rel="noreferrer">
            <ExternalLink /> צפייה בהדגמה
          </a>
        )}
        {ex.notes && <div className="pill-note pre small">{ex.notes}</div>}
      </div>
      {editing && <ExerciseEditSheet exercise={ex} onClose={() => setEditing(false)} onSaved={() => setCurrent({ ...ex })} />}
    </Sheet>
  );
}
