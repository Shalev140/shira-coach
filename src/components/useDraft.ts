import { useEffect, useRef, useState } from 'react';

/**
 * Keeps an unsaved form in localStorage while it is being edited, so closing the
 * app, a crash or losing the screen never loses work. `restored` tells the UI to
 * show a "draft restored" notice; `clear()` is called after a successful save.
 *
 * Callers that edit a versioned record put the version in the key, so a draft is
 * only ever restored on top of the exact version it was based on.
 */
export function useDraft<T>(key: string, initial: () => T, enabled = true) {
  const storageKey = `draft:${key}`;
  const [restored, setRestored] = useState(false);
  const [value, setValue] = useState<T>(() => {
    if (enabled) {
      try {
        const raw = localStorage.getItem(storageKey);
        if (raw) {
          const parsed = JSON.parse(raw) as { v: T; t: number };
          if (Date.now() - parsed.t < 14 * 86400000) {
            setTimeout(() => setRestored(true), 0);
            return parsed.v;
          }
        }
      } catch {
        /* storage unavailable — fall back to a fresh form */
      }
    }
    return initial();
  });
  const dirty = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef(value);
  latest.current = value;

  const write = () => {
    window.clearTimeout(timer.current);
    if (!enabled || !dirty.current) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify({ v: latest.current, t: Date.now() }));
    } catch {
      /* quota / private mode — the form still works, just without a draft */
    }
  };
  const writeRef = useRef(write);
  writeRef.current = write;

  useEffect(() => {
    if (!enabled || !dirty.current) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => writeRef.current(), 300);
  }, [value, enabled, storageKey]);

  // leaving the screen within the debounce window must not drop the last edit
  useEffect(() => () => writeRef.current(), []);

  const update = (next: T | ((prev: T) => T)) => {
    dirty.current = true;
    setValue(next);
  };
  const clear = () => {
    window.clearTimeout(timer.current);
    dirty.current = false;
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* ignore */
    }
  };
  const discard = () => {
    clear();
    setRestored(false);
    setValue(initial());
  };
  return { value, setValue: update, restored, setRestored, clear, discard, isDirty: () => dirty.current };
}

/** Drafts under `prefix` other than `current` (e.g. made on an older program version), newest first. */
export function otherDrafts<T>(prefix: string, current: string): { key: string; value: T; t: number }[] {
  const out: { key: string; value: T; t: number }[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(`draft:${prefix}`) || k === `draft:${current}`) continue;
      const parsed = JSON.parse(localStorage.getItem(k) ?? 'null') as { v: T; t: number } | null;
      if (parsed) out.push({ key: k, value: parsed.v, t: parsed.t });
    }
  } catch {
    /* ignore */
  }
  return out.sort((a, b) => b.t - a.t);
}

export function removeDraftKey(storageKey: string) {
  try {
    localStorage.removeItem(storageKey);
  } catch {
    /* ignore */
  }
}
