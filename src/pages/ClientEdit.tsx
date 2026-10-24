import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { Archive, ArchiveRestore, ChevronDown, RotateCcw, Trash2 } from 'lucide-react';
import { db } from '../db/db';
import { addMeasurement, alive, blankClient, deleteClient, saveClient, setClientArchived } from '../db/repo';
import { useClient, useSettings } from '../db/hooks';
import type { Client, ExperienceLevel, GoalKey, Measurement, TrainingType, VolumePresetKey } from '../domain/types';
import { CLIENT_COLORS, EXPERIENCE, GOALS, TRAINING_TYPES, VOLUME_PRESETS, WEEKDAYS_SHORT, presetTarget } from '../domain/labels';
import { isoDate } from '../domain/util';
import { ChipToggle, Field, NumInput, Rating, Seg, Stepper, TopBar, useUi } from '../components/ui';
import { useDraft } from '../components/useDraft';

/**
 * The form (and a draft restored from it) never shows goals (targets), the archive flag or deletion,
 * which are changed from other screens; those always come from the latest stored record, so saving
 * an older draft can't bring back a removed goal or drop one added since.
 */
export function mergeClientForm(form: Client, latest: Client | undefined): Client {
  if (!latest) return form;
  return { ...form, targets: latest.targets, archived: latest.archived, deletedAt: latest.deletedAt };
}

/**
 * The newest weigh-in: latest date, and for two on the same date the one entered last (a same-day
 * correction), so the overview and this form always agree on the current weight.
 */
export function latestWeighIn<M extends Pick<Measurement, 'date' | 'createdAt' | 'weight'>>(ms: readonly M[]): M | null {
  let best: M | null = null;
  for (const m of ms) {
    if (!m.weight) continue;
    if (!best || m.date > best.date || (m.date === best.date && m.createdAt >= best.createdAt)) best = m;
  }
  return best;
}

/**
 * A weight typed into the form is a new weigh-in, even when it equals the last one (weighed again
 * months later). Only re-entering the same value on the same day as the newest weigh-in is skipped.
 */
export function shouldRecordWeight(weight: number | null, last: Pick<Measurement, 'date' | 'weight'> | null | undefined, today = isoDate()): boolean {
  if (!weight) return false;
  return !(last && last.date === today && last.weight === weight);
}

export function ClientEdit() {
  const { id } = useParams();
  const client = useClient(id);
  if (id && client === undefined) return null;
  if (id && client === null)
    return (
      <>
        <TopBar title="המתאמן/ת לא נמצא/ה" back="/clients" />
      </>
    );
  return <ClientForm key={id ?? 'new'} existing={client ?? null} />;
}

