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
   *  so a document looks identical on reload.
   *
   *  REWRITTEN because the previous version was not a hash, it was a bias. It
   *  built the mixer in DOUBLE arithmetic — `seed * 1442695040888963407` lands
   *  near 1.4e18, where the ULP is 256 — so the pixel terms and every low bit
   *  were quantised away before the mix. Measured over a 200x200 grid it
   *  returned values only in [0, 0.5): mean 0.249, the top five deciles empty,
   *  and 15432 distinct values out of 40000 at seed 1234.
   *
   *  That is why noise DARKENED instead of dithering. `(hash - 0.5)` was
   *  negative for every pixel on the canvas, so "add noise" meant "subtract
   *  up to half": mean luminance fell 146.7 -> 102.5 at amount 0.7. It could
   *  not brighten a single pixel, which is also why monochromatic grain never
   *  looked like grain — real grain is signed.
   *
   *  Math.imul and >>> keep every step inside exact int32, which is what the
   *  original comment assumed was happening. Now: mean 0.4998, all 40000
   *  distinct, flat deciles, full [0,1). The field changes in documents saved
   *  before this, and it has to — the old one was broken. */
  function hash2(x, y, seed) {
    let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  /** Signed grain in roughly a NORMAL distribution, which is what film grain
   *  and sensor noise actually are — uniform noise reads as digital speckle
   *  because real grain clusters around zero and only rarely swings wide.
   *  Three hashes summed is Irwin-Hall n=3: cheap, deterministic, and close
   *  enough to Gaussian that the difference is invisible at grain amplitudes.
   *  Returns roughly [-1.5, 1.5] with sigma 0.5. */
  function grain3(x, y, seed) {
    return hash2(x, y, seed) + hash2(x, y, seed + 0x9e37) + hash2(x, y, seed + 0x85eb) - 1.5;
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
    /* Interpolate premultiplied colour, then return straight RGBA. Otherwise
     * transparent padding contributes hidden black RGB and warped edges grow
     * a dark fringe. */
    const weights = [(1-fx)*(1-fy), fx*(1-fy), (1-fx)*fy, fx*fy];
    const indices = [i00,i10,i01,i11];
    let alpha=0, pr=0, pg=0, pb=0;
    for(let q=0;q<4;q++){
      const a=src[indices[q]+3]/255, wt=weights[q];
      alpha+=a*wt; pr+=src[indices[q]]*a*wt; pg+=src[indices[q]+1]*a*wt; pb+=src[indices[q]+2]*a*wt;
    }
    out[oi]=alpha?pr/alpha:0; out[oi+1]=alpha?pg/alpha:0; out[oi+2]=alpha?pb/alpha:0; out[oi+3]=alpha*255;
  }

  /** Run an inverse warp: fn(dx,dy) returns the SOURCE coordinate. */
  function remap(img, w, h, fn, edge, draft) {
    const src = new Uint8ClampedArray(img.data);
    const dst = img.data;
    const p = [0, 0, 0, 0];
    const step=draft?2:1;
    for (let y = 0; y < h; y+=step) {
      for (let x = 0; x < w; x+=step) {
        const s = fn(x, y);
        const i = (y * w + x) * 4;
        if (!s) {
          dst[i] = dst[i + 1] = dst[i + 2] = dst[i + 3] = 0;
          continue;
        }
        sample(src, w, h, s[0], s[1], edge || "clamp", p, 0);
        for(let by=0;by<step&&y+by<h;by++) for(let bx=0;bx<step&&x+bx<w;bx++){
          const di=((y+by)*w+x+bx)*4;
          dst[di]=p[0]; dst[di+1]=p[1]; dst[di+2]=p[2]; dst[di+3]=p[3];
        }
      }
    }
  }

  /* ---- §5.10 distortion ------------------------------------------------ */
  function distortion(img, w, h, P, extra) {
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
      extra && extra.draft,
    );
  }

  /* ---- §5.12 warp ------------------------------------------------------ */
  const ENVELOPES = ["arc", "arch", "bulge", "flag", "wave", "fisheye"];
  function warp(img, w, h, P, extra) {
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
      extra && extra.draft,
    );
  }

  /* ---- §5.11 displacement ---------------------------------------------- */
  function displacement(img, w, h, P, extra) {
    const sx = +P.scaleX || 0,
      sy = +P.scaleY || 0;
    if (!sx && !sy) return;
    const ch = { red: 0, green: 1, blue: 2, alpha: 3, luminance: -1 }[P.channel] ?? -1;
    const sc = Math.max(0.01, +P.mapScale || 1);
    const seed = Math.round(+P.seed || 1);
    /* Renderer options are not map pixels. A map is now explicit instead of
     * accidentally treating the always-present `{draft}` object as an array. */
    const mapData=extra&&extra.mapData&&typeof extra.mapData.length==='number'?extra.mapData:null;
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
      extra && extra.draft,
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
        /* 80 puts sigma at 40/255 with the slider at 100 — heavy but still
         * a picture — and at 4/255 around 10, which is the subtle film grain
         * range real work actually uses. The old scaling was 255*amt, so the
         * bottom of the slider was already past anything usable. */
        const g = amt * 80;
        if (mono) {
          // one signed value on all three channels: grain that does not tint
          const v = grain3(sx, sy, seed) * g;
          d[i] = clamp(d[i] + v, 0, 255);
          d[i + 1] = clamp(d[i + 1] + v, 0, 255);
          d[i + 2] = clamp(d[i + 2] + v, 0, 255);
        } else {
          d[i] = clamp(d[i] + grain3(sx, sy, seed) * g, 0, 255);
          d[i + 1] = clamp(d[i + 1] + grain3(sx, sy, seed + 17) * g, 0, 255);
          d[i + 2] = clamp(d[i + 2] + grain3(sx, sy, seed + 31) * g, 0, 255);
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

  /* Bloom is deliberately pixel-based, not another geometric glow. It keeps
   * the original layer, extracts only pixels above a luminance threshold,
   * softens that highlight layer, and adds it back. */
  function bloomLayer(cv, P) {
    const amount = Math.max(0, +P.amount || 0);
    const radius = Math.max(0, +P.radius || 0);
    if (!amount || !radius) return cv;
    const w = cv.width,
      h = cv.height;
    const hi = document.createElement("canvas");
    hi.width = w;
    hi.height = h;
    const hc = hi.getContext("2d", { willReadFrequently: true });
    hc.drawImage(cv, 0, 0);
    const im = hc.getImageData(0, 0, w, h),
      d = im.data;
    const threshold = clamp(+P.threshold || 0, 0, 1),
      knee = Math.max(0.001, clamp(+P.knee || 0, 0, 1));
    for (let i = 0; i < d.length; i += 4) {
      const lum = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      const keep = clamp((lum - threshold + knee) / (knee * 2), 0, 1);
      d[i + 3] = Math.round(d[i + 3] * keep);
    }
    hc.putImageData(im, 0, 0);
    const soft = blurLayer(hi, { kind: "gaussian", radius });
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    const oc = out.getContext("2d");
    oc.drawImage(cv, 0, 0);
    oc.globalCompositeOperation = "lighter";
    oc.globalAlpha = amount;
    oc.drawImage(soft, 0, 0);
    return out;
  }

  /* Shared colour correction. Engines and shaders deliberately do not own
   * copies of these controls: any rendered layer can pass through this once
   * in the ordered pixel stack. */
  function colorAdjust(img, w, h, P) {
    const d = img.data;
    const exposure = Math.pow(2, clamp(+P.exposure || 0, -3, 3));
    const blackPoint = clamp(+P.blackPoint || 0, 0, 0.99);
    const whitePoint = Math.max(
      blackPoint + 0.01,
      clamp(P.whitePoint === undefined ? 1 : +P.whitePoint, 0.01, 1),
    );
    const brightness = clamp(+P.brightness || 0, -1, 1);
    const contrast = clamp(+P.contrast || 0, -1, 1);
    const contrastFactor = contrast >= 0 ? 1 + contrast * 2 : 1 + contrast;
    const brilliance = clamp(+P.brilliance || 0, -1, 1);
    const gamma = clamp(P.gamma === undefined ? 1 : +P.gamma, 0.2, 4);
    const saturation = 1 + clamp(+P.saturation || 0, -1, 1);
    const vibrance = clamp(+P.vibrance || 0, -1, 1);
    const temperature = clamp(+P.temperature || 0, -1, 1);
    const tint = clamp(+P.tint || 0, -1, 1);
    const highlights = clamp(+P.highlights || 0, -1, 1);
    const shadows = clamp(+P.shadows || 0, -1, 1);
    const filterAmount = clamp(+P.filterAmount || 0, 0, 1);
    const filter = hexRgb(P.filterColor || "#ffffff").map((v) => v / 255);
    const definition = clamp(+P.definition || 0, 0, 1);
    const toward = (v, amount) => (amount >= 0 ? v + (1 - v) * amount : v * (1 + amount));
    const smooth = (a, b, v) => {
      const t = clamp((v - a) / (b - a), 0, 1);
      return t * t * (3 - 2 * t);
    };
    for (let i = 0; i < d.length; i += 4) {
      let r = d[i] / 255,
        g = d[i + 1] / 255,
        b = d[i + 2] / 255;
      r = clamp(r * exposure, 0, 1);
      g = clamp(g * exposure, 0, 1);
      b = clamp(b * exposure, 0, 1);
      r = clamp((r - blackPoint) / (whitePoint - blackPoint), 0, 1);
      g = clamp((g - blackPoint) / (whitePoint - blackPoint), 0, 1);
      b = clamp((b - blackPoint) / (whitePoint - blackPoint), 0, 1);
      r = toward(r, brightness);
      g = toward(g, brightness);
      b = toward(b, brightness);
      r = (r - 0.5) * contrastFactor + 0.5;
      g = (g - 0.5) * contrastFactor + 0.5;
      b = (b - 0.5) * contrastFactor + 0.5;
      let tone = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const brilliantShift = brilliance * (0.5 - tone) * 4 * Math.pow(tone - 0.5, 2) * 0.7;
      r = clamp(r + brilliantShift, 0, 1);
      g = clamp(g + brilliantShift, 0, 1);
      b = clamp(b + brilliantShift, 0, 1);
      r = Math.pow(r, 1 / gamma);
      g = Math.pow(g, 1 / gamma);
      b = Math.pow(b, 1 / gamma);
      let lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = lum + (r - lum) * saturation;
      g = lum + (g - lum) * saturation;
      b = lum + (b - lum) * saturation;
      r = clamp(r, 0, 1);
      g = clamp(g, 0, 1);
      b = clamp(b, 0, 1);
      const mx = Math.max(r, g, b),
        mn = Math.min(r, g, b),
        chroma = clamp(mx - mn, 0, 1);
      lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (vibrance !== 0 && chroma > 0.0001) {
        /* Vibrance is NOT a second Saturation slider. Positive values favour
         * muted colours quadratically, protect warm skin-like hues, and cap
         * the scale before any RGB channel clips. Negative values remain a
         * gentler global desaturation. */
        let hue = 0;
        if (mx !== mn) {
          if (mx === r) hue = 60 * (((g - b) / (mx - mn)) % 6);
          else if (mx === g) hue = 60 * ((b - r) / (mx - mn) + 2);
          else hue = 60 * ((r - g) / (mx - mn) + 4);
          if (hue < 0) hue += 360;
        }
        const skinLike =
          hue >= 12 && hue <= 58 && chroma >= 0.08 && chroma <= 0.72 && lum >= 0.18 && lum <= 0.92;
        let vf;
        if (vibrance > 0) {
          const muted = Math.pow(1 - chroma, 2);
          const protection = skinLike ? 0.35 : 1;
          const wanted = 1 + vibrance * 0.65 * muted * protection;
          let safe = Infinity;
          [r, g, b].forEach((v) => {
            const delta = v - lum;
            if (delta > 0) safe = Math.min(safe, (1 - lum) / delta);
            else if (delta < 0) safe = Math.min(safe, lum / -delta);
          });
          vf = Math.min(wanted, safe);
        } else vf = 1 + vibrance * 0.75;
        r = lum + (r - lum) * vf;
        g = lum + (g - lum) * vf;
        b = lum + (b - lum) * vf;
      }
      /* Temperature follows a blue↔amber axis; Tint follows green↔magenta.
       * Both are bounded channel balances, not hue rotations. */
      r = clamp(r + temperature * 0.12 + tint * 0.07, 0, 1);
      g = clamp(g - temperature * 0.015 - tint * 0.1, 0, 1);
      b = clamp(b - temperature * 0.12 + tint * 0.07, 0, 1);
      lum = clamp(0.2126 * r + 0.7152 * g + 0.0722 * b, 0, 1);
      const shadowWeight = 1 - smooth(0, 0.6, lum);
      const highlightWeight = smooth(0.4, 1, lum);
      const shadowMove = shadows * shadowWeight;
      const highlightMove = highlights * highlightWeight;
      r = toward(toward(clamp(r, 0, 1), shadowMove), highlightMove);
      g = toward(toward(clamp(g, 0, 1), shadowMove), highlightMove);
      b = toward(toward(clamp(b, 0, 1), shadowMove), highlightMove);
      r = r + (filter[0] - r) * filterAmount;
      g = g + (filter[1] - g) * filterAmount;
      b = b + (filter[2] - b) * filterAmount;
      d[i] = Math.round(clamp(r, 0, 1) * 255);
      d[i + 1] = Math.round(clamp(g, 0, 1) * 255);
      d[i + 2] = Math.round(clamp(b, 0, 1) * 255);
    }
    if (definition > 0 && w > 1 && h > 1) {
      const src = new Uint8ClampedArray(d);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          for (let ch = 0; ch < 3; ch++) {
            let sum = 0,
              n = 0;
            if (x > 0) {
              sum += src[i - 4 + ch];
              n++;
            }
            if (x < w - 1) {
              sum += src[i + 4 + ch];
              n++;
            }
            if (y > 0) {
              sum += src[i - w * 4 + ch];
              n++;
            }
            if (y < h - 1) {
              sum += src[i + w * 4 + ch];
              n++;
            }
            const edge = src[i + ch] - sum / n;
            d[i + ch] = Math.round(clamp(src[i + ch] + edge * definition * 0.8, 0, 255));
          }
        }
    }
    return img;
  }

  const hexRgb = (hex) => {
    const n = parseInt(String(hex || "#000000").slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };

  /* Three familiar mapping operations share the same luminance pass and the
   * same strength control. This is a capability with modes, not three engines
   * that would each repeat colour and opacity UI. */
  function colorMap(img, w, h, P) {
    const amount = clamp(+P.amount || 0, 0, 1);
    if (!amount) return img;
    const mode = ["gradientMap", "duotone", "overlay"].includes(P.mode) ? P.mode : "gradientMap";
    const lo = hexRgb(P.shadow),
      hi = hexRgb(P.highlight),
      over = hexRgb(P.overlay);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i],
        g = d[i + 1],
        b = d[i + 2];
      const lum = clamp((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255, 0, 1);
      let tr, tg, tb;
      if (mode === "overlay") {
        [tr, tg, tb] = over;
      } else if (mode === "gradientMap") {
        const t = clamp(lum + (+P.mapOffset || 0), 0, 1);
        tr = lo[0] + (hi[0] - lo[0]) * t;
        tg = lo[1] + (hi[1] - lo[1]) * t;
        tb = lo[2] + (hi[2] - lo[2]) * t;
      } else {
        /* Photoshop Duotone is not a two-stop gradient. It converts the
         * source to a single tonal channel, then gives EACH ink its own curve
         * from tone to ink percentage. We model those two printing plates and
         * overprint them subtractively on white paper. */
        const ink = 1 - lum;
        const darkCoverage = clamp(
          Math.pow(ink, clamp(+P.darkGamma || 1.25, 0.2, 4)) *
            clamp(P.darkStrength === undefined ? 1 : +P.darkStrength, 0, 1),
          0,
          1,
        );
        const lightCoverage = clamp(
          Math.pow(ink, clamp(+P.lightGamma || 0.65, 0.2, 4)) *
            clamp(P.lightStrength === undefined ? 0.55 : +P.lightStrength, 0, 1),
          0,
          1,
        );
        const channel = (dc, lc) =>
          255 * (1 - (1 - dc / 255) * darkCoverage) * (1 - (1 - lc / 255) * lightCoverage);
        tr = channel(lo[0], hi[0]);
        tg = channel(lo[1], hi[1]);
        tb = channel(lo[2], hi[2]);
      }
      d[i] = Math.round(r + (tr - r) * amount);
      d[i + 1] = Math.round(g + (tg - g) * amount);
      d[i + 2] = Math.round(b + (tb - b) * amount);
    }
    return img;
  }

  function channelFx(img, w, h, P, extra) {
    const mode = ["rgbSplit", "aberration", "channelOffset"].includes(P.mode) ? P.mode : "rgbSplit";
    const mix = clamp(P.mix === undefined ? 1 : +P.mix, 0, 1);
    const amount = clamp(+P.amount || 0, 0, 200);
    if (!mix || (mode !== "channelOffset" && !amount)) return img;
    const edge = ["clamp", "wrap", "mirror"].includes(P.edge) ? P.edge : "clamp";
    const src = new Uint8ClampedArray(img.data),
      out = img.data,
      tmp = [0, 0, 0, 0];
    const angle = ((+P.angle || 0) * Math.PI) / 180,
      ax = Math.cos(angle) * amount,
      ay = Math.sin(angle) * amount;
    const cx = w * (0.5 + clamp(+P.cx || 0, -0.5, 0.5)),
      cy = h * (0.5 + clamp(+P.cy || 0, -0.5, 0.5));
    const maxR = Math.max(1, Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy)));
    const falloff = clamp(+P.falloff || 1, 0.2, 4);
    const explicit = [
      +P.redX || 0,
      +P.redY || 0,
      +P.greenX || 0,
      +P.greenY || 0,
      +P.blueX || 0,
      +P.blueY || 0,
    ];
    const step = extra && extra.draft ? 2 : 1;
    for (let y = 0; y < h; y += step)
      for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4;
        let offsets;
        if (mode === "channelOffset") offsets = explicit;
        else if (mode === "rgbSplit") offsets = [ax, ay, 0, 0, -ax, -ay];
        else {
          const vx = x - cx,
            vy = y - cy,
            radius = Math.hypot(vx, vy),
            radial = Math.pow(radius / maxR, falloff) * amount;
          const ux = radius ? vx / radius : 0,
            uy = radius ? vy / radius : 0;
          offsets = [ux * radial, uy * radial, 0, 0, -ux * radial, -uy * radial];
        }
        /* EACH CHANNEL CARRIES ITS OWN ALPHA, and the result is recombined in
         * PREMULTIPLIED space. This is the whole difference between dispersion
         * and a hole punched in the artwork.
         *
         * Keeping the original alpha and moving only RGB looks right on a photo
         * and is wrong on anything with transparency: a displaced channel that
         * lands off the shape reads the background as BLACK, so the edge loses
         * that channel instead of the layer gaining a halo. Measured on a white
         * square over transparency, every inside edge came back rgba(255,255,0)
         * for aberration and rgba(0,255,255) for split and offset — a saturated
         * fringe biting inward, on all three modes.
         *
         * Real dispersion GROWS the layer: the displaced channel extends past
         * the original silhouette and shows as a coloured halo outside it, which
         * is what After Effects, Nuke and Blender all produce. Taking the union
         * of the sampled alphas lets it do that, and pixelPad has already
         * reserved the room. */
        const cols = [0, 0, 0],
          alphas = [0, 0, 0];
        for (let ch = 0; ch < 3; ch++) {
          /* Sampling from x-offset makes a positive offset move that channel's
           * visible content in the positive direction. */
          sample(src, w, h, x - offsets[ch * 2], y - offsets[ch * 2 + 1], edge, tmp, 0);
          cols[ch] = tmp[ch];
          alphas[ch] = tmp[3];
        }
        const srcA = src[i + 3];
        /* Inside the original silhouette, a displaced channel may sample
         transparent padding. Treating that missing sample as black carves a
         dark band into Glass. Backfill only the missing coverage from the
         undisplaced source channel; outside the silhouette srcA is zero, so
         displaced channels still grow the intended coloured halo. */
        for (let ch = 0; ch < 3; ch++) {
          if (srcA > alphas[ch]) {
            const missing = srcA - alphas[ch];
            cols[ch] = (cols[ch] * alphas[ch] + src[i + ch] * missing) / srcA;
            alphas[ch] = srcA;
          }
        }
        const dispA = Math.max(alphas[0], alphas[1], alphas[2]);
        /* Mix blends premultiplied, so a partly-applied effect over transparency
         * fades toward nothing rather than toward black. */
        const outA = srcA + (dispA - srcA) * mix;
        const rgb = [0, 0, 0];
        for (let ch = 0; ch < 3; ch++) {
          const srcP = src[i + ch] * srcA,
            dispP = cols[ch] * alphas[ch];
          const p2 = srcP + (dispP - srcP) * mix;
          rgb[ch] = outA > 0 ? Math.round(p2 / outA) : 0;
        }
        const aOut = Math.round(outA);
        for (let by = 0; by < step && y + by < h; by++)
          for (let bx = 0; bx < step && x + bx < w; bx++) {
            const oi = ((y + by) * w + x + bx) * 4;
            out[oi] = rgb[0];
            out[oi + 1] = rgb[1];
            out[oi + 2] = rgb[2];
            out[oi + 3] = aOut;
          }
      }
    return img;
  }

  /* One stylize capability, four modes. These operations all quantise the
   * rendered pixels, so they belong in the same ordered pixel-stack slot and
   * share a single non-destructive Mix control. */
  /* HALFTONE INK CURVE.
   *
   * A screen is only worth having if it is TONALLY FAITHFUL: 50% grey has to
   * print as 50% ink, or every image comes out muddy. Coverage goes as the
   * dot's AREA, so picking the radius proportional to sqrt(1-lum) and scaling
   * by a constant does not do that — `sqrt(1-lum)*0.68` yielded 0.73 coverage
   * at mid grey where 0.50 was wanted, and 0.94 at quarter tone where 0.75
   * was, pushing the whole curve dark. It also stopped short of solid: 0.68 is
   * less than the half-diagonal, so pure black kept 1% of the paper white.
   *
   * The exact coverage of a radius-r dot tiled on a cell of side 1:
   *   t <= 0.5      pi*t^2                      the dot fits its own cell
   *   t <= 1/sqrt2  pi*t^2 minus four segments  dots have met and overlap
   *   beyond        1                           the corners are filled
   * Inverting that numerically once gives the radius for any wanted coverage,
   * so the screen reproduces tone instead of approximating it. */
  const HALFTONE_R = (() => {
    const cover = (t) => {
      if (t <= 0) return 0;
      if (t >= Math.SQRT1_2) return 1;
      if (t <= 0.5) return Math.PI * t * t;
      const seg = t * t * Math.acos(0.5 / t) - 0.5 * Math.sqrt(t * t - 0.25);
      return Math.PI * t * t - 4 * seg;
    };
    const lut = new Float32Array(257);
    for (let i = 0; i <= 256; i++) {
      let lo = 0,
        hi = Math.SQRT1_2;
      for (let k = 0; k < 26; k++) {
        const m = (lo + hi) / 2;
        if (cover(m) < i / 256) lo = m;
        else hi = m;
      }
      lut[i] = (lo + hi) / 2;
    }
    return lut;
  })();

  function stylize(img, w, h, P) {
    const mix = clamp(P.mix === undefined ? 0 : +P.mix, 0, 1);
    if (!mix) return img;
    const mode = ["posterize", "threshold", "halftone", "pixelate"].includes(P.mode)
      ? P.mode
      : "posterize";
    const src = new Uint8ClampedArray(img.data),
      out = img.data;
    const blend = (i, r, g, b) => {
      out[i] = Math.round(src[i] + (r - src[i]) * mix);
      out[i + 1] = Math.round(src[i + 1] + (g - src[i + 1]) * mix);
      out[i + 2] = Math.round(src[i + 2] + (b - src[i + 2]) * mix);
    };
    if (mode === "posterize") {
      const levels = Math.round(clamp(+P.levels || 6, 2, 32)),
        scale = levels - 1;
      for (let i = 0; i < out.length; i += 4)
        blend(
          i,
          (Math.round((src[i] / 255) * scale) / scale) * 255,
          (Math.round((src[i + 1] / 255) * scale) / scale) * 255,
          (Math.round((src[i + 2] / 255) * scale) / scale) * 255,
        );
      return img;
    }
    const fg = hexRgb(P.foreground),
      bg = hexRgb(P.background);
    if (mode === "threshold") {
      const threshold = clamp(+P.threshold || 0, 0, 1),
        softness = clamp(+P.softness || 0, 0, 0.5);
      for (let i = 0; i < out.length; i += 4) {
        const lum = (0.2126 * src[i] + 0.7152 * src[i + 1] + 0.0722 * src[i + 2]) / 255;
        const t = softness
          ? clamp((lum - threshold + softness) / (softness * 2), 0, 1)
          : lum >= threshold
            ? 1
            : 0;
        blend(
          i,
          fg[0] + (bg[0] - fg[0]) * t,
          fg[1] + (bg[1] - fg[1]) * t,
          fg[2] + (bg[2] - fg[2]) * t,
        );
      }
      return img;
    }
    if (mode === "pixelate") {
      const size = Math.round(clamp(+P.pixelSize || 12, 2, 100));
      for (let by = 0; by < h; by += size)
        for (let bx = 0; bx < w; bx += size) {
          let r = 0,
            g = 0,
            b = 0,
            a = 0,
            n = 0;
          const yy = Math.min(h, by + size),
            xx = Math.min(w, bx + size);
          for (let y = by; y < yy; y++)
            for (let x = bx; x < xx; x++) {
              const i = (y * w + x) * 4,
                alpha = src[i + 3] / 255;
              r += src[i] * alpha;
              g += src[i + 1] * alpha;
              b += src[i + 2] * alpha;
              a += alpha;
              n++;
            }
          const rr = a ? r / a : 0,
            gg = a ? g / a : 0,
            bb = a ? b / a : 0;
          for (let y = by; y < yy; y++)
            for (let x = bx; x < xx; x++) blend((y * w + x) * 4, rr, gg, bb);
        }
      return img;
    }
    /* Rotated monochrome halftone. Each screen cell measures source
     * luminance; darker cells receive a larger ink dot. This is the standard
     * amplitude-modulated screen model, not a decorative dot overlay. */
    const cell = Math.round(clamp(+P.dotSize || 10, 2, 100));
    const ang = ((+P.angle || 0) * Math.PI) / 180,
      ca = Math.cos(ang),
      sa = Math.sin(ang);
    /* Measure each rotated screen cell from its COVERED pixels. Sampling only
     * the centre makes a cell that intersects a white shape but whose centre
     * lands in transparent padding read as transparent black, producing a
     * full ink dot along the edge. Alpha-weighted cell luminance makes absent
     * pixels contribute no tone at all. */
    const cellKey=new Array(w*h), cells=new Map();
    for(let y=0;y<h;y++) for(let x=0;x<w;x++){
      const i=(y*w+x)*4, u=x*ca+y*sa, v=-x*sa+y*ca;
      const key=Math.floor(u/cell)+','+Math.floor(v/cell);
      cellKey[y*w+x]=key;
      let stat=cells.get(key); if(!stat){ stat=[0,0]; cells.set(key,stat); }
      const alpha=src[i+3]/255;
      stat[0]+=((.2126*src[i]+.7152*src[i+1]+.0722*src[i+2])/255)*alpha;
      stat[1]+=alpha;
    }
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4,
          u = x * ca + y * sa,
          v = -x * sa + y * ca;
        const cu = (Math.floor(u / cell) + 0.5) * cell,
          cv = (Math.floor(v / cell) + 0.5) * cell;
        const stat=cells.get(cellKey[y*w+x]), lum=stat&&stat[1]?stat[0]/stat[1]:1;
        const coverage=clamp(1-lum,0,1),
          radius = HALFTONE_R[Math.round(coverage * 256)] * cell,
          dist = Math.hypot(u - cu, v - cv);
        /* ANTIALIASED RIM, and not only for looks. A binary dist <= radius
         * test is evaluated at pixel CENTRES, so every dot loses about half a
         * pixel all the way round its edge — a systematic shortfall in ink
         * that correcting the radius cannot fix, because the error scales with
         * the dot's perimeter rather than its area. Measured at 4 to 6 points
         * of tone across the range. Ramping across one pixel integrates to the
         * right area, and removes the stair-stepping a hard test leaves on
         * every dot. */
        /* The antialias ramp assumes a non-zero boundary. At radius zero its
         * +0.5 term would still paint a grey centre pixel in every pure-white
         * cell. Preserve the exact endpoint required by a printing screen. */
        const ink = coverage<=1e-7?0:clamp(radius - dist + 0.5, 0, 1);
        blend(
          i,
          bg[0] + (fg[0] - bg[0]) * ink,
          bg[1] + (fg[1] - bg[1]) * ink,
          bg[2] + (fg[2] - bg[2]) * ink,
        );
      }
    return img;
  }

  /** Apply one pixel effect to a layer. Returns the layer (possibly a new one). */
  function apply(type, cv, params, extra) {
    const w = cv.width,
      h = cv.height;
    if (!w || !h) return cv;
    if (type === "blur") return blurLayer(cv, params);
    if (type === "bloom") return bloomLayer(cv, params);
    const c = cv.getContext("2d", { willReadFrequently: true });
    const img = c.getImageData(0, 0, w, h);
    switch (type) {
      case "colorAdjust":
        colorAdjust(img, w, h, params);
        break;
      case "colorMap":
        colorMap(img, w, h, params);
        break;
      case "channelFx":
        channelFx(img, w, h, params, extra);
        break;
      case "stylize":
        stylize(img, w, h, params);
        break;
      case "distortion":
        distortion(img, w, h, params, extra);
        break;
      case "warp":
        warp(img, w, h, params, extra);
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

  /* hash2 and grain3 are exported for TESTS. Their distribution is the whole
   * correctness of every noise-driven effect here and it is not observable
   * through apply() under jsdom, which has no real raster — a biased hash
   * shipped for exactly that reason. */
  window.Filters = {
    apply,
    ENVELOPES,
    fbm,
    valueNoise,
    hash2,
    grain3,
    colorAdjustPixels: colorAdjust,
    colorMapPixels: colorMap,
    channelFxPixels: channelFx,
    stylizePixels: stylize,
    distortionPixels: distortion,
    warpPixels: warp,
    displacementPixels: displacement,
  };
})();
