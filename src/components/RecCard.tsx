import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ArrowUpCircle,
  BarChart3,
  Check,
  ChevronDown,
  Pencil,
  Repeat,
  Scale,
  ShieldAlert,
  Target,
  X,
} from 'lucide-react';
import type { Client, Exercise, ID, Recommendation, RecType } from '../domain/types';
import { REC_STATUS, REC_TYPES } from '../domain/labels';
import { incrementFor, suggestionText } from '../domain/engine';
import { applyRecommendation, decideRecommendation } from '../db/repo';
import { useSettings } from '../db/hooks';
import { fmtDateTime, relativeTime } from '../domain/util';
import { Avatar, Field, Sheet, Stepper, useUi } from './ui';
import { ExercisePicker } from './ExercisePicker';

const ICONS: Record<RecType, typeof Activity> = {
  increaseWeight: ArrowUpCircle,
  addReps: Target,
  adjustRange: Scale,
  reduceLoad: Scale,
  swapExercise: Repeat,
  techniqueCheck: AlertTriangle,
  painCheck: ShieldAlert,
  recoveryCheck: Activity,
  volumeLow: BarChart3,
  volumeHigh: BarChart3,
  adherence: BarChart3,
};

const TONE = { info: 'info', suggest: 'accent', warn: 'danger' } as const;

export function RecCard({
  rec,
  client,
  exercises,
  compact,
}: {
  rec: Recommendation;
  client?: Client | null;
  exercises: Map<ID, Exercise>;
  compact?: boolean;
}) {
  const { toast } = useUi();
  const [open, setOpen] = useState(!compact && rec.status === 'pending');
  const [editing, setEditing] = useState(false);
  const Icon = ICONS[rec.type] ?? Activity;
  const tone = TONE[rec.severity];
  const s = rec.suggestion;
  const pending = rec.status === 'pending';
  const sugg = suggestionText(s);

  const approve = async () => {
    if (s.kind === 'swap') return setEditing(true);
    const res = await applyRecommendation(rec);
    toast(res.message);
  };
  const reject = async () => {
    await decideRecommendation(rec.id, 'rejected');
    toast('ההמלצה נדחתה', { action: { label: 'ביטול', run: () => decideRecommendation(rec.id, 'pending', { decidedAt: null }) } });
  };

  return (
    <div className="card rec" data-tone={tone}>
      <div className="rec-head">
        <div className={`rec-icon tone-${tone}`}>
          <Icon />
        </div>
        <div className="grow">
          <div className="row row-wrap" style={{ gap: 6 }}>
            <span className={`badge tone-${tone}`}>{REC_TYPES[rec.type]}</span>
            {!pending && (
              <span className={`badge ${rec.status === 'rejected' ? '' : 'tone-success'}`}>
                {rec.editedTo && rec.status === 'applied' ? 'נערכה ובוצעה' : REC_STATUS[rec.status]}
              </span>
            )}
            <span className="tiny faint">{relativeTime(rec.createdAt)}</span>
          </div>
          <div className="rec-title">{rec.title}</div>
          {client && (
            <Link to={`/clients/${client.id}`} className="row small muted" style={{ gap: 6, marginTop: 2 }}>
              <Avatar name={client.name} color={client.color} size="sm" />
              {client.name}
            </Link>
          )}
        </div>
      </div>

      <p className="rec-detected">{rec.detected}</p>
      {sugg && pending && <div className="rec-sugg num">{sugg}</div>}

      <button className="link-btn" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? 'הסתרת הנימוק' : 'למה? על מה זה מבוסס'}
        <ChevronDown style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform .15s' }} />
      </button>
      {open && (
        <div className="rec-why">
          <p>{rec.reasoning}</p>
          {rec.evidence.length > 0 && (
            <div className="rec-evidence">
              {rec.evidence.map((e, i) => (
                <div key={i} className="ev-row">
                  <span className="muted">{e.sessionId ? <Link to={`/session/${e.sessionId}/view`}>{e.label}</Link> : e.label}</span>
                  <span className="num strong" style={{ textAlign: 'start', direction: 'rtl' }}>{e.value}</span>
                </div>
              ))}
            </div>
          )}
          <p className="strong">מה אפשר לעשות: <span style={{ fontWeight: 400 }}>{rec.action}</span></p>
          {s.kind === 'swap' && s.alternativeIds && s.alternativeIds.length > 0 && (
            <div className="chips">
              {s.alternativeIds.map((id) => (
                <span key={id} className="chip chip-sm">{exercises.get(id)?.nameHe ?? id}</span>
              ))}
            </div>
          )}
          {!pending && (
            <p className="tiny muted">
              {REC_STATUS[rec.status]} · {fmtDateTime(rec.decidedAt)}
              {rec.decisionNote ? ` · ${rec.decisionNote}` : ''}
              {rec.appliedVersion ? ` · גרסת תוכנית ${rec.appliedVersion}` : ''}
            </p>
          )}
        </div>
      )}

      {pending && (
        <div className="rec-actions">
          <button className="btn btn-primary btn-sm" onClick={approve}>
            <Check /> {s.kind === 'none' ? 'סימון כנבדק' : s.kind === 'reps' ? 'אישור כדגש' : s.kind === 'swap' ? 'בחירת חלופה' : 'אישור ועדכון'}
          </button>
          {s.kind !== 'none' && s.kind !== 'swap' && (
            <button className="btn btn-sm" onClick={() => setEditing(true)}>
              <Pencil /> עריכה
            </button>
          )}
          <button className="btn btn-ghost btn-sm" onClick={reject}>
            <X /> דחייה
          </button>
        </div>
      )}
      {editing && <RecEditSheet rec={rec} exercises={exercises} onClose={() => setEditing(false)} />}
    </div>
  );
}

