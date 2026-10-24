import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Award, Plus, Ruler, Trash2, TrendingDown, TrendingUp } from 'lucide-react';
import type { Client, Exercise, ID, Measurement, Program, Session, SessionEntry, Settings, Technique } from '../domain/types';
import { addMeasurement, softDelete } from '../db/repo';
import { useMeasurements } from '../db/hooks';
import { TECHNIQUE_SCORE, completedWorkSets, entryStats, exerciseHistory, formatSet, personalRecords, type ExerciseOccurrence } from '../domain/progress';
import { addDays, daysBetween, fmtDate, fmtNum, isoDate, plural } from '../domain/util';
import { clientTarget, performedVolume, sessionsInRange, weekRange } from '../domain/volume';
import { LineChart, Sparkline, type Point } from './charts';
import { Field, NumInput, Seg, Sheet, useUi } from './ui';
import { VolumePanel } from './VolumePanel';

export type Metric = 'e1rm' | 'top' | 'volume' | 'reps' | 'duration' | 'technique';
const METRICS: { value: Metric; label: string; unit: string }[] = [
  { value: 'e1rm', label: '1RM משוער', unit: 'ק״ג' },
  { value: 'top', label: 'משקל מרבי', unit: 'ק״ג' },
  { value: 'volume', label: 'נפח (ק״ג×חזרות)', unit: '' },
  { value: 'reps', label: 'סה״כ חזרות', unit: '' },
  { value: 'duration', label: 'זמן בסט הטוב', unit: 'שנ׳' },
  { value: 'technique', label: 'איכות טכניקה', unit: '' },
];

const TECHNIQUE_ORDER: Technique[] = ['poor', 'fix', 'good', 'na'];

/**
 * One occurrence per workout, oldest first. The same exercise can appear twice in a workout (a heavy
 * main lift and a light finisher): the best set wins, totals add up, and the worst technique counts.
 */
export function perWorkout(history: ExerciseOccurrence[]): ExerciseOccurrence[] {
  const out = new Map<ID, ExerciseOccurrence>();
  for (const o of history) {
    const prev = out.get(o.session.id);
    if (!prev) {
      out.set(o.session.id, o);
      continue;
    }
    const techniques = [prev.entry.technique, o.entry.technique];
    const entry: SessionEntry = {
      ...prev.entry,
      sets: [...prev.entry.sets, ...o.entry.sets],
      technique: TECHNIQUE_ORDER.find((t) => techniques.includes(t)) ?? 'na',
      notes: [prev.entry.notes, o.entry.notes].filter(Boolean).join(' · ') || undefined,
    };
    out.set(o.session.id, { session: o.session, entry, stats: entryStats(entry) });
  }
  return [...out.values()];
}

/** The program slot of the latest workout's best set: the line a "change in the period" follows. */
export function latestSlot(history: ExerciseOccurrence[]): ID | null {
  const last = history[history.length - 1];
  if (!last) return null;
  const best = history
    .filter((o) => o.session.id === last.session.id)
    .reduce((a, o) => (o.stats.bestE1rm > a.stats.bestE1rm ? o : a));
  return best.entry.plannedExerciseId ?? null;
}

/**
 * Like for like, one point per workout: the same exercise in another slot (a light day, a finisher)
 * is a different line, so comparing its start with the main lift's end would show a drop that never
 * happened. Falls back to every workout while the slot is too new to compare.
 */
export function slotHistory(sessions: Session[], exerciseId: ID, slot: ID | null): ExerciseOccurrence[] {
  const all = perWorkout(exerciseHistory(sessions, exerciseId));
  if (!slot) return all;
  const same = perWorkout(exerciseHistory(sessions, exerciseId, undefined, slot));
  return same.length >= 2 ? same : all;
}

/** What the chart opens on: e1rm for loaded work, reps for bodyweight moves, seconds for timed holds. */
export function defaultMetric(history: ExerciseOccurrence[]): Metric {
  const sets = history.flatMap((o) => completedWorkSets(o.entry));
  if (sets.some((s) => (s.weight ?? 0) > 0 && (s.reps ?? 0) > 0)) return 'e1rm';
  if (sets.some((s) => (s.reps ?? 0) > 0)) return 'reps';
  if (sets.some((s) => (s.duration ?? 0) > 0)) return 'duration';
  return 'e1rm';
}

