export const uid = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);

export const now = () => Date.now();

const pad = (n: number) => String(n).padStart(2, '0');

/** Local calendar date as YYYY-MM-DD (never UTC — avoids off-by-one at night). */
export function isoDate(d: Date | number = new Date()): string {
  const x = typeof d === 'number' ? new Date(d) : d;
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
}

export function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function addDays(s: string, days: number): string {
  const d = parseDate(s);
  d.setDate(d.getDate() + days);
  return isoDate(d);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / 86400000);
}

/** First day of the week containing `date`. */
export function weekStart(date: string, startsOn: 0 | 1 = 0): string {
  const d = parseDate(date);
  const diff = (d.getDay() - startsOn + 7) % 7;
  d.setDate(d.getDate() - diff);
  return isoDate(d);
}

const heDate = new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'short' });
const heDateYear = new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'short', year: 'numeric' });
const heWeekday = new Intl.DateTimeFormat('he-IL', { weekday: 'long' });
const heTime = new Intl.DateTimeFormat('he-IL', { hour: '2-digit', minute: '2-digit' });

export function fmtDate(s?: string | null, withYear = false): string {
  if (!s) return '—';
  const d = parseDate(s);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return (withYear || !sameYear ? heDateYear : heDate).format(d);
}

export function fmtDateTime(ts?: number | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${fmtDate(isoDate(d))}, ${heTime.format(d)}`;
}

export function fmtTime(ts?: number | null): string {
  return ts ? heTime.format(new Date(ts)) : '—';
}

export function fmtWeekday(s: string): string {
  return heWeekday.format(parseDate(s));
}

export function relativeDay(s?: string | null): string {
  if (!s) return '—';
  const diff = daysBetween(s, isoDate());
  if (diff === 0) return 'היום';
  if (diff === 1) return 'אתמול';
  if (diff === -1) return 'מחר';
  if (diff > 1 && diff < 7) return `לפני ${diff} ימים`;
  if (diff >= 7 && diff < 14) return 'לפני שבוע';
  if (diff >= 14 && diff < 31) return `לפני ${Math.round(diff / 7)} שבועות`;
  if (diff < -1 && diff > -7) return `בעוד ${-diff} ימים`;
  return fmtDate(s);
}

export function relativeTime(ts?: number | null): string {
  if (!ts) return 'אף פעם';
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'עכשיו';
  if (mins < 60) return `לפני ${mins} דק׳`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours === 1 ? 'לפני שעה' : `לפני ${hours} שעות`;
  return relativeDay(isoDate(ts));
}

export function ageFrom(birth?: string): number | null {
  if (!birth) return null;
  const b = parseDate(birth);
  const t = new Date();
  let age = t.getFullYear() - b.getFullYear();
  if (t.getMonth() < b.getMonth() || (t.getMonth() === b.getMonth() && t.getDate() < b.getDate())) age--;
  return age >= 0 && age < 120 ? age : null;
}

export function fmtNum(n?: number | null, digits = 1): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const r = Math.round(n * 10 ** digits) / 10 ** digits;
  return String(r);
}

export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${pad(r)}`;
}

export function fmtMinutes(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} דק׳`;
  return `${Math.floor(mins / 60)}:${pad(mins % 60)} ש׳`;
}

export function initials(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter((p) => /^\p{L}/u.test(p));
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2);
  return parts[0][0] + parts[parts.length - 1][0];
}

/** Normalises Hebrew/English text for forgiving search (geresh, niqqud, case, final letters). */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[֑-ׇ]/g, '')
    .replace(/[׳'`"״-]/g, '')
    .replace(/ך/g, 'כ')
    .replace(/ם/g, 'מ')
    .replace(/ן/g, 'נ')
    .replace(/ף/g, 'פ')
    .replace(/ץ/g, 'צ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Hebrew-aware word variants: drops one attached prefix letter (ב/ה/ו/ל/מ/ש/כ)
 * and common endings, so "במכונה" also finds "מכונת", "סקוואטים" finds "סקוואט",
 * "כתפיים" finds "כתף".
 */
function stems(word: string): string[] {
  const out = new Set([word]);
  if (word.length > 3 && /^[בהולמשכ]/.test(word)) out.add(word.slice(1));
  for (const w of [...out]) {
    if (w.length > 4 && /יימ$/.test(w)) out.add(w.slice(0, -3)); // dual: רגליים → רגל
    if (w.length > 4 && /(ימ|ות)$/.test(w)) out.add(w.slice(0, -2));
    if (w.length > 3 && /[הת]$/.test(w)) out.add(w.slice(0, -1));
  }
  return [...out].filter((s) => s.length >= 3 || s === word);
}

export function matches(query: string, ...fields: (string | undefined | null)[]): boolean {
  const q = normalize(query);
  if (!q) return true;
  const hay = normalize(fields.filter(Boolean).join(' '));
  return q.split(' ').every((part) => stems(part).some((s) => hay.includes(s)));
}

export function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

export function deepClone<T>(v: T): T {
  return typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v));
}

export function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}

export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : `${n} ${many}`;
}

export function roundTo(n: number, step: number): number {
  if (!step) return Math.round(n * 10) / 10;
  return Math.round(n / step) * step;
}

export function blockLabel(index: number): string {
  return String.fromCharCode(65 + (index % 26));
}
