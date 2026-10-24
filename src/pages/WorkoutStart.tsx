import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronLeft, Dumbbell, Play, Sparkles, StickyNote, UserPlus, Zap } from 'lucide-react';
import { useActiveSessions, useAllSessions, useClients, useExercises, useNotes, usePrograms } from '../db/hooks';
import { startSession } from '../db/repo';
import { nextWorkout, openNextNotes } from '../domain/agenda';
import { isoDate, matches, parseDate, plural, relativeDay } from '../domain/util';
import { Avatar, Empty, SearchInput, TopBar } from '../components/ui';
import type { PlannedWorkout } from '../domain/types';

/** Sets the workout will hold: a circuit repeats its sets every round, as starting it does (entriesFromWorkout). */
export function plannedSetCount(w: PlannedWorkout): number {
  return w.blocks.reduce((n, b) => n + b.items.reduce((m, i) => m + i.sets.length, 0) * (b.type === 'circuit' && b.rounds && b.rounds > 1 ? b.rounds : 1), 0);
}

export function WorkoutStart() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const clients = useClients();
  const programs = usePrograms();
  const sessions = useAllSessions();
  const active = useActiveSessions();
  const notes = useNotes();
  const { map: exercises } = useExercises();
  const [q, setQ] = useState('');
  const [clientId, setClientId] = useState<string | null>(params.get('client'));
  const today = isoDate();
  const dow = parseDate(today).getDay();

  const sorted = useMemo(
    () =>
      (clients ?? [])
        .filter((c) => matches(q, c.name))
        .sort((a, b) => Number(b.plannedDays.includes(dow)) - Number(a.plannedDays.includes(dow)) || a.name.localeCompare(b.name, 'he')),
    [clients, q, dow],
  );

  const client = clients?.find((c) => c.id === clientId);
  const program = (programs ?? []).find((p) => p.clientId === clientId && p.status === 'active') ?? null;
  const own = (sessions ?? []).filter((s) => s.clientId === clientId);
  const suggested = nextWorkout(program, own);
  const live = (active ?? []).find((s) => s.clientId === clientId);
  const nn = clientId ? openNextNotes(notes ?? [], clientId) : [];

  const go = async (workoutId: string | null) => {
    if (!clientId) return;
    const s = await startSession({ clientId, program: workoutId ? program : null, workoutId, name: workoutId ? undefined : 'אימון חופשי' });
    nav(`/session/${s.id}`, { replace: true });
  };

  if (!client)
    return (
      <>
        <TopBar title="התחלת אימון" sub="בחירת מתאמן/ת" back="/" />
        <div className="page page-narrow stack">
          {(active ?? []).length > 0 && (
            <div className="stack-sm">
              {(active ?? []).map((s) => (
                <Link key={s.id} to={`/session/${s.id}`} className="banner tone-lime" style={{ color: 'inherit' }}>
                  <Zap />
                  <div className="grow strong">
                    אימון פעיל: {clients?.find((c) => c.id === s.clientId)?.name} · {s.workoutName}
                  </div>
                  <ChevronLeft />
                </Link>
              ))}
            </div>
          )}
          <SearchInput value={q} onChange={setQ} placeholder="חיפוש מתאמן/ת…" autoFocus />
          {clients && clients.length === 0 && (
            <div className="card">
              <Empty icon={<Dumbbell />} title="אין עדיין מתאמנים" action={<Link className="btn btn-primary" to="/clients/new"><UserPlus /> הוספת מתאמן/ת</Link>} />
            </div>
          )}
          <div className="card list">
            {sorted.map((c) => {
              const last = (sessions ?? []).find((s) => s.clientId === c.id && s.status === 'completed');
              const isToday = c.plannedDays.includes(dow);
              return (
                <button key={c.id} className="list-item" onClick={() => setClientId(c.id)}>
                  <Avatar name={c.name} color={c.color} size="sm" />
                  <div className="grow">
                    <div className="title">{c.name}</div>
                    <div className="sub">{last ? `אחרון ${relativeDay(last.date)}` : 'אימון ראשון'}</div>
                  </div>
                  {isToday && <span className="badge tone-accent">היום</span>}
                  <ChevronLeft className="chev" />
                </button>
              );
            })}
          </div>
        </div>
      </>
    );

  return (
    <>
      <TopBar title={client.name} sub="בחירת אימון" back={params.get('client') ? true : undefined} actions={<button className="btn btn-ghost btn-sm" onClick={() => setClientId(null)}>החלפה</button>} />
      <div className="page page-narrow stack-lg">
        {live && (
          <button className="btn btn-lime btn-lg btn-block" onClick={() => nav(`/session/${live.id}`)}>
            <Zap /> המשך האימון הפעיל ({live.workoutName})
          </button>
        )}
        {nn.length > 0 && (
          <div className="card card-pad next-card">
            <div className="card-title" style={{ marginBottom: 6 }}>
              <StickyNote /> דגשים לאימון הזה
            </div>
            {nn.map((n) => (
              <div key={n.id} className="small">• {n.text}</div>
            ))}
          </div>
        )}
        {program ? (
          <section className="section">
            <div className="section-head">
              <div className="section-title">{program.name}</div>
              <Link to={`/programs/${program.id}`} className="link-btn">
                עריכה <ChevronLeft />
              </Link>
            </div>
            {program.workouts.map((w) => {
              const items = w.blocks.flatMap((b) => b.items);
              const isNext = suggested?.id === w.id;
              return (
                <button key={w.id} className={`card card-pad workout-pick ${isNext ? 'suggested' : ''}`} onClick={() => go(w.id)} disabled={!!live}>
                  <div className="row between">
                    <div className="row" style={{ gap: 12 }}>
                      <span className="w-letter">{w.name}</span>
                      <div style={{ textAlign: 'start' }}>
                        <div className="strong">
                          {w.focus || `אימון ${w.name}`} {isNext && <span className="badge tone-accent">מומלץ עכשיו</span>}
                        </div>
                        <div className="small muted">{plural(items.length, "תרגיל אחד", "תרגילים")} · {plural(plannedSetCount(w), "סט אחד", "סטים")}</div>
                      </div>
                    </div>
                    <Play size={20} />
                  </div>
                  <div className="small muted ellipsis" style={{ marginTop: 8, textAlign: 'start' }}>
                    {items.map((i) => exercises.get(i.exerciseId)?.nameHe).filter(Boolean).join(' · ')}
                  </div>
                </button>
              );
            })}
          </section>
        ) : (
          <div className="card">
            <Empty title="אין תוכנית פעילה" action={<Link to={`/clients/${client.id}?tab=program`} className="btn btn-primary">בניית תוכנית</Link>}>
              אפשר להתחיל אימון חופשי ולהוסיף תרגילים תוך כדי.
            </Empty>
          </div>
        )}
        <button className="btn btn-block" onClick={() => go(null)} disabled={!!live}>
          <Sparkles /> אימון חופשי (בלי תוכנית)
        </button>
      </div>
    </>
  );
}