function RecEditSheet({ rec, exercises, onClose }: { rec: Recommendation; exercises: Map<ID, Exercise>; onClose: () => void }) {
  const { toast } = useUi();
  const settings = useSettings();
  const s = rec.suggestion;
  const [weight, setWeight] = useState<number | null>(s.weight ?? null);
  const [min, setMin] = useState<number | null>(s.repsMin ?? null);
  const [max, setMax] = useState<number | null>(s.repsMax ?? null);
  const [reps, setReps] = useState<number | null>(s.kind === 'reps' ? Number(s.to) || null : null);
  const [alt, setAlt] = useState<ID | null>(s.alternativeIds?.[0] ?? null);
  const [note, setNote] = useState('');
  const [picking, setPicking] = useState(false);
  const ex = s.exerciseId ? exercises.get(s.exerciseId) : null;

  const save = async () => {
    const override =
      s.kind === 'weight'
        ? { weight }
        : s.kind === 'range'
          ? { repsMin: min, repsMax: max }
          : s.kind === 'swap'
            ? { alternativeId: alt }
            : s.kind === 'reps'
              ? { reps }
              : {};
    const res = await applyRecommendation(rec, { ...override, note: note || undefined });
    toast(res.message);
    onClose();
  };

  return (
    <Sheet
      title={s.kind === 'swap' ? 'בחירת חלופה' : 'עריכת ההמלצה'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>ביטול</button>
          <button className="btn btn-primary" onClick={save} disabled={s.kind === 'swap' && !alt}>
            אישור ועדכון התוכנית
          </button>
        </>
      }
    >
      <div className="stack">
        {ex && <div className="muted small">{ex.nameHe}</div>}
        {s.kind === 'weight' && (
          <Field label="משקל חדש (ק״ג)" hint={`מוצע: ${s.to} ק״ג · נוכחי: ${s.from} ק״ג`}>
            {/* the same jump the engine used (exercise, else the equipment default from settings) */}
            <Stepper value={weight} onChange={setWeight} step={(ex && incrementFor(ex, settings)) || 2.5} decimal />
          </Field>
        )}
        {s.kind === 'reps' && (
          <Field label="חזרות יעד לאימון הבא">
            <Stepper value={reps} onChange={setReps} />
          </Field>
        )}
        {s.kind === 'range' && (
          <div className="grid-2">
            <Field label="חזרות מינ׳">
              <Stepper value={min} onChange={setMin} />
            </Field>
            <Field label="חזרות מקס׳">
              <Stepper value={max} onChange={setMax} />
            </Field>
          </div>
        )}
        {s.kind === 'swap' && (
          <div className="stack-sm">
            {(s.alternativeIds ?? []).concat(alt && !(s.alternativeIds ?? []).includes(alt) ? [alt] : []).map((id) => (
              <button key={id} className={`chip ${alt === id ? 'on' : ''}`} style={{ justifyContent: 'flex-start' }} onClick={() => setAlt(id)}>
                {exercises.get(id)?.nameHe ?? id}
              </button>
            ))}
            <button className="btn btn-soft btn-sm" onClick={() => setPicking(true)}>
              בחירה מספריית התרגילים
            </button>
          </div>
        )}
        <Field label="הערה" optional>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="למשל: עלייה הדרגתית יותר" />
        </Field>
        <p className="tiny muted">העדכון ייצור גרסה חדשה של התוכנית עם סיבת השינוי — אפשר תמיד לחזור לגרסה קודמת.</p>
      </div>
      {picking && (
        <ExercisePicker
          onClose={() => setPicking(false)}
          onPick={(id) => {
            setAlt(id);
            setPicking(false);
          }}
          initialMuscle={ex?.primary[0]}
        />
      )}
    </Sheet>
  );
}