function ClientForm({ existing }: { existing: Client | null }) {
  const nav = useNavigate();
  const { toast, confirm } = useUi();
  const settings = useSettings();
  const draft = useDraft<Client>(`client:${existing?.id ?? 'new'}`, () => existing ?? blankClient());
  const c = draft.value;
  const set = (patch: Partial<Client>) => draft.setValue((v) => ({ ...v, ...patch }));
  const lastWeight = useLiveQuery(async () => {
    if (!existing) return null;
    return latestWeighIn((await db.measurements.where('clientId').equals(existing.id).toArray()).filter(alive));
  }, [existing?.id]);
  const [weight, setWeight] = useState<number | null>(null);
  const [showTargets, setShowTargets] = useState(false);
  const muscles = settings.muscles.filter((m) => !m.hidden);

  /** Writes the form (and a typed weight); false when it can't be saved yet. */
  const persist = async (): Promise<boolean> => {
    if (!c.name.trim()) {
      toast('צריך שם מלא', { tone: 'error' });
      return false;
    }
    const latest = existing ? await db.clients.get(c.id) : undefined;
    await saveClient(mergeClientForm({ ...c, name: c.name.trim() }, latest));
    if (weight && shouldRecordWeight(weight, lastWeight)) await addMeasurement({ clientId: c.id, date: isoDate(), weight, demo: existing?.demo });
    return true;
  };

  const save = async () => {
    if (!(await persist())) return;
    draft.clear();
    toast(existing ? 'הפרטים נשמרו' : 'המתאמן/ת נוסף/ה');
    nav(`/clients/${c.id}`, { replace: true });
  };

  // archiving from the form must not drop what was typed into it (nor the draft that keeps it)
  const toggleArchived = async () => {
    if (!existing) return;
    const unsaved = draft.isDirty() || draft.restored || weight !== null;
    if (unsaved) {
      const ok = await confirm({
        title: existing.archived ? 'לשמור את השינויים ולהחזיר לפעילים?' : 'לשמור את השינויים ולהעביר לארכיון?',
        body: 'יש בטופס שינויים שלא נשמרו. הם יישמרו לפני שהכרטיס יועבר.',
        confirmLabel: 'שמירה והעברה',
      });
      if (!ok || !(await persist())) return;
    }
    await setClientArchived(existing.id, !existing.archived);
    draft.clear();
    toast(existing.archived ? 'הכרטיס הוחזר לפעילים' : 'הכרטיס הועבר לארכיון');
    nav(`/clients/${existing.id}`);
  };

  const remove = async () => {
    if (!existing) return;
    const ok = await confirm({
      title: `למחוק את ${existing.name}?`,
      body: 'הכרטיס וכל הנתונים המקושרים (אימונים, תוכניות, מדדים, הערות) יוסתרו. נשמר גיבוי אוטומטי לפני המחיקה, כך שאפשר לשחזר ממסך הגיבוי.',
      confirmLabel: 'מחיקה',
      danger: true,
    });
    if (!ok) return;
    await deleteClient(existing.id);
    draft.clear();
    toast('הכרטיס נמחק — אפשר לשחזר ממסך הגיבוי');
    nav('/clients', { replace: true });
  };

  return (
    <>
      <TopBar
        title={existing ? `עריכת ${existing.name}` : 'מתאמן/ת חדש/ה'}
        back={existing ? `/clients/${existing.id}` : '/clients'}
        actions={
          <button className="btn btn-primary btn-sm" onClick={save}>
            שמירה
          </button>
        }
      />
      <div className="page page-narrow stack-lg">
        {draft.restored && (
          <div className="banner tone-info">
            <RotateCcw />
            <div className="grow small">שוחזרה טיוטה שלא נשמרה.</div>
            <button className="btn btn-sm btn-ghost" onClick={draft.discard}>
              התחלה מחדש
            </button>
          </div>
        )}

        <section className="card card-lg stack">
          <h2>פרטים אישיים</h2>
          <Field label="שם מלא">
            <input className="input" value={c.name} onChange={(e) => set({ name: e.target.value })} autoFocus={!existing} autoComplete="off" />
          </Field>
          <div className="grid-2">
            <Field label="טלפון" optional>
              <input className="input ltr" dir="ltr" inputMode="tel" value={c.phone ?? ''} onChange={(e) => set({ phone: e.target.value })} />
            </Field>
            <Field label="דוא״ל" optional>
              <input className="input ltr" dir="ltr" inputMode="email" value={c.email ?? ''} onChange={(e) => set({ email: e.target.value })} />
            </Field>
          </div>
          <div className="grid-2">
            <Field label="תאריך לידה" optional>
              <input className="input" type="date" value={c.birthDate ?? ''} onChange={(e) => set({ birthDate: e.target.value })} />
            </Field>
            <Field label="גובה (ס״מ)" optional>
              <NumInput className="input" value={c.height} onChange={(v) => set({ height: v ?? undefined })} />
            </Field>
          </div>
          <Field
            label="משקל עדכני (ק״ג)"
            optional
            hint={lastWeight ? `מדידה אחרונה: ${lastWeight.weight} ק״ג (${lastWeight.date}). ערך חדש יישמר כמדידה נוספת — ההיסטוריה לא נדרסת.` : 'יישמר כמדידה ראשונה עם תאריך היום.'}
          >
            <NumInput className="input" decimal value={weight} placeholder={lastWeight?.weight ? String(lastWeight.weight) : ''} onChange={setWeight} />
          </Field>
          <div className="field">
            <span className="label">צבע</span>
            <div className="row row-wrap" style={{ gap: 8 }}>
              {CLIENT_COLORS.map((col) => (
                <button
                  key={col}
                  aria-label={col}
                  onClick={() => set({ color: col })}
                  style={{ width: 32, height: 32, borderRadius: 10, background: col, boxShadow: c.color === col ? '0 0 0 3px var(--surface), 0 0 0 5px ' + col : undefined }}
                />
              ))}
            </div>
          </div>
        </section>

        <section className="card card-lg stack">
          <h2>מסגרת אימונים</h2>
          <div className="grid-2">
            <Field label="תאריך התחלה">
              <input className="input" type="date" value={c.startDate ?? ''} onChange={(e) => set({ startDate: e.target.value })} />
            </Field>
            <Field label="אימונים בשבוע">
              <Stepper value={c.weeklyFrequency ?? null} onChange={(v) => set({ weeklyFrequency: v ?? undefined })} />
            </Field>
          </div>
          <Field label="סוג אימון">
            <Seg value={c.trainingType ?? 'personal'} onChange={(v) => set({ trainingType: v as TrainingType })} options={(Object.keys(TRAINING_TYPES) as TrainingType[]).map((k) => ({ value: k, label: TRAINING_TYPES[k] }))} />
          </Field>
          <div className="field">
            <span className="label">ימים מתוכננים</span>
            <div className="week-days">
              {WEEKDAYS_SHORT.map((d, i) => (
                <button
                  key={i}
                  className={c.plannedDays.includes(i) ? 'on' : ''}
                  onClick={() => set({ plannedDays: c.plannedDays.includes(i) ? c.plannedDays.filter((x) => x !== i) : [...c.plannedDays, i].sort() })}
                >
                  {d}
                </button>
              ))}
            </div>
            <span className="hint">המתאמן/ת יופיע/תופיע במסך הבית בימים האלה.</span>
          </div>
        </section>

        <section className="card card-lg stack">
          <h2>מטרות</h2>
          <ChipToggle options={(Object.keys(GOALS) as GoalKey[]).map((k) => ({ value: k, label: GOALS[k] }))} value={c.goals} onChange={(v) => set({ goals: v })} />
          {c.goals.includes('custom') && (
            <Field label="מטרה מותאמת">
              <input className="input" value={c.customGoal ?? ''} onChange={(e) => set({ customGoal: e.target.value })} />
            </Field>
          )}
        </section>

        <section className="card card-lg stack">
          <h2>רקע מקצועי</h2>
          <Field label="ניסיון באימוני כוח">
            {/* nothing is shown as selected until a level is actually stored */}
            <Seg<ExperienceLevel | ''>
              value={c.experience ?? ''}
              onChange={(v) => set({ experience: v || undefined })}
              options={(Object.keys(EXPERIENCE) as ExperienceLevel[]).map((k) => ({ value: k, label: EXPERIENCE[k] }))}
            />
          </Field>
          <Field label="רמת כושר">
            <Rating value={c.fitnessLevel ?? null} onChange={(v) => set({ fitnessLevel: (v ?? undefined) as Client['fitnessLevel'] })} low="נמוכה" high="גבוהה" />
          </Field>
          <Field label="מגבלות תנועה" optional>
            <textarea className="textarea" value={c.limitations ?? ''} onChange={(e) => set({ limitations: e.target.value })} />
          </Field>
          <Field label="פציעות רלוונטיות" optional>
            <textarea className="textarea" value={c.injuries ?? ''} onChange={(e) => set({ injuries: e.target.value })} />
          </Field>
          <Field label="תרגילים לא נוחים" optional hint="המנוע לא יציע אותם כחלופה">
            <input className="input" value={c.uncomfortableExercises ?? ''} onChange={(e) => set({ uncomfortableExercises: e.target.value })} />
          </Field>
          <Field label="הערות טכניות" optional>
            <textarea className="textarea" value={c.technicalNotes ?? ''} onChange={(e) => set({ technicalNotes: e.target.value })} />
          </Field>
        </section>

        <section className="card card-lg stack">
          <h2>יעדי נפח שבועי</h2>
          <p className="small muted">מספר סטים אפקטיביים לשבוע לכל קבוצת שרירים. בחרי בסיס, ואפשר לכוונן כל שריר בנפרד.</p>
          <Seg
            value={c.volumePreset ?? 'intermediate'}
            onChange={(v) => set({ volumePreset: v as VolumePresetKey })}
            options={(Object.keys(VOLUME_PRESETS) as VolumePresetKey[]).map((k) => ({ value: k, label: VOLUME_PRESETS[k].label }))}
          />
          <div className="hint">{VOLUME_PRESETS[c.volumePreset ?? 'intermediate'].hint}</div>
          <button className="link-btn" onClick={() => setShowTargets((s) => !s)}>
            התאמה לכל שריר <ChevronDown style={{ transform: showTargets ? 'rotate(180deg)' : undefined }} />
          </button>
          {showTargets && (
            <div className="stack-sm">
              <div className="hint">מינימום–מקסימום סטים בשבוע. מקסימום 0 = השריר לא נמדד אצל המתאמן/ת.</div>
              {muscles.map((m) => {
                const base = presetTarget(c.volumePreset ?? 'intermediate', m.id);
                const t = c.volumeTargets[m.id];
                const setT = (patch: Partial<{ min: number; max: number }>) =>
                  set({ volumeTargets: { ...c.volumeTargets, [m.id]: { ...(t ?? base), ...patch } } });
                return (
                  <div key={m.id} className="row between target-row">
                    <span className="small strong grow">{m.name}</span>
                    <NumInput value={t?.min ?? null} placeholder={String(base.min)} onChange={(v) => setT({ min: v ?? 0 })} ariaLabel={`מינימום ${m.name}`} />
                    <span className="muted">–</span>
                    <NumInput value={t?.max ?? null} placeholder={String(base.max)} onChange={(v) => setT({ max: v ?? 0 })} ariaLabel={`מקסימום ${m.name}`} />
                    {t && (
                      <button
                        className="icon-btn"
                        aria-label="איפוס"
                        onClick={() => {
                          const next = { ...c.volumeTargets };
                          delete next[m.id];
                          set({ volumeTargets: next });
                        }}
                      >
                        <RotateCcw size={16} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <button className="btn btn-primary btn-lg btn-block" onClick={save}>
          שמירה
        </button>

        {existing && (
          <div className="row row-wrap" style={{ justifyContent: 'center' }}>
            <button className="btn btn-ghost" onClick={toggleArchived}>
              {existing.archived ? <ArchiveRestore /> : <Archive />}
              {existing.archived ? 'החזרה לפעילים' : 'העברה לארכיון'}
            </button>
            <button className="btn btn-danger" onClick={remove}>
              <Trash2 /> מחיקת מתאמן/ת
            </button>
          </div>
        )}
      </div>
    </>
  );
}
