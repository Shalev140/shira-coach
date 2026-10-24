// Generates the PWA icons (PNG) and icon.svg into public/ — no dependencies.
// Run: node scripts/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const BG_A = [0x6a, 0x5c, 0xff];
const BG_B = [0x44, 0x33, 0xd6];
const LIME = [0xc6, 0xf2, 0x5a];
// bars in a 24×24 design space (same as the in-app brand mark)
const BARS = [
  { x: 3, y: 12, w: 4.2, h: 9, c: [255, 255, 255], a: 0.55 },
  { x: 9.9, y: 7.5, w: 4.2, h: 13.5, c: [255, 255, 255], a: 0.85 },
  { x: 16.8, y: 3, w: 4.2, h: 18, c: LIME, a: 1 },
];

function inRoundRect(px, py, x, y, w, h, r) {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

function render(size, { maskable }) {
  const px = Buffer.alloc(size * size * 4);
  const S = 4; // supersampling
  const radius = maskable ? 0 : size * 0.225;
  // artwork occupies the safe zone (maskable icons get cropped to a circle)
  const art = maskable ? size * 0.56 : size * 0.62;
  const off = (size - art) / 2;
  const k = art / 24;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const fx = x + (sx + 0.5) / S;
          const fy = y + (sy + 0.5) / S;
          if (!inRoundRect(fx, fy, 0, 0, size, size, radius)) continue;
          const t = (fx + fy) / (2 * size);
          let c = BG_A.map((v, i) => v + (BG_B[i] - v) * t);
          for (const bar of BARS) {
            if (inRoundRect(fx, fy, off + bar.x * k, off + bar.y * k, bar.w * k, bar.h * k, (bar.w * k) / 2)) {
              c = c.map((v, i) => v * (1 - bar.a) + bar.c[i] * bar.a);
            }
          }
          r += c[0];
          g += c[1];
          b += c[2];
          a += 1;
        }
      }
      const n = S * S;
      const i = (y * size + x) * 4;
      if (a) {
        px[i] = Math.round(r / a);
        px[i + 1] = Math.round(g / a);
        px[i + 2] = Math.round(b / a);
      }
      px[i + 3] = Math.round((a / n) * 255);
    }
  }
  return png(size, size, px);
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync('public/icons', { recursive: true });
writeFileSync('public/icons/icon-192.png', render(192, { maskable: false }));
writeFileSync('public/icons/icon-512.png', render(512, { maskable: false }));
writeFileSync('public/icons/maskable-512.png', render(512, { maskable: true }));
writeFileSync('public/icons/apple-touch-icon.png', render(180, { maskable: true }));
writeFileSync(
  'public/icon.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6A5CFF"/><stop offset="1" stop-color="#4433D6"/></linearGradient></defs><rect width="64" height="64" rx="14" fill="url(#g)"/><g transform="translate(12.2 12.2) scale(1.65)"><rect x="3" y="12" width="4.2" height="9" rx="2.1" fill="#fff" opacity=".55"/><rect x="9.9" y="7.5" width="4.2" height="13.5" rx="2.1" fill="#fff" opacity=".85"/><rect x="16.8" y="3" width="4.2" height="18" rx="2.1" fill="#C6F25A"/></g></svg>\n`,
);
console.log('icons written');
