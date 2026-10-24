/** Home-screen logic: what is planned today and what needs attention (spec §3). */
import type { Client, ClientNote, Exercise, ID, Measurement, PlannedWorkout, Program, Recommendation, Session } from './types';
import { daysBetween, isoDate, parseDate } from './util';
import { sameSeries } from './engine';

export function nextWorkout(program: Program | null | undefined, sessions: Session[], date = isoDate()): PlannedWorkout | null {
  if (!program || !program.workouts.length) return null;
  const dow = parseDate(date).getDay();
  const byDay = program.workouts.find((w) => w.days.includes(dow));
  if (byDay) return byDay;
  const last = sessions
    .filter((s) => s.programId === program.id && s.status === 'completed' && !s.deletedAt)
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  if (!last) return program.workouts[0];
  const idx = program.workouts.findIndex((w) => w.id === last.plannedWorkoutId);
  return program.workouts[(idx + 1) % program.workouts.length] ?? program.workouts[0];
}

export interface AgendaItem {
  client: Client;
  program: Program | null;
  workout: PlannedWorkout | null;
  session: Session | null; // today's session (active or completed)
  planned: boolean; // today is one of the client's planned days
}

export function todayAgenda(clients: Client[], programs: Program[], sessions: Session[], date = isoDate()): AgendaItem[] {
  const dow = parseDate(date).getDay();
  const out: AgendaItem[] = [];
  for (const client of clients) {
    if (client.archived) continue;
    const own = sessions.filter((s) => s.clientId === client.id);
    const today = own.filter((s) => s.date === date && s.status !== 'abandoned').sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
    const planned = client.plannedDays?.includes(dow) ?? false;
    if (!planned && !today) continue;
    const program = programs.find((p) => p.clientId === client.id && p.status === 'active') ?? null;
    const workout = today?.plannedSnapshot ?? nextWorkout(program, own, date);
    out.push({ client, program, workout, session: today, planned });
  }
  const rank = (a: AgendaItem) => (a.session?.status === 'active' ? 0 : a.session ? 2 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || a.client.name.localeCompare(b.client.name, 'he'));
}

export interface Alert {
  id: string;
  tone: 'danger' | 'warn' | 'info';
  clientId?: ID;
  title: string;
  detail: string;
  link: string;
}

