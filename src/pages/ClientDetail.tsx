import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  CalendarDays,
  Check,
  ChevronLeft,
  ClipboardList,
  Copy,
  History,
  Mail,
  Pencil,
  Phone,
  Pin,
  Play,
  Plus,
  ShieldAlert,
  StickyNote,
  Trash2,
  Trophy,
  Zap,
} from 'lucide-react';
import {
  useActiveProgram,
  useClient,
  useClientSessions,
  useExercises,
  useMeasurements,
  useNotes,
  usePrograms,
  useRecommendations,
  useSettings,
} from '../db/hooks';
import { db } from '../db/db';
import { addNote, alive, blankProgram, duplicateProgram, resolveNote, saveProgram, softDelete, startSession, updateNote } from '../db/repo';
import type { Client, ClientNote, NoteKind, Program, Session } from '../domain/types';
import { EXPERIENCE, GOALS, PROGRAM_GOALS, PROGRAM_STATUS, TRAINING_TYPES, WEEKDAYS_SHORT } from '../domain/labels';
import { nextWorkout } from '../domain/agenda';
import { entryStats } from '../domain/progress';
import { latestWeighIn } from './ClientEdit';
import { ageFrom, fmtDate, fmtDateTime, fmtMinutes, fmtNum, isoDate, plural, relativeDay, relativeTime } from '../domain/util';
import { Avatar, Empty, Seg, SectionHead, Sheet, Tabs, TopBar, useUi } from '../components/ui';
import { RecCard } from '../components/RecCard';
import { VolumePanel } from '../components/VolumePanel';
import { ProgressPanel } from '../components/ProgressPanel';
import { TargetsCard } from '../components/TargetsCard';

type Tab = 'overview' | 'program' | 'history' | 'progress' | 'notes';

export function ClientDetail() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'overview';
  const client = useClient(id);
  const sessions = useClientSessions(id);
  const program = useActiveProgram(id);
  const settings = useSettings();
  const { map: exercises } = useExercises();
  const nav = useNavigate();

  if (client === undefined) return null;
  if (client === null)
    return (
      <>
        <TopBar title="לא נמצא" back="/clients" />
        <div className="page">
          <Empty title="המתאמן/ת לא נמצא/ה">ייתכן שנמחק/ה. אפשר לשחזר ממסך הגיבוי.</Empty>
        </div>
      </>
    );

  const live = (sessions ?? []).find((s) => s.status === 'active');
  const start = async () => {
    if (live) return nav(`/session/${live.id}`);
    const w = nextWorkout(program, sessions ?? []);
    const s = await startSession({ clientId: client.id, program, workoutId: w?.id });
    nav(`/session/${s.id}`);
  };

  return (
    <>
      <TopBar
        title={client.name}
        sub={client.archived ? 'בארכיון' : program ? program.name : undefined}
        back="/clients"
        actions={
          <Link to={`/clients/${client.id}/edit`} className="icon-btn" aria-label="עריכה">
            <Pencil />
          </Link>
        }
      />
      <div className="page stack-lg">
        <Tabs
          value={tab}
          onChange={(t) => setParams({ tab: t }, { replace: true })}
          tabs={[
            { value: 'overview', label: 'סקירה' },
            { value: 'program', label: 'תוכנית' },
            { value: 'history', label: 'היסטוריה' },
            { value: 'progress', label: 'התקדמות' },
            { value: 'notes', label: 'הערות' },
          ]}
        />
        {tab === 'overview' && <Overview client={client} sessions={sessions ?? []} program={program ?? null} live={live} onStart={start} />}
        {tab === 'program' && <ProgramTab client={client} />}
        {tab === 'history' && <HistoryTab sessions={sessions ?? []} />}
        {tab === 'progress' && <ProgressPanel client={client} sessions={sessions ?? []} program={program} exercises={exercises} settings={settings} />}
        {tab === 'notes' && <NotesTab client={client} />}
      </div>
    </>
  );
}

