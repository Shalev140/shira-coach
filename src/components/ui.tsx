import {
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Check, Info, Minus, Plus, Search, X } from 'lucide-react';
import { initials } from '../domain/util';

/* ------------------------------------------------------------------ toast */

interface ToastItem {
  id: number;
  text: string;
  tone?: 'ok' | 'info' | 'error';
  action?: { label: string; run: () => void };
}
interface UiApi {
  toast: (text: string, opts?: { tone?: ToastItem['tone']; action?: ToastItem['action']; ms?: number }) => void;
  confirm: (opts: ConfirmOpts) => Promise<boolean>;
}
interface ConfirmOpts {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

const UiCtx = createContext<UiApi>({ toast: () => {}, confirm: async () => false });
export const useUi = () => useContext(UiCtx);

export function UiProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [confirmState, setConfirm] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const seq = useRef(0);

  const toast = useCallback<UiApi['toast']>((text, opts) => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-2), { id, text, tone: opts?.tone, action: opts?.action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), opts?.ms ?? (opts?.action ? 6000 : 2800));
  }, []);

  const confirm = useCallback<UiApi['confirm']>(
    (opts) => new Promise<boolean>((resolve) => setConfirm({ ...opts, resolve })),
    [],
  );

  const close = (v: boolean) => {
    confirmState?.resolve(v);
    setConfirm(null);
  };

  return (
    <UiCtx.Provider value={{ toast, confirm }}>
      {children}
      {createPortal(
        <div className="toast-wrap" role="status" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className="toast">
              {t.tone === 'error' ? <X color="#ff8a8f" /> : t.tone === 'info' ? <Info /> : <Check color="#c6f25a" />}
              <span>{t.text}</span>
              {t.action && (
                <button
                  onClick={() => {
                    t.action!.run();
                    setToasts((all) => all.filter((x) => x.id !== t.id));
                  }}
                >
                  {t.action.label}
                </button>
              )}
            </div>
          ))}
        </div>,
        document.body,
      )}
      {confirmState && (
        <Sheet
          title={confirmState.title}
          onClose={() => close(false)}
          footer={
            <>
              <button className="btn" onClick={() => close(false)}>
                {confirmState.cancelLabel ?? 'ביטול'}
              </button>
              <button className={`btn ${confirmState.danger ? 'btn-danger-solid' : 'btn-primary'}`} onClick={() => close(true)} autoFocus>
                {confirmState.confirmLabel ?? 'אישור'}
              </button>
            </>
          }
        >
          {confirmState.body && <div className="muted">{confirmState.body}</div>}
        </Sheet>
      )}
    </UiCtx.Provider>
  );
}

/* ------------------------------------------------------------------ sheet */

/*
 * One page-scroll lock shared by every open sheet. A per-sheet save/restore of
 * body.style.overflow broke with nested sheets: closing both in one commit (Escape,
 * back button, save in the inner sheet) let the inner one restore the 'hidden' it had
 * saved, and the whole app stopped scrolling until reload.
 */
let scrollLocks = 0;
let overflowBeforeLock = '';

/** Locks page scrolling until every returned release has run (each release counts once). */
export function lockBodyScroll(): () => void {
  if (scrollLocks++ === 0) {
    overflowBeforeLock = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--scrollLocks === 0) document.body.style.overflow = overflowBeforeLock;
  };
}

/** The sheet drawn on top: the last backdrop in the body (they share one z-index). */
function isTopSheet(el: HTMLElement | null): boolean {
  const open = document.querySelectorAll('.sheet-backdrop');
  return el !== null && open[open.length - 1] === el;
}

