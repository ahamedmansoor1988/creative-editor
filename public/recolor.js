/* Recolour — a colour named in the prompt, applied to the measured palette.
 *
 * The reference pipeline's rule is that the model judges structure and the
 * PIXELS decide colour, which is what stops a vision model inventing hex
 * values. It also meant a prompt saying "in red shades" had nowhere to land:
 * every colour was measured off a blue reference, and blue is what came back.
 *
 * So the prompt is given one deterministic path to colour. A colour WORD maps
 * to a hue; the reference's own dominant hue is measured off its colour grid;
 * and every colour in the finished document is rotated by the difference.
 * Lightness and saturation are untouched, so the reference's structure — what
 * is bright, what is deep, what is muted — survives exactly, and only the hue
 * family moves. White, black and grey have no hue to rotate and stay as they
 * are, which is what keeps white text white and a shadow black.
 *
 * No model is asked anything. "red" is 0 degrees whoever reads it. */
(function () {
  "use strict";

  const VERSION = "20260921-recolor1";

  /* Named hues. The last colour word in the prompt wins, so "from blue to
   * red" lands on red. A hex code wins over words. */
  const NAMES = [
    ["crimson", 350],
    ["scarlet", 5],
    ["red", 0],
    ["coral", 12],
    ["orange", 28],
    ["amber", 40],
    ["gold", 45],
    ["yellow", 55],
    ["lime", 90],
    ["green", 125],
    ["emerald", 145],
    ["mint", 155],
    ["teal", 172],
    ["cyan", 190],
    ["turquoise", 178],
    ["sky", 205],
    ["azure", 210],
    ["blue", 222],
    ["navy", 230],
    ["indigo", 248],
    ["violet", 275],
    ["purple", 285],
    ["lavender", 270],
    ["magenta", 320],
    ["fuchsia", 320],
    ["pink", 335],
    ["rose", 345],
  ];

  /** What colour, if any, the prompt asks for. null when it names none. */
  function intentFromPrompt(prompt) {
    const p = String(prompt || "").toLowerCase();
    if (!p.trim()) return null;
    const hexM = p.match(/#([0-9a-f]{6}|[0-9a-f]{3})\b/i);
    if (hexM) {
      let h = hexM[1];
      if (h.length === 3)
        h = h
          .split("")
          .map((c) => c + c)
          .join("");
      return { hue: hexToHsl("#" + h).h, name: "#" + h.toLowerCase(), source: "hex" };
    }
    let best = null;
    for (const [name, hue] of NAMES) {
      /* A trailing e is optional before a suffix: "blue" gives "bluish" and
       * "bluey", "purple" gives "purplish" and "purply". Anchored on both
       * sides, so "reduce" and "bluetooth" are not colour requests. */
      const stem = name.replace(/e$/, "");
      const re = new RegExp("\\b" + stem + "e?(ish|s|y)?\\b", "g");
      let m;
      while ((m = re.exec(p))) {
        if (!best || m.index > best.index) best = { hue, name, index: m.index };
      }
    }
    return best ? { hue: best.hue, name: best.name, source: "word" } : null;
  }

  /* ---- colour maths --------------------------------------------------- */

  function hexToRgb(hex) {
    const v = parseInt(String(hex).slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  function rgbToHex(r, g, b) {
    const c = (x) =>
      Math.max(0, Math.min(255, Math.round(x)))
        .toString(16)
        .padStart(2, "0");
    return "#" + c(r) + c(g) + c(b);
  }
  function rgbToHsl(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const mx = Math.max(r, g, b),
      mn = Math.min(r, g, b);
    const l = (mx + mn) / 2;
    if (mx === mn) return { h: 0, s: 0, l };
    const d = mx - mn;
    const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    let h;
    if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return { h: (h * 60) % 360, s, l };
  }
  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360;
    if (s === 0) return [l * 255, l * 255, l * 255];
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const f = (t) => {
      t = ((t % 1) + 1) % 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const hk = h / 360;
    return [f(hk + 1 / 3) * 255, f(hk) * 255, f(hk - 1 / 3) * 255];
  }
  function hexToHsl(hex) {
    return rgbToHsl(...hexToRgb(hex));
  }

  /** The reference's dominant hue, from its colour grid: a chroma-weighted
   *  circular mean, so grey cells do not vote and a strong colour outvotes a
   *  faint one. null for a picture with no colour in it. */
  function dominantHue(rows) {
    let x = 0,
      y = 0,
      w = 0;
    for (const row of Array.isArray(rows) ? rows : []) {
      for (const hex of Array.isArray(row) ? row : []) {
        if (!/^#[0-9a-f]{6}$/i.test(hex)) continue;
        const [r, g, b] = hexToRgb(hex);
        const chroma = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
        if (chroma < 0.08) continue; // grey: no hue worth counting
        const { h } = rgbToHsl(r, g, b);
        x += Math.cos((h * Math.PI) / 180) * chroma;
        y += Math.sin((h * Math.PI) / 180) * chroma;
        w += chroma;
      }
    }
    if (w === 0) return null;
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }

  /** One colour, moved. `shift` is degrees of hue rotation. With `colorize`
   *  (a reference that had no hue to rotate FROM) the hue is SET to the target
   *  and a little saturation is given to anything that had some. */
  function shiftRgb(r, g, b, op) {
    const { h, s, l } = rgbToHsl(r, g, b);
    if (s === 0) return [r, g, b]; // grey, white, black: nothing to move
    if (op.colorize) return hslToRgb(op.target, Math.max(s, 0.55), l);
    return hslToRgb(h + op.shift, s, l);
  }
  function shiftHex(hex, op) {
    if (!/^#[0-9a-f]{6}$/i.test(String(hex))) return hex;
    return rgbToHex(...shiftRgb(...hexToRgb(hex), op));
  }

  /* ---- the document walk --------------------------------------------- */

  const HEX_RE = /^#[0-9a-f]{6}$/i;
  const SKIP = new Set(["id", "parentId", "src", "name", "text", "font", "family"]);

  /** Every colour in a document, moved. Walks the tree generically — a hex
   *  string anywhere, or a [r,g,b] under a key named color, as a mesh point
   *  stores it — so an effect added later is covered without being listed
   *  here. Objects are visited once by identity: `fill` IS `fills[0]`, and
   *  shifting a colour twice is a different colour. */
  function recolorDoc(doc, intent, gridRows) {
    if (!doc || !intent) return null;
    const from = dominantHue(gridRows);
    const op =
      from == null
        ? { colorize: true, target: intent.hue }
        : { colorize: false, shift: intent.hue - from };
    const seen = new Set();
    let count = 0;
    const walk = (node) => {
      if (!node || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      for (const key of Object.keys(node)) {
        if (key.startsWith("__") || SKIP.has(key)) continue;
        const v = node[key];
        if (typeof v === "string") {
          if (HEX_RE.test(v)) {
            const nv = shiftHex(v, op);
            if (nv !== v) {
              node[key] = nv;
              count++;
            }
          }
        } else if (
          key === "color" &&
          Array.isArray(v) &&
          v.length === 3 &&
          v.every((n) => typeof n === "number")
        ) {
          const nv = shiftRgb(v[0], v[1], v[2], op).map((n) => Math.round(n));
          if (nv.join() !== v.join()) {
            node[key] = nv;
            count++;
          }
        } else if (v && typeof v === "object") {
          walk(v);
        }
      }
    };
    walk(doc);
    return {
      to: intent.name,
      hue: intent.hue,
      from: from == null ? null : Math.round(from),
      mode: op.colorize ? "colorize" : "rotate",
      changed: count,
    };
  }

  window.Recolor = Object.freeze({
    VERSION,
    NAMES,
    intentFromPrompt,
    dominantHue,
    shiftHex,
    shiftRgb,
    recolorDoc,
    hexToHsl,
    rgbToHsl,
    hslToRgb,
    rgbToHex,
  });
})();
