import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, Plus } from 'lucide-react';
import { useExercises, useSettings } from '../db/hooks';
import type { Equipment, Exercise, ID, MovementPattern } from '../domain/types';
import { EQUIPMENT } from '../domain/labels';
import { matches, plural } from '../domain/util';
import { SearchInput, Sheet } from './ui';
import { ExerciseEditSheet } from './ExerciseEdit';

export interface ExerciseFilter {
  q: string;
  muscle: string | null;
  equipment: Equipment | null;
  pattern: MovementPattern | null;
  difficulty: number | null;
}

export function filterExercises(list: Exercise[], { q, muscle, equipment, pattern, difficulty }: ExerciseFilter): Exercise[] {
  return list.filter(
    (e) =>
      (!muscle || e.primary.includes(muscle) || (q === '' ? false : e.secondary.some((s) => s.muscle === muscle))) &&
      (!equipment || e.equipment === equipment) &&
      (!pattern || e.pattern === pattern) &&
      (!difficulty || e.difficulty === difficulty) &&
      matches(q, e.nameHe, e.nameEn, ...e.aliases),
  );
}

/**
 * How many exercises match the search text but are hidden by the muscle / equipment / pattern /
 * difficulty filters. A swap picker opens pre-filtered to the exercise's muscle (its chip may be
 * scrolled out of view), so without this a search for an existing exercise looks like "not found"
 * and invites creating a duplicate.
 */
export function searchHiddenByFilters(list: Exercise[], f: ExerciseFilter, shown: number): number {
  if (!f.q.trim() || !(f.muscle || f.equipment || f.pattern || f.difficulty)) return 0;
  return list.filter((e) => matches(f.q, e.nameHe, e.nameEn, ...e.aliases)).length - shown;
}

export function useExerciseFilter(list: Exercise[], initialMuscle?: string | null) {
  const [q, setQ] = useState('');
  const [muscle, setMuscle] = useState<string | null>(initialMuscle ?? null);
  const [equipment, setEquipment] = useState<Equipment | null>(null);
  const [pattern, setPattern] = useState<MovementPattern | null>(null);
  const [difficulty, setDifficulty] = useState<number | null>(null);
  const { filtered, hiddenByFilters } = useMemo(() => {
    const f = { q, muscle, equipment, pattern, difficulty };
    const filtered = filterExercises(list, f);
    return { filtered, hiddenByFilters: searchHiddenByFilters(list, f, filtered.length) };
  }, [list, q, muscle, equipment, pattern, difficulty]);
  const clearFilters = () => {
    setMuscle(null);
    setEquipment(null);
    setPattern(null);
    setDifficulty(null);
  };
  return { q, setQ, muscle, setMuscle, equipment, setEquipment, pattern, setPattern, difficulty, setDifficulty, filtered, hiddenByFilters, clearFilters };
}

/** A muscle id that is no longer in the settings (its custom group was deleted). */
export const DELETED_MUSCLE = 'שריר שנמחק';

export function muscleSummary(e: Exercise, names: Map<string, string>): string {
  return e.primary.map((m) => names.get(m) ?? DELETED_MUSCLE).join(' · ');
}

