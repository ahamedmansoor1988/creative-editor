/* Gradient Stripe engine
 * Ported from the Gradient Stripe Generator Figma plugin
 * (~/Documents/2026_Files/My-Scripts/gradient-plugin).
 *
 * The look: the box is cut into horizontal bands. Each band is split left/right
 * at a point that drifts band by band, the left side ramps through gradient 1
 * and the right through gradient 2, and each band advances the stop positions
 * by `phase` so successive bands are progressively offset versions of the same
 * two ramps. Mirroring folds the result.
 *
 * The plugin sampled the gradient once PER PIXEL, and each of those samples
 * copied and sorted the stop array. At the 448x200 preview size that is fine;
 * at page size it is hundreds of thousands of array sorts per redraw. Here the
 * stop array is resolved once per band and the pixel loop walks it with a
 * cursor, and since every row inside a band is identical only the first row is
 * computed and the rest are copyWithin'd. Pixel-identical to the plugin.
 */
(function(){
'use strict';

const MAX_DIM = 4096;   // guard: a rogue size must not allocate gigabytes
const CACHE_MAX = 32;

const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;

function hexToRgb(hex){
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  const n = m ? parseInt(m[1], 16) : 0x888888;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hslToHex(h, s, l){
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = n => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function hexToHsl(hex){
  const [r, g, b] = hexToRgb(hex).map(v => v / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  const l = (mx + mn) / 2;
  let h = 0, s = 0;
  if (d > 0){
    s = d / (1 - Math.abs(2 * l - 1));
    h = mx === r ? ((g - b) / d + (g < b ? 6 : 0))
      : mx === g ? ((b - r) / d + 2)
      :            ((r - g) / d + 4);
    h *= 60;
  }
  return [h, s * 100, l * 100];
}

/* One band's ramp, resolved once: hex decoded, positions offset by
 * (phase + shift) and CLAMPED to [0,1], then sorted. Clamping is monotonic so
 * the order survives it, and once the offset exceeds the span every stop pins
 * to the same end and the band goes flat — that run-out is part of the original
 * look, and the Bounce toggle in the panel is the way out of it.
 *
 * This is the whole optimisation: the plugin rebuilt and re-sorted this array
 * inside the pixel loop. Hoisting it to once per band is what makes the effect
 * usable at page size. The pixel loop below still evaluates the EXACT u for
 * each column rather than sampling a quantised table — clamping regularly
 * stacks two stops on the same position, which puts a step discontinuity in the
 * ramp, and a table lookup can land a pixel on the wrong side of that step. */
function mapStops(stops, t, shift){
  return stops.map(s => ({ rgb: hexToRgb(s.color), pos: clamp01((+s.pos || 0) + t + shift) }))
              .sort((a, b) => a.pos - b.pos);
}

/* Writes span pixels of `m`'s ramp into d starting at byte `at`, with u running
 * i/span for i in [0,span) — the plugin's exact parameterisation. The segment
 * cursor never rewinds because u only increases. */
function writeRamp(d, at, span, m){
  const first = m[0], last = m[m.length - 1], nSeg = m.length - 2;
  let seg = 0, o = at;
  for (let i = 0; i < span; i++){
    const u = i / span;
    let r, g, b;
    if (u <= first.pos){ r = first.rgb[0]; g = first.rgb[1]; b = first.rgb[2]; }
    else if (u >= last.pos){ r = last.rgb[0]; g = last.rgb[1]; b = last.rgb[2]; }
    else {
      while (seg < nSeg && u > m[seg + 1].pos) seg++;
      const a = m[seg], c = m[seg + 1];
      const range = c.pos - a.pos;
      const f = range > 0 ? (u - a.pos) / range : 0;
      r = a.rgb[0] + (c.rgb[0] - a.rgb[0]) * f;
      g = a.rgb[1] + (c.rgb[1] - a.rgb[1]) * f;
      b = a.rgb[2] + (c.rgb[2] - a.rgb[2]) * f;
    }
    d[o] = (r + 0.5) | 0; d[o + 1] = (g + 0.5) | 0; d[o + 2] = (b + 0.5) | 0; d[o + 3] = 255;
    o += 4;
  }
}

/* Triangle wave in [-0.5, 0.5], period 2. Keeps the per-band phase cycling
   instead of running off the end of the ramp and pinning flat. */
function bounce(x){
  const q = Math.abs(x) % 2;
  return (1 - Math.abs(q - 1)) - 0.5;
}

function renderBands(W, H, P){
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const img = g.createImageData(W, H);
  const d = img.data;

  const bandH = Math.max(1, Math.round(P.bandHeight));
  const base  = P.split / 100;
  const drift = P.drift / 100;
  const s1 = P.g1shift / 100, s2 = P.g2shift / 100;
  const ph = P.phase;
  const rowBytes = W * 4;

  let y = 0, i = 0;
  while (y < H){
    const sf = Math.max(0.05, Math.min(0.95, base + i * drift));
    const splitX = Math.round(W * sf);
    const t = P.bounce ? bounce(i * ph) : i * ph;
    const h = Math.min(bandH, H - y);
    const rowStart = y * rowBytes;
    const rightSpan = W - splitX;
    if (splitX > 0)    writeRamp(d, rowStart, splitX, mapStops(P.g1, t, s1));
    if (rightSpan > 0) writeRamp(d, rowStart + splitX * 4, rightSpan, mapStops(P.g2, t, s2));
    // every row in a band is identical — stamp the first one down the band
    for (let row = 1; row < h; row++)
      d.copyWithin(rowStart + row * rowBytes, rowStart, rowStart + rowBytes);

    y += h; i++;
  }

  if (P.mirrorX){
    const half = W >> 1;
    for (let row = 0; row < H; row++){
      const rs = row * rowBytes;
      for (let col = 0; col < half; col++){
        const s = rs + col * 4, t2 = rs + (W - col - 1) * 4;
        d[t2] = d[s]; d[t2 + 1] = d[s + 1]; d[t2 + 2] = d[s + 2]; d[t2 + 3] = d[s + 3];
      }
    }
  }
  if (P.mirrorY){
    for (let row = 0; row < (H >> 1); row++)
      d.copyWithin((H - row - 1) * rowBytes, row * rowBytes, row * rowBytes + rowBytes);
  }

  g.putImageData(img, 0, 0);
  return cv;
}

/* Angle is applied by rendering the bands into a square the size of the box's
   diagonal and rotating that about the centre — a diagonal-sized square always
   still covers the box at any angle, so no corner can come up empty. */
function render(w, h, P){
  const W = Math.max(1, Math.min(MAX_DIM, Math.round(w)));
  const H = Math.max(1, Math.min(MAX_DIM, Math.round(h)));
  const ang = ((P.angle || 0) % 360) * Math.PI / 180;
  if (!ang) return renderBands(W, H, P);
  const D = Math.min(MAX_DIM, Math.ceil(Math.hypot(W, H)));
  const src = renderBands(D, D, P);
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.translate(W / 2, H / 2);
  g.rotate(ang);
  g.drawImage(src, -D / 2, -D / 2);
  return cv;
}

/* LRU by insertion order. render() runs on every drag frame and pattern
   instances ask for several sizes of the same params, so without this the
   editor would re-solve the whole image per pointer move. */
const cache = new Map();
function get(w, h, P){
  const W = Math.max(1, Math.min(MAX_DIM, Math.round(w)));
  const H = Math.max(1, Math.min(MAX_DIM, Math.round(h)));
  const k = W + 'x' + H + '|' + JSON.stringify(P);
  const hit = cache.get(k);
  if (hit){ cache.delete(k); cache.set(k, hit); return hit; }
  const cv = render(W, H, P);
  cache.set(k, cv);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return cv;
}

/* ---- colour helpers for the panel ---- */
function randomColor(){
  return hslToHex(Math.random() * 360, 55 + Math.random() * 45, 38 + Math.random() * 32);
}
function randomStops(count){
  const n = Math.max(2, count || 3);
  return Array.from({ length: n }, (_, i) => ({ color: randomColor(), pos: i / (n - 1) }));
}

/* Seed both ramps from whatever fill the object already has, so the user's
   "add object, pick a colour, apply the effect" path lands on their colour
   rather than on the plugin's blue/orange defaults. */
function seedFromFill(fill){
  let base;
  if (fill && fill.kind !== 'solid' && fill.stops && fill.stops.length >= 2){
    base = fill.stops.map(s => ({ color: s.color, pos: clamp01(+s.pos || 0) }))
                     .sort((a, b) => a.pos - b.pos);
  } else {
    const c = (fill && (fill.color || (fill.stops && fill.stops[0] && fill.stops[0].color))) || '#cccccc';
    const [h, s, l] = hexToHsl(c);
    base = [
      { color: c, pos: 0 },
      { color: hslToHex((h + 30) % 360, Math.min(100, s + 10), Math.min(90, l + 18)), pos: 0.5 },
      { color: hslToHex((h + 60) % 360, s, Math.max(12, l - 16)), pos: 1 },
    ];
  }
  // Second ramp: the same colours running the other way with the hue swung
  // across the wheel, which is what gives the two halves of a band contrast.
  const g2 = base.slice().reverse().map((s, i, a) => {
    const [h, sa, l] = hexToHsl(s.color);
    return { color: hslToHex((h + 175) % 360, sa, l), pos: a.length === 1 ? 0.5 : i / (a.length - 1) };
  });
  return { g1: base.map(s => ({ ...s })), g2 };
}

/* The plugin's eight built-ins, verbatim. */
const PRESETS = [
  { name: 'Sunset', g1: [{color:'#ff6b35',pos:0},{color:'#f7c59f',pos:0.5},{color:'#efefd0',pos:1}], g2: [{color:'#004e89',pos:0},{color:'#1a936f',pos:0.5},{color:'#88d498',pos:1}] },
  { name: 'Ocean',  g1: [{color:'#03045e',pos:0},{color:'#0096c7',pos:0.5},{color:'#90e0ef',pos:1}], g2: [{color:'#023e8a',pos:0},{color:'#00b4d8',pos:0.5},{color:'#caf0f8',pos:1}] },
  { name: 'Neon',   g1: [{color:'#ff00ff',pos:0},{color:'#7700ff',pos:0.5},{color:'#00ffff',pos:1}], g2: [{color:'#00ff88',pos:0},{color:'#ffdd00',pos:0.5},{color:'#ff0055',pos:1}] },
  { name: 'Ember',  g1: [{color:'#240000',pos:0},{color:'#900000',pos:0.4},{color:'#ff4500',pos:1}], g2: [{color:'#ff4500',pos:0},{color:'#ffcc00',pos:0.6},{color:'#fffbe6',pos:1}] },
  { name: 'Aurora', g1: [{color:'#0d0221',pos:0},{color:'#0a7b6c',pos:0.5},{color:'#6dffa3',pos:1}], g2: [{color:'#6dffa3',pos:0},{color:'#7b2fff',pos:0.5},{color:'#0d0221',pos:1}] },
  { name: 'Dusk',   g1: [{color:'#2d1b69',pos:0},{color:'#c47aff',pos:0.5},{color:'#ffd6e0',pos:1}], g2: [{color:'#ffd6e0',pos:0},{color:'#ff6b9d',pos:0.5},{color:'#2d1b69',pos:1}] },
  { name: 'Arctic', g1: [{color:'#e8f4fd',pos:0},{color:'#a8d8ea',pos:0.5},{color:'#4a90d9',pos:1}], g2: [{color:'#4a90d9',pos:0},{color:'#2c5282',pos:0.5},{color:'#1a2a4a',pos:1}] },
  { name: 'Acid',   g1: [{color:'#00ff00',pos:0},{color:'#aaff00',pos:0.5},{color:'#ffff00',pos:1}], g2: [{color:'#ff00aa',pos:0},{color:'#aa00ff',pos:0.5},{color:'#0000ff',pos:1}] },
];

window.GradientEngine = {
  get, render, PRESETS,
  randomColor, randomStops, seedFromFill,
  available: () => true,
  MAX_STOPS: 6,
};
})();
