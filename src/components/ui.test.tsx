import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChipToggle, CommitInput, Field, NumInput, Rating, Seg, Stepper } from './ui';

const noop = () => {};
const attr = (html: string, re: RegExp) => html.match(re)?.[1] ?? '';
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The rendered <input> carries this id (attribute order does not matter). */
const inputWithId = (id: string) => new RegExp(`<input[^>]*\\sid="${esc(id)}"`);

describe('Field', () => {
  // A wrapping <label> forwards taps on its caption / hint to its first labelable
  // descendant — the first Seg option, Rating "1" or Stepper "+" — silently changing data.
  it('never wraps button controls in a <label>; they get a named group instead', () => {
    for (const control of [
      <Seg value="a" options={[{ value: 'a', label: 'א' }, { value: 'b', label: 'ב' }]} onChange={noop} />,
      <Rating value={null} onChange={noop} low="נמוכה" high="גבוהה" />,
      <div className="row">
        <button type="button">בחירת תרגיל</button>
      </div>,
    ]) {
      const html = renderToStaticMarkup(
        <Field label="מקדם עקיף" hint="הסבר">
          {control}
        </Field>,
      );
      expect(html).not.toContain('<label');
      expect(html.startsWith('<div class="field" role="group"')).toBe(true);
      const labelledBy = attr(html, /aria-labelledby="([^"]+)"/);
      expect(labelledBy).toBeTruthy();
      expect(html).toContain(`<span class="label" id="${labelledBy}">מקדם עקיף`);
      const describedBy = attr(html, /<div class="field"[^>]*aria-describedby="([^"]+)"/);
      expect(html).toContain(`<span class="hint" id="${describedBy}">הסבר</span>`);
    }
  });

  it('links the caption to a single native input with htmlFor, and the hint with aria-describedby', () => {
    const html = renderToStaticMarkup(
      <Field label="שם" optional hint="מופרדים בפסיק">
        <input className="input" value="" onChange={noop} />
      </Field>,
    );
    expect(html.startsWith('<div class="field">')).toBe(true);
    const forId = attr(html, /<label class="label" for="([^"]+)"/);
    expect(forId).toBeTruthy();
    expect(html).toMatch(inputWithId(forId));
    expect(html).toContain('(רשות)');
    const hintId = attr(html, /<span class="hint" id="([^"]+)"/);
    expect(html).toContain(`aria-describedby="${hintId}"`);
    // The label wraps only the caption, not the control.
    expect(html.indexOf('</label>')).toBeLessThan(html.indexOf('<input'));
  });

  it('labels the input inside Stepper / NumInput / CommitInput, not their buttons', () => {
    for (const control of [
      <Stepper value={90} onChange={noop} />,
      <NumInput value={2.5} onChange={noop} />,
      <CommitInput value="שירה" onCommit={noop} />,
    ]) {
      const html = renderToStaticMarkup(<Field label="מנוחה">{control}</Field>);
      const forId = attr(html, /<label class="label" for="([^"]+)"/);
      expect(forId).toBeTruthy();
      expect(html).toMatch(inputWithId(forId));
      expect(html).not.toContain('role="group"');
    }
  });

  it('keeps an id the caller already gave the input', () => {
    const html = renderToStaticMarkup(
      <Field label="תאריך">
        <input id="due" type="date" />
      </Field>,
    );
    expect(html).toContain('<label class="label" for="due">');
    expect(html).toMatch(inputWithId('due'));
  });
});

describe('selection state is exposed to assistive tech', () => {
  it('Seg marks only the active option as pressed and is not a bare tablist', () => {
    const html = renderToStaticMarkup(
      <Seg value={0.5} options={[{ value: 0, label: 'לא לספור' }, { value: 0.5, label: 'חצי' }, { value: 1, label: 'מלא' }]} onChange={noop} />,
    );
    expect(html).not.toContain('tablist');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(2);
    expect(html).toMatch(/class="on" aria-pressed="true">חצי</);
  });

  it('ChipToggle marks selected chips as pressed', () => {
    const html = renderToStaticMarkup(
      <ChipToggle value={['b']} options={[{ value: 'a', label: 'א' }, { value: 'b', label: 'ב' }]} onChange={noop} />,
    );
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-pressed="true"[^>]*>ב</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>א</);
  });
});
