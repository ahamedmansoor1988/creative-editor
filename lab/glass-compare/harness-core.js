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
  function render(impl, bd, P) {
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
    const P = params(impl, ior, t, opts && opts.r);
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
    /* FOLD-OVER: the image must keep the backdrop's order. A line deeper in
     * must still APPEAR deeper in: apparent depth = d - disp (outward disp
     * brings it toward the edge). Consecutive sampled lines on one side whose
     * apparent order reverses by more than half a pixel are a fold — the
     * mirrored duplicates B's comments say refract() produced. */
    let folds = 0;
    for (const sd of ["L", "R", "T", "B"]) {
      const g = ok.filter((l) => l.side === sd && l.d < 90).sort((a, b) => a.d - b.d);
      for (let i = 1; i < g.length; i++)
        if (g[i].d - g[i - 1].d >= 1 && g[i].d - g[i].disp < g[i - 1].d - g[i - 1].disp - 0.5)
          folds++;
    }
    return {
      impl,
      ior,
      t,
      maxAbsDisp: top ? +Math.abs(top.disp).toFixed(2) : 0,
      atDepth: top ? top.d : null,
      signAtMax: top ? (top.disp >= 0 ? "outward" : "inward") : null,
      interiorMaxAbs: interior.length
        ? +Math.max(...interior.map((l) => Math.abs(l.disp))).toFixed(2)
        : null,
      folds,
      linesMeasured: ok.length,
      linesLost: lines.length - ok.length,
      profile: lines,
    };
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
