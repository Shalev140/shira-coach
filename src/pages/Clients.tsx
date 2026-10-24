import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronLeft, Play, UserPlus, Users } from 'lucide-react';
import { useAllSessions, useClients, useNotes, usePrograms, useRecommendations } from '../db/hooks';
import { startSession } from '../db/repo';
import { GOALS } from '../domain/labels';
import { nextWorkout, openNextNotes } from '../domain/agenda';
import { ageFrom, matches, plural, relativeDay } from '../domain/util';
import { Avatar, Empty, SearchInput, Seg, TopBar } from '../components/ui';

export function Clients() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [view, setView] = useState<'active' | 'archived'>('active');
  const clients = useClients(true);
  const sessions = useAllSessions();
  const programs = usePrograms();
  const recs = useRecommendations();
  const notes = useNotes();

  const list = useMemo(
    () => (clients ?? []).filter((c) => (view === 'archived' ? c.archived : !c.archived)).filter((c) => matches(q, c.name, c.phone, c.email)),
    [clients, q, view],
  );
  const archivedCount = (clients ?? []).filter((c) => c.archived).length;

  const start = async (clientId: string) => {
    const program = (programs ?? []).find((p) => p.clientId === clientId && p.status === 'active') ?? null;
    const w = nextWorkout(program, (sessions ?? []).filter((s) => s.clientId === clientId));
    const s = await startSession({ clientId, program, workoutId: w?.id });
    nav(`/session/${s.id}`);
  };

  return (
    <>
      <TopBar
        title="מתאמנים"
        sub={clients ? plural(clients.filter((c) => !c.archived).length, 'מתאמן/ת פעיל/ה אחד/ת', 'פעילים') : undefined}
        actions={
          <Link to="/clients/new" className="btn btn-primary btn-sm">
            <UserPlus /> חדש
          </Link>
        }
      />
      <div className="page stack">
        <SearchInput value={q} onChange={setQ} placeholder="חיפוש לפי שם, טלפון או מייל…" />
        {archivedCount > 0 && (
          <Seg
            value={view}
            onChange={setView}
            options={[
              { value: 'active', label: 'פעילים' },
              { value: 'archived', label: `בארכיון (${archivedCount})` },
            ]}
          />
        )}
        {clients && list.length === 0 && (
          <div className="card">
            <Empty
              icon={<Users />}
              title={q ? 'לא נמצאו מתאמנים' : 'עדיין אין מתאמנים'}
              action={
                !q && (
                  <Link to="/clients/new" className="btn btn-primary">
                    <UserPlus /> הוספת מתאמן/ת
                  </Link>
                )
              }
            >
              {!q && 'כרטיס מתאמן/ת מרכז פרטים, מטרות, תוכנית, היסטוריה ומדדים.'}
            </Empty>
          </div>
        )}
        <div className="grid-auto">
          {list.map((c) => {
            const own = (sessions ?? []).filter((s) => s.clientId === c.id);
            const last = own.find((s) => s.status === 'completed');
            const program = (programs ?? []).find((p) => p.clientId === c.id && p.status === 'active');
            const pend = (recs ?? []).filter((r) => r.clientId === c.id && r.status === 'pending').length;
            const nn = openNextNotes(notes ?? [], c.id).length;
            const age = ageFrom(c.birthDate);
            const live = own.find((s) => s.status === 'active');
            return (
              <div key={c.id} className="card client-card">
                <Link to={`/clients/${c.id}`} className="row" style={{ color: 'inherit' }}>
                  <Avatar name={c.name} color={c.color} />
                  <div className="grow">
                    <div className="strong ellipsis">{c.name}</div>
                    <div className="small muted ellipsis">
                      {[age ? `גיל ${age}` : null, program ? program.name : 'ללא תוכנית'].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <ChevronLeft className="chev" style={{ color: 'var(--faint)' }} />
                </Link>
                <div className="chips" style={{ gap: 6 }}>
                  {c.goals.slice(0, 2).map((g) => (
                    <span key={g} className="badge">
                      {g === 'custom' ? c.customGoal || GOALS.custom : GOALS[g]}
                    </span>
                  ))}
                  {pend > 0 && <span className="badge tone-accent">{plural(pend, 'המלצה אחת', 'המלצות')}</span>}
                  {nn > 0 && <span className="badge tone-warn">{plural(nn, 'דגש אחד', 'דגשים')}</span>}
                </div>
                <div className="row between">
                  <span className="small muted">{last ? `אחרון: ${relativeDay(last.date)}` : 'עוד לא התאמן/ה'}</span>
                  {live ? (
                    <button className="btn btn-lime btn-sm" onClick={() => nav(`/session/${live.id}`)}>
                      אימון פעיל
                    </button>
                  ) : (
                    !c.archived && (
                      <button className="btn btn-sm" onClick={() => start(c.id)}>
                        <Play /> אימון
                      </button>
                    )
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