/** Change from the first to the last workout on the best set: e1rm, or reps / seconds for unloaded work. */
export function periodChange(history: ExerciseOccurrence[]): { label: string; pct: number } | null {
  if (history.length < 2) return null;
  const a = history[0].stats;
  const b = history[history.length - 1].stats;
  const pct = (x: number, y: number) => ((x - y) / y) * 100;
  if (a.bestE1rm > 0 && b.bestE1rm > 0) return { label: 'שינוי ב-1RM בתקופה', pct: pct(b.bestE1rm, a.bestE1rm) };
  // load added to (or dropped from) a bodyweight move: there is no honest comparison
  if (a.bestE1rm > 0 || b.bestE1rm > 0) return null;
  const ra = a.bestSet?.reps ?? 0;
  const rb = b.bestSet?.reps ?? 0;
  if (ra > 0 && rb > 0) return { label: 'שינוי בחזרות בסט הטוב', pct: pct(rb, ra) };
  if (a.bestDuration > 0 && b.bestDuration > 0) return { label: 'שינוי בזמן ההחזקה', pct: pct(b.bestDuration, a.bestDuration) };
  return null;
}

const slotName = (o: ExerciseOccurrence) =>
  `${o.session.workoutName.startsWith('אימון') ? o.session.workoutName : `אימון ${o.session.workoutName}`} · ${o.entry.blockLabel}`;

type Range = '6w' | '3m' | '6m' | 'all';
const RANGE_DAYS: Record<Range, number> = { '6w': 42, '3m': 92, '6m': 183, all: 100000 };

const MEAS_FIELDS: { key: keyof Measurement; label: string; unit: string }[] = [
  { key: 'weight', label: 'משקל', unit: 'ק״ג' },
  { key: 'bodyFat', label: 'אחוז שומן', unit: '%' },
  { key: 'waist', label: 'היקף מותן', unit: 'ס״מ' },
  { key: 'hips', label: 'היקף ירכיים', unit: 'ס״מ' },
  { key: 'chest', label: 'היקף חזה', unit: 'ס״מ' },
  { key: 'arm', label: 'היקף זרוע', unit: 'ס״מ' },
  { key: 'thigh', label: 'היקף ירך', unit: 'ס״מ' },
  { key: 'restingHr', label: 'דופק מנוחה', unit: 'פעימות' },
];

