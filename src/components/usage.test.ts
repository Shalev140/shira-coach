import { describe, expect, it } from 'vitest';
import { buildPing, countingChoice, platformOf, RESUME_GAP_MS, shouldPing } from './usage';

describe('usage counter (anonymous visit pings)', () => {
  it('names the platform without sending the user agent', () => {
    expect(platformOf('anything', true)).toBe('ios');
    expect(platformOf('Mozilla/5.0 (Linux; Android 14; Pixel 8)', false)).toBe('android');
    expect(platformOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', false)).toBe('windows');
    expect(platformOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', false)).toBe('mac');
    expect(platformOf('Mozilla/5.0 (X11; Linux x86_64)', false)).toBe('other');
  });

  it('counts every open, but a resume only after a long break', () => {
    const now = 10 * RESUME_GAP_MS;
    expect(shouldPing('open', now - 1000, now)).toBe(true);
    expect(shouldPing('resume', now - 1000, now)).toBe(false);
    expect(shouldPing('resume', now - RESUME_GAP_MS, now)).toBe(true);
    expect(shouldPing('resume', 0, now)).toBe(true);
  });

  it('reads the per-device on/off switch from the address', () => {
    expect(countingChoice('?count=off')).toBe('off');
    expect(countingChoice('?x=1&count=on')).toBe('on');
    expect(countingChoice('?count=maybe')).toBeNull();
    expect(countingChoice('')).toBeNull();
  });

  it('sends only the event, device id, platform, home-screen flag and version', () => {
    const p = buildPing('open', '3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f', 'ios', true, '1.1.0');
    expect([...p.keys()].sort()).toEqual(['d', 'e', 'p', 's', 'v']);
    expect(p.toString()).toBe('e=open&d=3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f&p=ios&s=1&v=1.1.0');
  });
});
