import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp, ChevronLeft, Eye, EyeOff, Plus, Sparkles, Trash2 } from 'lucide-react';
import { db } from '../db/db';
import { getSettings, saveSettings } from '../db/repo';
import { useSettings } from '../db/hooks';
import type { Equipment, Exercise, MuscleGroup, Settings } from '../domain/types';
import { EQUIPMENT } from '../domain/labels';
import { loadDemoData, removeDemoData } from '../domain/demo';
import { isoDate, plural } from '../domain/util';
import { CommitInput, Field, NumInput, Seg, Stepper, Switch, TopBar, useUi } from '../components/ui';
import { isIOS } from '../components/install';

declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;

/**
 * Builds every change from the LATEST stored settings inside one write transaction. On a phone,
 * leaving a text field by tapping a button commits the text and runs the tap in the same task,
 * before the screen re-renders, so a change built from this render's copy would put the old text back.
 */
export function updateSettings(fn: (cur: Settings) => Partial<Settings>): Promise<void> {
  return db.transaction('rw', db.settings, async () => saveSettings(fn(await getSettings())));
}

/** Exercises that count sets toward this muscle group, as a primary or a secondary muscle. */
export function exercisesUsingMuscle(exercises: Exercise[], id: string): Exercise[] {
  return exercises.filter((e) => !e.deletedAt && (e.primary.includes(id) || e.secondary.some((s) => s.muscle === id)));
}

/**
 * Deletes a custom muscle group and, in the same transaction, removes it from every exercise
 * that used it — otherwise those exercises keep an id that no screen can name or remove.
 */
export async function deleteMuscle(id: string): Promise<void> {
  await db.transaction('rw', db.settings, db.exercises, async () => {
    const cur = await getSettings();
    // the id is remembered as deleted, so merging a backup from another device can't bring it back
    await saveSettings({
      muscles: cur.muscles.filter((x) => x.id !== id),
      deletedMuscleIds: [...new Set([...(cur.deletedMuscleIds ?? []), id])],
    });
    const t = Date.now();
    await db.exercises
      .filter((e) => e.primary.includes(id) || e.secondary.some((s) => s.muscle === id))
      .modify((e) => {
        e.primary = e.primary.filter((m) => m !== id);
        e.secondary = e.secondary.filter((s) => s.muscle !== id);
        e.updatedAt = t;
      });
  });
}