export function Sheet({
  title,
  onClose,
  children,
  footer,
  wide,
  headExtra,
}: {
  title: ReactNode;
  onClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  headExtra?: ReactNode;
}) {
  const backdrop = useRef<HTMLDivElement>(null);
  // a press that started on the dimmed area (not a drag out of an input) closes the sheet. onClick, not
  // onMouseDown: iPhone sends no mouse events for a tap on an element without its own click handler
  const downOnBackdrop = useRef(false);
  // the latest onClose, so a parent re-render (inline arrow) never re-runs the lock effect
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    // Escape closes only the top-most sheet, so edits in a sheet below it are kept
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && isTopSheet(backdrop.current) && close.current();
    window.addEventListener('keydown', onKey);
    const unlock = lockBodyScroll();
    return () => {
      window.removeEventListener('keydown', onKey);
      unlock();
    };
  }, []);
  return createPortal(
    <div
      ref={backdrop}
      className="sheet-backdrop"
      onPointerDown={(e) => (downOnBackdrop.current = e.target === e.currentTarget)}
      onClick={(e) => {
        if (downOnBackdrop.current && e.target === e.currentTarget) onClose();
        downOnBackdrop.current = false;
      }}
    >
      <div className={`sheet ${wide ? 'sheet-wide' : ''}`} role="dialog" aria-modal="true">
        <div className="sheet-grip" />
        <div className="sheet-head">
          <h2>{title}</h2>
          {headExtra}
          <button className="icon-btn" onClick={onClose} aria-label="סגירה">
            <X />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/* ----------------------------------------------------------------- topbar */

export function TopBar({
  title,
  sub,
  back,
  actions,
}: {
  title: ReactNode;
  sub?: ReactNode;
  back?: string | true;
  actions?: ReactNode;
}) {
  const nav = useNavigate();
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 4);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  return (
    <header className={`topbar ${scrolled ? 'scrolled' : ''}`}>
      <div className="topbar-inner">
        {back && (
          <button
            className="icon-btn"
            aria-label="חזרה"
            onClick={() => (back === true ? (window.history.length > 1 ? nav(-1) : nav('/')) : nav(back))}
          >
            <ArrowRight />
          </button>
        )}
        <div className="topbar-title">
          <h1>{title}</h1>
          {sub && <div className="sub">{sub}</div>}
        </div>
        {actions}
      </div>
    </header>
  );
}

/* ---------------------------------------------------------------- basics */

export function Avatar({ name, color, size }: { name: string; color?: string; size?: 'sm' | 'lg' }) {
  return (
    <div className={`avatar ${size ? `avatar-${size}` : ''}`} style={{ background: color ?? '#5B4CF0' }} aria-hidden>
      {initials(name)}
    </div>
  );
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <h3>{title}</h3>
      {children && <div className="small" style={{ maxWidth: 360 }}>{children}</div>}
      {action}
    </div>
  );
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`switch ${on ? 'on' : ''}`}
      onClick={() => onChange(!on)}
    />
  );
}

