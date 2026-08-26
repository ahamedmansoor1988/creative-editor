/* Pixel filters (§4.8, §4.12, §5.5, §5.6, §5.10, §5.11, §5.12).
 *
 * These are the effects that read the object's RENDERED PIXELS rather than its
 * geometry, so they all share one pipeline: the object is drawn to a padded
 * offscreen layer, the layer is transformed, and the result is composited back.
 * Building that once is what makes seven spec sections tractable in a session.
 *
 * They register as a new `pixel` slot in the effect stack, which runs after
 * the material and the over-slot filters — so a warp bends the glass, the
 * gradient stripe and the grain together, which is what a user means by
 * "warp this object".
 *
 * ALL SAMPLING IS INVERSE. For every destination pixel we ask where it came
 * from in the source, rather than pushing source pixels forward. Forward
 * mapping leaves holes wherever the transform expands; inverse mapping cannot.
 *
 * PERFORMANCE. These are per-pixel loops on the CPU, so cost scales with the
 * object's area. A draft flag (set while a slider is moving) halves the
 * resolution, and every filter early-outs at zero strength.
 */
(function () {
  "use strict";

  /* ---- shared helpers -------------------------------------------------- */
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  /** Deterministic hash noise — same seed gives the same field every render,
   *  so a document looks identical on reload. */
  function hash2(x, y, seed) {
    /* eslint-disable-next-line no-loss-of-precision --
     * The seed multiplier is a 64-bit SplitMix64 constant and a double cannot
     * hold it exactly. That is harmless here: the next line XOR-shifts h, which
     * coerces to int32 and discards the high bits regardless, and the same
     * inputs still produce the same double — so the field stays deterministic,
     * which is the property this function actually promises.
     * Substituting a 32-bit-safe constant would change the noise pattern in
     * every already-saved document, so the value stays. */
    let h = x * 374761393 + y * 668265263 + seed * 1442695040888963407;
    h = (h ^ (h >> 13)) * 1274126177;
    return ((h ^ (h >> 16)) >>> 0) / 4294967296;
  }
  function valueNoise(x, y, seed) {
    const xi = Math.floor(x),
      yi = Math.floor(y);
    const xf = x - xi,
      yf = y - yi;
    const u = xf * xf * (3 - 2 * xf),
      v = yf * yf * (3 - 2 * yf);
    const a = hash2(xi, yi, seed),
      b = hash2(xi + 1, yi, seed);
    const c = hash2(xi, yi + 1, seed),
      d = hash2(xi + 1, yi + 1, seed);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  /** §5.5 fractal Brownian motion — the haze density field. */
  function fbm(x, y, seed, octaves, lacunarity, gain) {
    let sum = 0,
      amp = 0.5,
      freq = 1,
      norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += valueNoise(x * freq, y * freq, seed + i * 101) * amp;
      norm += amp;
      freq *= lacunarity;
      amp *= gain;
    }
    return norm > 0 ? sum / norm : 0;
  }

  /** Bilinear sample with an edge policy (§5.11 clamp / wrap / mirror). */
  function sample(src, w, h, x, y, mode, out, oi) {
    let x0, y0;
    if (mode === "wrap") {
      x = ((x % w) + w) % w;
      y = ((y % h) + h) % h;
    } else if (mode === "mirror") {
      const w2 = w * 2,
        h2 = h * 2;
      x = ((x % w2) + w2) % w2;
      if (x >= w) x = w2 - x - 1;
      y = ((y % h2) + h2) % h2;
      if (y >= h) y = h2 - y - 1;
    } else {
      x = clamp(x, 0, w - 1);
      y = clamp(y, 0, h - 1);
    }
    x0 = Math.floor(x);
    y0 = Math.floor(y);
    const fx = x - x0,
      fy = y - y0;
    const x1 = Math.min(x0 + 1, w - 1),
      y1 = Math.min(y0 + 1, h - 1);
    const i00 = (y0 * w + x0) * 4,
      i10 = (y0 * w + x1) * 4,
      i01 = (y1 * w + x0) * 4,
      i11 = (y1 * w + x1) * 4;
    for (let k = 0; k < 4; k++) {
      const a = src[i00 + k] + (src[i10 + k] - src[i00 + k]) * fx;
      const b = src[i01 + k] + (src[i11 + k] - src[i01 + k]) * fx;
      out[oi + k] = a + (b - a) * fy;
    }
  }

  /** Run an inverse warp: fn(dx,dy) returns the SOURCE coordinate. */
  function remap(img, w, h, fn, edge) {
    const src = new Uint8ClampedArray(img.data);
    const dst = img.data;
    const p = [0, 0, 0, 0];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = fn(x, y);
        const i = (y * w + x) * 4;
        if (!s) {
          dst[i] = dst[i + 1] = dst[i + 2] = dst[i + 3] = 0;
          continue;
        }
        sample(src, w, h, s[0], s[1], edge || "clamp", p, 0);
        dst[i] = p[0];
        dst[i + 1] = p[1];
        dst[i + 2] = p[2];
        dst[i + 3] = p[3];
      }
    }
  }

  /* ---- §5.10 distortion ------------------------------------------------ */
  function distortion(img, w, h, P) {
    const amt = +P.amount || 0;
    if (!amt) return;
    const cx = w * (0.5 + (+P.cx || 0)),
      cy = h * (0.5 + (+P.cy || 0));
    const R = Math.max(1, ((+P.radius || 0.5) * Math.max(w, h)) / 2);
    const mode = P.mode || "wave";
    const wl = Math.max(2, (+P.wavelength || 0.2) * Math.min(w, h));
    const ph = ((+P.phase || 0) * Math.PI) / 180;
    const axis = P.axis || "both";
    remap(
      img,
      w,
      h,
      (x, y) => {
        if (mode === "wave") {
          const dx = axis === "y" ? 0 : Math.sin((y / wl) * Math.PI * 2 + ph) * amt;
          const dy = axis === "x" ? 0 : Math.sin((x / wl) * Math.PI * 2 + ph) * amt;
          return [x - dx, y - dy];
        }
        const ox = x - cx,
          oy = y - cy;
        const d = Math.hypot(ox, oy);
        if (d > R) return [x, y];
        const t = 1 - d / R;
        if (mode === "twirl") {
          const a = amt * 0.02 * t * t;
          const cs = Math.cos(a),
            sn = Math.sin(a);
          return [cx + ox * cs - oy * sn, cy + ox * sn + oy * cs];
        }
        if (mode === "ripple") {
          const s = Math.sin((d / wl) * Math.PI * 2 - ph) * amt * t;
          const k = d > 0.001 ? (d + s) / d : 1;
          return [cx + ox * k, cy + oy * k];
        }
        // bulge (amt>0) / pinch (amt<0)
        const k = Math.pow(Math.max(0.001, d / R), -amt * 0.01 * t);
        return [cx + ox * k, cy + oy * k];
      },
      P.edge,
    );
  }

  /* ---- §5.12 warp ------------------------------------------------------ */
  const ENVELOPES = ["arc", "arch", "bulge", "flag", "wave", "fisheye"];
  function warp(img, w, h, P) {
    const s = (+P.strength || 0) / 100;
    if (!s) return;
    const env = ENVELOPES.includes(P.envelope) ? P.envelope : "arc";
    const vert = P.axis === "vertical";
    remap(
      img,
      w,
      h,
      (x, y) => {
        // work in normalised -1..1 so the envelopes read the same at any size
        let u = (x / w) * 2 - 1,
          v = (y / h) * 2 - 1;
        if (vert) {
          const t = u;
          u = v;
          v = t;
        }
        let su = u,
          sv = v;
        switch (env) {
          case "arc":
            sv = v - s * (1 - u * u);
            break;
          case "arch":
            sv = v - s * (1 - u * u) * (0.5 - v * 0.5);
            break;
          case "bulge": {
            const k = 1 + s * (1 - v * v) * 0.6;
            su = u / k;
            break;
          }
          case "flag":
            sv = v - s * Math.sin(u * Math.PI * 1.5);
            break;
          case "wave":
            sv = v - s * Math.sin(u * Math.PI * 2);
            break;
          case "fisheye": {
            const r = Math.hypot(u, v);
            if (r > 0.001) {
              const k = Math.pow(r, 1 - s * 0.8) / r;
              su = u * k;
              sv = v * k;
            }
            break;
          }
        }
        if (vert) {
          const t = su;
          su = sv;
          sv = t;
        }
        return [((su + 1) / 2) * w, ((sv + 1) / 2) * h];
      },
      P.edge,
    );
  }

  /* ---- §5.11 displacement ---------------------------------------------- */
  function displacement(img, w, h, P, mapData) {
    const sx = +P.scaleX || 0,
      sy = +P.scaleY || 0;
    if (!sx && !sy) return;
    const ch = { red: 0, green: 1, blue: 2, alpha: 3, luminance: -1 }[P.channel] ?? -1;
    const sc = Math.max(0.01, +P.mapScale || 1);
    const seed = Math.round(+P.seed || 1);
    const read = (x, y) => {
      if (mapData) {
        const mx = clamp(Math.round(x), 0, w - 1),
          my = clamp(Math.round(y), 0, h - 1);
        const i = (my * w + mx) * 4;
        if (ch >= 0) return mapData[i + ch] / 255;
        return (0.2126 * mapData[i] + 0.7152 * mapData[i + 1] + 0.0722 * mapData[i + 2]) / 255;
      }
      // no source map supplied: drive it procedurally so the effect is usable
      return fbm(x / (60 * sc), y / (60 * sc), seed, 4, 2, 0.5);
    };
    remap(
      img,
      w,
      h,
      (x, y) => {
        const d = read(x, y) - 0.5;
        return [x - d * sx, y - d * sy];
      },
      P.edge,
    );
  }

  /* ---- §5.5 fractal glass haze ----------------------------------------- */
  function haze(img, w, h, P) {
    const dens = +P.density || 0;
    if (dens <= 0) return;
    const d = img.data;
    const oct = clamp(Math.round(+P.octaves || 4), 1, 8);
    const lac = +P.lacunarity || 2,
      gain = +P.gain || 0.5;
    const sc = Math.max(1, (+P.scale || 0.25) * Math.min(w, h));
    const seed = Math.round(+P.seed || 1);
    const tint = hexRGB(P.color || "#ffffff");
    const fall = +P.falloff || 1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (!d[i + 3]) continue;
        let n = fbm(x / sc, y / sc, seed, oct, lac, gain);
        // §5.5 depth-dependent accumulation: haze builds toward the interior,
        // which is what makes it read as volume rather than a flat overlay
        const edge = Math.min(1, Math.min(x, y, w - 1 - x, h - 1 - y) / (Math.min(w, h) * 0.35));
        n *= Math.pow(edge, fall);
        const a = clamp(n * dens, 0, 1);
        d[i] = d[i] + (tint[0] - d[i]) * a;
        d[i + 1] = d[i + 1] + (tint[1] - d[i + 1]) * a;
        d[i + 2] = d[i + 2] + (tint[2] - d[i + 2]) * a;
      }
    }
  }

  /* ---- §5.6 slice ------------------------------------------------------ */
  function slice(img, w, h, P) {
    const n = clamp(Math.round(+P.count || 0), 0, 200);
    if (n < 2) return;
    const vert = P.axis === "vertical";
    const span = vert ? w : h;
    const band = span / n;
    const off = +P.offset || 0;
    const gap = Math.max(0, +P.gap || 0);
    const seed = Math.round(+P.seed || 1);
    const rand = P.mode === "random";
    remap(
      img,
      w,
      h,
      (x, y) => {
        const along = vert ? x : y;
        const idx = Math.min(n - 1, Math.floor(along / band));
        // a gap is a hole, so those pixels resolve to nothing rather than to a
        // stretched neighbour
        if (gap > 0) {
          const within = along - idx * band;
          if (within < gap * 0.5 || within > band - gap * 0.5) return null;
        }
        const k = rand ? hash2(idx, 0, seed) * 2 - 1 : (idx / (n - 1)) * 2 - 1;
        const shift = k * off;
        return vert ? [x, y - shift] : [x - shift, y];
      },
      P.edge,
    );
  }

  /* ---- §4.12 noise ----------------------------------------------------- */
  function noise(img, w, h, P) {
    const amt = +P.amount || 0;
    if (amt <= 0) return;
    const d = img.data;
    const mono = P.mono !== false;
    const sc = Math.max(1, +P.scale || 1);
    const seed = Math.round(+P.seed || 1);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (!d[i + 3]) continue;
        const sx = Math.floor(x / sc),
          sy = Math.floor(y / sc);
        if (mono) {
          const v = (hash2(sx, sy, seed) - 0.5) * 255 * amt;
          d[i] = clamp(d[i] + v, 0, 255);
          d[i + 1] = clamp(d[i + 1] + v, 0, 255);
          d[i + 2] = clamp(d[i + 2] + v, 0, 255);
        } else {
          d[i] = clamp(d[i] + (hash2(sx, sy, seed) - 0.5) * 255 * amt, 0, 255);
          d[i + 1] = clamp(d[i + 1] + (hash2(sx, sy, seed + 17) - 0.5) * 255 * amt, 0, 255);
          d[i + 2] = clamp(d[i + 2] + (hash2(sx, sy, seed + 31) - 0.5) * 255 * amt, 0, 255);
        }
      }
    }
  }

  function hexRGB(h) {
    const n = parseInt(String(h).replace("#", ""), 16) || 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  /* ---- §4.8 blur -------------------------------------------------------
   * Gaussian and directional run on the 2D context (ctx.filter is hardware
   * accelerated and far faster than a JS convolution); zoom blur is an
   * accumulation of scaled copies, which ctx.filter cannot express. */
  function blurLayer(cv, P) {
    const kind = P.kind || "gaussian";
    const r = +P.radius || 0;
    const dist = Math.max(0, +P.distance || 0);
    /* Each kind is driven by a DIFFERENT quantity, so one guard cannot ask
     * about radius alone. This read `r <= 0 && kind !== "zoom"`, which meant a
     * directional blur — whose radius is legitimately 0, because distance is
     * what drives it — returned the layer untouched. Measured: mean pixel
     * difference of exactly 0 at every angle and distance tested, while
     * gaussian and zoom both moved ~11.5. Motion blur did nothing at all.
     *
     * The identical wrong assumption lived in FxStack.entryOn, which reported
     * the same effect OFF for the same reason. Fixing that one made the effect
     * reach this function; it did not make it do anything, and nothing checked
     * that it had. Verify the effect, not the call. */
    if (kind === "gaussian" && r <= 0) return cv;
    if (kind === "directional" && r <= 0 && dist <= 0) return cv;
    const w = cv.width,
      h = cv.height;
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    const c = out.getContext("2d");
    if (kind === "gaussian") {
      c.filter = `blur(${r}px)`;
      c.drawImage(cv, 0, 0);
      return out;
    }
    if (kind === "directional") {
      // smear along the angle by compositing offset, blurred copies
      const a = ((+P.angle || 0) * Math.PI) / 180;
      const len = Math.max(1, dist || r);
      const steps = Math.min(32, Math.max(4, Math.round(len)));
      c.globalAlpha = 1 / steps;
      c.filter = `blur(${Math.max(0, r * 0.3)}px)`;
      for (let i = 0; i < steps; i++) {
        const t = (i / (steps - 1) - 0.5) * len;
        c.drawImage(cv, Math.cos(a) * t, Math.sin(a) * t);
      }
      return out;
    }
    if (kind === "zoom") {
      const amt = +P.amount || 0.2;
      const cx = w * (0.5 + (+P.cx || 0)),
        cy = h * (0.5 + (+P.cy || 0));
      const steps = Math.min(32, Math.max(4, Math.round(12 + amt * 40)));
      c.globalAlpha = 1 / steps;
      for (let i = 0; i < steps; i++) {
        const s = 1 + amt * (i / (steps - 1));
        c.save();
        c.translate(cx, cy);
        c.scale(s, s);
        c.translate(-cx, -cy);
        c.drawImage(cv, 0, 0);
        c.restore();
      }
      return out;
    }
    return cv;
  }

  /** Apply one pixel effect to a layer. Returns the layer (possibly a new one). */
  function apply(type, cv, params, extra) {
    const w = cv.width,
      h = cv.height;
    if (!w || !h) return cv;
    if (type === "blur") return blurLayer(cv, params);
    const c = cv.getContext("2d", { willReadFrequently: true });
    const img = c.getImageData(0, 0, w, h);
    switch (type) {
      case "distortion":
        distortion(img, w, h, params);
        break;
      case "warp":
        warp(img, w, h, params);
        break;
      case "displacement":
        displacement(img, w, h, params, extra);
        break;
      case "haze":
        haze(img, w, h, params);
        break;
      case "slice":
        slice(img, w, h, params);
        break;
      case "noise":
        noise(img, w, h, params);
        break;
      default:
        return cv;
    }
    c.putImageData(img, 0, 0);
    return cv;
  }

  window.Filters = { apply, ENVELOPES, fbm, valueNoise };
})();