/** Swaps a muscle group with its neighbour (by id, so a stale row index can't move the wrong one). */
export function moveMuscle(muscles: MuscleGroup[], id: string, dir: -1 | 1): MuscleGroup[] | null {
  const list = [...muscles].sort((a, b) => a.order - b.order);
  const i = list.findIndex((m) => m.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return null;
  [list[i], list[j]] = [list[j], list[i]];
  return list.map((m, k) => ({ ...m, order: k }));
}

export function SettingsPage() {
  const s = useSettings();
  const { toast, confirm } = useUi();
  const [newMuscle, setNewMuscle] = useState('');
  const set = (patch: Partial<Settings>) => updateSettings(() => patch);
  const muscles = [...s.muscles].sort((a, b) => a.order - b.order);
  const patchMuscle = (id: string, fn: (m: MuscleGroup) => MuscleGroup) =>
    updateSettings((cur) => ({ muscles: cur.muscles.map((x) => (x.id === id ? fn(x) : x)) }));
  const move = (id: string, dir: -1 | 1) =>
    updateSettings((cur) => {
      const list = moveMuscle(cur.muscles, id, dir);
      return list ? { muscles: list } : {};
    });
  const removeMuscle = async (m: MuscleGroup) => {
    const n = exercisesUsingMuscle(await db.exercises.toArray(), m.id).length;
    const ok = await confirm({
      title: `למחוק את קבוצת השריר ${m.name}?`,
      body: n
        ? `${plural(n, 'תרגיל אחד משויך', 'תרגילים משויכים')} אליה — השיוך יוסר, והסטים שלהם לא ייספרו לקבוצה הזו. אפשר במקום זה להסתיר אותה.`
        : 'אין תרגילים משויכים אליה. אפשר במקום זה להסתיר אותה.',
      confirmLabel: 'מחיקה',
      danger: true,
    });
    if (!ok) return;
    await deleteMuscle(m.id);
    toast('קבוצת השריר נמחקה');
  };

  return (
    <>
      <TopBar title="הגדרות" back={true} />
      <div className="page page-narrow stack-lg">
        <section className="card card-lg stack">
          <h2>כללי</h2>
          <Field label="שם המאמנת" hint="מופיע במסך הבית וכ״מאשרת״ בגרסאות התוכנית">
            <CommitInput value={s.trainerName} onCommit={(v) => set({ trainerName: v })} />
          </Field>
          <Field label="מראה">
            <Seg
              value={s.theme}
              onChange={(v) => set({ theme: v })}
              options={[
                { value: 'system', label: 'לפי המכשיר' },
                { value: 'light', label: 'בהיר' },
                { value: 'dark', label: 'כהה' },
              ]}
            />
          </Field>
          <Field label="השבוע מתחיל ביום">
            <Seg
              value={s.weekStartsOn}
              onChange={(v) => set({ weekStartsOn: v })}
              options={[
                { value: 0, label: 'ראשון' },
                { value: 1, label: 'שני' },
              ]}
            />
          </Field>
        </section>

        <section className="card card-lg stack">
          <h2>תיעוד אימון</h2>
          <Field label="מנוחה ברירת מחדל (שניות)">
            <Stepper value={s.defaultRest} step={15} onChange={(v) => set({ defaultRest: v ?? 90 })} />
          </Field>
          <Field label="מדד מאמץ לכל סט">
            <Seg
              value={s.rirMode}
              onChange={(v) => set({ rirMode: v })}
              options={[
                { value: 'rir', label: 'RIR' },
                { value: 'rpe', label: 'RPE' },
                { value: 'both', label: 'שניהם' },
              ]}
            />
          </Field>
          <label className="row between">
            <span>צליל בסוף מנוחה</span>
            <Switch on={s.sound} onChange={(v) => set({ sound: v })} label="צליל" />
          </label>
          {isIOS() && <p className="tiny muted">באייפון הצליל לא נשמע כשהטלפון במצב שקט — אז רק פס הזמן מסמן את סוף המנוחה.</p>}
          {'vibrate' in navigator ? (
            <label className="row between">
              <span>רטט</span>
              <Switch on={s.vibrate} onChange={(v) => set({ vibrate: v })} label="רטט" />
            </label>
          ) : (
            <p className="tiny muted">רטט לא נתמך בדפדפן של המכשיר הזה.</p>
          )}
        </section>

        <section className="card card-lg stack">
          <h2>חישוב נפח שבועי</h2>
          <p className="small muted">
            כל סט עבודה נספר כסט <b>ישיר</b> לשרירים העיקריים של התרגיל, ותורם לשרירים המשניים לפי <b>מקדם עקיף</b>. אפשר לקבוע מקדם שונה לכל תרגיל
            ושריר בספריית התרגילים — הערך כאן הוא ברירת המחדל.
          </p>
          <Field label="מקדם עקיף ברירת מחדל">
            <Seg
              value={s.indirectFactor}
              onChange={(v) => set({ indirectFactor: v })}
              options={[0, 0.25, 0.5, 0.75, 1].map((f) => ({ value: f, label: <span className="num">{f === 0 ? 'לא לספור' : f}</span> }))}
            />
          </Field>
          <div className="small muted">
            לדוגמה: לחיצת חזה — 3 סטים = 3 ישירים לחזה + <span className="num">{3 * s.indirectFactor}</span> ליד אחורית ולכתפיים.
          </div>
          <label className="row between">
            <span>לספור סטי דרופ</span>
            <Switch on={s.countDropSets} onChange={(v) => set({ countDropSets: v })} label="סטי דרופ" />
          </label>
          <Field label="אילו סטים נספרים" hint="סטים ״קשים״ בלבד = רק סטים קרובים לכשל (RIR נמוך). סטים בלי RIR מתועד תמיד נספרים.">
            <Seg
              value={s.hardSetMaxRir ?? -1}
              onChange={(v) => set({ hardSetMaxRir: v === -1 ? null : v })}
              options={[
                { value: -1, label: 'כל סטי העבודה' },
                { value: 4, label: 'RIR ≤ 4' },
                { value: 3, label: 'RIR ≤ 3' },
              ]}
            />
          </Field>
        </section>

        <section className="card card-lg stack">
          <h2>קבוצות שרירים</h2>
          <p className="small muted">אפשר לשנות שמות, להסתיר קבוצות שלא רלוונטיות, להוסיף קבוצות ולשנות סדר.</p>
          <div className="stack-sm">
            {muscles.map((m, i) => (
              <div key={m.id} className={`row muscle-row ${m.hidden ? 'hidden' : ''}`}>
                <div className="grow">
                  <CommitInput
                    className="input input-sm"
                    value={m.name}
                    onCommit={(v) => patchMuscle(m.id, (x) => ({ ...x, name: v }))}
                  />
                </div>
                <button className="icon-btn" onClick={() => move(m.id, -1)} aria-label="למעלה" disabled={i === 0}>
                  <ArrowUp size={18} />
                </button>
                <button className="icon-btn" onClick={() => move(m.id, 1)} aria-label="למטה" disabled={i === muscles.length - 1}>
                  <ArrowDown size={18} />
                </button>
                <button className="icon-btn" onClick={() => patchMuscle(m.id, (x) => ({ ...x, hidden: !x.hidden }))} aria-label={m.hidden ? 'הצגה' : 'הסתרה'}>
                  {m.hidden ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
                {m.custom && (
                  <button className="icon-btn" aria-label="מחיקה" onClick={() => removeMuscle(m)}>
                    <Trash2 size={18} />
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="row">
            <input className="input grow" placeholder="קבוצה חדשה (למשל: טרפזים)" value={newMuscle} onChange={(e) => setNewMuscle(e.target.value)} />
            <button
              className="btn"
              disabled={!newMuscle.trim()}
              onClick={() => {
                const muscle = { id: `m_${Date.now().toString(36)}`, name: newMuscle.trim(), custom: true };
                updateSettings((cur) => ({ muscles: [...cur.muscles, { ...muscle, order: Math.max(-1, ...cur.muscles.map((x) => x.order)) + 1 }] }));
                setNewMuscle('');
              }}
            >
              <Plus /> הוספה
            </button>
          </div>
        </section>

        <section className="card card-lg stack">
          <h2>מנוע ההמלצות</h2>
          <Field label="קפיצות משקל לפי ציוד (ק״ג)" hint="משמש להמלצת העלאת משקל. אפשר לקבוע קפיצה שונה לכל תרגיל בספרייה.">
            <div className="grid-3">
              {(Object.keys(EQUIPMENT) as Equipment[])
                .filter((k) => !['bodyweight', 'band', 'trx'].includes(k))
                .map((k) => (
                  <label key={k} className="field">
                    <span className="tiny muted">{EQUIPMENT[k]}</span>
                    <NumInput decimal value={s.increments[k]} onChange={(v) => updateSettings((cur) => ({ increments: { ...cur.increments, [k]: v ?? 0 } }))} />
                  </label>
                ))}
            </div>
          </Field>
          <Field label="תקופה ללא התקדמות לפני הצעת שינוי (שבועות)">
            <Stepper value={s.stagnationWeeks} min={2} onChange={(v) => set({ stagnationWeeks: v ?? 4 })} />
          </Field>
        </section>

        <section className="card card-lg stack">
          <h2>גיבוי</h2>
          <Field label="תזכורת לגיבוי מחוץ למכשיר אחרי (ימים)">
            <Stepper value={s.backupReminderDays} min={1} onChange={(v) => set({ backupReminderDays: v ?? 7 })} />
          </Field>
          <label className="row between">
            <span>גיבוי אוטומטי יומי בתוך האפליקציה</span>
            <Switch on={s.autoSnapshot} onChange={(v) => set({ autoSnapshot: v })} label="גיבוי אוטומטי" />
          </label>
          <Link to="/backup" className="btn btn-soft">
            למסך הגיבוי והשחזור <ChevronLeft />
          </Link>
        </section>

        <section className="card card-lg stack">
          <h2>נתוני הדגמה</h2>
          <p className="small muted">שלושה מתאמנים לדוגמה עם תוכניות ו-6 שבועות של אימונים — כדי להכיר את המערכת. הם מסומנים ונמחקים בלחיצה, בלי לגעת בנתונים אמיתיים.</p>
          <div className="row row-wrap">
            <button
              className="btn"
              onClick={async () => {
                await loadDemoData();
                toast('נתוני ההדגמה נטענו');
              }}
            >
              <Sparkles /> טעינת נתוני הדגמה
            </button>
            <button
              className="btn btn-danger"
              onClick={async () => {
                if (!(await confirm({ title: 'למחוק את נתוני ההדגמה?', body: 'רק רשומות שסומנו כהדגמה יימחקו.', danger: true, confirmLabel: 'מחיקה' }))) return;
                const n = await removeDemoData();
                toast(n === 1 ? 'נמחקה רשומת הדגמה אחת' : `נמחקו ${n} רשומות הדגמה`);
              }}
            >
              <Trash2 /> מחיקת נתוני הדגמה
            </button>
          </div>
        </section>

        <div className="small muted" style={{ textAlign: 'center' }}>
          Shira Coach · גרסה {typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''} · נבנתה {typeof __BUILD_TIME__ === 'string' ? isoDate(new Date(__BUILD_TIME__)) : ''}
          <br />
          כל הנתונים נשמרים במכשיר הזה בלבד ואינם נשלחים לשום שרת.
          <br />
          נשלח רק מונה כניסות אנונימי, בלי שום מידע על מתאמנים או אימונים.
        </div>
      </div>
    </>
  );
}
