import { useSearchParams } from 'react-router-dom';
import { TrendingUp } from 'lucide-react';
import { useActiveProgram, useClientSessions, useClients, useExercises, useSettings } from '../db/hooks';
import { Avatar, Empty, TopBar } from '../components/ui';
import { ProgressPanel } from '../components/ProgressPanel';

export function Progress() {
  const [params, setParams] = useSearchParams();
  const clients = useClients();
  const id = params.get('client') ?? clients?.[0]?.id;
  const client = clients?.find((c) => c.id === id);
  const sessions = useClientSessions(client?.id);
  const program = useActiveProgram(client?.id);
  const { map: exercises } = useExercises();
  const settings = useSettings();

  return (
    <>
      <TopBar title="התקדמות" sub={client?.name} back={true} />
      <div className="page stack-lg">
        {clients && clients.length === 0 && (
          <div className="card">
            <Empty icon={<TrendingUp />} title="אין עדיין מתאמנים" />
          </div>
        )}
        <div className="chips-scroll">
          {(clients ?? []).map((c) => (
            <button key={c.id} className={`chip ${c.id === client?.id ? 'on' : ''}`} onClick={() => setParams({ client: c.id }, { replace: true })}>
              <Avatar name={c.name} color={c.color} size="sm" />
              {c.name}
            </button>
          ))}
        </div>
        {client && sessions && <ProgressPanel key={client.id} client={client} sessions={sessions} program={program} exercises={exercises} settings={settings} />}
      </div>
    </>
  );
}
