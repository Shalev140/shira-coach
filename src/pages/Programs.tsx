import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ClipboardList, LayoutTemplate, Plus } from 'lucide-react';
import { useClients, useExercises, usePrograms } from '../db/hooks';
import { db } from '../db/db';
import { blankProgram, saveProgram } from '../db/repo';
import { matches } from '../domain/util';
import { Empty, SearchInput, Seg, SectionHead, Sheet, TopBar } from '../components/ui';
import { ProgramCard } from './ClientDetail';

export function Programs() {
  const nav = useNavigate();
  const programs = usePrograms();
  const clients = useClients(true);
  const { map: exercises } = useExercises();
  const [view, setView] = useState<'clients' | 'templates'>('clients');
  const [q, setQ] = useState('');
  const [choosing, setChoosing] = useState(false);
  const busy = useRef(false);
  const clientById = new Map((clients ?? []).map((c) => [c.id, c]));

  const list = useMemo(
    () =>
      (programs ?? [])
        .filter((p) => (view === 'templates' ? p.clientId === null : p.clientId !== null && clientById.has(p.clientId)))
        .filter((p) => matches(q, p.name, p.clientId ? clientById.get(p.clientId)?.name : ''))
        .sort((a, b) => (a.status === 'active' ? -1 : 0) - (b.status === 'active' ? -1 : 0) || b.updatedAt - a.updatedAt),
    [programs, view, q, clients],
  );

  const createTemplate = async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const { program } = await saveProgram(blankProgram(null, 'תבנית חדשה'), { reason: 'יצירת תבנית' });
      nav(`/programs/${program.id}`);
    } finally {
      busy.current = false;
    }
  };
  const createFor = async (clientId: string) => {
    if (busy.current) return; // double tap must not create two (active) programs
    busy.current = true;
    try {
      const c = clientById.get(clientId);
      // read the stored state, not the rendered list (it may not be loaded / up to date yet)
      const hasActive = (await db.programs.where('clientId').equals(clientId).toArray()).some((p) => !p.deletedAt && p.status === 'active');
      const p = blankProgram(clientId, `תוכנית ${c?.name.split(' ')[0] ?? ''}`.trim());
      p.status = hasActive ? 'draft' : 'active';
      p.demo = c?.demo;
      const { program } = await saveProgram(p, { reason: 'יצירת תוכנית' });
      nav(`/programs/${program.id}`);
    } finally {
      busy.current = false;
    }
  };

  // group client programs by client
  const grouped = useMemo(() => {
    const m = new Map<string, typeof list>();
    for (const p of list) m.set(p.clientId!, [...(m.get(p.clientId!) ?? []), p]);
    return [...m.entries()].sort((a, b) => (clientById.get(a[0])?.name ?? '').localeCompare(clientById.get(b[0])?.name ?? '', 'he'));
  }, [list]);

  return (
    <>
      <TopBar
        title="תוכניות"
        actions={
          <button className="btn btn-primary btn-sm" onClick={() => (view === 'templates' ? createTemplate() : setChoosing(true))}>
            <Plus /> {view === 'templates' ? 'תבנית' : 'תוכנית'}
          </button>
        }
      />
      <div className="page stack-lg">
        <div className="row row-wrap between">
          <Seg
            value={view}
            onChange={setView}
            options={[
              { value: 'clients', label: 'תוכניות מתאמנים' },
              { value: 'templates', label: 'תבניות' },
            ]}
          />
        </div>
        <SearchInput value={q} onChange={setQ} placeholder="חיפוש תוכנית או מתאמן/ת…" />
        {programs && list.length === 0 && (
          <div className="card">
            <Empty
              icon={view === 'templates' ? <LayoutTemplate /> : <ClipboardList />}
              title={view === 'templates' ? 'אין עדיין תבניות' : 'אין עדיין תוכניות'}
              action={
                <button className="btn btn-primary" onClick={() => (view === 'templates' ? createTemplate() : setChoosing(true))}>
                  <Plus /> {view === 'templates' ? 'תבנית חדשה' : 'תוכנית חדשה'}
                </button>
              }
            >
              {view === 'templates'
                ? 'תבנית היא תוכנית לשימוש חוזר — יוצרים ממנה תוכנית לכל מתאמן/ת בלחיצה. אפשר גם לשמור תוכנית קיימת כתבנית.'
                : 'תוכנית שייכת למתאמן/ת. אפשר לבנות מאפס, משכפול או מתבנית.'}
            </Empty>
          </div>
        )}
        {view === 'templates' ? (
          <div className="grid-auto">
            {list.map((p) => (
              <ProgramCard key={p.id} program={p} exercises={exercises} />
            ))}
          </div>
        ) : (
          grouped.map(([clientId, ps]) => (
            <section key={clientId} className="section">
              <SectionHead title={clientById.get(clientId)?.name ?? ''} count={ps.length} />
              <div className="grid-auto">
                {ps.map((p) => (
                  <ProgramCard key={p.id} program={p} exercises={exercises} highlight={p.status === 'active'} />
                ))}
              </div>
            </section>
          ))
        )}
      </div>
      {choosing && (
        <Sheet title="תוכנית חדשה עבור…" onClose={() => setChoosing(false)}>
          <div className="list card">
            {(clients ?? [])
              .filter((c) => !c.archived)
              .map((c) => (
                <button key={c.id} className="list-item" onClick={() => createFor(c.id)}>
                  <div className="grow title">{c.name}</div>
                </button>
              ))}
            <button className="list-item" onClick={createTemplate}>
              <LayoutTemplate size={18} />
              <div className="grow title">תבנית כללית (ללא מתאמן/ת)</div>
            </button>
          </div>
        </Sheet>
      )}
    </>
  );
}