export function ExercisePicker({
  onPick,
  onClose,
  title = 'בחירת תרגיל',
  initialMuscle,
  multi,
}: {
  onPick: (id: ID) => void;
  onClose: () => void;
  title?: string;
  initialMuscle?: string;
  multi?: boolean;
}) {
  const { list } = useExercises();
  const settings = useSettings();
  const f = useExerciseFilter(list, initialMuscle);
  const [creating, setCreating] = useState(false);
  const [picked, setPicked] = useState<ID[]>([]);
  const names = new Map(settings.muscles.map((m) => [m.id, m.name]));
  // a preselected muscle chip can sit off-screen in the scrolling row — bring it into view
  const activeChip = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    activeChip.current?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
  }, [settings.muscles]); // again once the stored muscle list (custom groups) has loaded
  const onlyOutsideFilters = f.filtered.length === 0 && f.hiddenByFilters > 0;

  return (
    <Sheet title={title} onClose={onClose} wide footer={multi && picked.length ? (
      <button className="btn btn-primary" onClick={onClose}>{picked.length === 1 ? 'סיום · נוסף תרגיל אחד' : `סיום · נוספו ${picked.length}`}</button>
    ) : undefined}>
      <div className="stack" style={{ position: 'sticky', top: -4, background: 'var(--surface)', zIndex: 2, paddingBottom: 8 }}>
        <SearchInput value={f.q} onChange={f.setQ} placeholder="חיפוש בעברית או באנגלית…" autoFocus />
        <div className="chips-scroll" style={{ margin: '0 -20px', padding: '2px 20px' }}>
          <button className={`chip chip-sm ${!f.muscle ? 'on' : ''}`} onClick={() => f.setMuscle(null)}>
            הכול
          </button>
          {settings.muscles
            .filter((m) => !m.hidden)
            .map((m) => (
              <button
                key={m.id}
                ref={f.muscle === m.id ? activeChip : undefined}
                className={`chip chip-sm ${f.muscle === m.id ? 'on' : ''}`}
                onClick={() => f.setMuscle(f.muscle === m.id ? null : m.id)}
              >
                {m.name}
              </button>
            ))}
        </div>
        <div className="chips-scroll" style={{ margin: '0 -20px', padding: '2px 20px' }}>
          {(Object.keys(EQUIPMENT) as Equipment[]).map((k) => (
            <button key={k} className={`chip chip-sm ${f.equipment === k ? 'on' : ''}`} onClick={() => f.setEquipment(f.equipment === k ? null : k)}>
              {EQUIPMENT[k]}
            </button>
          ))}
        </div>
      </div>
      {f.hiddenByFilters > 0 && (
        <button className="btn btn-soft btn-sm btn-block" style={{ marginTop: 4 }} onClick={f.clearFilters}>
          {plural(f.hiddenByFilters, 'תרגיל נוסף מתאים', 'תרגילים נוספים מתאימים')} לחיפוש מחוץ לסינון · הצגת הכול
        </button>
      )}
      <div className="list card" style={{ marginTop: 4 }}>
        {f.filtered.map((e) => {
          const on = picked.includes(e.id);
          return (
            <button
              key={e.id}
              className="list-item"
              onClick={() => {
                onPick(e.id);
                if (multi) setPicked((p) => [...p, e.id]);
              }}
            >
              <div className="grow">
                <div className="title">
                  {e.nameHe} {e.custom && <span className="badge tone-accent">מותאם</span>}
                </div>
                <div className="sub ellipsis">
                  {muscleSummary(e, names)} · {EQUIPMENT[e.equipment]}
                  {e.nameEn && (
                    <>
                      {' · '}
                      <span className="ltr">{e.nameEn}</span>
                    </>
                  )}
                </div>
              </div>
              {on ? <span className="badge tone-success">נוסף</span> : multi ? <Plus className="chev" /> : <ChevronLeft className="chev" />}
            </button>
          );
        })}
        {f.filtered.length === 0 &&
          (onlyOutsideFilters ? (
            <div className="empty">
              <h3>אין תוצאות בסינון הנוכחי</h3>
              <div className="small">התרגיל קיים בספרייה תחת שריר או ציוד אחרים</div>
            </div>
          ) : (
            <div className="empty">
              <h3>לא נמצא תרגיל</h3>
              <div className="small">אפשר ליצור תרגיל מותאם אישית</div>
            </div>
          ))}
      </div>
      {!onlyOutsideFilters && (
        <button className="btn btn-soft btn-block" style={{ marginTop: 12 }} onClick={() => setCreating(true)}>
          <Plus /> יצירת תרגיל חדש{f.q ? ` "${f.q}"` : ''}
        </button>
      )}
      <p className="tiny muted" style={{ marginTop: 8 }}>
        {plural(f.filtered.length, 'תרגיל אחד', 'תרגילים')}
      </p>
      {creating && (
        <ExerciseEditSheet
          initial={{ nameHe: f.q, primary: f.muscle ? [f.muscle] : [] }}
          onClose={() => setCreating(false)}
          onSaved={(id) => {
            setCreating(false);
            onPick(id);
          }}
        />
      )}
    </Sheet>
  );
}
