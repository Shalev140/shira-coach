import { afterEach, describe, expect, it, vi } from 'vitest';
import { iosVersion } from './install';

const device = (userAgent: string, platform = '', maxTouchPoints = 0) =>
  vi.stubGlobal('navigator', { userAgent, platform, maxTouchPoints });
afterEach(() => vi.unstubAllGlobals());

describe('iOS version (decides the screen-lock hint for home-screen apps before iOS 18.4)', () => {
  it('reads an iPhone, also as an installed home-screen app (no Safari version in its user agent)', () => {
    device('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148');
    expect(iosVersion()).toEqual([17, 4]);
  });

  it('reads an iPad that presents itself as a Mac', () => {
    device('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15', 'MacIntel', 5);
    expect(iosVersion()).toEqual([18, 3]);
  });

  it('is null on Android and on a real Mac', () => {
    device('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36');
    expect(iosVersion()).toBeNull();
    device('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15', 'MacIntel', 0);
    expect(iosVersion()).toBeNull();
  });
});
