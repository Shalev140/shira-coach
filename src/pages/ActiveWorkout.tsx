import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  AlertTriangle,
  ArrowRight,
  Ban,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Flag,
  HeartPulse,
  History,
  ListOrdered,
  MoreHorizontal,
  Pencil,
  Plus,
  Repeat,
  ShieldAlert,
  SkipForward,
  StickyNote,
  Timer,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { db } from '../db/db';
import { alive, completeSession, discardSession, resolveNote, saveSession } from '../db/repo';
import { useClient, useExercises, useNotes, useSettings } from '../db/hooks';
import type { EntryStatus, PerformedSet, Session, SessionEntry, Technique } from '../domain/types';
import { BLOCK_TYPES, SET_TYPES, TECHNIQUE } from '../domain/labels';
import { formatSet, previousOccurrence } from '../domain/progress';
import { noteShowsIn } from '../domain/agenda';
import { iosVersion, isStandalone, localFlag, setLocalFlag } from '../components/install';
import { deepClone, fmtDuration, plural, relativeDay, uid } from '../domain/util';
import { Field, Rating, Sheet, Stepper, useUi } from '../components/ui';
import { RestTimer, primeAudio, type RestState } from '../components/RestTimer';
import { ExercisePicker } from '../components/ExercisePicker';
import { ExerciseDetailSheet } from '../components/ExerciseEdit';

export function ActiveWorkout() {
  const { id } = useParams();
  const nav = useNavigate();
  const loaded = useLiveQuery(async () => {
    const s = id ? await db.sessions.get(id) : undefined;
    return alive(s) ? s : null;
  }, [id]);
  useEffect(() => {
    // a finished / discarded / missing workout must never be revived from its unsaved copy
    if (id && loaded !== undefined && loaded?.status !== 'active') dropPendingCopy(id);
    if (loaded && loaded.status !== 'active') nav(`/session/${loaded.id}/view`, { replace: true });
  }, [id, loaded, nav]);
  if (loaded === undefined) return null;
  if (!loaded)
    return (
      <div className="page" style={{ paddingTop: 60 }}>
        <div className="empty">
          <h3>האימון לא נמצא</h3>
          <button className="btn" onClick={() => nav('/')}>לבית</button>
        </div>
      </div>
    );
  if (loaded.status !== 'active') return null;
  return <Workout key={loaded.id} initial={loaded} />;
}

/* ---- a synchronous copy of unsaved changes: an IndexedDB write may not finish before a reload tears the page down ---- */
const pendingKey = (id: string) => `pending-session:${id}`;

function dropPendingCopy(id: string) {
  try {
    localStorage.removeItem(pendingKey(id));
  } catch {
    /* ignore */
  }
}

/** The copy kept on hide / before a reload, when it is newer than the database row (else null). */
export function newerPendingCopy(dbCopy: Session, raw: string | null): Session | null {
  if (!raw) return null;
  try {
    const local = JSON.parse(raw) as Session;
    if (local?.id !== dbCopy.id || local.status !== 'active' || local.deletedAt || !Array.isArray(local.entries)) return null;
    return dbCopy.status === 'active' && (local.updatedAt ?? 0) > (dbCopy.updatedAt ?? 0) ? local : null;
  } catch {
    return null;
  }
}

/* Keeps the phone screen awake during a workout (where supported). */
function useWakeLock() {
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const req = async () => {
      try {
        const wl = (navigator as unknown as { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock;
        if (wl && document.visibilityState === 'visible') lock = await wl.request('screen');
      } catch {
        /* not supported / denied */
      }
    };
    void req();
    const onVis = () => document.visibilityState === 'visible' && req();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      void lock?.release().catch(() => {});
    };
  }, []);
}

