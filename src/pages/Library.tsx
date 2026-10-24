import { useEffect, useMemo, useState } from 'react';
import { plural } from '../domain/util';
import { ChevronLeft, Plus, SlidersHorizontal } from 'lucide-react';
import { useExercises, useSettings } from '../db/hooks';
import type { Equipment, Exercise, MovementPattern } from '../domain/types';
import { DIFFICULTY, EQUIPMENT, PATTERNS } from '../domain/labels';
import { SearchInput, Seg, TopBar } from '../components/ui';
import { DELETED_MUSCLE, useExerciseFilter, muscleSummary } from '../components/ExercisePicker';
import { ExerciseDetailSheet, ExerciseEditSheet } from '../components/ExerciseEdit';

export function Library() {
  const { list, map } = useExercises();
  const settings = useSettings();
  // archived exercises are hidden everywhere else; this view is the way back (like archived clients)
  const archived = useMemo(() => [...map.values()].filter((e) => e.archived).sort((a, b) => a.nameHe.localeCompare(b.nameHe, 'he')), [map]);
  const [view, setView] = useState<'active' | 'archived'>('active');
  const showArchived = view === 'archived' && archived.length > 0;
  // once the archive is empty the choice resets, so archiving the next exercise doesn't flip the view
  useEffect(() => {
    if (view === 'archived' && archived.length === 0) setView('active');
  }, [view, archived.length]);
  const f = useExerciseFilter(showArchived ? archived : list);
  const [filters, setFilters] = useState(false);
  const [open, setOpen] = useState<Exercise | null>(null);
  const [creating, setCreating] = useState(false);
  const names = new Map(settings.muscles.map((m) => [m.id, m.name]));
  const activeFilters = [f.equipment, f.pattern, f.difficulty].filter(Boolean).length;

  return (
    <>
      <TopBar
        title="ספריית תרגילים"
        sub={plural(list.length, "תרגיל אחד", "תרגילים")}
        back={true}
        actions={
          <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
            <Plus /> תרגיל
          </button>
        }
      />
      <div className="page stack">
        <div className="row">
          <div className="grow">
            <SearchInput value={f.q} onChange={f.setQ} placeholder="חיפוש בעברית או באנגלית (למשל: RDL, פולי, סקוואט)…" />
          </div>
          <button className={`btn btn-icon ${filters || activeFilters ? 'btn-soft' : ''}`} onClick={() => setFilters((v) => !v)} aria-label="סינון">
            <SlidersHorizontal />
          </button>
        </div>
        {archived.length > 0 && (
          <Seg
            value={showArchived ? 'archived' : 'active'}
            onChange={setView}
            options={[
              { value: 'active', label: 'בספרייה' },
              { value: 'archived', label: `בארכיון (${archived.length})` },
            ]}
          />
        )}
        <div className="chips-scroll">
          <button className={`chip chip-sm ${!f.muscle ? 'on' : ''}`} onClick={() => f.setMuscle(null)}>
            כל השרירים
          </button>
          {settings.muscles
            .filter((m) => !m.hidden)
            .map((m) => (
              <button key={m.id} className={`chip chip-sm ${f.muscle === m.id ? 'on' : ''}`} onClick={() => f.setMuscle(f.muscle === m.id ? null : m.id)}>
                {m.name}
              </button>
            ))}
        </div>
        {filters && (
          <div className="card card-pad stack-sm">
            <div className="label">דפוס תנועה</div>
            <div className="chips">
              {(Object.keys(PATTERNS) as MovementPattern[]).map((k) => (
                <button key={k} className={`chip chip-sm ${f.pattern === k ? 'on' : ''}`} onClick={() => f.setPattern(f.pattern === k ? null : k)}>
                  {PATTERNS[k]}
                </button>
              ))}
            </div>
            <div className="label">ציוד</div>
            <div className="chips">
              {(Object.keys(EQUIPMENT) as Equipment[]).map((k) => (
                <button key={k} className={`chip chip-sm ${f.equipment === k ? 'on' : ''}`} onClick={() => f.setEquipment(f.equipment === k ? null : k)}>
                  {EQUIPMENT[k]}
                </button>
              ))}
            </div>
            <div className="label">רמת קושי</div>
            <div className="chips">
              {([1, 2, 3] as const).map((d) => (
                <button key={d} className={`chip chip-sm ${f.difficulty === d ? 'on' : ''}`} onClick={() => f.setDifficulty(f.difficulty === d ? null : d)}>
                  {DIFFICULTY[d]}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="small muted">
          {plural(f.filtered.length, "תוצאה אחת", "תוצאות")}
          {showArchived && ' בארכיון · פתיחת תרגיל מאפשרת להחזיר אותו לספרייה'}
        </div>
        {f.hiddenByFilters > 0 && (
          <button className="btn btn-soft btn-sm" style={{ alignSelf: 'flex-start' }} onClick={f.clearFilters}>
            {plural(f.hiddenByFilters, 'תרגיל נוסף מתאים', 'תרגילים נוספים מתאימים')} לחיפוש מחוץ לסינון · הצגת הכול
          </button>
        )}
        <div className="card list lib-list">
          {f.filtered.map((e) => (
            <button key={e.id} className="list-item" onClick={() => setOpen(e)}>
              <div className={`pattern-dot p-${e.pattern}`} aria-hidden />
              <div className="grow">
                <div className="title">
                  {e.nameHe} {e.custom && <span className="badge tone-accent">מותאם</span>}
                </div>
                <div className="sub ellipsis">
                  {muscleSummary(e, names)}
                  {e.secondary.length ? <span className="faint"> · +{e.secondary.map((s) => names.get(s.muscle) ?? DELETED_MUSCLE).join(', ')}</span> : null}
                </div>
              </div>
              <span className="badge hide-mobile">{EQUIPMENT[e.equipment]}</span>
              <ChevronLeft className="chev" />
            </button>
          ))}
        </div>
      </div>
      {open && <ExerciseDetailSheet exercise={open} onClose={() => setOpen(null)} />}
      {creating && <ExerciseEditSheet initial={{ nameHe: f.q, primary: f.muscle ? [f.muscle] : [] }} onClose={() => setCreating(false)} />}
    </>
  );
}