export function computeAlerts(input: {
  clients: Client[];
  sessions: Session[];
  programs: Program[];
  recs: Recommendation[];
  notes: ClientNote[];
  measurements?: Measurement[];
  exercises: Map<ID, Exercise>;
  today?: string;
}): Alert[] {
  const today = input.today ?? isoDate();
  const out: Alert[] = [];
  for (const c of input.clients) {
    if (c.archived) continue;
    const own = input.sessions.filter((s) => s.clientId === c.id && s.status === 'completed').sort((a, b) => b.startedAt - a.startedAt);
    const last = own[0];
    if (last && daysBetween(last.date, today) <= 21) {
      for (const e of last.entries.filter((x) => x.pain?.reported)) {
        out.push({
          id: `pain-${last.id}-${e.id}`,
          tone: 'danger',
          clientId: c.id,
          title: `${c.name}: דווח כאב`,
          detail: `${input.exercises.get(e.exerciseId)?.nameHe ?? 'תרגיל'}${e.pain.location ? ` · ${e.pain.location}` : ''}${e.pain.severity ? ` · ${e.pain.severity}/10` : ''} — ${last.date === today ? 'היום' : `באימון האחרון`}`,
          link: `/session/${last.id}/view`,
        });
      }
    }
    const decline = input.recs.find((r) => r.clientId === c.id && r.type === 'recoveryCheck' && r.status === 'pending' && r.severity === 'warn');
    if (decline)
      out.push({ id: `decline-${decline.id}`, tone: 'warn', clientId: c.id, title: `${c.name}: ירידה עקבית בביצועים`, detail: decline.detected, link: '/insights' });

    // 'other' gear (ab wheel, stability ball) and timed sets (holds, carries, cardio) are often
    // unloaded, so for them a missing weight counts only once the plan or an earlier set of that
    // exercise had one. "Earlier" is per session (that workout or one before it): loading the exercise
    // later doesn't make past unloaded sets wrong.
    const loadedUpTo = (s: Session) =>
      new Set(
        own
          .filter((o) => o === s || o.startedAt < s.startedAt)
          .flatMap((o) => o.entries.filter((e) => e.sets.some((x) => x.done && x.weight)).map((e) => e.exerciseId)),
      );
    const withMissing = own
      .filter((x) => daysBetween(x.date, today) <= 14)
      .map((s) => {
        const loadedBefore = loadedUpTo(s);
        return {
          s,
          missing: s.entries.reduce((n, e) => {
            const ex = input.exercises.get(e.exerciseId);
            const loaded = !!ex && !['bodyweight', 'band', 'trx'].includes(ex.equipment);
            const unloadedOther = ex?.equipment === 'other' && !loadedBefore.has(e.exerciseId);
            return (
              n +
              e.sets.filter((x) => {
                const needsWeight = loaded && (x.duration || unloadedOther ? !!x.planned?.weight || loadedBefore.has(e.exerciseId) : true);
                return x.done && ((x.reps == null && !x.duration) || (needsWeight && x.weight == null));
              }).length
            );
          }, 0),
        };
      })
      .filter((x) => x.missing > 0);
    if (withMissing.length) {
      const total = withMissing.reduce((n, x) => n + x.missing, 0);
      out.push({
        id: `missing-${c.id}`,
        tone: 'info',
        clientId: c.id,
        title: `${c.name}: נתונים חסרים`,
        detail: `${total === 1 ? "סט אחד" : `${total} סטים`} בלי משקל או חזרות${withMissing.length > 1 ? ` ב-${withMissing.length} אימונים` : ` באימון ${withMissing[0].s.workoutName}`}`,
        link: `/session/${withMissing[0].s.id}/view`,
      });
    }

    const hasProgram = input.programs.some((p) => p.clientId === c.id && p.status === 'active');
    if (!hasProgram) out.push({ id: `noprog-${c.id}`, tone: 'info', clientId: c.id, title: `${c.name}: אין תוכנית פעילה`, detail: 'כדאי לבנות תוכנית כדי לתכנן ולעקוב', link: `/clients/${c.id}?tab=program` });

    if (last && (c.plannedDays?.length || c.weeklyFrequency)) {
      const gap = daysBetween(last.date, today);
      if (gap >= 14) out.push({ id: `gap-${c.id}`, tone: 'info', clientId: c.id, title: `${c.name}: ${gap} ימים ללא אימון`, detail: 'האימון האחרון תועד לפני יותר משבועיים', link: `/clients/${c.id}` });
    }

    const ms = (input.measurements ?? []).filter((m) => m.clientId === c.id).sort((a, b) => b.date.localeCompare(a.date));
    if (ms[0] && daysBetween(ms[0].date, today) > 60)
      out.push({ id: `meas-${c.id}`, tone: 'info', clientId: c.id, title: `${c.name}: מדדים לא עודכנו`, detail: `המדידה האחרונה לפני ${daysBetween(ms[0].date, today)} ימים`, link: `/clients/${c.id}?tab=progress` });
  }
  const order = { danger: 0, warn: 1, info: 2 };
  return out.sort((a, b) => order[a.tone] - order[b.tone]);
}

export function openNextNotes(notes: ClientNote[], clientId: ID) {
  return notes.filter((n) => n.clientId === clientId && n.kind === 'next' && !n.done);
}

/**
 * A "for the next session" note shows in a workout: a general note always; a note about one exercise only
 * where that exercise is in the workout — in the same program slot when the note names one (a heavy and a
 * light day of the same exercise are different series).
 */
export function noteShowsIn(n: ClientNote, s: Session): boolean {
  if (n.deletedAt || n.kind !== 'next' || n.done || n.createdAt > s.startedAt) return false;
  if (!n.exerciseId) return true;
  return s.entries.some((e) => noteMatchesEntry(n, e, s));
}

export function noteMatchesEntry(n: ClientNote, e: Session['entries'][number], s: Session): boolean {
  return (
    e.exerciseId === n.exerciseId &&
    sameSeries({ slot: n.plannedExerciseId, programId: n.programId }, { slot: e.plannedExerciseId, programId: s.programId })
  );
}

export function openTasks(notes: ClientNote[], clientId?: ID) {
  return notes.filter((n) => (!clientId || n.clientId === clientId) && n.kind === 'task' && !n.done);
}