function Workout({ initial }: { initial: Session }) {
  const nav = useNavigate();
  const { toast, confirm } = useUi();
  const settings = useSettings();
  const client = useClient(initial.clientId);
  const { map: exercises } = useExercises();
  const notes = useNotes(initial.clientId) ?? [];
  const history = useLiveQuery(
    async () => (await db.sessions.where('clientId').equals(initial.clientId).toArray()).filter((s) => alive(s) && s.id !== initial.id),
    [initial.clientId],
  );
  // changes kept on hide / before a reload that never reached the database win over the stored row
  const [start] = useState(() => {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(pendingKey(initial.id));
    } catch {
      /* ignore */
    }
    return newerPendingCopy(initial, raw) ?? initial;
  });
  const [s, setS] = useState<Session>(start);
  const [rest, setRestState] = useState<RestState | null>(() => {
    try {
      const raw = localStorage.getItem(`rest:${initial.id}`);
      const r = raw ? (JSON.parse(raw) as RestState) : null;
      return r && r.endsAt > Date.now() - 60000 ? r : null;
    } catch {
      return null;
    }
  });
  const [sheet, setSheet] = useState<null | 'list' | 'add' | 'swap' | 'menu' | 'readiness' | 'edit' | 'info'>(null);
  const [showNotes, setShowNotes] = useState(true);
  // an app on the iPhone home screen could not keep the screen awake before iOS 18.4 — say so once
  const [lockHint, setLockHint] = useState(() => {
    const v = iosVersion();
    return !!v && isStandalone() && (v[0] < 18 || (v[0] === 18 && v[1] < 4)) && !localFlag('wakelock-hint');
  });
  /** set while asking how to finish a workout that has records but no set marked done */
  const [noSetsAsk, setNoSetsAsk] = useState<((c: NoSetsChoice) => void) | null>(null);
  const answerNoSets = (c: NoSetsChoice) => {
    noSetsAsk?.(c);
    setNoSetsAsk(null);
  };
  useWakeLock();

  /* ---- autosave: every change is written to the device database ---- */
  const pending = useRef<Session | null>(null);
  /** the snapshot whose database write hasn't finished yet */
  const inflight = useRef<Session | null>(null);
  const timer = useRef<number | undefined>(undefined);
  /** latest state, for callbacks that outlive a render (toast undo, timers) */
  const sRef = useRef<Session>(start);
  /** set once the workout is finished / discarded / the screen is gone — no write may follow */
  const closed = useRef(false);
  /** the screen is gone — unlike `closed`, a failed finish / discard never resets it */
  const unmounted = useRef(false);
  const busy = useRef(false);
  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    // after finish / discard nothing may write the "active" copy again (not even a re-queued failed save)
    if (closed.current || !pending.current) return;
    const snap = pending.current;
    pending.current = null;
    inflight.current = snap;
    saveSession(snap)
      .then(() => {
        if (inflight.current === snap) inflight.current = null;
        if (!pending.current && !inflight.current) dropPendingCopy(snap.id);
      })
      .catch((e) => {
        console.error('autosave failed', e);
        if (inflight.current === snap) inflight.current = null;
        // keep the latest state queued, so the next change / hiding / leaving the screen writes it again
        if (!closed.current && !pending.current) pending.current = sRef.current;
        toast('השמירה במכשיר נכשלה — בדקי שיש מקום פנוי באחסון', { tone: 'error', ms: 8000 });
      });
  }, [toast]);
  /** Synchronous copy of whatever isn't written yet — survives a reload that aborts the database write. */
  const stash = useCallback(() => {
    if (closed.current || (!pending.current && !inflight.current)) return;
    try {
      localStorage.setItem(pendingKey(initial.id), JSON.stringify({ ...sRef.current, updatedAt: Date.now() }));
    } catch {
      /* storage full / blocked — the database write is still attempted */
    }
  }, [initial.id]);
  const commit = useCallback(
    (next: Session, immediate = false) => {
      if (closed.current || unmounted.current) return;
      sRef.current = next;
      setS(next);
      pending.current = next;
      window.clearTimeout(timer.current);
      if (immediate) flush();
      else timer.current = window.setTimeout(flush, 350);
    },
    [flush],
  );
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    closed.current = false; // (re)mounted — StrictMode mounts twice in development
    unmounted.current = false;
    if (start !== initial) {
      // recovered the copy kept on hide / reload → write it now (its key is removed once saved)
      pending.current = start;
      flushRef.current();
    } else dropPendingCopy(initial.id);
    return () => {
      // leaving the screen: write what's pending, then refuse late writes (e.g. a toast's undo)
      stash();
      flushRef.current();
      closed.current = true;
      unmounted.current = true;
    };
  }, []);
  useEffect(() => {
    const onHide = (ev: Event) => {
      if (ev.type !== 'visibilitychange' || document.visibilityState === 'hidden') stash();
      flush();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    // dispatched by the app right before it reloads itself (e.g. a service-worker update)
    window.addEventListener('shira:flush', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('shira:flush', onHide);
    };
  }, [flush, stash]);

  const setRest = (r: RestState | null) => {
    setRestState(r);
    try {
      if (r) localStorage.setItem(`rest:${initial.id}`, JSON.stringify(r));
      else localStorage.removeItem(`rest:${initial.id}`);
    } catch {
      /* ignore */
    }
  };

  const idx = Math.min(s.currentIndex ?? 0, Math.max(0, s.entries.length - 1));
  const entry = s.entries[idx] as SessionEntry | undefined;
  const ex = entry ? exercises.get(entry.exerciseId) : undefined;
  // the same program slot first (e.g. a heavy and a light squat day), else the exercise's latest occurrence
  const prev = useMemo(
    () => (entry && history ? previousOccurrence(history, entry.exerciseId, s, entry.plannedExerciseId) : null),
    [entry?.exerciseId, entry?.plannedExerciseId, history],
  );
  // a timed hold (plank, wall sit) is logged in seconds — also for sets / exercises added during the workout
  const timedEntry = !!entry && timedByDefault(entry, prev?.entry ?? null);

  const totalSets = s.entries.filter((e) => e.status !== 'skipped' && e.status !== 'notdone').reduce((n, e) => n + e.sets.length, 0);
  const doneSets = s.entries.reduce((n, e) => n + e.sets.filter((x) => x.done).length, 0);
  // a note about one exercise belongs to the workout that has it (an A/B split shows it on the right day)
  const nextNotes = notes.filter((n) => noteShowsIn(n, s));
  const blockMates = entry?.blockId ? s.entries.map((e, i) => ({ e, i })).filter(({ e }) => e.blockId === entry.blockId) : [];

  const go = (i: number) => commit({ ...s, currentIndex: Math.max(0, Math.min(s.entries.length - 1, i)) });
  const updateEntry = (fn: (e: SessionEntry) => void, immediate = false) => {
    const next = deepClone(s);
    fn(next.entries[idx]);
    commit(next, immediate);
  };

  /** Marks a set as done; fills empty fields from the visible targets; handles supersets and rest. */
  const completeSet = (setIdx: number, timed: boolean) => {
    primeAudio();
    const next = deepClone(s);
    const e = next.entries[idx];
    const set = e.sets[setIdx];
    fillOnDone(set, placeholders(e, setIdx, prev?.entry ?? null), timed);
    const t = Date.now();
    // actual rest = time since the previous completed set anywhere in this workout (capped)
    const lastDone = Math.max(0, ...next.entries.flatMap((x) => x.sets.map((z) => (z.done ? z.doneAt ?? 0 : 0))));
    set.restTaken = lastDone ? Math.min(900, Math.round((t - lastDone) / 1000)) : null;
    set.done = true;
    set.doneAt = t;
    if (e.status === 'pending' || e.status === 'skipped' || e.status === 'notdone') e.status = 'done';
    if (settings.vibrate && navigator.vibrate) navigator.vibrate(18);

    const restSec = afterSetDone(next, idx, setIdx, settings.defaultRest);
    commit(next, true);
    if (restSec > 0) setRest({ endsAt: Date.now() + restSec * 1000, total: restSec });
  };

  const undoSet = (setIdx: number) =>
    updateEntry((e) => {
      e.sets[setIdx].done = false;
      e.sets[setIdx].doneAt = null;
      if (!e.sets.some((x) => x.done)) e.status = 'pending';
    }, true);

  const addSet = () =>
    updateEntry((e) => {
      const last = e.sets[e.sets.length - 1];
      e.sets.push({
        id: uid(),
        type: last?.type === 'warmup' ? 'working' : last?.type ?? 'working',
        planned: null,
        weight: last?.weight ?? null,
        reps: null,
        rir: null,
        done: false,
        added: true,
      });
      if (e.status === 'skipped' || e.status === 'notdone') e.status = 'pending';
    }, true);

  const setStatus = (status: EntryStatus) => {
    const next = deepClone(s);
    const entryId = next.entries[idx].id;
    next.entries[idx].status = status;
    const after = next.entries.findIndex((x, i) => i > idx && x.status === 'pending');
    if (after !== -1) next.currentIndex = after;
    commit(next, true);
    toast(status === 'skipped' ? 'התרגיל דולג' : 'סומן כלא בוצע', {
      action: {
        label: 'ביטול',
        // undo only that entry's status, on top of the LATEST state (sets logged meanwhile stay)
        run: () => {
          if (closed.current || unmounted.current) return;
          const cur = deepClone(sRef.current);
          const i = cur.entries.findIndex((x) => x.id === entryId);
          if (i === -1 || cur.entries[i].status !== status) return;
          cur.entries[i].status = cur.entries[i].sets.some((z) => z.done) ? 'done' : 'pending';
          cur.currentIndex = i;
          commit(cur, true);
        },
      },
    });
  };

  const finish = async () => {
    if (busy.current) return; // double tap on one of the two finish buttons
    busy.current = true;
    try {
      await finishInner();
    } finally {
      busy.current = false;
    }
  };

  const finishInner = async () => {
    flush();
    const missing = s.entries.filter((e) => e.status === 'pending' || e.status === 'done').reduce((n, e) => n + e.sets.filter((x) => !x.done).length, 0);
    if (doneSets === 0) {
      // a pain report / notes made before any set must be keepable — discarding them would let the next
      // workout recommend a load increase that the pain should have blocked
      if (keptWithoutSets(s).length) {
        const choice = await new Promise<NoSetsChoice>((resolve) => setNoSetsAsk(() => resolve));
        if (choice === 'discard') await discardNow();
        if (choice !== 'save') return;
      } else {
        const ok = await confirm({
          title: 'לא סומנו סטים',
          body: 'לא נשמר אף סט באימון הזה. לבטל את האימון (לא יישמר בהיסטוריה), או לחזור לתעד?',
          confirmLabel: 'ביטול האימון',
          cancelLabel: 'חזרה לאימון',
          danger: true,
        });
        if (ok) await discardNow();
        return;
      }
    } else if (missing > 0) {
      const ok = await confirm({
        title: 'לסיים את האימון?',
        body: `${plural(missing, 'סט אחד לא סומן כבוצע', 'סטים לא סומנו כבוצעו')}. ${missing === 1 ? 'הוא יופיע בסיכום כסט שלא הושלם' : 'הם יופיעו בסיכום כסטים שלא הושלמו'} — התכנון המקורי לא משתנה.`,
        confirmLabel: 'סיום וסיכום',
        cancelLabel: 'חזרה',
      });
      if (!ok) return;
    }
    // from here on nothing may write the "active" copy again
    const final = sRef.current;
    flush();
    closed.current = true;
    try {
      await saveSession(final);
      await completeSession({ ...final, endedAt: Date.now() });
    } catch (e) {
      console.error(e);
      // the failure may come after the "completed" row was written (e.g. while creating recommendations) —
      // then the workout IS finished and must not be reopened (a late undo would revive the active copy)
      const row = await db.sessions.get(final.id).catch(() => undefined);
      if (row?.status !== 'completed') {
        if (!unmounted.current) {
          closed.current = false; // keep the workout editable; nothing was lost
          // the failed write may have been the save itself → queue it again for the next change / hide / exit
          if (row?.status === 'active') pending.current ??= sRef.current;
        }
        toast('לא הצלחתי לסיים את האימון — הנתונים שמורים, נסי שוב', { tone: 'error', ms: 8000 });
        return;
      }
      toast('האימון נשמר, אבל בדיקת ההמלצות נכשלה — אפשר ללחוץ "בדיקה מחדש" בסיכום', { tone: 'error', ms: 8000 });
    }
    dropPendingCopy(final.id);
    setRest(null);
    nav(`/session/${final.id}/summary`, { replace: true });
  };

  /** Throws the workout away; if the write fails the screen stays editable. */
  const discardNow = async () => {
    flush();
    closed.current = true;
    try {
      await discardSession(s.id);
    } catch (e) {
      console.error(e);
      if (!unmounted.current) closed.current = false;
      toast('לא הצלחתי לבטל את האימון — נסי שוב', { tone: 'error', ms: 8000 });
      return;
    }
    dropPendingCopy(s.id);
    setRest(null);
    nav('/', { replace: true });
  };

  const discard = async () => {
    if (busy.current) return;
    const ok = await confirm({ title: 'לבטל את האימון?', body: 'האימון והסטים שתועדו בו לא יישמרו בהיסטוריה.', confirmLabel: 'ביטול האימון', danger: true });
    if (!ok || busy.current) return;
    busy.current = true;
    try {
      await discardNow();
    } finally {
      busy.current = false;
    }
  };

  const addExercise = (exerciseId: string) => {
    const next = deepClone(s);
    const plusCount = next.entries.filter((e) => e.added).length + 1;
    next.entries.push({
      id: uid(),
      exerciseId,
      blockId: null,
      blockLabel: `+${plusCount}`,
      blockType: 'single',
      section: 'main',
      status: 'pending',
      sets: Array.from({ length: 3 }, () => ({ id: uid(), type: 'working' as const, planned: null, weight: null, reps: null, rir: null, done: false, added: true })),
      technique: 'na',
      pain: { reported: false },
      setup: {},
      added: true,
    });
    next.currentIndex = next.entries.length - 1;
    commit(next, true);
    setSheet(null);
  };

  const swapExercise = (exerciseId: string) => {
    setSheet(null);
    const next = swapEntry(s, idx, exerciseId);
    if (!next) return;
    commit(next, true);
    toast(
      next.entries.length > s.entries.length
        ? 'התרגיל הוחלף באימון הזה בלבד — הסטים שכבר בוצעו נשארו בתרגיל הקודם'
        : 'התרגיל הוחלף באימון הזה בלבד — התוכנית לא השתנתה',
    );
  };

  return (
    // every tap unlocks the end-of-rest sound (iPhone allows audio only after a tap) — also the manual timer
    <div className="workout" onClickCapture={primeAudio}>
      <header className="wo-top">
        <div className="wo-top-row">
          <button className="icon-btn" onClick={() => nav('/')} aria-label="יציאה (האימון נשמר)">
            <ArrowRight />
          </button>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="wo-client ellipsis">{client?.name}</div>
            <div className="wo-sub ellipsis">
              {s.workoutName} · <Elapsed since={s.startedAt} />
            </div>
          </div>
          <button className="icon-btn" onClick={() => setSheet('list')} aria-label="רשימת תרגילים">
            <ListOrdered />
          </button>
          <button className="icon-btn" onClick={() => setSheet('menu')} aria-label="עוד">
            <MoreHorizontal />
          </button>
          <button className="btn btn-lime btn-sm" onClick={finish}>
            <Flag /> סיום
          </button>
        </div>
        <div className="wo-progress">
          <i style={{ width: `${totalSets ? (doneSets / totalSets) * 100 : 0}%` }} />
        </div>
        <div className="wo-pills" role="tablist">
          {s.entries.map((e, i) => {
            const done = e.sets.filter((x) => x.done).length;
            const st = e.status === 'skipped' || e.status === 'notdone' ? 'skip' : done === e.sets.length && done > 0 ? 'done' : done > 0 ? 'part' : '';
            return (
              <button key={e.id} className={`wo-pill ${i === idx ? 'on' : ''} ${st}`} onClick={() => go(i)}>
                {e.blockLabel}
              </button>
            );
          })}
          <button className="wo-pill add" onClick={() => setSheet('add')} aria-label="הוספת תרגיל">
            <Plus size={16} />
          </button>
        </div>
      </header>

      <div className="wo-body">
        {lockHint && (
          <div className="banner tone-info">
            <Timer />
            <div className="grow small">
              בגרסת iOS שבמכשיר המסך עלול להינעל באמצע מנוחה. כדאי לעדכן ל-iOS 18.4 ומעלה, או להאריך את הנעילה: הגדרות ← תצוגה ובהירות ← נעילה אוטומטית.
            </div>
            <button
              className="icon-btn"
              aria-label="סגירה"
              onClick={() => {
                setLocalFlag('wakelock-hint');
                setLockHint(false);
              }}
            >
              <X size={18} />
            </button>
          </div>
        )}
        {nextNotes.length > 0 && showNotes && (
          <div className="next-banner">
            <div className="row between">
              <div className="strong row" style={{ gap: 6 }}>
                <StickyNote size={18} /> דגשים מהאימון הקודם
              </div>
              <button className="icon-btn" onClick={() => setShowNotes(false)} aria-label="הסתרה">
                <X size={18} />
              </button>
            </div>
            {nextNotes.map((n) => (
              <div key={n.id} className="row row-top" style={{ gap: 8 }}>
                <button className="check-btn" aria-label="טופל" onClick={() => resolveNote(n.id)}>
                  <Check size={14} />
                </button>
                <div className="small grow">{n.text}</div>
              </div>
            ))}
          </div>
        )}

        {client && (client.injuries || client.limitations) && idx === 0 && (
          <div className="banner tone-danger small">
            <ShieldAlert />
            <div className="grow">{[client.injuries, client.limitations].filter(Boolean).join(' · ')}</div>
          </div>
        )}

        {!s.readiness.energy && !s.readiness.sleep && doneSets === 0 && (
          <button className="card card-pad readiness-cta" onClick={() => setSheet('readiness')}>
            <HeartPulse size={20} />
            <span className="grow">איך מרגישים היום? (אנרגיה, שינה, כאבי שרירים)</span>
            <span className="tiny muted">רשות</span>
          </button>
        )}

        {!entry ? (
          <div className="card card-lg empty">
            <h3>אין עדיין תרגילים באימון</h3>
            <button className="btn btn-primary" onClick={() => setSheet('add')}>
              <Plus /> הוספת תרגיל
            </button>
          </div>
        ) : (
          <div className={`wo-card ${entry.status}`}>
            <div className="wo-card-head">
              <div className="row row-wrap" style={{ gap: 6 }}>
                <span className="block-tag">{entry.blockLabel}</span>
                {blockMates.length > 1 && (
                  <span className="badge tone-accent">
                    {BLOCK_TYPES[entry.blockType]} · {blockMates.findIndex((m) => m.i === idx) + 1}/{blockMates.length}
                  </span>
                )}
                {entry.section !== 'main' && <span className="badge">{entry.section === 'warmup' ? 'חימום' : 'סיום'}</span>}
                {entry.swappedFromId && <span className="badge tone-warn"><Repeat /> הוחלף מ{exercises.get(entry.swappedFromId)?.nameHe}</span>}
                {entry.added && <span className="badge tone-info">נוסף באימון</span>}
                {entry.status === 'skipped' && <span className="badge tone-warn">דולג</span>}
                {entry.status === 'notdone' && <span className="badge tone-danger">לא בוצע</span>}
              </div>
              <button className="wo-ex-name" onClick={() => setSheet('info')}>
                {ex?.nameHe ?? 'תרגיל'} <CircleHelp size={18} className="faint" />
              </button>
              {blockMates.length > 1 && (
                <div className="mates">
                  {blockMates.map(({ e, i }) => (
                    <button key={e.id} className={`mate ${i === idx ? 'on' : ''}`} onClick={() => go(i)}>
                      <span className="tiny strong">{e.blockLabel}</span>
                      <span className="ellipsis small">{exercises.get(e.exerciseId)?.nameHe}</span>
                      <span className="tiny muted num">
                        {e.sets.filter((x) => x.done).length}/{e.sets.length}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {(Object.values(entry.setup ?? {}).some(Boolean) || entry.notes || plannedItem(s, entry)?.notes || plannedItem(s, entry)?.tempo) && (
                <div className="setup-chips">
                  {Object.entries(entry.setup ?? {})
                    .filter(([, v]) => v)
                    .map(([k, v]) => (
                      <span key={k} className="chip chip-sm">
                        {SETUP_LABEL[k] ?? k}: <b>{v}</b>
                      </span>
                    ))}
                  {plannedItem(s, entry)?.tempo && (
                    <span className="chip chip-sm">
                      טמפו: <b className="ltr">{plannedItem(s, entry)?.tempo}</b>
                    </span>
                  )}
                  {plannedItem(s, entry)?.notes && <div className="plan-note small">{plannedItem(s, entry)?.notes}</div>}
                </div>
              )}
            </div>

            <PrevPanel prev={prev} />

            <div className="sets">
              {entry.sets.map((set, i) => (
                <SetRow
                  key={set.id}
                  set={set}
                  workIndex={entry.sets.slice(0, i + 1).filter((x) => x.type !== 'warmup').length}
                  ph={placeholders(entry, i, prev?.entry ?? null)}
                  timed={timedEntry}
                  showRpe={settings.rirMode !== 'rir'}
                  showRir={settings.rirMode !== 'rpe'}
                  // bodyweight / band / TRX have a 0 kg increment — the +/− for added load still needs a step
                  weightStep={(ex && (ex.increment || settings.increments[ex.equipment])) || 2.5}
                  onChange={(patch) => updateEntry((e) => editSet(e.sets[i], patch))}
                  onDone={(timed) => completeSet(i, timed)}
                  onUndo={() => undoSet(i)}
                  onRemove={set.added && !set.done ? () => updateEntry((e) => void e.sets.splice(i, 1), true) : undefined}
                />
              ))}
            </div>

            <div className="wo-actions">
              <button className="btn btn-sm" onClick={addSet}>
                <Plus /> סט
              </button>
              <button className="btn btn-sm" onClick={() => setRest({ endsAt: Date.now() + settings.defaultRest * 1000, total: settings.defaultRest })}>
                <Timer /> טיימר
              </button>
              <button className="btn btn-sm" onClick={() => setSheet('swap')}>
                <Repeat /> החלפה
              </button>
              <button className="btn btn-sm" onClick={() => setSheet('edit')}>
                <Pencil /> עריכה
              </button>
              {entry.status === 'pending' && (
                <>
                  <button className="btn btn-sm btn-ghost" onClick={() => setStatus('skipped')}>
                    <SkipForward /> דילוג
                  </button>
                  <button className="btn btn-sm btn-ghost" onClick={() => setStatus('notdone')}>
                    <Ban /> לא בוצע
                  </button>
                </>
              )}
              {(entry.status === 'skipped' || entry.status === 'notdone') && (
                <button className="btn btn-sm btn-ghost" onClick={() => updateEntry((e) => void (e.status = 'pending'), true)}>
                  <Undo2 /> החזרה
                </button>
              )}
            </div>

            <div className="wo-section">
              <div className="label">איכות טכניקה</div>
              <div className="tech-chips">
                {(['good', 'fix', 'poor', 'na'] as Technique[]).map((t) => (
                  <button key={t} className={`tech t-${t} ${entry.technique === t ? 'on' : ''}`} aria-pressed={entry.technique === t} onClick={() => updateEntry((e) => void (e.technique = t), true)}>
                    {TECHNIQUE[t]}
                  </button>
                ))}
              </div>
            </div>

            <div className={`wo-section pain ${entry.pain?.reported ? 'on' : ''}`}>
              <button
                className="row between"
                style={{ width: '100%' }}
                onClick={() => updateEntry((e) => void (e.pain = { ...e.pain, reported: !e.pain?.reported }), true)}
                aria-pressed={entry.pain?.reported}
              >
                <span className="row strong" style={{ gap: 8 }}>
                  <AlertTriangle size={18} /> כאב / אי-נוחות
                </span>
                <span className={`switch ${entry.pain?.reported ? 'on danger' : ''}`} />
              </button>
              {entry.pain?.reported && (
                <div className="stack-sm" style={{ marginTop: 10 }}>
                  <input
                    className="input input-sm"
                    placeholder="איפה? (למשל: כתף ימין, ברך)"
                    value={entry.pain.location ?? ''}
                    onChange={(ev) => updateEntry((e) => void (e.pain.location = ev.target.value))}
                  />
                  <div className="sev">
                    {Array.from({ length: 10 }, (_, k) => k + 1).map((n) => (
                      <button key={n} aria-pressed={entry.pain.severity === n} aria-label={`עוצמת כאב ${n}`} className={`${entry.pain.severity === n ? "on" : ""} ${n >= 7 ? 'hi' : n >= 4 ? 'mid' : ''}`} onClick={() => updateEntry((e) => void (e.pain.severity = n), true)}>
                        {n}
                      </button>
                    ))}
                  </div>
                  <div className="tiny muted">כאב מדווח חוסם המלצות להעלאת עומס בתרגיל עד לבדיקה.</div>
                </div>
              )}
            </div>

            <div className="wo-section">
              <textarea
                className="textarea"
                style={{ minHeight: 64 }}
                placeholder="הערות לתרגיל (תחושה, טכניקה, ציוד)…"
                value={entry.notes ?? ''}
                onChange={(ev) => updateEntry((e) => void (e.notes = ev.target.value))}
              />
            </div>
          </div>
        )}

        {entry && (
          <div className="wo-nav">
            <button className="btn btn-lg" onClick={() => go(idx - 1)} disabled={idx === 0}>
              <ChevronRight /> הקודם
            </button>
            {idx < s.entries.length - 1 ? (
              <button className="btn btn-lg btn-dark" onClick={() => go(idx + 1)}>
                הבא <ChevronLeft />
              </button>
            ) : (
              <button className="btn btn-lg btn-lime" onClick={finish}>
                <Flag /> סיום וסיכום
              </button>
            )}
          </div>
        )}
      </div>

      <RestTimer rest={rest} onChange={setRest} sound={settings.sound} vibrate={settings.vibrate} />

      {sheet === 'list' && (
        <Sheet title="תרגילי האימון" onClose={() => setSheet(null)}>
          <div className="list card">
            {s.entries.map((e, i) => {
              const done = e.sets.filter((x) => x.done).length;
              return (
                <button key={e.id} className="list-item" onClick={() => (go(i), setSheet(null))}>
                  <span className={`block-tag ${i === idx ? 'on' : ''}`}>{e.blockLabel}</span>
                  <div className="grow">
                    <div className="title small">{exercises.get(e.exerciseId)?.nameHe}</div>
                    <div className="sub">
                      <span className="num">
                        {done}/{e.sets.length}
                      </span>{' '}
                      {e.sets.length === 1 ? 'סט' : 'סטים'}
                      {e.status === 'skipped' ? ' · דולג' : e.status === 'notdone' ? ' · לא בוצע' : ''}
                    </div>
                  </div>
                  {done === e.sets.length && done > 0 && <Check size={18} className="trend-up" />}
                </button>
              );
            })}
          </div>
          <button className="btn btn-soft btn-block" style={{ marginTop: 12 }} onClick={() => setSheet('add')}>
            <Plus /> הוספת תרגיל לאימון
          </button>
        </Sheet>
      )}
      {sheet === 'add' && <ExercisePicker title="הוספת תרגיל לאימון" onClose={() => setSheet(null)} onPick={addExercise} />}
      {sheet === 'swap' && entry && (
        <ExercisePicker title={`החלפת ${ex?.nameHe ?? 'תרגיל'}`} initialMuscle={ex?.primary[0]} onClose={() => setSheet(null)} onPick={swapExercise} />
      )}
      {sheet === 'info' && ex && <ExerciseDetailSheet exercise={ex} onClose={() => setSheet(null)} />}
      {sheet === 'readiness' && <ReadinessSheet session={s} onClose={() => setSheet(null)} onSave={(r) => commit({ ...s, readiness: r }, true)} />}
      {sheet === 'edit' && entry && (
        <Sheet title="כיוונים לאימון הזה" onClose={() => setSheet(null)} footer={<button className="btn btn-primary" onClick={() => setSheet(null)}>סיום</button>}>
          <div className="stack">
            <p className="small muted">נשמר כמה שקרה בפועל באימון הזה. התוכנית עצמה לא משתנה.</p>
            <div className="grid-2">
              {Object.keys(SETUP_LABEL).map((k) => (
                <Field key={k} label={SETUP_LABEL[k]} optional>
                  <input
                    className="input input-sm"
                    value={(entry.setup as Record<string, string | undefined>)[k] ?? ''}
                    onChange={(ev) => updateEntry((e) => void (e.setup = { ...e.setup, [k]: ev.target.value }))}
                  />
                </Field>
              ))}
            </div>
          </div>
        </Sheet>
      )}
      {sheet === 'menu' && (
        <Sheet title="אפשרויות אימון" onClose={() => setSheet(null)}>
          <div className="list card">
            <button className="list-item" onClick={() => setSheet('readiness')}>
              <HeartPulse size={18} /> <span className="grow">תחושה ומוכנות</span>
            </button>
            <button className="list-item" onClick={() => setSheet('add')}>
              <Plus size={18} /> <span className="grow">הוספת תרגיל</span>
            </button>
            <button className="list-item" onClick={() => (setSheet(null), finish())}>
              <Flag size={18} /> <span className="grow">סיום וסיכום</span>
            </button>
            <button className="list-item" style={{ color: 'var(--danger)' }} onClick={() => (setSheet(null), discard())}>
              <Trash2 size={18} /> <span className="grow">ביטול האימון</span>
            </button>
          </div>
          <p className="tiny muted" style={{ marginTop: 10 }}>
            כל שינוי נשמר מיד במכשיר. אפשר לסגור את האפליקציה ולחזור — האימון ימשיך מאותה נקודה.
          </p>
        </Sheet>
      )}
      {noSetsAsk && (
        <Sheet title="לא סומנו סטים" onClose={() => answerNoSets(null)}>
          <div className="stack">
            <p className="muted">
              לא סומן אף סט כבוצע, אבל באימון יש תיעוד: {keptWithoutSets(s).join(', ')}. כדי שהתיעוד יישמר אפשר לסיים ולשמור את האימון — תרגילים
              בלי סטים יסומנו כ"לא בוצע".
            </p>
            <button className="btn btn-primary btn-block" onClick={() => answerNoSets('save')}>
              <Flag /> סיום ושמירה
            </button>
            <button className="btn btn-block" onClick={() => answerNoSets(null)}>
              חזרה לאימון
            </button>
            <button className="btn btn-ghost btn-block" style={{ color: 'var(--danger)' }} onClick={() => answerNoSets('discard')}>
              <Trash2 /> ביטול האימון (התיעוד לא יישמר)
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

type NoSetsChoice = 'save' | 'discard' | null;

/** What a workout without any done set still recorded and must not silently lose (empty = nothing). */
export function keptWithoutSets(s: Session): string[] {
  const out: string[] = [];
  if (s.entries.some((e) => e.pain?.reported)) out.push('דיווח כאב');
  if (s.entries.some((e) => e.technique && e.technique !== 'na')) out.push('הערכת טכניקה');
  if (s.entries.some((e) => e.notes?.trim())) out.push('הערות');
  const r = s.readiness ?? {};
  if (r.energy || r.sleep || r.fatigue || r.soreness || r.note?.trim()) out.push('תחושה ומוכנות');
  return out;
}

/** effort buttons share the row's width instead of overflowing it (the row hides its scrollbar) */
const EFFORT_BTN: CSSProperties = { flex: '1 1 0px', minWidth: 0 };
const RPE_GRID: CSSProperties = { display: 'grid', gridTemplateColumns: '30px repeat(4, minmax(0, 1fr))', overflow: 'visible' };

const SETUP_LABEL: Record<string, string> = {
  seat: 'כיסא/משענת',
  bench: 'ספסל',
  angle: 'זווית',
  cable: 'גובה כבל',
  grip: 'אחיזה',
  rom: 'טווח',
  other: 'אחר',
};

function plannedItem(s: Session, e: SessionEntry) {
  if (!e.plannedExerciseId || !s.plannedSnapshot) return null;
  for (const b of s.plannedSnapshot.blocks) for (const i of b.items) if (i.id === e.plannedExerciseId) return i;
  return null;
}

/** A value edited by hand. Only typed reps / duration make an auto-filled set real evidence again. */
export function editSet(set: PerformedSet, patch: Partial<PerformedSet>) {
  Object.assign(set, patch);
  // correcting just the load leaves reps that were never typed — the engine must keep ignoring them
  if ('reps' in patch || 'duration' in patch) set.autoFilled = false;
}

/**
 * Swaps the exercise at `idx` for this workout only (null when there's nothing to change).
 * Sets already done stay on the exercise they were done on; the rest move to a new entry for the
 * replacement right after it, so neither exercise's history or load leaks into the other.
 */
export function swapEntry(s: Session, idx: number, exerciseId: string): Session | null {
  if (!s.entries[idx] || s.entries[idx].exerciseId === exerciseId) return null;
  const next = deepClone(s);
  const e = next.entries[idx];
  // "back" = the exercise the program slot planned (not just the one this entry replaced, which may itself
  // have been a replacement); an entry without a plan slot can only go back to the exercise it replaced
  const item = plannedItem(next, e);
  const back = item ? item.exerciseId === exerciseId : e.swappedFromId === exerciseId;
  if (!e.sets.some((z) => z.done)) {
    if (!e.swappedFromId) e.swappedFromId = e.exerciseId;
    if (back) e.swappedFromId = null;
    // going back to an earlier replacement: it still stands in for the planned exercise
    else if (e.swappedFromId === exerciseId) e.swappedFromId = item?.exerciseId ?? null;
    e.exerciseId = exerciseId;
    // loads carried over / planned for the old exercise don't apply to the new one
    for (const z of e.sets) {
      z.planned = plannedForSwap(next, e, z, back);
      z.weight = back ? z.planned?.weight ?? null : null;
    }
    return next;
  }
  // back to the planned exercise → its planned loads apply again
  const left = e.sets.filter((z) => !z.done);
  e.sets = e.sets.filter((z) => z.done);
  // the original exercise was stopped early — it must not look "fully completed" to the engine
  if (left.length) e.cutShort = true;
  next.entries.splice(idx + 1, 0, {
    id: uid(),
    plannedExerciseId: e.plannedExerciseId,
    exerciseId,
    swappedFromId: back ? null : e.exerciseId,
    blockId: e.blockId,
    blockLabel: e.blockLabel,
    blockType: e.blockType,
    section: e.section,
    status: 'pending',
    sets: left.length
      ? left.map((z) => {
          const planned = plannedForSwap(next, e, z, back);
          return { ...z, planned, weight: back ? planned?.weight ?? null : null };
        })
      : [{ id: uid(), type: 'working', planned: null, weight: null, reps: null, rir: null, done: false, added: true }],
    technique: 'na',
    pain: { reported: false },
    setup: {},
  });
  next.currentIndex = idx + 1;
  return next;
}

/**
 * A set's target after a swap: the planned load belongs to the planned exercise only — a replacement
 * gets none (no "target 80 kg" / "changed from plan" on another exercise); going back to the planned
 * exercise restores it from the workout's plan snapshot. Reps, RIR, rest and time targets stay.
 */
function plannedForSwap(s: Session, e: SessionEntry, z: PerformedSet, onPlan: boolean): PerformedSet['planned'] {
  if (!z.planned) return z.planned;
  if (!onPlan) return { ...z.planned, weight: null };
  const ps = z.plannedSetId ? plannedItem(s, e)?.sets.find((x) => x.id === z.plannedSetId) : undefined;
  return ps ? { ...z.planned, weight: ps.weight ?? null } : z.planned;
}

type Placeholders = { weight: number | null; reps: number | null; duration: number | null };

/** What a tap on ✓ will record when fields are empty: plan first, then last time. */
export function placeholders(entry: SessionEntry, i: number, prev: SessionEntry | null): Placeholders {
  const set = entry.sets[i];
  const prevWork = prev ? prev.sets.filter((s) => s.done && s.type === set.type) : [];
  const ordinal = entry.sets.slice(0, i).filter((s) => s.type === set.type).length;
  const p = prevWork[Math.min(ordinal, prevWork.length - 1)];
  const before = entry.sets.slice(0, i).reverse();
  // after a swap the planned load belongs to the old exercise — use the new exercise's history instead
  const plannedWeight = entry.swappedFromId ? null : set.planned?.weight;
  const weight = plannedWeight ?? p?.weight ?? before.find((s) => s.weight != null)?.weight ?? null;
  const reps = set.planned?.repsMax ?? set.planned?.repsMin ?? p?.reps ?? null;
  const duration = set.planned?.duration || p?.duration || before.find((s) => s.duration)?.duration || null;
  return { weight, reps, duration };
}

/**
 * Fills the empty fields of a set marked done from what the screen showed. The load is shown on screen,
 * so taking it is a real entry; reps / a hold time taken from the target or last time are not — those are
 * flagged so the engine won't treat them as evidence (the planned time of a timed set is taken as is).
 */
export function fillOnDone(set: PerformedSet, ph: Placeholders, timed: boolean) {
  if (set.weight == null && ph.weight != null) set.weight = ph.weight;
  if (set.reps != null || set.duration != null) return;
  if (timed) {
    if (set.planned?.duration) set.duration = set.planned.duration;
    else if (ph.duration != null) {
      set.duration = ph.duration;
      set.autoFilled = true;
    }
  } else if (ph.reps != null) {
    set.reps = ph.reps;
    set.autoFilled = true;
  }
}

/** A hold measured in seconds: planned / logged as time in this workout, or logged as time last time. */
export function timedByDefault(entry: SessionEntry, prev: SessionEntry | null): boolean {
  if (entry.sets.some((z) => !!z.planned?.duration || z.duration != null)) return true;
  // a plan that gives rep targets decides — history only fills in when the plan says nothing
  if (entry.sets.some((z) => z.planned?.repsMin != null || z.planned?.repsMax != null)) return false;
  return !!prev?.sets.some((z) => z.done && !!z.duration);
}

/**
 * After set `setIdx` of entry `idx` was marked done: moves `next.currentIndex` on and returns the rest (s).
 * A superset goes to the partner without rest and rests after the round; a warm-up isn't a round (its own
 * rest, same exercise); a drop set follows at once, and the rest after the drop cluster is the drop's own,
 * else that of the set it drops from.
 */
export function afterSetDone(next: Session, idx: number, setIdx: number, defaultRest: number): number {
  const e = next.entries[idx];
  const set = e.sets[setIdx];
  const followUp = e.sets.slice(setIdx + 1).find((z) => !z.done);
  if (followUp?.type === 'drop') return 0;
  let restSec = set.planned?.rest ?? defaultRest;
  if (set.type === 'drop' && !restSec)
    restSec = e.sets.slice(0, setIdx).reverse().find((z) => z.type !== 'drop')?.planned?.rest ?? defaultRest;

  const nextPendingAfter = (from: number) => next.entries.findIndex((x, i) => i > from && x.status === 'pending' && x.sets.some((z) => !z.done));
  // a round is made of work sets — a warm-up left on a partner doesn't pull the flow back to it
  const toDo = (x: SessionEntry) => x.sets.some((z) => !z.done && z.type !== 'warmup');
  const mates = e.blockId ? next.entries.map((x, i) => ({ x, i })).filter(({ x }) => x.blockId === e.blockId && x.status !== 'skipped' && x.status !== 'notdone') : [];
  const pos = mates.findIndex((m) => m.i === idx);
  if (mates.length > 1 && !(set.type === 'warmup' && followUp)) {
    const after = mates.slice(pos + 1).find((m) => toDo(m.x));
    if (after) {
      next.currentIndex = after.i;
      restSec = 0;
    } else {
      const block = next.plannedSnapshot?.blocks.find((b) => b.id === e.blockId);
      restSec = block?.restAfter ?? restSec;
      const first = mates.find((m) => toDo(m.x));
      if (first) next.currentIndex = first.i;
      else {
        // the whole superset is done → continue with the next exercise after the block
        const nxt = nextPendingAfter(Math.max(...mates.map((m) => m.i)));
        if (nxt !== -1) next.currentIndex = nxt;
      }
    }
  } else if (e.sets.every((z) => z.done)) {
    // exercise finished → move on to the next unfinished one
    const after = nextPendingAfter(idx);
    if (after !== -1) next.currentIndex = after;
  }
  return restSec;
}

function Elapsed({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, []);
  return <span className="num">{fmtDuration((Date.now() - since) / 1000)}</span>;
}

function PrevPanel({ prev }: { prev: ReturnType<typeof previousOccurrence> }) {
  const [open, setOpen] = useState(true);
  if (!prev)
    return (
      <div className="prev-panel empty-prev">
        <History size={16} /> פעם ראשונה בתרגיל הזה
      </div>
    );
  const sets = prev.entry.sets.filter((s) => s.done);
  return (
    <div className="prev-panel">
      <button className="row between" style={{ width: '100%' }} onClick={() => setOpen((o) => !o)}>
        <span className="row small strong" style={{ gap: 6 }}>
          <History size={16} /> פעם קודמת · {relativeDay(prev.session.date)}
        </span>
        <span className="row" style={{ gap: 6 }}>
          {prev.entry.pain?.reported && <span className="badge tone-danger">כאב</span>}
          {prev.entry.technique !== 'na' && <span className="badge">{TECHNIQUE[prev.entry.technique]}</span>}
        </span>
      </button>
      {open && (
        <>
          <div className="prev-sets">
            {sets.map((s) => (
              <span key={s.id} className={`set-chip ${s.type !== 'working' ? 'muted' : ''}`}>
                {/* numbered like the live screen: working sets only, counted over the whole entry */}
                <span className="tiny muted">
                  {s.type === 'working' ? prev.entry.sets.slice(0, prev.entry.sets.indexOf(s) + 1).filter((x) => x.type !== 'warmup').length : SET_TYPES[s.type]}
                </span>{' '}
                <span className="num">{formatSet(s)}</span>
              </span>
            ))}
          </div>
          {prev.entry.notes && <div className="small muted" style={{ marginTop: 6 }}>"{prev.entry.notes}"</div>}
        </>
      )}
    </div>
  );
}

function SetRow({
  set,
  workIndex,
  ph,
  timed,
  showRir,
  showRpe,
  weightStep,
  onChange,
  onDone,
  onUndo,
  onRemove,
}: {
  set: PerformedSet;
  workIndex: number;
  ph: Placeholders;
  /** the exercise is a timed hold — the default unit for a set the plan gave no reps / time target */
  timed: boolean;
  showRir: boolean;
  showRpe: boolean;
  weightStep: number;
  onChange: (patch: Partial<PerformedSet>) => void;
  /** `timed`: the set is logged in seconds */
  onDone: (timed: boolean) => void;
  onUndo: () => void;
  onRemove?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [unit, setUnit] = useState<'reps' | 'secs' | null>(null);
  const p = set.planned;
  // the plan fixes the unit; a set without a reps / time target (added in the workout) can be switched
  const unitFree = !p?.duration && p?.repsMin == null && p?.repsMax == null;
  const secs = set.duration != null || !!p?.duration || (unitFree && (unit ? unit === 'secs' : set.reps == null && timed));
  const switchUnit = () => {
    // a number typed in the wrong field moves along (one taken from the target doesn't)
    const carry = set.autoFilled ? null : (secs ? set.duration : set.reps) ?? null;
    setUnit(secs ? 'reps' : 'secs');
    onChange(secs ? { duration: null, reps: carry } : { reps: null, duration: carry });
  };
  const target = p
    ? [
        p.weight != null ? `${p.weight} ק״ג` : null,
        p.duration ? `${p.duration} שנ׳` : p.repsMin != null || p.repsMax != null ? `${p.repsMin ?? ''}${p.repsMax != null && p.repsMax !== p.repsMin ? `–${p.repsMax}` : ''} חזרות` : null,
        p.rir != null ? `RIR ${p.rir}` : null,
        p.rpe != null ? `RPE ${p.rpe}` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : 'סט נוסף';
  const label = set.type === 'working' ? String(workIndex) : set.type === 'warmup' ? 'ח' : set.type === 'drop' ? 'D' : 'B';

  if (set.done && !editing)
    return (
      <div className={`set-row done t-${set.type}`}>
        <span className="set-num">{label}</span>
        <button className="grow set-done-text" onClick={() => setEditing(true)} aria-label="עריכת סט">
          <span className="num strong">
            {set.duration ? `${set.duration} שנ׳` : `${set.weight ?? 'BW'} × ${set.reps ?? '—'}`}
          </span>
          {set.rir != null && <span className="badge num">RIR {set.rir}</span>}
          {set.rpe != null && <span className="badge num">RPE {set.rpe}</span>}
          {set.autoFilled && <span className="badge" title="נרשם לפי היעד — לחיצה לתיקון">לפי היעד</span>}
          {p?.repsMin != null && set.reps != null && set.reps < p.repsMin && <span className="badge tone-warn">מתחת לטווח</span>}
          {p?.weight != null && set.weight != null && set.weight !== p.weight && <span className="badge tone-info">שונה מהתכנון</span>}
        </button>
        <button className="set-check on" onClick={onUndo} aria-label="ביטול סימון">
          <Check />
        </button>
      </div>
    );

  return (
    <div className={`set-row open t-${set.type}`}>
      <div className="set-row-head">
        <span className="set-num">{label}</span>
        <span className="small muted grow">
          {set.type !== 'working' && <b>{SET_TYPES[set.type]} · </b>}
          יעד: {target}
        </span>
        {unitFree && (
          <button className={`chip chip-sm ${secs ? 'on' : ''}`} onClick={switchUnit} aria-pressed={secs} aria-label="מדידה בשניות (החזקה)">
            <Timer size={14} /> שניות
          </button>
        )}
        {onRemove && (
          <button className="icon-btn" onClick={onRemove} aria-label="מחיקת סט">
            <X size={16} />
          </button>
        )}
        {!set.done ? (
          <button className="set-check" onClick={() => onDone(secs)} aria-label={`סימון סט ${label} כבוצע`}>
            <Check />
          </button>
        ) : (
          <button className="set-check on" onClick={() => setEditing(false)} aria-label="שמירה">
            <Check />
          </button>
        )}
      </div>
      <div className="set-inputs">
        <Stepper label="משקל (ק״ג)" value={set.weight ?? null} placeholder={ph.weight != null ? String(ph.weight) : 'BW'} step={weightStep} decimal onChange={(v) => onChange({ weight: v })} />
        {secs ? (
          <Stepper key="secs" label="שניות" value={set.duration ?? null} placeholder={ph.duration != null ? String(ph.duration) : ''} step={5} onChange={(v) => onChange({ duration: v })} />
        ) : (
          <Stepper key="reps" label="חזרות" value={set.reps ?? null} placeholder={ph.reps != null ? String(ph.reps) : ''} onChange={(v) => onChange({ reps: v })} />
        )}
      </div>
      {/* every option fits the row at phone width (no hidden, swipe-only values): buttons share the width,
          the 8 RPE values take two rows */}
      {showRir && set.type !== 'warmup' && (
        <div className="rir-row">
          <span className="tiny muted">RIR</span>
          {[0, 1, 2, 3, 4, 5].map((n) => (
            <button key={n} style={EFFORT_BTN} aria-pressed={set.rir === n} aria-label={`RIR ${n}`} className={`rir ${set.rir === n ? 'on' : ''} ${p?.rir === n ? 'target' : ''}`} onClick={() => onChange({ rir: set.rir === n ? null : n })}>
              {n === 5 ? '5+' : n}
            </button>
          ))}
        </div>
      )}
      {showRpe && set.type !== 'warmup' && (
        <div className="rir-row" style={RPE_GRID}>
          <span className="tiny muted" style={{ gridRow: 'span 2' }}>RPE</span>
          {[6, 7, 7.5, 8, 8.5, 9, 9.5, 10].map((n) => (
            <button key={n} style={{ minWidth: 0 }} aria-pressed={set.rpe === n} aria-label={`RPE ${n}`} className={`rir ${set.rpe === n ? 'on' : ''}`} onClick={() => onChange({ rpe: set.rpe === n ? null : n })}>
              {n}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ReadinessSheet({ session, onClose, onSave }: { session: Session; onClose: () => void; onSave: (r: Session['readiness']) => void }) {
  const [r, setR] = useState(session.readiness ?? {});
  return (
    <Sheet
      title="תחושה ומוכנות"
      onClose={onClose}
      footer={
        <button
          className="btn btn-primary"
          onClick={() => {
            onSave(r);
            onClose();
          }}
        >
          שמירה
        </button>
      }
    >
      <div className="stack">
        <p className="small muted">תיעוד קצר ואופציונלי שעוזר לפרש ביצועים. אינו אבחון רפואי.</p>
        <Field label="רמת אנרגיה">
          <Rating value={r.energy} onChange={(v) => setR({ ...r, energy: v })} low="נמוכה" high="גבוהה" />
        </Field>
        <Field label="איכות שינה">
          <Rating value={r.sleep} onChange={(v) => setR({ ...r, sleep: v })} low="גרועה" high="מצוינת" />
        </Field>
        <Field label="עייפות">
          <Rating value={r.fatigue} onChange={(v) => setR({ ...r, fatigue: v })} low="רענן/ה" high="מותש/ת" />
        </Field>
        <Field label="כאבי שרירים מאוחרים">
          <Rating value={r.soreness} onChange={(v) => setR({ ...r, soreness: v })} low="אין" high="חזקים" />
        </Field>
        <Field label="הערה" optional>
          <input className="input" value={r.note ?? ''} onChange={(e) => setR({ ...r, note: e.target.value })} placeholder="למשל: יום עבודה ארוך" />
        </Field>
      </div>
    </Sheet>
  );
}
