import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lockBodyScroll } from './ui';

/** The tests run without a DOM: a bare body style is all the lock touches. */
let body: { style: { overflow: string } };
beforeEach(() => {
  body = { style: { overflow: '' } };
  vi.stubGlobal('document', { body });
});
afterEach(() => vi.unstubAllGlobals());

describe('sheet scroll lock', () => {
  it('locks the page while a sheet is open and restores it on close', () => {
    const release = lockBodyScroll();
    expect(body.style.overflow).toBe('hidden');
    release();
    expect(body.style.overflow).toBe('');
  });

  // Closing an outer sheet and the sheet opened from it in one commit runs the outer
  // cleanup first. A per-sheet saved value let the inner sheet restore 'hidden' last,
  // and the whole app stopped scrolling until reload.
  it('scrolls again after nested sheets close in either order', () => {
    for (const order of ['outer-first', 'inner-first'] as const) {
      const outer = lockBodyScroll();
      const inner = lockBodyScroll();
      expect(body.style.overflow).toBe('hidden');
      if (order === 'outer-first') {
        outer();
        expect(body.style.overflow).toBe('hidden'); // the inner sheet is still open
        inner();
      } else {
        inner();
        expect(body.style.overflow).toBe('hidden');
        outer();
      }
      expect(body.style.overflow).toBe('');
    }
  });

  it('survives re-locking while open (a parent re-render) and double releases', () => {
    const outer = lockBodyScroll();
    let inner = lockBodyScroll();
    inner();
    inner = lockBodyScroll();
    outer();
    outer(); // a second release of the same sheet counts once
    expect(body.style.overflow).toBe('hidden');
    inner();
    expect(body.style.overflow).toBe('');
  });

  it('restores whatever the page had before the first sheet opened', () => {
    body.style.overflow = 'auto';
    const a = lockBodyScroll();
    const b = lockBodyScroll();
    a();
    b();
    expect(body.style.overflow).toBe('auto');
  });
});
