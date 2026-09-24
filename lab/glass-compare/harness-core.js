/* The harness page's own code: one scene, three drivers, one measurement.
 * Inlined into harness.html by build.mjs after the three implementations. */
(function () {
  "use strict";
  const W = 900,
    H = 600;
  // one thick glass rounded-rect, centred
  const GLASS = { x: 225, y: 150, w: 450, h: 300, r: 48 };
  const S = 48; // grid pitch, px
  const LW = 2; // grid line width, px

  /* ---- backdrops -------------------------------------------------------- */
  function backdrop(kind, shift) {
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const g = c.getContext("2d");
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, W, H);
    g.fillStyle = "#000000";
    const s = (((shift || 0) % S) + S) % S;
    if (kind === "grid" || kind === "v") for (let x = s; x < W; x += S) g.fillRect(x, 0, LW, H);
    if (kind === "grid" || kind === "h") for (let y = s; y < H; y += S) g.fillRect(0, y, W, LW);
    return c;
  }
  /* Position-encoding backdrops for the direct fold test. R is a coarse ramp
   * across the frame (to about 3.5 px); G is a triangle wave of period 64 px,
   * continuous so filtering and mips cannot break it, which resolves position
   * to about 0.13 px within its half-period. */
  const TRI = 64;
  /** Triangle wave, 0..TRI/2 px. */
  const tri = (v) => {
    const t = ((v % TRI) + TRI) % TRI;
    return t < TRI / 2 ? t : TRI - t;
  };
  function rampBackdrop(axis) {
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const g = c.getContext("2d");
    const img = g.createImageData(W, H);
    const n = axis === "x" ? W : H;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const v = axis === "x" ? x : y;
        const t = v % TRI;
        const k = (y * W + x) * 4;
        img.data[k] = Math.round((255 * v) / (n - 1));
        img.data[k + 1] = Math.round(
          t < TRI / 2 ? (t * 255) / (TRI / 2) : ((TRI - t) * 255) / (TRI / 2),
        );
        img.data[k + 2] = Math.round((tri(v + TRI / 4) * 255) / (TRI / 2)); // quadrature: settles which side of a peak
        img.data[k + 3] = 255;
      }
    g.putImageData(img, 0, 0);
    return c;
  }
  function clone(src) {
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    c.getContext("2d").drawImage(src, 0, 0);
    return c;
  }

  /* ---- the same physical scene, in each implementation's own units ------
   * Normalised knobs shared by all three: refraction 0.25 of full scale,
   * thickness t of full scale, IOR as given. Everything that adds light
   * (reflection, rim/edge light, glow) is off, frost and dispersion are off,
   * tint is clear — so what is left is transmission. */
  function params(impl, ior, t, r) {
    r = r === undefined ? 0.25 : r; // refraction strength, fraction of full scale
    if (impl === "A")
      return {
        depth: 200 * t,
        refraction: r * 200,
        frost: 0,
        reflection: 0,
        light: 0,
        edgeMode: 0,
        edgeGlow: 0,
        edgeBlur: 30,
        edgeBlurOffset: 0,
        flutes: 0,
        fluteWidth: 24,
        fluteAngle: 0,
        fluteMode: 0,
        fluteCount: 20,
        fluteRandom: 0,
        lightAngle: 135,
        lightElevation: 55,
        dispersion: 0,
        tint: [1, 1, 1],
        opacity: 100,
        ior,
      };
    if (impl === "B")
      return {
        depth: 200 * t,
        refraction: r * 200,
        ior,
        roughness: 0,
        absorption: 0.1,
        backdropDistance: 10,
        bevel: 55,
        quality: "standard",
        frost: 0,
        reflection: 0,
        whiteLight: false,
        edgeIntensity: 0,
        edgeWidth: 12,
        edgeSoftness: 45,
        light: 0,
        edgeGlow: 0,
        dispersion: 0,
        tint: "#ffffff",
        opacity: 100,
        __crop: false,
      };
    if (impl === "C")
      return {
        depth: 100 * t,
        refraction: r * 100,
        frost: 0,
        reflection: 0,
        light: 0,
        dispersion: 0,
        transparency: 100,
        tint: "#ffffff",
        ior,
      };
    return { ior, t };
  }

  /* ---- A: its own shaders, its own uniform list (A's render(), ~1300-1334) */
  const A = (function () {
    let cv, gl, prog, loc, tex;
    const NAMES = [
      "backdrop",
      "resolution",
      "objectCenter",
      "objectSize",
      "objectRadius",
      "objectShape",
      "fillA",
      "fillB",
      "hasGlass",
      "depth",
      "refraction",
      "frost",
      "reflection",
      "light",
      "edgeMode",
      "edgeGlow",
      "edgeBlur",
      "edgeBlurOffset",
      "flutes",
      "fluteWidth",
      "fluteAngle",
      "fluteMode",
      "fluteCount",
      "fluteRandom",
      "lightAngle",
      "lightElevation",
      "dispersion",
      "tint",
      "opacity",
      "debugView",
      "labIor",
    ];
    function init() {
      if (gl) return true;
      cv = document.createElement("canvas");
      cv.width = W;
      cv.height = H;
      // A's own context options
      gl = cv.getContext("webgl2", {
        antialias: false,
        alpha: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: true,
      });
      if (!gl) return false;
      const sh = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
          throw new Error("A shader: " + gl.getShaderInfoLog(s));
        return s;
      };
      prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, window.A_SHADERS.vert));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, window.A_SHADERS.frag));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
        throw new Error("A link: " + gl.getProgramInfoLog(prog));
      loc = { position: gl.getAttribLocation(prog, "position") };
      NAMES.forEach((n) => (loc[n] = gl.getUniformLocation(prog, n)));
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
        gl.STATIC_DRAW,
      ); // A's quad
      tex = gl.createTexture();
      return true;
    }
    function render(bd, P) {
      if (!init()) throw new Error("A: no WebGL2");
      gl.viewport(0, 0, W, H);
      gl.useProgram(prog);
      gl.enableVertexAttribArray(loc.position);
      gl.vertexAttribPointer(loc.position, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      // A renders its backdrop into a GL texture, so row 0 is the BOTTOM; an
      // uploaded canvas has row 0 at the top — flip on upload to match.
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bd);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      // A's texture parameters, and A's generateMipmap before the object pass
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.generateMipmap(gl.TEXTURE_2D);
      const u1 = (n, v) => gl.uniform1f(loc[n], v);
      gl.uniform1i(loc.backdrop, 0);
      gl.uniform2f(loc.resolution, W, H);
      // A's object space is normalised and y-up
      gl.uniform2f(loc.objectCenter, (GLASS.x + GLASS.w / 2) / W, 1 - (GLASS.y + GLASS.h / 2) / H);
      gl.uniform2f(loc.objectSize, GLASS.w / W, GLASS.h / H);
      u1("objectRadius", GLASS.r / Math.min(GLASS.w, GLASS.h));
      u1("objectShape", 0);
      gl.uniform3f(loc.fillA, 1.0, 0.42, 0.03);
      gl.uniform3f(loc.fillB, 1.0, 0.16, 0.52);
      u1("hasGlass", 1);
      [
        "depth",
        "refraction",
        "frost",
        "reflection",
        "light",
        "edgeMode",
        "edgeGlow",
        "edgeBlur",
        "edgeBlurOffset",
        "flutes",
        "fluteWidth",
        "fluteAngle",
        "fluteMode",
        "fluteCount",
        "fluteRandom",
        "lightAngle",
        "lightElevation",
        "dispersion",
        "opacity",
      ].forEach((k) => u1(k, P[k]));
      gl.uniform3f(loc.tint, P.tint[0], P.tint[1], P.tint[2]);
      u1("debugView", 0);
      u1("labIor", P.ior);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      const out = document.createElement("canvas");
      out.width = W;
      out.height = H;
      out.getContext("2d").drawImage(cv, 0, 0);
      return out;
    }
    return { render };
  })();

  /* ---- B and C through their own entry points --------------------------- */
  function renderB(bd, P) {
    const c = clone(bd);
    const ok = window.GlassEngine.render(
      c,
      W,
      H,
      [
        {
          cx: GLASS.x + GLASS.w / 2,
          cy: GLASS.y + GLASS.h / 2,
          w: GLASS.w,
          h: GLASS.h,
          shape: 0,
          radius01: GLASS.r / Math.min(GLASS.w, GLASS.h),
        },
      ],
      P,
    );
    if (!ok) throw new Error("B: GlassEngine.render returned " + ok);
    return c;
  }
  function renderC(bd, P) {
    const c = clone(bd);
    const ctx = c.getContext("2d");
    const node = {
      transform: { x: GLASS.x, y: GLASS.y, width: GLASS.w, height: GLASS.h, rotation: 0 },
    };
    const path = new Path2D();
    path.roundRect(GLASS.x, GLASS.y, GLASS.w, GLASS.h, GLASS.r);
    window.C_renderGlassPass(
      ctx,
      node,
      path,
      { type: "geometry.rectangle", params: { radius: GLASS.r } },
      P,
      1,
    );
    return c;
  }
  /* A known answer for the metric itself: the backdrop shifted by exactly
   * +5 px in x and y inside the glass footprint, and nothing else. */
  function renderSynth(bd) {
    const c = clone(bd);
    const g = c.getContext("2d");
    g.save();
    g.beginPath();
    g.roundRect(GLASS.x, GLASS.y, GLASS.w, GLASS.h, GLASS.r);
    g.clip();
    g.drawImage(bd, 5, 5);
    g.restore();
    return c;
  }
  /* Known answers for the fold test: the left part of the glass samples
   * x' = x0 + f(d) column by column, d the depth into the glass.
   *   FOLD      f = d + 25 e^(-d/8)        steep fold near the rim (slope < -1)
   *   MIRROR05  a 40 px mirror of slope -0.5, compressed — a GRADUAL fold
   *   RIMFOLD   a 3 px reversal between the first two pixel columns of the rim */
  const REMAPS = {
    FOLD: (d) => d + 25 * Math.exp(-d / 8),
    MIRROR05: (d) => (d <= 60 ? d : d <= 100 ? 60 - 0.5 * (d - 60) : 40 + (d - 100)),
    RIMFOLD: (d) => (d < 1 ? d : d < 2 ? 6 : d < 3 ? 3 : d),
  };
  function renderRemap(bd, f) {
    const c = clone(bd);
    const g = c.getContext("2d");
    g.save();
    g.beginPath();
    g.roundRect(GLASS.x, GLASS.y, GLASS.w, GLASS.h, GLASS.r);
    g.clip();
    for (let d = 0; d < 140; d++)
      g.drawImage(bd, GLASS.x + f(d + 0.5) - 0.5, 0, 1, H, GLASS.x + d, 0, 1, H);
    g.restore();
    return c;
  }
  function render(impl, bd, P) {
    if (REMAPS[impl]) return renderRemap(bd, REMAPS[impl]);
    if (impl === "A") return A.render(bd, P);
    if (impl === "B") return renderB(bd, P);
    if (impl === "C") return renderC(bd, P);
    if (impl === "SYNTH5") return renderSynth(bd);
    if (impl === "NONE") return clone(bd);
    throw new Error("unknown impl " + impl);
  }

  /* ---- measurement ------------------------------------------------------
   * The line's image is isolated as (render over a blank white backdrop)
   * minus (render over the lines): everything the glass adds by itself —
   * Fresnel darkening, tint, absorption, dither — is identical in both and
   * cancels, leaving only where the line was transmitted to. Its centroid
   * in a ±R window, against the centroid of the same line with no glass,
   * is the displacement in px. The grid is shifted through a full pitch in
   * 3 px steps so every depth into the glass is sampled, not just where the
   * grid happens to fall. Rows (for vertical lines) and columns (for
   * horizontal ones) are taken from the straight middle 40% of each side,
   * away from the corners, and the per-line value is their median. */
  function lum(canvas) {
    const d = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, W, H).data;
    const L = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++)
      L[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
    return L;
  }
  const median = (a) => {
    const s = a.slice().sort((p, q) => p - q);
    return s.length ? s[s.length >> 1] : NaN;
  };
  function measure(impl, ior, t, opts) {
    const R = 21,
      STEP = (opts && opts.step) || 3;
    const P = Object.assign(params(impl, ior, t, opts && opts.r), (opts && opts.extra) || {});
    const blank = lum(render(impl, backdrop("blank"), P));
    const lines = [];
    const cx = GLASS.x + GLASS.w / 2,
      cy = GLASS.y + GLASS.h / 2;
    for (const axis of ["v", "h"]) {
      for (let sh = 0; sh < S; sh += STEP) {
        const bd = backdrop(axis, sh);
        const ref = lum(bd);
        const out = lum(render(impl, bd, P));
        for (let p0 = sh; p0 < (axis === "v" ? W : H); p0 += S) {
          const c = p0 + LW / 2; // line centre, px
          const lo = axis === "v" ? GLASS.x : GLASS.y,
            hi = axis === "v" ? GLASS.x + GLASS.w : GLASS.y + GLASS.h;
          if (c <= lo + 1 || c >= hi - 1) continue;
          const d = Math.min(c - lo, hi - c);
          const outwardSign = c < (axis === "v" ? cx : cy) ? -1 : 1;
          const side = axis === "v" ? (outwardSign < 0 ? "L" : "R") : outwardSign < 0 ? "T" : "B";
          const along0 =
            axis === "v"
              ? Math.round(GLASS.y + GLASS.h * 0.3)
              : Math.round(GLASS.x + GLASS.w * 0.3);
          const along1 =
            axis === "v"
              ? Math.round(GLASS.y + GLASS.h * 0.7)
              : Math.round(GLASS.x + GLASS.w * 0.7);
          const disps = [];
          let lost = 0,
            rows = 0;
          for (let a = along0; a <= along1; a += 3) {
            rows++;
            let wr = 0,
              xr = 0,
              wo = 0,
              xo = 0;
            for (let q = Math.round(c) - R; q <= Math.round(c) + R; q++) {
              if (q < 0 || q >= (axis === "v" ? W : H)) continue;
              const idx = axis === "v" ? a * W + q : q * W + a;
              const r = 255 - ref[idx];
              const o = Math.max(0, blank[idx] - out[idx]);
              wr += r;
              xr += r * (q + 0.5);
              wo += o;
              xo += o * (q + 0.5);
            }
            if (wo < 0.2 * wr) {
              lost++;
              continue;
            }
            disps.push(xo / wo - xr / wr);
          }
          const m = median(disps);
          lines.push({
            axis,
            side,
            d: +d.toFixed(1),
            disp: Number.isFinite(m) ? +(m * outwardSign).toFixed(3) : null,
            lostShare: +(lost / rows).toFixed(2),
          });
        }
      }
    }
    const ok = lines.filter((l) => l.disp !== null && l.lostShare < 0.5);
    const top = ok.reduce((b, l) => (Math.abs(l.disp) > Math.abs(b ? b.disp : 0) ? l : b), null);
    const interior = ok.filter((l) => l.d > 90);
    return {
      impl,
      ior,
      t,
      maxAbsDisp: top ? +Math.abs(top.disp).toFixed(2) : 0,
      // within 4 px of the ±21 px window, or any line lost: a lower bound only
      saturated: !!(top && Math.abs(top.disp) > R - 4),
      atDepth: top ? top.d : null,
      signAtMax: top ? (top.disp >= 0 ? "outward" : "inward") : null,
      interiorMaxAbs: interior.length
        ? +Math.max(...interior.map((l) => Math.abs(l.disp))).toFixed(2)
        : null,
      linesMeasured: ok.length,
      linesLost: lines.length - ok.length,
      profile: lines,
    };
  }

  /* ---- the direct fold test ---------------------------------------------
   * Decode, for every pixel inside the glass, WHERE on the backdrop it
   * sampled: (render over the ramp) / (render over white), per channel, which
   * cancels every multiplicative term the glass applies (tint, absorption,
   * Fresnel, the gamma round-trip). The coarse ramp picks the half-period,
   * the triangle wave gives the position within it. Along every row the
   * decoded x must never go backwards; along every column, y. A step back of
   * more than TOL px is a fold — the backdrop's order reversed, a mirrored
   * copy. Pixels within 2 px of the silhouette (antialiasing) are skipped. */
  function sdfRect(px, py) {
    const qx = Math.abs(px - (GLASS.x + GLASS.w / 2)) - GLASS.w / 2 + GLASS.r;
    const qy = Math.abs(py - (GLASS.y + GLASS.h / 2)) - GLASS.h / 2 + GLASS.r;
    return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - GLASS.r;
  }
  function rgba(canvas) {
    return canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  }
  function decode(out, blank, k, n) {
    const ratio = (c) => Math.min(1, Math.max(0, out[k + c] / Math.max(blank[k + c], 1)));
    const coarse = ratio(0) * (n - 1);
    const tG = ratio(1) * (TRI / 2),
      tB = ratio(2) * (TRI / 2);
    const base = Math.floor(coarse / TRI) * TRI;
    let best = coarse,
      bs = 1e9;
    // G gives two positions per period (either side of a peak); the coarse
    // ramp picks the period and the quadrature wave in B picks the side.
    for (const b of [base - TRI, base, base + TRI])
      for (const cand of [b + tG, b + TRI - tG]) {
        const score = Math.abs(cand - coarse) / 8 + Math.abs(tri(cand + TRI / 4) - tB);
        if (score < bs) {
          bs = score;
          best = cand;
        }
      }
    return best;
  }
  function mapFolds(impl, ior, t, opts) {
    const TOL = opts && opts.tol !== undefined ? opts.tol : 1.0;
    const P = Object.assign(params(impl, ior, t, opts && opts.r), (opts && opts.extra) || {});
    const blank = rgba(render(impl, backdrop("blank"), P));
    const res = {};
    for (const axis of ["x", "y"]) {
      const out = rgba(render(impl, rampBackdrop(axis), P));
      const n = axis === "x" ? W : H;
      let count = 0,
        worst = 0,
        where = null;
      const outer = axis === "x" ? H : W,
        inner = axis === "x" ? W : H;
      for (let a = 0; a < outer; a++) {
        /* Against the RUNNING MAXIMUM of this run of pixels, not the previous
         * pixel: a gradual fold (slope between -1 and 0) never steps back by
         * more than a pixel at a time, but it does fall below the furthest
         * point already reached. */
        let runMax = null;
        for (let b = 0; b < inner; b++) {
          const x = axis === "x" ? b : a,
            y = axis === "x" ? a : b;
          // only the outermost ~1 px (mostly antialiasing) is skipped; the rim is tested
          if (sdfRect(x + 0.5, y + 0.5) > -(opts && opts.edge !== undefined ? opts.edge : 1)) {
            runMax = null;
            continue;
          }
          const v = decode(out, blank, (y * W + x) * 4, n);
          if (runMax !== null && v < runMax - TOL) {
            count++;
            if (v - runMax < worst) {
              worst = v - runMax;
              where = [x, y];
            }
          }
          runMax = runMax === null ? v : Math.max(runMax, v);
        }
      }
      res[axis] = { reversals: count, worstPx: +worst.toFixed(2), at: where };
    }
    return { impl, ior, t, folds: res.x.reversals + res.y.reversals, x: res.x, y: res.y };
  }

  /* ---- pictures --------------------------------------------------------- */
  function scene(impl, ior, t, kind, shift, r) {
    return render(
      impl,
      backdrop(kind || "grid", shift === undefined ? 10 : shift),
      params(impl, ior, t, r),
    );
  }
  function panelRow(panels, labels, opts) {
    const band = 34,
      gap = 12;
    const w = panels[0].width,
      h = panels[0].height;
    const c = document.createElement("canvas");
    c.width = panels.length * w + (panels.length - 1) * gap;
    c.height = h + band;
    const g = c.getContext("2d");
    g.fillStyle = "#f2f2f4";
    g.fillRect(0, 0, c.width, c.height);
    panels.forEach((p, i) => {
      g.drawImage(p, i * (w + gap), band);
      g.fillStyle = "#111318";
      g.font = "600 " + ((opts && opts.font) || 18) + "px Helvetica, Arial, sans-serif";
      g.fillText(labels[i], i * (w + gap) + 8, 24);
    });
    return c.toDataURL("image/png");
  }
  function crop(src, x, y, w, h, k) {
    const c = document.createElement("canvas");
    c.width = w * k;
    c.height = h * k;
    const g = c.getContext("2d");
    g.imageSmoothingEnabled = false;
    g.drawImage(src, x, y, w, h, 0, 0, w * k, h * k);
    // the glass silhouette, drawn thin, so the eye can see where the edge is
    g.strokeStyle = "rgba(37,99,235,0.9)";
    g.lineWidth = 1;
    g.beginPath();
    g.roundRect((GLASS.x - x) * k, (GLASS.y - y) * k, GLASS.w * k, GLASS.h * k, GLASS.r * k);
    g.stroke();
    return c;
  }

  window.LAB = {
    W,
    H,
    GLASS,
    S,
    params,
    measure,
    mapFolds,
    render,
    backdrop,
    ready() {
      const out = {
        A: false,
        B: !!(window.GlassEngine && window.GlassEngine.available()),
        C: typeof window.C_renderGlassPass === "function",
      };
      try {
        A.render(backdrop("blank"), params("A", 1.52, 0.4));
        out.A = true;
      } catch (e) {
        out.Aerr = String(e.message || e);
      }
      return out;
    },
    sideBySide(ior, t) {
      return panelRow(
        ["A", "B", "C"].map((i) => scene(i, ior, t)),
        [
          `A  original demo  (IOR ${ior})`,
          `B  creative-editor glass.js  (IOR ${ior})`,
          `C  refract glass.ts  (IOR ${ior})`,
        ],
      );
    },
    iorSweep(impl, iors, t) {
      return panelRow(
        iors.map((n) => scene(impl, n, t)),
        iors.map((n) => `${impl}  IOR ${n}`),
      );
    },
    thicknessSweep(impl, ior, ts, names) {
      return panelRow(
        ts.map((t) => scene(impl, ior, t)),
        ts.map((t, i) => `${impl}  ${names[i]}  (IOR ${ior})`),
      );
    },
    sideBySideExtreme() {
      return panelRow(
        ["A", "B", "C"].map((i) => scene(i, 1.52, 1.0, "grid", 10, 1.0)),
        ["A  extreme (refraction 100%, depth 100%)", "B  extreme", "C  extreme"],
      );
    },
    /* where a grid line crosses the glass edge: the top-left corner, 4x */
    edgeCrops(ior, t, impls) {
      const box = [195, 120, 130, 130],
        k = 4;
      return panelRow(
        (impls || ["A", "B", "C"]).map((i) => crop(scene(i, ior, t), ...box, k)),
        (impls || ["A", "B", "C"]).map((i) => `${i}  IOR ${ior}  corner, ${k}x`),
        { font: 22 },
      );
    },
    edgeCropsIor(impl, iors, t) {
      const box = [195, 120, 130, 130],
        k = 4;
      return panelRow(
        iors.map((n) => crop(scene(impl, n, t), ...box, k)),
        iors.map((n) => `${impl}  IOR ${n}  corner, ${k}x`),
        { font: 22 },
      );
    },
  };
})();
