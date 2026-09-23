/* Colour — hex, rgb, alpha strings, and blending in sRGB, linear light or
 * OKLab.
 *
 * Pure arithmetic on colour strings and triples: nothing here reads the
 * document or the page. Moved out of app.js on 23 Sep 2026 exactly as it
 * was, the second seam cut from that file after the structure engines. The
 * gradient ramp, the mesh panel, the reference flow's measured palette and
 * the glow all blend through these, and until now the only way to test the
 * blend was to boot the whole editor in jsdom.
 *
 * OKLab is Björn Ottosson's, published to the public domain. */
(function () {
  "use strict";

  const VERSION = "20260923-color1";
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /* §4.5/§4.6: a paint spec -> a canvas style. Per-stop opacity is baked into
   * the stop colour (canvas gradients take colour strings), and the
   * interpolation midpoint is emitted as an extra sampled stop, since canvas
   * gradients are always linear between stops. */
  function stopColor(s) {
    const a = s.opacity === undefined ? 1 : clamp(+s.opacity, 0, 1);
    if (a >= 1) return s.color;
    const n = parseInt(String(s.color).slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  /* Hex <-> [r,g,b], for the mesh panel and its canvas handles. */
  const rgbHex = (c) =>
    "#" + c.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("");

  function hexRgb(h) {
    const n = parseInt(String(h).replace("#", ""), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function mixHex(c1, c2, t) {
    const a = parseInt(String(c1).slice(1), 16),
      b2 = parseInt(String(c2).slice(1), 16);
    const ch = (sh) => Math.round(((a >> sh) & 255) + (((b2 >> sh) & 255) - ((a >> sh) & 255)) * t);
    return "#" + [16, 8, 0].map((sh) => ch(sh).toString(16).padStart(2, "0")).join("");
  }

  /* §4.5 gradient interpolation space.
   *
   * `space` has been in the model and the schema since gradients landed, and
   * nothing ever read it: addStops did not take it and paintStyle did not pass
   * it, so every gradient interpolated in sRGB whatever the document said. A
   * field that normalises, serialises and does nothing is worse than a missing
   * one, because a document can claim a rendering it never gets.
   *
   * Canvas only ever interpolates between stops in sRGB, so working in another
   * space means SAMPLING the ramp there and emitting the results as ordinary
   * stops. sRGB blending is the reason a blue-to-yellow ramp passes through a
   * dead grey: the midpoint is dark in the middle of two bright colours. Linear
   * light fixes the brightness; OKLab fixes hue and lightness together, which is
   * what perceptual uniformity buys.
   *
   * OKLab is Björn Ottosson's, published to the public domain. */
  const _srgbToLin = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));

  const _linToSrgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

  function _hexToRgb(h) {
    const n = parseInt(String(h).slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  function _rgbToHex(r) {
    return (
      "#" +
      r
        .map((v) =>
          Math.round(clamp(v, 0, 1) * 255)
            .toString(16)
            .padStart(2, "0"),
        )
        .join("")
    );
  }

  function _linToOklab([r, g, b]) {
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
  }

  function _oklabToLin([L, A, B]) {
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
    return [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
  }

  /** Blend two hex colours at t, working in `space`. */
  function mixIn(c1, c2, t, space) {
    if (space !== "linear" && space !== "oklab") return mixHex(c1, c2, t);
    const a = _hexToRgb(c1).map(_srgbToLin),
      b = _hexToRgb(c2).map(_srgbToLin);
    if (space === "linear") return _rgbToHex(a.map((v, i) => v + (b[i] - v) * t).map(_linToSrgb));
    const A = _linToOklab(a),
      B = _linToOklab(b);
    return _rgbToHex(_oklabToLin(A.map((v, i) => v + (B[i] - v) * t)).map(_linToSrgb));
  }

  function hexAlpha(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  function hexToRgba(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
    if (!m) return "rgba(0,0,0," + a + ")";
    const n = parseInt(m[1], 16);
    return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
  }

  /** The colour the gradient already shows between two stops. Guarded, because
   *  the editor's mixHex assumes two well-formed hex strings. */
  function rampMix(a, b, t) {
    const ok = (v) => /^#[0-9a-f]{6}$/i.test(String(v || ""));
    if (!ok(a)) return ok(b) ? b : "#888888";
    if (!ok(b)) return a;
    return mixHex(a, b, clamp(t, 0, 1));
  }

  const HEX6 = /^#[0-9a-fA-F]{6}$/;

  const hexDist = (a, b) => {
    const A = hexRgb(a),
      B = hexRgb(b);
    return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
  };

  function meanHexOf(hexes) {
    let r = 0,
      g = 0,
      b = 0,
      n = 0;
    (hexes || []).forEach((h) => {
      if (!HEX6.test(h || "")) return;
      const c = hexRgb(h);
      r += c[0];
      g += c[1];
      b += c[2];
      n++;
    });
    return n ? rgbHex([r / n, g / n, b / n]) : "#808080";
  }

  /** Up to n grid colours that are far enough apart to be different colours,
   *  most-covered first — a palette, not a histogram. */
  function dominantHexes(hexes, n) {
    const counts = new Map();
    (hexes || []).forEach((h) => {
      if (!HEX6.test(h || "")) return;
      const c = hexRgb(h);
      const k = rgbHex([
        Math.round(c[0] / 24) * 24,
        Math.round(c[1] / 24) * 24,
        Math.round(c[2] / 24) * 24,
      ]);
      counts.set(k, (counts.get(k) || 0) + 1);
    });
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
    const out = [];
    for (const h of sorted) {
      if (out.every((o) => hexDist(o, h) >= 48)) out.push(h);
      if (out.length >= n) break;
    }
    return out.length ? out : ["#808080"];
  }

  window.Color = Object.freeze({
    VERSION,
    stopColor,
    rgbHex,
    hexRgb,
    mixHex,
    _srgbToLin,
    _linToSrgb,
    _hexToRgb,
    _rgbToHex,
    _linToOklab,
    _oklabToLin,
    mixIn,
    hexAlpha,
    hexToRgba,
    rampMix,
    HEX6,
    hexDist,
    meanHexOf,
    dominantHexes,
  });
})();
