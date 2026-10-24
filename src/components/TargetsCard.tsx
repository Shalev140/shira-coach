import { useState } from 'react';
import { Check, Flag, Plus, Trash2 } from 'lucide-react';
import type { Client, ClientTarget, Exercise, ID, Session } from '../domain/types';
import { saveClient } from '../db/repo';
import { exerciseHistory, personalRecords } from '../domain/progress';
import { daysBetween, fmtDate, isoDate, uid } from '../domain/util';
import { Field, NumInput, Sheet, useUi } from './ui';
import { ExercisePicker } from './ExercisePicker';

/** Client goals (spec §4 "יעדים"): free text, or a lift target tracked against personal records. */
export function TargetsCard({ client, sessions, exercises }: { client: Client; sessions: Session[]; exercises: Map<ID, Exercise> }) {
  const { toast, confirm } = useUi();
  const [adding, setAdding] = useState(false);
  const targets = client.targets ?? [];
  const save = (next: ClientTarget[]) => saveClient({ ...client, targets: next });

  const progressOf = (t: ClientTarget) => {
    if (!t.exerciseId || !t.value) return null;
    const pr = personalRecords(exerciseHistory(sessions, t.exerciseId));
    const best = pr.topWeight?.value ?? 0;
    return { best, pct: Math.min(100, (best / t.value) * 100), reached: best >= t.value };
  };

  return (
    <div className="card card-pad stack-sm">
      <div className="row between">
        <div className="card-title">
          <Flag /> יעדים
        </div>
        <button className="btn btn-sm btn-soft" onClick={() => setAdding(true)}>
          <Plus /> יעד
        </button>
      </div>
      {targets.length === 0 && <div className="small muted">למשל: ״סקוואט 80 ק״ג עד דצמבר״ או ״לחזור לרוץ 5 ק״מ״.</div>}
      {targets.map((t) => {
        const p = progressOf(t);
        const done = !!t.achievedAt;
        const overdue = t.due && !done && daysBetween(t.due, isoDate()) > 0;
        return (
          <div key={t.id} className={`target ${done ? 'done' : ''}`}>
            <div className="row row-top">
              <button
                className={`check-btn ${done ? 'on' : ''}`}
                aria-label={done ? 'סימון כלא הושג' : 'סימון כהושג'}
                onClick={() => save(targets.map((x) => (x.id === t.id ? { ...x, achievedAt: done ? null : Date.now() } : x)))}
              >
                <Check size={14} />
              </button>
              <div className="grow">
                <div className="small strong">{t.text}</div>
                <div className="tiny muted">
                  {t.due && <span className={overdue ? 'trend-down' : ''}>יעד: {fmtDate(t.due)}</span>}
                  {done && <span> · הושג {fmtDate(isoDate(t.achievedAt!))}</span>}
                  {p && !done && (
                    <span>
                      {t.due ? ' · ' : ''}שיא נוכחי <span className="num">{p.best || '—'}</span> מתוך <span className="num">{t.value}</span> ק״ג
                    </span>
                  )}
                </div>
              </div>
              {p?.reached && !done && <span className="badge tone-lime">הושג!</span>}
              <button
                className="icon-btn"
                aria-label="מחיקת יעד"
                onClick={async () => {
                  if (await confirm({ title: 'למחוק את היעד?', danger: true, confirmLabel: 'מחיקה' })) {
                    await save(targets.filter((x) => x.id !== t.id));
                    toast('היעד נמחק');
                  }
                }}
              >
                <Trash2 size={16} />
              </button>
            </div>
            {p && !done && (
              <div className="bar" style={{ marginTop: 6 }}>
                <i style={{ width: `${p.pct}%`, background: p.reached ? 'var(--success-bg)' : undefined }} />
              </div>
            )}
          </div>
        );
      })}
      {adding && (
        <TargetSheet
          exercises={exercises}
          onClose={() => setAdding(false)}
          onSave={async (t) => {
            await save([...targets, t]);
            toast('היעד נוסף');
            setAdding(false);
          }}
        />
      )}
    </div>
  );
}

function TargetSheet({ exercises, onClose, onSave }: { exercises: Map<ID, Exercise>; onClose: () => void; onSave: (t: ClientTarget) => void }) {
  const [text, setText] = useState('');
  const [exerciseId, setExerciseId] = useState<ID | null>(null);
  const [value, setValue] = useState<number | null>(null);
  const [due, setDue] = useState('');
  const [picking, setPicking] = useState(false);
  const ex = exerciseId ? exercises.get(exerciseId) : null;
  const autoText = ex && value ? `${ex.nameHe} — ${value} ק״ג` : '';
  const finalText = text.trim() || autoText;
  return (
    <Sheet
      title="יעד חדש"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>ביטול</button>
          <button
            className="btn btn-primary"
            disabled={!finalText}
            onClick={() => onSave({ id: uid(), text: finalText, exerciseId: exerciseId ?? undefined, value: value ?? undefined, unit: value ? 'kg' : undefined, due: due || undefined, achievedAt: null })}
          >
            שמירה
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="תרגיל ומשקל יעד" optional hint="יעד בתרגיל מתעדכן אוטומטית מול השיא האישי">
          <div className="row">
            <button className="btn grow" onClick={() => setPicking(true)}>
              {ex ? ex.nameHe : 'בחירת תרגיל'}
            </button>
            <div style={{ width: 110 }}>
              <NumInput className="input" decimal value={value} placeholder="ק״ג" onChange={setValue} ariaLabel="משקל יעד" />
            </div>
          </div>
        </Field>
        <Field label="תיאור היעד" optional={!!autoText}>
          <input className="input" value={text} placeholder={autoText || 'למשל: 10 שכיבות סמיכה מלאות'} onChange={(e) => setText(e.target.value)} />
        </Field>
        <Field label="תאריך יעד" optional>
          <input className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </Field>
      </div>
      {picking && (
        <ExercisePicker
          onClose={() => setPicking(false)}
          onPick={(id) => {
            setExerciseId(id);
            setPicking(false);
          }}
        />
      )}
    </Sheet>
  );
}