function Overview({ client, sessions, program, live, onStart }: { client: Client; sessions: Session[]; program: Program | null; live?: Session; onStart: () => void }) {
  const settings = useSettings();
  const { map: exercises } = useExercises();
  const notes = useNotes(client.id) ?? [];
  const recs = (useRecommendations(client.id) ?? []).filter((r) => r.status === 'pending');
  const measurements = useMeasurements(client.id) ?? [];
  const age = ageFrom(client.birthDate);
  // same-date weigh-ins: the one entered last wins (a correction), matching the edit form
  const weight = latestWeighIn(measurements);
  const completed = sessions.filter((s) => s.status === 'completed');
  const last = completed[0];
  const nextW = nextWorkout(program, sessions);
  const nextNotes = notes.filter((n) => n.kind === 'next' && !n.done);
  const tasks = notes.filter((n) => n.kind === 'task' && !n.done);
  const pinned = notes.filter((n) => n.pinned && !n.done && n.kind !== 'next' && n.kind !== 'task');
  const background = [
    client.injuries && { label: 'פציעות', text: client.injuries },
    client.limitations && { label: 'מגבלות', text: client.limitations },
    client.uncomfortableExercises && { label: 'לא נוח', text: client.uncomfortableExercises },
  ].filter(Boolean) as { label: string; text: string }[];
  // session dates are local calendar dates, so compare with the local month (not the UTC one)
  const month = isoDate().slice(0, 7);
  const thisMonth = completed.filter((s) => s.date.slice(0, 7) === month).length;

  return (
    <div className="split">
      <div className="stack-lg">
        <div className="card card-lg stack">
          <div className="row">
            <Avatar name={client.name} color={client.color} size="lg" />
            <div className="grow">
              <h2>{client.name}</h2>
              <div className="small muted">
                {[age && `גיל ${age}`, client.height && `${client.height} ס״מ`, weight && `${weight.weight} ק״ג (${relativeDay(weight.date)})`]
                  .filter(Boolean)
                  .join(' · ') || 'אין עדיין פרטים גופניים'}
              </div>
              <div className="chips" style={{ gap: 6, marginTop: 8 }}>
                {client.goals.map((g) => (
                  <span key={g} className="badge tone-accent">
                    {g === 'custom' ? client.customGoal || GOALS.custom : GOALS[g]}
                  </span>
                ))}
                {client.experience && <span className="badge">{EXPERIENCE[client.experience]}</span>}
              </div>
            </div>
          </div>
          <div className="row row-wrap small muted" style={{ gap: 14 }}>
            {client.plannedDays.length > 0 && (
              <span className="row" style={{ gap: 4 }}>
                <CalendarDays size={15} /> {client.plannedDays.map((d) => WEEKDAYS_SHORT[d]).join(' ')}
              </span>
            )}
            {client.trainingType && <span>{TRAINING_TYPES[client.trainingType]}</span>}
            {client.weeklyFrequency ? <span>{client.weeklyFrequency}× בשבוע</span> : null}
            {client.phone && (
              <a href={`tel:${client.phone}`} className="row" style={{ gap: 4 }}>
                <Phone size={15} /> <span className="ltr">{client.phone}</span>
              </a>
            )}
            {client.email && (
              <a href={`mailto:${client.email}`} className="row" style={{ gap: 4 }}>
                <Mail size={15} /> מייל
              </a>
            )}
          </div>
          <button className={`btn btn-lg btn-block ${live ? 'btn-lime' : 'btn-primary'}`} onClick={onStart}>
            {live ? <Zap /> : <Play />}
            {live ? 'המשך האימון הפעיל' : nextW ? `התחלת אימון ${nextW.name}` : 'התחלת אימון'}
          </button>
        </div>

        {nextNotes.length > 0 && (
          <div className="card card-pad next-card">
            <div className="card-title" style={{ marginBottom: 8 }}>
              <StickyNote /> דגשים לאימון הבא
            </div>
            <div className="stack-sm">
              {nextNotes.map((n) => (
                <div key={n.id} className="row row-top">
                  <button className="check-btn" aria-label="סימון כטופל" onClick={() => resolveNote(n.id)}>
                    <Check size={14} />
                  </button>
                  <div className="grow small">{n.text}</div>
                  <span className="tiny faint">{relativeTime(n.createdAt)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {background.length > 0 && (
          <div className="banner tone-danger">
            <ShieldAlert />
            <div className="grow small stack-sm">
              {background.map((b) => (
                <div key={b.label}>
                  <b>{b.label}:</b> {b.text}
                </div>
              ))}
            </div>
          </div>
        )}

        {recs.length > 0 && (
          <section className="section">
            <SectionHead title="המלצות ממתינות" count={recs.length} />
            {recs.slice(0, 4).map((r) => (
              <RecCard key={r.id} rec={r} exercises={exercises} compact />
            ))}
          </section>
        )}

        <section className="section">
          <SectionHead
            title="נפח השבוע"
            action={
              <Link to={`/clients/${client.id}?tab=progress`} className="link-btn">
                פירוט <ChevronLeft />
              </Link>
            }
          />
          <VolumePanel client={client} sessions={sessions} program={program} exercises={exercises} settings={settings} compact />
        </section>
      </div>

      <div className="stack-lg">
        <div className="kpis">
          <div className="kpi">
            <div className="k-label">אימונים החודש</div>
            <div className="k-value">
              <span className="num">{thisMonth}</span>
            </div>
          </div>
          <div className="kpi">
            <div className="k-label">סה״כ אימונים</div>
            <div className="k-value">
              <span className="num">{completed.length}</span>
            </div>
          </div>
          <div className="kpi">
            <div className="k-label">אימון אחרון</div>
            <div className="k-value" style={{ fontSize: '1.05rem' }}>{last ? relativeDay(last.date) : '—'}</div>
          </div>
        </div>

        {last && (
          <Link to={`/session/${last.id}/view`} className="card card-pad" style={{ color: 'inherit' }}>
            <div className="card-head" style={{ marginBottom: 6 }}>
              <div className="card-title">
                <History /> האימון האחרון
              </div>
              <ChevronLeft size={18} className="faint" />
            </div>
            <div className="strong">
              {last.workoutName} · {fmtDate(last.date)}
            </div>
            <div className="small muted">
              {plural(last.entries.filter((e) => e.sets.some((s) => s.done)).length, 'תרגיל אחד', 'תרגילים')} ·{' '}
              {plural(last.entries.reduce((n, e) => n + e.sets.filter((s) => s.done && s.type !== 'warmup').length, 0), 'סט אחד', 'סטים')}
              {last.endedAt ? ` · ${fmtMinutes(last.endedAt - last.startedAt)}` : ''}
              {last.wrapUp?.effort ? ` · מאמץ ${last.wrapUp.effort}/10` : ''}
            </div>
            {last.entries.some((e) => e.pain?.reported) && (
              <div className="badge tone-danger" style={{ marginTop: 8 }}>
                <AlertTriangle /> דווח כאב
              </div>
            )}
          </Link>
        )}

        <TargetsCard client={client} sessions={sessions} exercises={exercises} />

        {tasks.length > 0 && (
          <div className="card card-pad">
            <div className="card-title" style={{ marginBottom: 8 }}>
              <ClipboardList /> משימות מעקב
            </div>
            <div className="stack-sm">
              {tasks.map((n) => (
                <div key={n.id} className="row row-top">
                  <button className="check-btn" aria-label="בוצע" onClick={() => resolveNote(n.id)}>
                    <Check size={14} />
                  </button>
                  <div className="grow small">{n.text}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {pinned.map((n) => (
          <div key={n.id} className="pill-note small">
            <Pin size={14} style={{ verticalAlign: -2 }} /> {n.text}
          </div>
        ))}

        {client.technicalNotes && (
          <div className="card card-pad small">
            <div className="strong" style={{ marginBottom: 4 }}>הערות טכניות</div>
            <div className="pre muted">{client.technicalNotes}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function ProgramTab({ client }: { client: Client }) {
  const programs = usePrograms(client.id);
  const templates = usePrograms(null);
  const { map: exercises } = useExercises();
  const nav = useNavigate();
  const { toast } = useUi();
  const [picking, setPicking] = useState(false);
  const busy = useRef(false);
  const active = (programs ?? []).find((p) => p.status === 'active');
  const others = (programs ?? []).filter((p) => p !== active);

  const create = async () => {
    if (busy.current) return; // double tap: one program, never two active ones
    busy.current = true;
    try {
      const p = blankProgram(client.id, `תוכנית ${client.name.split(' ')[0]}`);
      // decided from the stored rows, not this render (the list may not have loaded yet)
      const hasActive = (await db.programs.where('clientId').equals(client.id).toArray()).some((x) => alive(x) && x.status === 'active');
      p.status = hasActive ? 'draft' : 'active';
      p.demo = client.demo;
      const { program } = await saveProgram(p, { reason: 'יצירת תוכנית' });
      nav(`/programs/${program.id}`);
    } catch (e) {
      busy.current = false; // stays set after success: the screen is being left
      throw e;
    }
  };
  const fromTemplate = async (t: Program) => {
    const p = await duplicateProgram(t, client.id, t.name);
    setPicking(false);
    toast('נוצרה תוכנית מהתבנית (טיוטה)');
    nav(`/programs/${p.id}`);
  };

  return (
    <div className="stack-lg">
      <div className="row row-wrap">
        <button className="btn btn-primary" onClick={create}>
          <Plus /> תוכנית חדשה
        </button>
        <button className="btn" onClick={() => setPicking(true)} disabled={!(templates ?? []).length}>
          <Copy /> מתבנית
        </button>
      </div>
      {!programs?.length && (
        <div className="card">
          <Empty icon={<ClipboardList />} title="עדיין אין תוכנית">
            תוכנית כוללת אימונים לפי יום (A/B/C…), סופר-סטים, טווחי חזרות, RIR ומנוחות. כל שינוי נשמר כגרסה.
          </Empty>
        </div>
      )}
      {active && <ProgramCard program={active} exercises={exercises} highlight />}
      {others.length > 0 && (
        <section className="section">
          <SectionHead title="תוכניות נוספות" count={others.length} />
          {others.map((p) => (
            <ProgramCard key={p.id} program={p} exercises={exercises} />
          ))}
        </section>
      )}
      {picking && (
        <Sheet title="בחירת תבנית" onClose={() => setPicking(false)}>
          <div className="list card">
            {(templates ?? []).map((t) => (
              <button key={t.id} className="list-item" onClick={() => fromTemplate(t)}>
                <div className="grow">
                  <div className="title">{t.name}</div>
                  <div className="sub">
                    {PROGRAM_GOALS[t.goal]} · {plural(t.workouts.length, 'אימון אחד', 'אימונים')}
                  </div>
                </div>
                <ChevronLeft className="chev" />
              </button>
            ))}
          </div>
        </Sheet>
      )}
    </div>
  );
}

export function ProgramCard({ program, exercises, highlight }: { program: Program; exercises: Map<string, { nameHe: string }>; highlight?: boolean }) {
  return (
    <Link to={`/programs/${program.id}`} className={`card card-pad program-card ${highlight ? 'highlight' : ''}`} style={{ color: 'inherit' }}>
      <div className="row between">
        <div className="grow">
          <div className="row row-wrap" style={{ gap: 6 }}>
            <span className={`badge ${program.status === 'active' ? 'tone-success' : ''}`}>{PROGRAM_STATUS[program.status]}</span>
            <span className="badge">{PROGRAM_GOALS[program.goal]}</span>
            <span className="tiny muted">גרסה {program.version}</span>
          </div>
          <h3 style={{ marginTop: 6 }}>{program.name}</h3>
        </div>
        <ChevronLeft size={18} className="faint" />
      </div>
      <div className="stack-sm" style={{ marginTop: 10 }}>
        {program.workouts.map((w) => (
          <div key={w.id} className="workout-line">
            <span className="w-name">{w.name}</span>
            <span className="small muted ellipsis grow">
              {w.blocks
                .flatMap((b) => b.items)
                .map((i) => exercises.get(i.exerciseId)?.nameHe)
                .filter(Boolean)
                .join(' · ') || 'ריק'}
            </span>
            {w.days.length > 0 && <span className="tiny muted">{w.days.map((d) => WEEKDAYS_SHORT[d]).join(' ')}</span>}
          </div>
        ))}
      </div>
    </Link>
  );
}

function HistoryTab({ sessions }: { sessions: Session[] }) {
  const completed = sessions.filter((s) => s.status !== 'active');
  const groups = useMemo(() => {
    const m = new Map<string, Session[]>();
    for (const s of completed) {
      const k = s.date.slice(0, 7);
      m.set(k, [...(m.get(k) ?? []), s]);
    }
    return [...m.entries()];
  }, [completed]);
  if (!completed.length)
    return (
      <div className="card">
        <Empty icon={<History />} title="עדיין אין אימונים">כל אימון וכל סט נשמרים כאן לאורך זמן.</Empty>
      </div>
    );
  const monthFmt = new Intl.DateTimeFormat('he-IL', { month: 'long', year: 'numeric' });
  return (
    <div className="stack-lg">
      {groups.map(([month, list]) => (
        <section key={month} className="section">
          <SectionHead title={monthFmt.format(new Date(`${month}-01T12:00:00`))} count={list.length} />
          <div className="card list">
            {list.map((s) => {
              const sets = s.entries.reduce((n, e) => n + e.sets.filter((x) => x.done && x.type !== 'warmup').length, 0);
              const vol = s.entries.reduce((n, e) => n + entryStats(e).volume, 0);
              const pain = s.entries.some((e) => e.pain?.reported);
              return (
                <Link key={s.id} to={`/session/${s.id}/view`} className="list-item">
                  <div className="date-tile">
                    <span className="d num">{Number(s.date.slice(8, 10))}</span>
                    <span className="tiny">{new Intl.DateTimeFormat('he-IL', { weekday: 'short' }).format(new Date(`${s.date}T12:00:00`))}</span>
                  </div>
                  <div className="grow">
                    <div className="title small">{s.workoutName}</div>
                    <div className="sub">
                      {plural(sets, 'סט אחד', 'סטים')} · {fmtNum(vol / 1000)} טון{s.endedAt ? ` · ${fmtMinutes(s.endedAt - s.startedAt)}` : ''}
                    </div>
                  </div>
                  {pain && <span className="badge tone-danger"><AlertTriangle /> כאב</span>}
                  {s.wrapUp?.effort ? <span className="badge num">RPE {s.wrapUp.effort}</span> : null}
                  <ChevronLeft className="chev" />
                </Link>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

const NOTE_KINDS: { value: NoteKind; label: string }[] = [
  { value: 'general', label: 'כללית' },
  { value: 'next', label: 'לאימון הבא' },
  { value: 'task', label: 'משימת מעקב' },
  { value: 'injury', label: 'פציעה / כאב' },
];

function NotesTab({ client }: { client: Client }) {
  const notes = useNotes(client.id) ?? [];
  const { toast } = useUi();
  const [kind, setKind] = useState<NoteKind>('general');
  const [text, setText] = useState('');
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const shown = notes.filter((n) => filter === 'all' || !n.done).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.createdAt - a.createdAt);

  const add = async () => {
    if (!text.trim()) return;
    await addNote(client.id, kind, text, { demo: client.demo });
    setText('');
    toast('ההערה נשמרה');
  };

  return (
    <div className="split">
      <div className="stack">
        <div className="card card-pad stack">
          <Seg value={kind} onChange={setKind} options={NOTE_KINDS} />
          <textarea
            className="textarea"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={kind === 'next' ? 'מה חשוב לזכור באימון הבא?' : kind === 'task' ? 'למשל: לבדוק טכניקת סקוואט בווידאו' : 'הערה…'}
          />
          <button className="btn btn-primary" onClick={add} disabled={!text.trim()}>
            <Plus /> הוספה
          </button>
        </div>
        <div className="row between">
          <Seg
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'open', label: 'פתוחות' },
              { value: 'all', label: 'הכול' },
            ]}
          />
          <span className="small muted">{plural(shown.length, 'הערה אחת', 'הערות')}</span>
        </div>
        {shown.length === 0 && <div className="empty small">אין הערות</div>}
        {shown.map((n) => (
          <NoteRow key={n.id} note={n} />
        ))}
      </div>
      <div className="stack">
        <div className="card card-pad stack-sm small">
          <div className="strong">רקע מקצועי</div>
          <dl className="kv">
            <dt>ניסיון</dt>
            <dd>{client.experience ? EXPERIENCE[client.experience] : '—'}</dd>
            <dt>רמת כושר</dt>
            <dd>{client.fitnessLevel ? `${client.fitnessLevel}/5` : '—'}</dd>
            <dt>מגבלות</dt>
            <dd className="pre">{client.limitations || '—'}</dd>
            <dt>פציעות</dt>
            <dd className="pre">{client.injuries || '—'}</dd>
            <dt>לא נוח</dt>
            <dd>{client.uncomfortableExercises || '—'}</dd>
            <dt>טכני</dt>
            <dd className="pre">{client.technicalNotes || '—'}</dd>
          </dl>
          <Link to={`/clients/${client.id}/edit`} className="link-btn">
            עריכה <Pencil />
          </Link>
        </div>
      </div>
    </div>
  );
}

function NoteRow({ note }: { note: ClientNote }) {
  const { confirm, toast } = useUi();
  const label = NOTE_KINDS.find((k) => k.value === note.kind)?.label;
  const tone = note.kind === 'next' ? 'warn' : note.kind === 'task' ? 'info' : note.kind === 'injury' ? 'danger' : '';
  return (
    <div className={`card card-pad note-row ${note.done ? 'done' : ''}`}>
      <div className="row row-top">
        {(note.kind === 'next' || note.kind === 'task') && (
          <button className={`check-btn ${note.done ? 'on' : ''}`} onClick={() => resolveNote(note.id, !note.done)} aria-label="סימון">
            <Check size={14} />
          </button>
        )}
        <div className="grow">
          <div className="row row-wrap" style={{ gap: 6 }}>
            <span className={`badge ${tone ? `tone-${tone}` : ''}`}>{label}</span>
            {note.pinned && <span className="badge tone-accent"><Pin /> נעוצה</span>}
            {note.sessionId && <span className="badge"><Trophy /> מסיכום אימון</span>}
            <span className="tiny faint">{fmtDateTime(note.createdAt)}</span>
          </div>
          <div className="pre" style={{ marginTop: 6 }}>{note.text}</div>
        </div>
        <button className="icon-btn" aria-label={note.pinned ? "ביטול נעיצה" : "נעיצה"} aria-pressed={!!note.pinned} onClick={() => updateNote(note.id, { pinned: !note.pinned })}>
          <Pin size={18} style={{ opacity: note.pinned ? 1 : 0.4 }} />
        </button>
        <button
          className="icon-btn"
          aria-label="מחיקה"
          onClick={async () => {
            if (await confirm({ title: 'למחוק את ההערה?', confirmLabel: 'מחיקה', danger: true })) {
              await softDelete('notes', note.id);
              toast('ההערה נמחקה');
            }
          }}
        >
          <Trash2 size={18} />
        </button>
      </div>
    </div>
  );
}
