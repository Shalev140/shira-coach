import { isIOS, isStandalone } from './install';

declare const __APP_VERSION__: string;

/**
 * Anonymous usage counter: one ping when the app opens, and one when it comes back to the
 * foreground after a long break (an iPhone home-screen app is usually resumed, not reopened).
 * A ping holds only a random id for this device, the platform, whether the app runs from the
 * home screen, and the app version. Nothing about clients or workouts ever leaves the device.
 */
export const USAGE_URL = 'https://n8n.srv1070239.hstgr.cloud/webhook/shira-coach-usage';
export const RESUME_GAP_MS = 30 * 60 * 1000;
const DEVICE_KEY = 'usage:device';
const LAST_KEY = 'usage:last';
const OFF_KEY = 'usage:off';

export type UsageEvent = 'open' | 'resume';
export type Platform = 'ios' | 'android' | 'windows' | 'mac' | 'other';

export function platformOf(userAgent: string, ios: boolean): Platform {
  if (ios) return 'ios';
  if (/android/i.test(userAgent)) return 'android';
  if (/windows/i.test(userAgent)) return 'windows';
  if (/macintosh|mac os x/i.test(userAgent)) return 'mac';
  return 'other';
}

/** A resume counts only after a long break; every real open counts. */
export function shouldPing(event: UsageEvent, lastSent: number, now: number): boolean {
  return event === 'open' || now - lastSent >= RESUME_GAP_MS;
}

/** `?count=off` stops counting this device (and the report drops its earlier visits); `?count=on` resumes. */
export function countingChoice(search: string): 'off' | 'on' | null {
  const v = new URLSearchParams(search).get('count');
  return v === 'off' || v === 'on' ? v : null;
}

export function buildPing(event: UsageEvent | 'optout', device: string, platform: Platform, standalone: boolean, version: string): URLSearchParams {
  return new URLSearchParams({ e: event, d: device, p: platform, s: standalone ? '1' : '0', v: version });
}

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const h = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20)}`;
}

/** Random per-device id (storage can be blocked — then each launch just gets a fresh one). */
function deviceId(): string {
  try {
    const cur = localStorage.getItem(DEVICE_KEY);
    if (cur && /^[0-9a-f-]{36}$/i.test(cur)) return cur;
    const id = newId();
    localStorage.setItem(DEVICE_KEY, id);
    return id;
  } catch {
    return newId();
  }
}

function lastSent(): number {
  try {
    return Number(localStorage.getItem(LAST_KEY)) || 0;
  } catch {
    return 0;
  }
}

function send(event: UsageEvent): void {
  const now = Date.now();
  if (!shouldPing(event, lastSent(), now)) return;
  try {
    localStorage.setItem(LAST_KEY, String(now));
  } catch {
    /* ignore */
  }
  post(event);
}

function post(event: UsageEvent | 'optout'): void {
  const body = buildPing(
    event,
    deviceId(),
    platformOf(navigator.userAgent, isIOS()),
    isStandalone(),
    typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev',
  );
  try {
    // a form-encoded beacon needs no CORS preflight and survives the app being closed right away
    if (navigator.sendBeacon?.(USAGE_URL, body)) return;
  } catch {
    /* fall through */
  }
  fetch(USAGE_URL, { method: 'POST', body, mode: 'no-cors', keepalive: true }).catch(() => {});
}

/** Counts only the published app — never the dev server, previews or tests. */
export function startUsageCounter(): void {
  if (typeof window === 'undefined' || location.hostname !== 'shalev140.github.io') return;
  const choice = countingChoice(location.search);
  try {
    if (choice === 'off') localStorage.setItem(OFF_KEY, '1');
    if (choice === 'on') localStorage.removeItem(OFF_KEY);
  } catch {
    /* ignore */
  }
  if (choice === 'off') return post('optout');
  try {
    if (localStorage.getItem(OFF_KEY) === '1') return;
  } catch {
    /* ignore */
  }
  send('open');
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') send('resume');
  });
}