export function ProgressPanel({
  client,
  sessions,
  program,
  exercises,
  settings,
}: {
  client: Client;
  sessions: Session[];
  program?: Program | null;
  exercises: Map<ID, Exercise>;
  settings: Settings;
}) {
  const [range, setRange] = useState<Range>('3m');
  // null until the trainer picks one: the chart then opens on what the exercise is measured in
  const [metricPick, setMetric] = useState<Metric | null>(null);
  const [programFilter, setProgramFilter] = useState<'all' | 'current'>('all');
  const measurements = useMeasurements(client.id) ?? [];
  const from = isoDate(Date.now() - RANGE_DAYS[range] * 86400000);
  const completed = sessions.filter(
    (s) => s.status === 'completed' && s.date >= from && (programFilter === 'all' || !program || s.programId === program.id),
  );

  // exercises the client actually performed, most frequent first
  const performed = useMemo(() => {
    const counts = new Map<ID, number>();
    for (const s of completed) for (const e of s.entries) if (completedWorkSets(e).length) counts.set(e.exerciseId, (counts.get(e.exerciseId) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }, [completed]);
  const [exId, setExId] = useState<ID | null>(null);
  const [slotPick, setSlot] = useState<ID | 'all'>('all');
  const selected = exId && performed.includes(exId) ? exId : performed[0] ?? null;
  const rawHistory = selected ? exerciseHistory(completed, selected) : [];
  const allHistory = selected ? exerciseHistory(sessions, selected) : [];
  const prs = personalRecords(allHistory);

  // program slots the exercise was done in during the period (e.g. a heavy day and a light day)
  const slots: { id: ID; first: string; label: string }[] = [];
  for (const o of rawHistory) {
    const id = o.entry.plannedExerciseId;
    if (id && !slots.some((x) => x.id === id)) slots.push({ id, first: o.session.date, label: slotName(o) });
  }
  for (const x of slots) if (slots.some((y) => y !== x && y.label === x.label)) x.label += ` · מ-${fmtDate(x.first)}`;
  const slot = slotPick !== 'all' && slots.some((x) => x.id === slotPick) ? slotPick : null;
  const history = perWorkout(slot && selected ? exerciseHistory(completed, selected, undefined, slot) : rawHistory);
  const metric = metricPick ?? defaultMetric(history);
  const kpiSlot = slot ?? latestSlot(rawHistory);
  const kpiHist = selected ? slotHistory(completed, selected, kpiSlot) : [];
  const change = periodChange(kpiHist);
  const kpiLabel = slots.length > 1 && kpiSlot && kpiHist.every((o) => o.entry.plannedExerciseId === kpiSlot) ? slots.find((x) => x.id === kpiSlot)?.label : undefined;

  const points: Point[] = history
    .map((o) => {
      let y = 0;
      if (metric === 'e1rm') y = o.stats.bestE1rm;
      if (metric === 'top') y = o.stats.topWeight;
      if (metric === 'volume') y = o.stats.volume;
      if (metric === 'reps') y = o.stats.reps;
      if (metric === 'duration') y = o.stats.bestDuration;
      if (metric === 'technique') y = TECHNIQUE_SCORE[o.entry.technique] ?? -1;
      return { x: o.session.date, y, note: o.stats.bestSet ? formatSet(o.stats.bestSet) : undefined };
    })
    .filter((p) => p.y > 0);
  const hasDuration = history.some((o) => o.stats.bestDuration > 0);
  const unit = METRICS.find((m) => m.value === metric)!.unit;

  return (
    <div className="stack-lg">
      <div className="row row-wrap between">
        <Seg
          value={range}
          onChange={setRange}
          options={[
            { value: '6w', label: '6 שבועות' },
            { value: '3m', label: '3 חודשים' },
            { value: '6m', label: 'חצי שנה' },
            { value: 'all', label: 'הכול' },
          ]}
        />
        {program && (
          <Seg
            value={programFilter}
            onChange={setProgramFilter}
            options={[
              { value: 'all', label: 'כל התוכניות' },
              { value: 'current', label: 'תוכנית נוכחית' },
            ]}
          />
        )}
      </div>

      <section className="card card-pad stack">
        <div className="card-head" style={{ marginBottom: 0 }}>
          <div className="card-title">
            <TrendingUp /> התקדמות לפי תרגיל
          </div>
          <span className="tiny muted">{plural(completed.length, 'אימון אחד', 'אימונים')} בתקופה</span>
        </div>
        {performed.length === 0 ? (
          <div className="empty small">אין עדיין אימונים שהושלמו בתקופה הזו</div>
        ) : (
          <>
            <select
              className="select"
              value={selected ?? ''}
              onChange={(e) => {
                setExId(e.target.value);
                setMetric(null);
                setSlot('all');
              }}
              aria-label="תרגיל"
            >
              {performed.map((id) => (
                <option key={id} value={id}>
                  {exercises.get(id)?.nameHe ?? id}
                </option>
              ))}
            </select>
            {slots.length > 1 && (
              <div className="chips-scroll" role="group" aria-label="מיקום בתוכנית">
                <button aria-pressed={!slot} className={`chip chip-sm ${!slot ? 'on' : ''}`} onClick={() => setSlot('all')}>
                  כל האימונים
                </button>
                {slots.map((x) => (
                  <button key={x.id} aria-pressed={slot === x.id} className={`chip chip-sm ${slot === x.id ? 'on' : ''}`} onClick={() => setSlot(x.id)}>
                    {x.label}
                  </button>
                ))}
              </div>
            )}
            <div className="chips-scroll">
              {METRICS.filter((m) => m.value !== 'duration' || hasDuration || metric === 'duration').map((m) => (
                <button key={m.value} aria-pressed={metric === m.value} className={`chip chip-sm ${metric === m.value ? 'on' : ''}`} onClick={() => setMetric(m.value)}>
                  {m.label}
                </button>
              ))}
            </div>
            <LineChart points={points} unit={unit} digits={metric === 'volume' || metric === 'reps' || metric === 'duration' ? 0 : 1} label={exercises.get(selected!)?.nameHe} />
            {metric === 'technique' && <div className="tiny muted">3 = טובה · 2 = נדרש תיקון · 1 = לא מספקת. אימונים בלי תיעוד טכניקה לא מוצגים.</div>}
            <div className="kpis">
              <div className="kpi">
                <div className="k-label">{change?.label ?? 'שינוי בתקופה'}</div>
                {change ? (
                  <div className={`k-value ${change.pct > 0.5 ? 'trend-up' : change.pct < -0.5 ? 'trend-down' : ''}`}>
                    <span className="num">{change.pct > 0 ? '+' : ''}{fmtNum(change.pct)}%</span>
                  </div>
                ) : (
                  <div className="k-value">—</div>
                )}
                {kpiLabel && <div className="k-foot muted">{kpiLabel}</div>}
              </div>
              <div className="kpi">
                <div className="k-label">שיא משקל</div>
                <div className="k-value">
                  <span className="num">{prs.topWeight ? prs.topWeight.value : '—'}</span>
                  <small>ק״ג</small>
                </div>
                {prs.topWeight && <div className="k-foot muted">×{prs.topWeight.reps} · {fmtDate(prs.topWeight.date)}</div>}
              </div>
              <div className="kpi">
                <div className="k-label">1RM משוער שיא</div>
                <div className="k-value">
                  <span className="num">{prs.bestE1rm ? fmtNum(prs.bestE1rm.value) : '—'}</span>
                  <small>ק״ג</small>
                </div>
                {prs.bestE1rm && <div className="k-foot muted"><span className="num">{prs.bestE1rm.weight}×{prs.bestE1rm.reps}</span> · {fmtDate(prs.bestE1rm.date)}</div>}
              </div>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>תאריך</th>
                    <th>סטים (מתוכנן ← בוצע)</th>
                    <th>טכניקה</th>
                  </tr>
                </thead>
                <tbody>
                  {history
                    .slice(-8)
                    .reverse()
                    .map((o) => (
                      <tr key={o.session.id + o.entry.id}>
                        <td className="nowrap">
                          <Link to={`/session/${o.session.id}/view`}>{fmtDate(o.session.date)}</Link>
                        </td>
                        <td>
                          <div className="set-chips">
                            {completedWorkSets(o.entry).map((s) => (
                              <span key={s.id} className={`set-chip ${s.planned?.repsMin != null && (s.reps ?? 0) < (s.planned.repsMin ?? 0) ? 'below' : ''}`}>
                                {formatSet(s)}
                              </span>
                            ))}
                          </div>
                          {o.entry.notes && <div className="tiny muted">{o.entry.notes}</div>}
                        </td>
                        <td className="small">{o.entry.technique === 'na' ? '—' : { good: 'טובה', fix: 'תיקון', poor: 'לא מספקת' }[o.entry.technique]}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <PRBoard sessions={sessions} exercises={exercises} />

      <section className="stack">
        <h2>נפח שבועי לפי קבוצת שרירים</h2>
        <VolumePanel client={client} sessions={sessions} program={program} exercises={exercises} settings={settings} />
      </section>

      <MuscleTrend client={client} sessions={sessions} exercises={exercises} settings={settings} />

      <Measurements client={client} measurements={measurements} />
    </div>
  );
}

/** Effective weekly sets for one muscle group over the last 12 weeks, against the client's minimum target. */
function MuscleTrend({ client, sessions, exercises, settings }: { client: Client; sessions: Session[]; exercises: Map<ID, Exercise>; settings: Settings }) {
  const muscles = settings.muscles.filter((m) => !m.hidden).sort((a, b) => a.order - b.order);
  const [muscle, setMuscle] = useState(muscles[0]?.id ?? 'chest');
  const completed = sessions.filter((s) => s.status === 'completed');
  const points = useMemo(() => {
    const out: Point[] = [];
    const first = completed.length ? completed.reduce((a, s) => (s.date < a ? s.date : a), isoDate()) : isoDate();
    for (let k = 11; k >= 0; k--) {
      const range = weekRange(addDays(isoDate(), -7 * k), settings.weekStartsOn);
      if (range.end < first) continue;
      const vol = performedVolume(sessionsInRange(completed, range), exercises, settings, client).find((v) => v.muscle === muscle);
      out.push({ x: range.start, y: vol?.effective ?? 0, note: k === 0 ? 'השבוע (חלקי)' : `שבוע ${fmtDate(range.start)}` });
    }
    return out;
  }, [completed, muscle, exercises, settings, client]);
  const target = clientTarget(client, muscle);
  if (!completed.length) return null;
  return (
    <section className="card card-pad stack">
      <div className="card-title">
        <TrendingUp /> נפח שבועי לאורך זמן
      </div>
      <div className="chips-scroll">
        {muscles.map((m) => (
          <button key={m.id} aria-pressed={muscle === m.id} className={`chip chip-sm ${muscle === m.id ? 'on' : ''}`} onClick={() => setMuscle(m.id)}>
            {m.name}
          </button>
        ))}
      </div>
      <LineChart points={points} unit="סטים" digits={1} target={target?.min ?? null} label="נפח שבועי" height={180} />
      <div className="tiny muted">סטים אפקטיביים (ישיר + עקיף משוקלל) בכל שבוע. הקו המקווקו — מינימום היעד.</div>
    </section>
  );
}

function PRBoard({ sessions, exercises }: { sessions: Session[]; exercises: Map<ID, Exercise> }) {
  const rows = useMemo(() => {
    const ids = new Set(sessions.filter((s) => s.status === 'completed').flatMap((s) => s.entries.map((e) => e.exerciseId)));
    return [...ids]
      .map((id) => {
        const h = exerciseHistory(sessions, id);
        const pr = personalRecords(h);
        // one point per workout, along the slot of the latest best set, so a light day never reads as a drop
        const line = slotHistory(sessions, id, latestSlot(h));
        return { id, pr, spark: line.slice(-8).map((o) => o.stats.bestE1rm), last: h[h.length - 1] };
      })
      .filter((r) => r.pr.bestE1rm)
      .sort((a, b) => (b.pr.bestE1rm!.date > a.pr.bestE1rm!.date ? 1 : -1))
      .slice(0, 8);
  }, [sessions]);
  if (!rows.length) return null;
  return (
    <section className="card card-pad stack">
      <div className="card-title">
        <Award /> שיאים אישיים
      </div>
      <div className="list">
        {rows.map((r) => {
          const recent = daysBetween(r.pr.bestE1rm!.date, isoDate()) <= 14;
          const trendUp = r.spark.length > 1 && r.spark[r.spark.length - 1] >= r.spark[0];
          return (
            <div key={r.id} className="list-item" style={{ padding: '10px 0' }}>
              <div className="grow">
                <div className="small strong ellipsis">
                  {exercises.get(r.id)?.nameHe ?? r.id} {recent && <span className="badge tone-lime">חדש</span>}
                </div>
                <div className="tiny muted">
                  {r.pr.topWeight && (
                    <>
                      שיא <span className="num">{r.pr.topWeight.value}×{r.pr.topWeight.reps}</span> ·{' '}
                    </>
                  )}
                  1RM משוער <span className="num">{fmtNum(r.pr.bestE1rm!.value)}</span> · {fmtDate(r.pr.bestE1rm!.date)}
                </div>
              </div>
              <Sparkline values={r.spark} color={trendUp ? 'var(--success)' : 'var(--danger)'} />
              {trendUp ? <TrendingUp size={16} className="trend-up" /> : <TrendingDown size={16} className="trend-down" />}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Measurements({ client, measurements }: { client: Client; measurements: Measurement[] }) {
  const { toast, confirm } = useUi();
  const [adding, setAdding] = useState(false);
  const [field, setField] = useState<keyof Measurement>('weight');
  const available = MEAS_FIELDS.filter((f) => measurements.some((m) => typeof m[f.key] === 'number'));
  const active = available.find((f) => f.key === field) ?? available[0];
  const points: Point[] = active
    ? measurements.filter((m) => typeof m[active.key] === 'number').map((m) => ({ x: m.date, y: m[active.key] as number, note: m.note }))
    : [];

  return (
    <section className="card card-pad stack">
      <div className="card-head" style={{ marginBottom: 0 }}>
        <div className="card-title">
          <Ruler /> מדדים
        </div>
        <button className="btn btn-sm btn-soft" onClick={() => setAdding(true)}>
          <Plus /> מדידה
        </button>
      </div>
      {measurements.length === 0 ? (
        <div className="empty small">עדיין אין מדידות. כל מדידה נשמרת עם תאריך — ההיסטוריה לא נדרסת.</div>
      ) : (
        <>
          {available.length > 1 && (
            <div className="chips-scroll">
              {available.map((f) => (
                <button key={String(f.key)} aria-pressed={active?.key === f.key} className={`chip chip-sm ${active?.key === f.key ? 'on' : ''}`} onClick={() => setField(f.key)}>
                  {f.label}
                </button>
              ))}
            </div>
          )}
          {active && <LineChart points={points} unit={active.unit} label={active.label} height={170} />}
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>תאריך</th>
                  {available.map((f) => (
                    <th key={String(f.key)}>{f.label}</th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {[...measurements].reverse().map((m) => (
                  <tr key={m.id}>
                    <td className="nowrap">{fmtDate(m.date, true)}</td>
                    {available.map((f) => (
                      // the cell stays right-to-left (aligned under its header); only the number is isolated
                      <td key={String(f.key)}>
                        <span className="num">{typeof m[f.key] === 'number' ? (m[f.key] as number) : '—'}</span>
                      </td>
                    ))}
                    <td>
                      <button
                        className="icon-btn"
                        aria-label="מחיקת מדידה"
                        onClick={async () => {
                          if (await confirm({ title: 'למחוק את המדידה?', danger: true, confirmLabel: 'מחיקה' })) {
                            await softDelete('measurements', m.id);
                            toast('המדידה נמחקה');
                          }
                        }}
                      >
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {adding && <MeasurementSheet client={client} onClose={() => setAdding(false)} />}
    </section>
  );
}

function MeasurementSheet({ client, onClose }: { client: Client; onClose: () => void }) {
  const { toast } = useUi();
  const [date, setDate] = useState(isoDate());
  const [vals, setVals] = useState<Partial<Record<keyof Measurement, number | null>>>({});
  const [note, setNote] = useState('');
  const save = async () => {
    const clean = Object.fromEntries(Object.entries(vals).filter(([, v]) => typeof v === 'number')) as Partial<Measurement>;
    if (!Object.keys(clean).length && !note) return toast('לא הוזנו ערכים', { tone: 'error' });
    await addMeasurement({ clientId: client.id, date, note: note || undefined, ...clean, demo: client.demo });
    toast('המדידה נשמרה');
    onClose();
  };
  return (
    <Sheet
      title="מדידה חדשה"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>ביטול</button>
          <button className="btn btn-primary" onClick={save}>שמירה</button>
        </>
      }
    >
      <div className="stack">
        <Field label="תאריך">
          <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <div className="grid-2">
          {MEAS_FIELDS.map((f) => (
            <Field key={String(f.key)} label={`${f.label} (${f.unit})`} optional>
              <NumInput className="input" decimal value={vals[f.key] ?? null} onChange={(v) => setVals((x) => ({ ...x, [f.key]: v }))} />
            </Field>
          ))}
        </div>
        <Field label="הערה" optional>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Sheet>
  );
}