export function Seg<T extends string | number>({
  value,
  options,
  onChange,
  block,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  block?: boolean;
}) {
  return (
    <div className={`seg ${block ? 'seg-block' : ''}`}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" className={o.value === value ? 'on' : ''} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ChipToggle<T extends string>({
  options,
  value,
  onChange,
  multi = true,
  small,
}: {
  options: { value: T; label: ReactNode }[];
  value: T[];
  onChange: (v: T[]) => void;
  multi?: boolean;
  small?: boolean;
}) {
  return (
    <div className="chips">
      {options.map((o) => {
        const on = value.includes(o.value);
        return (
          <button
            type="button"
            key={o.value}
            className={`chip ${small ? 'chip-sm' : ''} ${on ? 'on' : ''}`}
            aria-pressed={on}
            onClick={() => onChange(multi ? (on ? value.filter((v) => v !== o.value) : [...value, o.value]) : on ? [] : [o.value])}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Single inputs a Field can link its caption to with htmlFor. */
const LABELABLE: unknown[] = ['input', 'select', 'textarea', NumInput, CommitInput, Stepper];
type ControlProps = { id?: string; 'aria-describedby'?: string };

/**
 * Caption + control + hint. Never a wrapping <label>: a label forwards taps on its
 * caption / hint to its first button, which silently changed Seg / Rating / Stepper
 * values. One input child is linked with htmlFor (tapping the caption still focuses
 * it); anything else becomes a group named by the caption.
 */
export function Field({ label, optional, hint, children }: { label: ReactNode; optional?: boolean; hint?: ReactNode; children: ReactNode }) {
  const id = useId();
  const hintId = hint ? `${id}h` : undefined;
  const caption = (
    <>
      {label} {optional && <span className="opt">(רשות)</span>}
    </>
  );
  if (isValidElement<ControlProps>(children) && LABELABLE.includes(children.type)) {
    const controlId = children.props.id ?? `${id}c`;
    const describedBy = [children.props['aria-describedby'], hintId].filter(Boolean).join(' ') || undefined;
    return (
      <div className="field">
        <label className="label" htmlFor={controlId}>
          {caption}
        </label>
        {cloneElement(children, { id: controlId, 'aria-describedby': describedBy })}
        {hint && <span className="hint" id={hintId}>{hint}</span>}
      </div>
    );
  }
  return (
    <div className="field" role="group" aria-labelledby={`${id}l`} aria-describedby={hintId}>
      <span className="label" id={`${id}l`}>
        {caption}
      </span>
      {children}
      {hint && <span className="hint" id={hintId}>{hint}</span>}
    </div>
  );
}

export function SearchInput({ value, onChange, placeholder, autoFocus }: { value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean }) {
  return (
    <div className="search">
      <Search />
      <input
        className="input"
        type="search"
        value={value}
        placeholder={placeholder ?? 'חיפוש…'}
        onChange={(e) => onChange(e.target.value)}
        autoFocus={autoFocus}
        enterKeyHint="search"
      />
      {value && (
        <button className="icon-btn clear" onClick={() => onChange('')} aria-label="ניקוי">
          <X />
        </button>
      )}
    </div>
  );
}

/** Numeric input with large −/+ buttons for quick one-handed entry. */
export function Stepper({
  value,
  onChange,
  step = 1,
  min = 0,
  placeholder,
  label,
  decimal,
  ariaLabel,
  id,
  'aria-describedby': describedBy,
}: {
  value: number | null | undefined;
  onChange: (v: number | null) => void;
  step?: number;
  min?: number;
  placeholder?: string;
  label?: string;
  decimal?: boolean;
  ariaLabel?: string;
} & ControlProps) {
  const { text, setText, focus } = useNumText(value);
  const bump = (dir: 1 | -1) => {
    const base = value ?? (placeholder ? Number(placeholder) || 0 : 0);
    const next = Math.max(min, Math.round((base + dir * step) * 100) / 100);
    setText(String(next));
    onChange(next);
    if (navigator.vibrate) navigator.vibrate(6);
  };
  return (
    <div style={{ minWidth: 0 }}>
      {label && <div className="stepper-label">{label}</div>}
      <div className="stepper">
        <button type="button" onClick={() => bump(1)} aria-label={`הוספה ${ariaLabel ?? label ?? ''}`}>
          <Plus />
        </button>
        <input
          id={id}
          inputMode={decimal ? 'decimal' : 'numeric'}
          value={text}
          placeholder={placeholder}
          aria-label={ariaLabel ?? label}
          aria-describedby={describedBy}
          {...focus}
          onChange={(e) => {
            const t = e.target.value.replace(/[^\d.,]/g, '');
            setText(t);
            onChange(parseNum(t));
          }}
        />
        <button type="button" onClick={() => bump(-1)} aria-label={`הפחתה ${ariaLabel ?? label ?? ''}`}>
          <Minus />
        </button>
      </div>
    </div>
  );
}

export function NumInput({
  value,
  onChange,
  placeholder,
  className,
  decimal,
  ariaLabel,
  id,
  'aria-describedby': describedBy,
}: {
  value: number | null | undefined;
  onChange: (v: number | null) => void;
  placeholder?: string;
  className?: string;
  decimal?: boolean;
  ariaLabel?: string;
} & ControlProps) {
  const { text, setText, focus } = useNumText(value);
  return (
    <input
      id={id}
      className={`input input-sm num ${className ?? ''}`}
      inputMode={decimal ? 'decimal' : 'numeric'}
      value={text}
      placeholder={placeholder}
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      {...focus}
      onChange={(e) => {
        const t = e.target.value.replace(/[^\d.,]/g, '');
        setText(t);
        const n = parseNum(t);
        if (t.trim() === '' || n !== null) onChange(n);
      }}
    />
  );
}

function parseNum(t: string): number | null {
  if (t.trim() === '') return null;
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** Local text for a numeric field; external value changes are ignored while the user is typing. */
function useNumText(value: number | null | undefined) {
  const [text, setText] = useState(value == null ? '' : String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current) return;
    setText((t) => (parseNum(t) === (value ?? null) ? t : value == null ? '' : String(value)));
  }, [value]);
  const focus = {
    onFocus: (e: FocusEvent<HTMLInputElement>) => {
      focused.current = true;
      e.target.select();
    },
    onBlur: () => {
      focused.current = false;
      setText((t) => (parseNum(t) === (value ?? null) ? t : value == null ? '' : String(value)));
    },
  };
  return { text, setText, focus };
}

export function Rating({
  value,
  onChange,
  max = 5,
  low,
  high,
}: {
  value: number | null | undefined;
  onChange: (v: number | null) => void;
  max?: number;
  low?: string;
  high?: string;
}) {
  return (
    <div>
      <div className="rating">
        {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
          <button key={n} type="button" className={value === n ? 'on' : ''} onClick={() => onChange(value === n ? null : n)}>
            {n}
          </button>
        ))}
      </div>
      {(low || high) && (
        <div className="rating-labels">
          <span>{low}</span>
          <span>{high}</span>
        </div>
      )}
    </div>
  );
}

export function Badge({ tone, children, icon }: { tone?: string; children: ReactNode; icon?: ReactNode }) {
  return (
    <span className={`badge ${tone ? `tone-${tone}` : ''}`}>
      {icon}
      {children}
    </span>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode }[] }) {
  return (
    <nav className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={t.value === value} className={`tab ${t.value === value ? 'on' : ''}`} onClick={() => onChange(t.value)}>
          {t.label}
        </button>
      ))}
    </nav>
  );
}

