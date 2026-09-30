/* UI screen -> editable layers.
 *
 * WHAT IT DOES. A screenshot of a software screen becomes a page of ordinary
 * layers — panels, boxes (cards, buttons, chips), live text and icons — that
 * can be edited like anything drawn by hand.
 *
 * WHO DOES WHAT. The model READS and the pixels MEASURE. On the free tier a
 * vision model may write about 1,000 tokens a minute, so it is asked for the
 * least it must supply: what is where (roughly, in percent), the words
 * verbatim, and which things are bold, rounded or icons. Everything a model
 * guesses badly is taken from the picture instead:
 *   - box edges are SNAPPED to the strongest colour step near the guess;
 *   - text is fitted to its INK, which gives the true position and a font
 *     size from the ink height;
 *   - every colour is MEASURED (median fill, ink colour, border colour).
 * Two readings: one for the panels, then one per panel on a crop of it, so a
 * dense screen is read at a size where small text is legible and each reply
 * stays under the output ceiling.
 *
 * Everything here is pure: it takes an ImageData-like {data,width,height} and
 * plain objects, so it is tested without a browser.
 */
(function () {
  "use strict";

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /* ---- the two replies ------------------------------------------------ */

  /** `P x y w h name` lines -> panels in percent. Unparseable lines are
   *  skipped, so a reply cut off mid-line still yields what came before. */
  function parseRegions(text) {
    const out = [];
    String(text || "")
      .split(/\r?\n/)
      .forEach((ln) => {
        const m = ln.trim().match(/^(?:P\s+)?(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*(.*)$/i);
        if (!m) return;
        const r = { x: +m[1], y: +m[2], w: +m[3], h: +m[4], name: (m[5] || "Panel").trim().slice(0, 40) || "Panel" };
        r.x = clamp(r.x, 0, 100);
        r.y = clamp(r.y, 0, 100);
        r.w = clamp(r.w, 1, 100 - r.x);
        r.h = clamp(r.h, 1, 100 - r.y);
        out.push(r);
      });
    return out.slice(0, 12);
  }

  /** `B x y w h r` / `T x y w h s text` / `I x y w h name` lines -> items in
   *  percent of the panel crop. */
  function parseItems(text) {
    const out = [];
    const N = "(-?\\d+(?:\\.\\d+)?)";
    const reB = new RegExp(`^B\\s+${N}\\s+${N}\\s+${N}\\s+${N}\\s+(\\d)`, "i");
    const reT = new RegExp(`^T\\s+${N}\\s+${N}\\s+${N}\\s+${N}\\s+([01])\\s+(.+)$`, "i");
    const reI = new RegExp(`^I\\s+${N}\\s+${N}\\s+${N}\\s+${N}\\s*([\\w-]*)`, "i");
    String(text || "")
      .split(/\r?\n/)
      .forEach((raw) => {
        const ln = raw.trim().replace(/^[-*]\s+/, "");
        let m;
        if ((m = ln.match(reB))) out.push({ kind: "box", x: +m[1], y: +m[2], w: +m[3], h: +m[4], r: clamp(+m[5], 0, 3) });
        else if ((m = ln.match(reT))) out.push({ kind: "text", x: +m[1], y: +m[2], w: +m[3], h: +m[4], bold: m[5] === "1", text: m[6].trim() });
        else if ((m = ln.match(reI))) out.push({ kind: "icon", x: +m[1], y: +m[2], w: +m[3], h: +m[4], name: (m[5] || "").toLowerCase() });
      });
    return out.filter((it) => it.w > 0 && it.h > 0).slice(0, 120);
  }

  /* ---- measuring ------------------------------------------------------ */

  function px(img, x, y) {
    const xi = clamp(Math.round(x), 0, img.width - 1),
      yi = clamp(Math.round(y), 0, img.height - 1);
    const i = (yi * img.width + xi) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
  }
  const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  const hex = (c) =>
    "#" +
    c
      .map((v) =>
        clamp(Math.round(v), 0, 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("");

  /** Per-channel median over a rectangle, sampled on a grid (cheap, and a
   *  median ignores the text and icons sitting on a fill). */
  function medianColor(img, x, y, w, h, step) {
    const s = step || Math.max(1, Math.floor(Math.min(w, h) / 12));
    const R = [],
      G = [],
      B = [];
    for (let yy = y; yy < y + h; yy += s)
      for (let xx = x; xx < x + w; xx += s) {
        const c = px(img, xx, yy);
        R.push(c[0]);
        G.push(c[1]);
        B.push(c[2]);
      }
    if (!R.length) return px(img, x, y);
    const med = (a) => a.sort((p, q) => p - q)[a.length >> 1];
    return [med(R), med(G), med(B)];
  }

  /** Average colour of a column (or row) segment. */
  function lineMean(img, vertical, at, from, to) {
    let r = 0,
      g = 0,
      b = 0,
      n = 0;
    const step = Math.max(1, Math.floor((to - from) / 24));
    for (let t = from; t <= to; t += step) {
      const c = vertical ? px(img, at, t) : px(img, t, at);
      r += c[0];
      g += c[1];
      b += c[2];
      n++;
    }
    return n ? [r / n, g / n, b / n] : [0, 0, 0];
  }

  /** Move one edge to where the box's own FILL begins, nearest the guess.
   *  Not the strongest colour step: a line of text inside a card is a far
   *  stronger step than the card's edge, and "strongest" snapped the card's
   *  top down onto its title. An edge is a line that matches the fill with a
   *  line outside it that does not. `outside` is -1 for left/top, +1 for
   *  right/bottom. Returns the edge coordinate (exclusive end for +1), or the
   *  guess when nothing qualifies. */
  function snapEdge(img, vertical, guess, from, to, reach, fill, outside) {
    const tol = 30;
    let best = null;
    const lim = (vertical ? img.width : img.height) - 1;
    for (let p = Math.max(1, Math.round(guess - reach)); p <= Math.min(lim, Math.round(guess + reach)); p++) {
      const inner = outside < 0 ? p : p - 1,
        outer = outside < 0 ? p - 1 : p;
      if (dist(lineMean(img, vertical, inner, from, to), fill) >= tol) continue;
      if (dist(lineMean(img, vertical, outer, from, to), fill) < tol) continue;
      if (best === null || Math.abs(p - guess) < Math.abs(best - guess)) best = p;
    }
    return best === null ? { at: Math.round(guess), border: null } : withBorder(img, vertical, best, from, to, fill, outside);
  }

  /** A one-pixel line just outside the fill that also differs from what lies
   *  beyond it is a BORDER: the box grows by that pixel and reports its colour. */
  function withBorder(img, vertical, at, from, to, fill, outside) {
    const lineAt = outside < 0 ? at - 1 : at; // first line outside the fill
    const beyond = lineAt + outside;
    const lim = (vertical ? img.width : img.height) - 1;
    if (beyond < 0 || beyond > lim) return { at, border: null };
    const a = lineMean(img, vertical, lineAt, from, to),
      b = lineMean(img, vertical, beyond, from, to);
    if (dist(a, fill) > 30 && dist(a, b) > 30) return { at: at + outside, border: a };
    return { at, border: null };
  }

  /** A box guessed in pixels -> its measured edges, fill and border. */
  function refineBox(img, b, seed) {
    // how far an edge may move: the model's width errs more than its height
    const reachX = Math.max(3, Math.min(40, Math.round(b.w * 0.3))),
      reachY = Math.max(3, Math.min(20, Math.round(b.h * 0.3)));
    const fill = seed || medianColor(img, b.x + b.w * 0.2, b.y + b.h * 0.2, Math.max(1, b.w * 0.6), Math.max(1, b.h * 0.6));
    const y0 = b.y + b.h * 0.2,
      y1 = b.y + b.h * 0.8,
      x0 = b.x + b.w * 0.2,
      x1 = b.x + b.w * 0.8;
    const L = snapEdge(img, true, b.x, y0, y1, reachX, fill, -1);
    const R = snapEdge(img, true, b.x + b.w, y0, y1, reachX, fill, 1);
    const T = snapEdge(img, false, b.y, x0, x1, reachY, fill, -1);
    const Bm = snapEdge(img, false, b.y + b.h, x0, x1, reachY, fill, 1);
    const out = { x: L.at, y: T.at, w: Math.max(2, R.at - L.at), h: Math.max(1, Bm.at - T.at) };
    if (out.w < b.w * 0.5 || out.h < b.h * 0.5) Object.assign(out, { x: b.x, y: b.y, w: b.w, h: b.h }); // a snap that collapses the box is wrong
    out.fill = fill;
    const borders = [L, R, T, Bm].map((e) => e.border).filter(Boolean);
    out.border = borders.length >= 3 ? [0, 1, 2].map((k) => borders.reduce((s2, c) => s2 + c[k], 0) / borders.length) : null;
    return out;
  }

  const DESCENDERS = /[gjpqy,;()[\]{}|@_]/;

  /** A text line guessed in pixels -> the box its INK occupies, the ink colour
   *  and the font size that ink implies. */
  function refineText(img, t, text, tight) {
    // a measured ink box needs no search margin; a guess does, but the margin
    // is where a neighbouring border or line gets in
    const padX = tight ? 3 : Math.max(4, t.w * 0.12),
      padY = tight ? 2 : Math.max(2, t.h * 0.3);
    const ax = clamp(Math.floor(t.x - padX), 0, img.width - 1),
      ay = clamp(Math.floor(t.y - padY), 0, img.height - 1);
    const bx = clamp(Math.ceil(t.x + t.w + padX), ax + 1, img.width),
      by = clamp(Math.ceil(t.y + t.h + padY), ay + 1, img.height);
    // background = median of the search box's rim
    const rim = [];
    for (let x = ax; x < bx; x += 2) rim.push(px(img, x, ay), px(img, x, by - 1));
    for (let y = ay; y < by; y += 2) rim.push(px(img, ax, y), px(img, bx - 1, y));
    const med = (k) => rim.map((c) => c[k]).sort((p, q) => p - q)[rim.length >> 1];
    const bg = [med(0), med(1), med(2)];
    let minX = 1e9,
      minY = 1e9,
      maxX = -1,
      maxY = -1,
      maxD = 0;
    const inks = [];
    for (let y = ay; y < by; y++)
      for (let x = ax; x < bx; x++) {
        const c = px(img, x, y),
          d = dist(c, bg);
        if (d > 90) {
          inks.push([c, d]);
          if (d > maxD) maxD = d;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    if (maxX < 0) {
      // no ink found: keep the guess, dark-on-light by default
      return { x: t.x, y: t.y, w: t.w, h: t.h, size: Math.max(8, t.h * 0.8), color: dist(bg, [0, 0, 0]) > 380 ? [17, 24, 39] : [240, 240, 240], bg };
    }
    // the ink colour is the strongest ink, not the anti-aliased fringe
    const strong = inks.filter(([, d]) => d >= maxD * 0.7);
    const col = [0, 1, 2].map((k) => strong.reduce((s, [c]) => s + c[k], 0) / strong.length);
    const inkH = maxY - minY + 1;
    // Inter: ascender-to-descender ink ~0.96em, cap/ascender only ~0.73em
    const size = clamp(inkH / (DESCENDERS.test(text || "") ? 0.96 : 0.74), 8, 300);
    return { x: minX, y: minY, w: maxX - minX + 1, h: inkH, size, color: col, bg };
  }

  /* ---- finding the words on the page ----------------------------------
   * The model's coordinates cannot be trusted as positions: measured on a real
   * screen, its y drifted ~15% by the bottom of a column (it reads a resized
   * copy) while its ORDER and its WORDS were right. So the pixels say where
   * text is and the model says what it says. inkSegments finds every run of
   * ink — text lines split into their separate groups — and alignTexts lays
   * the model's reading onto them. */

  /** Ink = a pixel that differs strongly from its neighbourhood mean, so text
   *  on any fill counts and the fills themselves do not. Long straight ink
   *  (box borders, dividers) is removed before lines are found, or one border
   *  would fuse a whole column into a single "line". */
  function inkSegments(img, rx, ry, rw, rh) {
    const x0 = Math.max(0, Math.floor(rx)),
      y0 = Math.max(0, Math.floor(ry));
    const w = Math.max(1, Math.min(img.width - x0, Math.round(rw))),
      h = Math.max(1, Math.min(img.height - y0, Math.round(rh)));
    /* Ink = a pixel far from the local BACKGROUND, taken as the local MEDIAN
     * of luminance: whatever most nearby pixels are. Two cheaper stand-ins
     * failed on real screens. The local mean: inside a line of text the gaps
     * between letters differ from it as much as the letters do, so sentences
     * read as solid ink and were erased as rules. The local brightest pixel:
     * a card's fill within reach of the white outside it read as ink. The
     * median is neither pulled by the letters nor by the edge. (Separable:
     * a row median, then a column median of those — close to the 2D one.) */
    const R = 7;
    const lum = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = ((y0 + y) * img.width + x0 + x) * 4;
        lum[y * w + x] = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
      }
    const buf = new Float32Array(2 * R + 1);
    const medPass = (src, horiz) => {
      const out = new Float32Array(w * h);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          let n = 0;
          for (let d = -R; d <= R; d++) {
            const xx = horiz ? x + d : x,
              yy = horiz ? y : y + d;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            // insertion into a small sorted buffer
            const q = src[yy * w + xx];
            let j = n++;
            while (j > 0 && buf[j - 1] > q) {
              buf[j] = buf[j - 1];
              j--;
            }
            buf[j] = q;
          }
          out[y * w + x] = buf[n >> 1];
        }
      return out;
    };
    const med = medPass(medPass(lum, true), false);
    const ink = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) if (Math.abs(lum[i] - med[i]) > 45) ink[i] = 1;
    // vertical lines: an unbroken run taller than any letter — a card's side
    // edge, not only a panel-length rule, or a selected card's outline is "text"
    const tallRun = 56;
    for (let x = 0; x < w; x++) {
      let run = 0;
      for (let y = 0; y <= h; y++) {
        if (y < h && ink[y * w + x]) run++;
        else {
          if (run > tallRun) for (let k = y - run; k < y; k++) ink[k * w + x] = 0;
          run = 0;
        }
      }
    }
    // horizontal lines: an unbroken run longer than any word
    const longRun = Math.max(60, w * 0.5);
    for (let y = 0; y < h; y++) {
      let run = 0;
      for (let x = 0; x <= w; x++) {
        if (x < w && ink[y * w + x]) run++;
        else {
          if (run > longRun) for (let k = x - run; k < x; k++) ink[y * w + k] = 0;
          run = 0;
        }
      }
    }
    // bands of inked rows (a one-row gap does not break a line)
    const rowInk = new Uint16Array(h);
    for (let y = 0; y < h; y++) {
      let n = 0;
      for (let x = 0; x < w; x++) n += ink[y * w + x];
      rowInk[y] = n;
    }
    const bands = [];
    let s0 = -1,
      gap = 0;
    for (let y = 0; y <= h; y++) {
      const on = y < h && rowInk[y] > 0;
      if (on) {
        if (s0 < 0) s0 = y;
        gap = 0;
      } else if (s0 >= 0 && ++gap > 1) {
        bands.push([s0, y - gap]);
        s0 = -1;
        gap = 0;
      }
    }
    // a band taller than one line is split at its thinnest rows: wrapped text
    // sits a few pixels apart, and those rows carry far less ink than a line
    const split = [];
    bands.forEach(([a, b]) => {
      if (b - a + 1 < 22) return split.push([a, b]);
      let peak = 0;
      for (let y = a; y <= b; y++) peak = Math.max(peak, rowInk[y]);
      let s1 = a;
      for (let y = a + 4; y <= b - 4; y++) {
        const low = rowInk[y] <= peak * 0.08 && rowInk[y] <= rowInk[y - 1] && rowInk[y] <= rowInk[y + 1];
        if (low && y - s1 >= 6) {
          split.push([s1, y - 1]);
          s1 = y + 1;
        }
      }
      split.push([s1, b]);
    });
    const segs = [];
    split.forEach(([a, b]) => {
      const bh = b - a + 1;
      if (bh < 4 || bh > 90) return;
      const col = new Uint8Array(w);
      for (let y = a; y <= b; y++) for (let x = 0; x < w; x++) if (ink[y * w + x]) col[x] = 1;
      // a word gap is ~0.3 of a line's height; the gap to an icon beside it is
      // more, and fusing the two sized the text to the icon
      const split = Math.max(5, bh * 0.55);
      let c0 = -1,
        last = -1;
      const close = (cA, cB) => {
        let ya = 1e9,
          yb = -1;
        for (let y = a; y <= b; y++)
          for (let x = cA; x <= cB; x++)
            if (ink[y * w + x]) {
              if (y < ya) ya = y;
              if (y > yb) yb = y;
            }
        if (yb >= ya && cB - cA >= 2) segs.push({ x: x0 + cA, y: y0 + ya, w: cB - cA + 1, h: yb - ya + 1 });
      };
      for (let x = 0; x < w; x++) {
        if (!col[x]) continue;
        if (c0 < 0) c0 = x;
        else if (x - last > split) {
          close(c0, last);
          c0 = x;
        }
        last = x;
      }
      if (c0 >= 0) close(c0, last);
    });
    return segs;
  }

  /** Least-squares line through pairs [m, d], slope held to a sane range. */
  function fitLine(pairs, dflt) {
    if (pairs.length < 2) return dflt;
    const n = pairs.length;
    const mx = pairs.reduce((s2, p) => s2 + p[0], 0) / n,
      my = pairs.reduce((s2, p) => s2 + p[1], 0) / n;
    let sxx = 0,
      sxy = 0;
    pairs.forEach(([m, d]) => {
      sxx += (m - mx) * (m - mx);
      sxy += (m - mx) * (d - my);
    });
    if (sxx < 1) return { a: 1, b: my - mx };
    const a = clamp(sxy / sxx, 0.6, 1.6);
    return { a, b: my - a * mx };
  }

  /** Lay the model's text lines onto the measured ink segments. Returns the
   *  correction (y = ay*y+by, x = ax*x+bx) for everything the model placed,
   *  and which segment each text took. */
  function alignTexts(texts, segs) {
    let Y = { a: 1, b: 0 },
      X = { a: 1, b: 0 };
    if (!texts.length || !segs.length) return { Y, X, match: new Map() };
    // CENTRES, not left edges: the model's box for a label often starts at
    // the icon beside it, and matching left edges gave the label the icon
    const cyT = (t) => t.py + t.ph / 2,
      cyS = (g) => g.y + g.h / 2,
      cxT = (t) => t.px + t.pw / 2,
      cxS = (g) => g.x + g.w / 2;
    const byY = texts.slice().sort((p, q) => cyT(p) - cyT(q));
    const sy = segs.slice().sort((p, q) => cyS(p) - cyS(q));
    // first guess: the first and last lines of text are the first and last ink
    if (byY.length > 1 && cyT(byY[byY.length - 1]) - cyT(byY[0]) > 10)
      Y = fitLine(
        [
          [cyT(byY[0]), cyS(sy[0])],
          [cyT(byY[byY.length - 1]), cyS(sy[sy.length - 1])],
        ],
        Y,
      );
    else Y = { a: 1, b: cyS(sy[0]) - cyT(byY[0]) };
    const nearest = (t) => {
      let best = null,
        bd = 1e9;
      const ty = Y.a * cyT(t) + Y.b,
        tx = X.a * cxT(t) + X.b;
      segs.forEach((g) => {
        const d = Math.abs(ty - cyS(g)) + 0.25 * Math.abs(tx - cxS(g));
        if (d < bd) {
          bd = d;
          best = g;
        }
      });
      return best && Math.abs(ty - cyS(best)) < Math.max(14, best.h * 1.6) ? best : null;
    };
    for (let it = 0; it < 4; it++) {
      const py = [],
        px2 = [];
      texts.forEach((t) => {
        const g = nearest(t);
        if (!g) return;
        py.push([cyT(t), cyS(g)]);
        px2.push([cxT(t), cxS(g)]);
      });
      Y = fitLine(py, Y);
      X = fitLine(px2, X);
    }
    // one text per segment: the cheapest pairs first
    const cand = [];
    texts.forEach((t, ti) => {
      const ty = Y.a * cyT(t) + Y.b,
        tx = X.a * cxT(t) + X.b,
        tw = X.a * t.pw;
      segs.forEach((g, gi) => {
        const dy = Math.abs(ty - cyS(g));
        if (dy > Math.max(14, g.h * 1.6)) return;
        // ink must be about one line of the height the model gave: a taller
        // blob is several lines or a picture, and sizing text to it is wrong
        const th = Y.a * t.ph;
        if (g.h > Math.max(th * 1.45, th + 5) || g.h < th * 0.35) return;
        cand.push({ ti, gi, cost: dy + 0.5 * Math.abs(tx - cxS(g)) + 0.4 * Math.abs(tw - g.w) });
      });
    });
    cand.sort((p, q) => p.cost - q.cost);
    const match = new Map(),
      used = new Set();
    cand.forEach((c) => {
      if (match.has(c.ti) || used.has(c.gi)) return;
      match.set(c.ti, segs[c.gi]);
      used.add(c.gi);
    });
    return { Y, X, match, used };
  }

  /* ---- building ------------------------------------------------------- */

  const RADIUS = (r, h) => (r === 0 ? 0 : r === 1 ? Math.min(4, h / 2) : r === 2 ? Math.min(10, h / 2) : h / 2);

  /** The measured screen as a document for normalizeDoc. `panels` is
   *  [{region (percent of the screen), items (percent of the region)}].
   *  `iconSrc(name,colorHex)` returns an image data URL or null. */
  function buildDoc(img, panels, opts) {
    opts = opts || {};
    const W = img.width,
      H = img.height;
    const k = Math.min(1, 2000 / Math.max(W, H)); // documents cap at 2000
    const S = (v) => Math.round(v * k * 10) / 10;
    const bgCol = medianColor(img, 0, 0, W, H, Math.max(2, Math.floor(Math.min(W, H) / 40)));
    const children = [];
    let boxes = 0,
      texts = 0,
      icons = 0,
      placed = 0;
    panels.forEach((p, pi) => {
      const g = p.region;
      const rx = (g.x / 100) * W,
        ry = (g.y / 100) * H,
        rw = (g.w / 100) * W,
        rh = (g.h / 100) * H;
      const kids = [];
      const fill = medianColor(img, rx, ry, rw, rh);
      kids.push({ type: "rect", name: (g.name || "Panel") + " background", x: S(rx), y: S(ry), w: S(rw), h: S(rh), radius: 0, fill: { kind: "solid", color: hex(fill) } });
      const items = (p.items || []).map((it) => Object.assign({}, it, { px: rx + (it.x / 100) * rw, py: ry + (it.y / 100) * rh, pw: (it.w / 100) * rw, ph: (it.h / 100) * rh }));
      const segs = inkSegments(img, rx, ry, rw, rh);
      const tItems = items.filter((it) => it.kind === "text");
      const al = alignTexts(tItems, segs);
      const used = al.used || new Set();
      // everything the model placed gets the same correction the text needed
      // (fitted on centres, so map the centre and scale the size about it)
      const fix = (it) => {
        const w = Math.max(2, al.X.a * it.pw),
          h = Math.max(2, al.Y.a * it.ph);
        return { x: al.X.a * (it.px + it.pw / 2) + al.X.b - w / 2, y: al.Y.a * (it.py + it.ph / 2) + al.Y.b - h / 2, w, h };
      };
      const inkBoxes = [],
        textLayers = [];
      tItems
        .map((it, ti) => ({ it, seg: al.match.get(ti) }))
        .sort((a, b) => a.it.py - b.it.py || a.it.px - b.it.px)
        .forEach(({ it, seg }) => {
          let t;
          if (seg) {
            t = refineText(img, seg, it.text, true);
            placed++;
          } else {
            // no ink matched: the ink near a guess can be several lines, so
            // the model's own line height sizes it (a line box is ~1.2 em)
            const f = fix(it);
            const c = refineText(img, f, it.text);
            t = { x: f.x, y: f.y + f.h * 0.1, size: clamp(f.h / 1.2, 8, 120), color: c.color };
          }
          // the text box's top sits above the ink by half the leading plus the
          // gap between the line top and the cap height
          const size = S(t.size);
          if (seg) inkBoxes.push({ x: seg.x, y: seg.y, w: seg.w, h: seg.h, bg: t.bg });
          textLayers.push({
            type: "text",
            name: it.text.slice(0, 40),
            text: it.text,
            x: S(t.x),
            y: S(t.y) - Math.round(size * 0.22 * 10) / 10,
            size: Math.round(size * 2) / 2,
            weight: it.bold ? 600 : 400,
            font: opts.font || "Inter",
            color: hex(t.color),
            lineHeight: 1.2,
          });
          texts++;
        });
      items
        .filter((it) => it.kind === "box")
        .sort((a, b) => b.pw * b.ph - a.pw * a.ph)
        .forEach((it) => {
          // a box holding text: its fill is what surrounds that text — the
          // model's box can be far too wide (a button read at twice its size)
          const f = fix(it);
          const inside = inkBoxes.filter((q) => q.bg && q.x + q.w / 2 > f.x && q.x + q.w / 2 < f.x + f.w && q.y + q.h / 2 > f.y && q.y + q.h / 2 < f.y + f.h);
          const small = inside.length && f.w * f.h < rw * rh * 0.25 ? inside : [];
          const seed = small.length ? [0, 1, 2].map((k) => small.map((q) => q.bg[k]).sort((p2, q2) => p2 - q2)[small.length >> 1]) : null;
          const m = refineBox(img, f, seed);
          const o = { type: "rect", name: m.h <= 3 ? "Divider" : "Box", x: S(m.x), y: S(m.y), w: S(m.w), h: S(m.h), radius: S(RADIUS(it.r, m.h)), fill: { kind: "solid", color: hex(m.fill) } };
          if (m.border) o.strokes = [{ width: 1, color: hex(m.border), align: "inside" }];
          kids.push(o);
          boxes++;
        });
      items
        .filter((it) => it.kind === "icon")
        .forEach((it) => {
          const f = fix(it);
          const cx0 = f.x + f.w / 2,
            cy0 = f.y + f.h / 2;
          // an unused, roughly square ink blob near where the icon should be
          let best = null,
            bd = Math.max(16, f.w * 1.5);
          segs.forEach((sg, gi) => {
            if (used.has(gi)) return;
            const ar = sg.w / sg.h;
            if (ar < 0.5 || ar > 2) return;
            const d = Math.hypot(sg.x + sg.w / 2 - cx0, sg.y + sg.h / 2 - cy0);
            if (d < bd) {
              bd = d;
              best = gi;
            }
          });
          let box;
          if (best !== null) {
            used.add(best);
            box = segs[best];
          } else box = f;
          const t = refineText(img, box, "", best !== null);
          const side = Math.max(8, Math.max(t.w, t.h));
          const cx = t.x + t.w / 2,
            cy = t.y + t.h / 2;
          const src = (opts.iconSrc || iconSrc)(it.name, hex(t.color));
          const base = { name: "icon/" + (it.name || "unknown"), x: S(cx - side / 2), y: S(cy - side / 2), w: S(side), h: S(side) };
          kids.push(
            src
              ? Object.assign({ type: "image", src }, base)
              : Object.assign({ type: "ellipse", fill: { kind: "solid", color: hex(t.color) }, opacity: 0.35 }, base),
          );
          icons++;
        });
      textLayers.forEach((l) => kids.push(l));
      children.push({ type: "group", name: g.name || "Panel " + (pi + 1), x: S(rx), y: S(ry), children: kids });
    });
    const doc = {
      frame: {
        name: opts.name || "UI screen",
        w: Math.round(W * k),
        h: Math.round(H * k),
        bg: hex(bgCol),
        guides: [],
        components: [],
        styles: [],
        artboards: [{ name: opts.name || "UI screen", x: 0, y: 0, w: Math.round(W * k), h: Math.round(H * k), bg: hex(bgCol), clip: true, fill: { kind: "solid", color: hex(bgCol) } }],
        children,
      },
    };
    return { doc, counts: { panels: panels.length, boxes, texts, icons, textsOnInk: placed } };
  }

  /* ---- icons -----------------------------------------------------------
   * The common UI icons as Lucide paths (ISC — the app already vendors Lucide;
   * see THIRD-PARTY-NOTICES.md), drawn as a small image layer in the MEASURED
   * ink colour. A name not in this set becomes a soft placeholder, named, so
   * it can be swapped by hand. */
  const ICONS = {
    inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    "chevron-down": '<path d="m6 9 6 6 6-6"/>',
    "chevron-right": '<path d="m9 18 6-6-6-6"/>',
    "x-circle": '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>',
    "alert-circle": '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    "file-text": '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4M10 9H8M16 13H8M16 17H8"/>',
    folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    book: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>',
    sparkles: '<path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.13-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0L14.06 8.5A2 2 0 0 0 15.5 9.94l6.14 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.13a.5.5 0 0 1-.96 0z"/>',
    "help-circle": '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01"/>',
    "credit-card": '<rect width="20" height="14" x="2" y="5" rx="2"/><path d="M2 10h20"/>',
    "bar-chart": '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M8 17v-4M12 17V8M16 17v-6"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    layout: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18M9 21V9"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M2 14h4M10 8h4M18 16h4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    star: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>',
    calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-10 5L2 7"/>',
    home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
    image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>',
    trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  };
  const ICON_ALIAS = { "user-check": "user", "square-user": "user", contact: "user", "bar-chart-2": "bar-chart", chart: "bar-chart", "file": "file-text", "circle-help": "help-circle", "circle-x": "x-circle", "circle-alert": "alert-circle", gear: "settings", cog: "settings" };

  /** An icon as an SVG data URL in the given colour, or null if unknown. */
  function iconSrc(name, color) {
    const k = ICON_ALIAS[name] || name;
    const body = ICONS[k];
    if (!body) return null;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }

  window.UiScreen = { parseRegions, parseItems, refineBox, refineText, medianColor, inkSegments, alignTexts, buildDoc, hex, iconSrc, ICONS };
})();