export function SectionHead({ title, count, action }: { title: ReactNode; count?: number; action?: ReactNode }) {
  return (
    <div className="section-head">
      <div className="section-title">
        {title}
        {count !== undefined && count > 0 && <span className="count">{count}</span>}
      </div>
      {action}
    </div>
  );
}

/**
 * Text input bound to a database value: keeps typing local and commits after a
 * short pause / on blur, so async writes never fight the cursor.
 */
export function CommitInput({
  value,
  onCommit,
  className = 'input',
  placeholder,
  id,
  'aria-describedby': describedBy,
}: {
  value: string;
  onCommit: (v: string) => void;
  className?: string;
  placeholder?: string;
} & ControlProps) {
  const [text, setText] = useState(value);
  const timer = useRef<number | undefined>(undefined);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);
  const commit = (v: string) => {
    window.clearTimeout(timer.current);
    if (v !== value) onCommit(v);
  };
  return (
    <input
      id={id}
      className={className}
      value={text}
      placeholder={placeholder}
      aria-describedby={describedBy}
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false;
        commit(text);
      }}
      onChange={(e) => {
        const v = e.target.value;
        setText(v);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => commit(v), 500);
      }}
    />
  );
}

/** Tracks online/offline — the app works either way; this only informs. */
export function useOnline() {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}
