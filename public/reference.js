/* Reference measurement — what a reference image IS, measured from pixels.
 *
 * Three questions, all answered here and none by a model:
 *
 *   1. CLASSIFY. Is the reference a colour field (a gradient, reproducible
 *      by one mesh), a material (a colour field seen through a surface — ribs,
 *      frost, grain), or a composition (things arranged: shapes, text, a
 *      grid, repeated geometry)? The class picks the reconstruction path.
 *      The old rule — "mean step between 16x16 grid cells under 60" — is true
 *      of every one of the nine references in images/ (they measure 25..52),
 *      because averaging a poster into 256 cells erases its edges. So every
 *      structured design was told it was a smooth field and flattened into a
 *      mesh. The features below are measured at 128px, where edges survive.
 *
 *   2. COMPARE. After a reconstruction is rendered, how far is it from the
 *      reference? Mean per-channel error at a normalised resolution, 0..255,
 *      with the same verdict bands the mesh fitter already reports: under 12
 *      close, under 30 approximate, otherwise failed. A model's self-reported
 *      confidence is never used for this; the pixels are.
 *
 *   3. SAMPLE. The measured colour grid the model is handed instead of being
 *      asked to judge colour by eye.
 *
 * Everything above the DOM helpers works on plain RGBA buffers, so the
 * classifier and the comparison are unit-tested without a canvas.
 *
 * Calibration (128px features, measured 6 Sep 2026 on images/):
 *
 *   file          edge24 edge64 periodic(axis lag strength amp)  expected
 *   gradient-01   0.037  0.000  cols 2 0.80 0.9                  color_field
 *   gradient-02   0.059  0.002  cols 2 0.55 0.7                  color_field
 *   glass         0.143  0.034  cols 16 0.28 8.3                 material
 *   object-01     0.166  0.015  rows 9 0.31 1.7                  composition
 *   grid-01       0.145  0.090  rows 42 0.11 12.0                composition
 *   hard edges    0.149  0.069  rows 16 0.35 8.4                 composition
 *   obj-02        0.237  0.086  rows 9 0.18 6.3                  composition
 *   object-03     0.253  0.065  cols 4 0.75 9.0                  composition
 *   gla21         0.382  0.093  rows 6 0.46 7.9                  composition
 *
 * edge24 = share of pixels whose luminance gradient exceeds 24/255 (any
 * edge), edge64 = share above 64 (a hard edge). A colour field has almost no
 * edges at all. A material has edges but soft ones, and a periodic structure
 * with real amplitude (ribs). Anything with hard edges is a composition —
 * including periodic ones (slats, streaks, a fan), which are compositions
 * with repetition metadata rather than materials. */
(function () {
  "use strict";

  const FEATURE_RES = 128;
  const COMPARE_RES = 96;
  const GRAIN_CROP = 384;

  /* Thresholds in one place, with the margin each has against the nearest
   * reference on the wrong side (see the table above). */
  const T = Object.freeze({
    fieldEdge: 0.1, // color field: edge24 below this (gradients 0.06, glass 0.14)
    fieldHard: 0.01, // ...and hard edges below this (gradients 0.002, object-01 0.015)
    materialHard: 0.05, // material: hard edges below this (glass 0.034, object-03 0.065)
    periodicStrength: 0.2, // ...and a periodic profile at least this strong (glass 0.28)
    periodicAmp: 4, // ...with at least this amplitude in luminance (glass 8.3, object-01 1.7)
    periodicLag: 4, // lags 2..3 are pixel noise, not structure
    close: 12, // verdict bands, shared with the mesh fitter's own report
    approximate: 30,
  });

  /* ---- pure measurements ------------------------------------------------ */

  function luminance(rgba, w, h) {
    const L = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      L[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
    }
    return L;
  }

  /** Share of interior pixels whose luminance gradient exceeds 24 and 64. */
  function edgeFractions(L, w, h) {
    let e24 = 0,
      e64 = 0,
      n = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const gx = L[y * w + x + 1] - L[y * w + x - 1];
        const gy = L[(y + 1) * w + x] - L[(y - 1) * w + x];
        const m = Math.hypot(gx, gy);
        n++;
        if (m > 24) e24++;
        if (m > 64) e64++;
      }
    }
    return { edge24: n ? e24 / n : 0, edge64: n ? e64 / n : 0 };
  }

  /** Distinct colours after 4-bit quantisation, counting only those covering
   *  at least 1% of the image — a palette size, not a histogram. */
  function distinctColours(rgba, w, h) {
    const counts = new Map();
    const total = w * h;
    for (let i = 0; i < total; i++) {
      const k = ((rgba[i * 4] >> 4) << 8) | ((rgba[i * 4 + 1] >> 4) << 4) | (rgba[i * 4 + 2] >> 4);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    let n = 0;
    counts.forEach((v) => {
      if (v >= total * 0.01) n++;
    });
    return n;
  }

  /** Mean luminance per row or per column. */
  function profile(L, w, h, axis) {
    const out = [];
    if (axis === "rows") {
      for (let y = 0; y < h; y++) {
        let m = 0;
        for (let x = 0; x < w; x++) m += L[y * w + x];
        out.push(m / w);
      }
    } else {
      for (let x = 0; x < w; x++) {
        let m = 0;
        for (let y = 0; y < h; y++) m += L[y * w + x];
        out.push(m / h);
      }
    }
    return out;
  }

  /** Repetition along one axis: the strongest autocorrelation peak of the
   *  HIGH-PASSED profile (a 9-wide moving average removed first, so a smooth
   *  gradient underneath does not read as one giant period). Returns the lag
   *  in pixels, the peak (0..1), and the profile's residual amplitude. */
  function periodicityAlong(L, w, h, axis) {
    const p = profile(L, w, h, axis);
    const n = p.length;
    const c = new Array(n);
    for (let i = 0; i < n; i++) {
      let a = 0,
        k = 0;
      for (let j = -4; j <= 4; j++) {
        const t = i + j;
        if (t >= 0 && t < n) {
          a += p[t];
          k++;
        }
      }
      c[i] = p[i] - a / k;
    }
    let v0 = 0;
    for (let i = 0; i < n; i++) v0 += c[i] * c[i];
    if (!v0) return { axis, lag: 0, strength: 0, amp: 0 };
    let best = 0,
      lag = 0;
    for (let d = 2; d < n / 3; d++) {
      let acc = 0;
      for (let i = 0; i + d < n; i++) acc += c[i] * c[i + d];
      const r = acc / v0;
      if (r > best) {
        best = r;
        lag = d;
      }
    }
    return { axis, lag, strength: best, amp: Math.sqrt(v0 / n) };
  }

  /** The more periodic of the two axes, with an estimated copy count. */
  function periodicity(L, w, h) {
    const r = periodicityAlong(L, w, h, "rows");
    const c = periodicityAlong(L, w, h, "cols");
    const p = r.strength >= c.strength ? r : c;
    const len = p.axis === "rows" ? h : w;
    return {
      axis: p.axis,
      lag: p.lag,
      strength: +p.strength.toFixed(3),
      amp: +p.amp.toFixed(2),
      count: p.lag ? Math.round(len / p.lag) : 0,
      /* pitch as a fraction of the axis, so a plan can place N copies */
      pitch: p.lag ? +(p.lag / len).toFixed(4) : 0,
    };
  }

  /** Film grain: the median 3x3 luminance residual over a NATIVE-resolution
   *  crop (downscaling averages grain away). Clean renders sit under 0.15,
   *  grainy references at 1.5 and above; mapped linearly to 0..1 between 0.3
   *  and 2.5. */
  function grainFromCrop(rgba, w, h) {
    if (!rgba || !(w >= 8) || !(h >= 8)) return { median: 0, amount: 0 };
    const L = luminance(rgba, w, h);
    const res = [];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        let m = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) m += L[(y + dy) * w + x + dx];
        res.push(Math.abs(L[y * w + x] - m / 9));
      }
    }
    res.sort((a, b) => a - b);
    const median = res[res.length >> 1] || 0;
    return {
      median: +median.toFixed(2),
      amount: +Math.min(1, Math.max(0, (median - 0.3) / 2.2)).toFixed(2),
    };
  }

  /** Every measurement the classifier and the planner use. `grainCrop` is an
   *  optional {rgba,w,h} at native resolution. */
  function features(rgba, w, h, grainCrop) {
    const L = luminance(rgba, w, h);
    const e = edgeFractions(L, w, h);
    const grain = grainCrop
      ? grainFromCrop(grainCrop.rgba, grainCrop.w, grainCrop.h)
      : { median: 0, amount: 0 };
    return {
      w,
      h,
      edge24: +e.edge24.toFixed(3),
      edge64: +e.edge64.toFixed(3),
      colours: distinctColours(rgba, w, h),
      periodic: periodicity(L, w, h),
      grain,
    };
  }

  /** The class, and the measurements that decided it, in words. */
  function classify(f) {
    const reasons = [];
    const p = f.periodic || { strength: 0, amp: 0, lag: 0 };
    const periodic =
      p.strength >= T.periodicStrength && p.amp >= T.periodicAmp && p.lag >= T.periodicLag;
    if (f.edge24 < T.fieldEdge && f.edge64 < T.fieldHard) {
      reasons.push(
        `almost no edges (${(f.edge24 * 100).toFixed(1)}% soft, ${(f.edge64 * 100).toFixed(1)}% hard)`,
      );
      return { kind: "color_field", reasons, periodic };
    }
    if (f.edge64 < T.materialHard && periodic) {
      reasons.push(
        `soft edges only (${(f.edge64 * 100).toFixed(1)}% hard) over a periodic ${p.axis === "rows" ? "horizontal" : "vertical"} structure of about ${p.count} (strength ${p.strength}, amplitude ${p.amp})`,
      );
      return { kind: "material", reasons, periodic };
    }
    reasons.push(
      `hard edges (${(f.edge64 * 100).toFixed(1)}% of pixels), ${f.colours} distinct colours`,
    );
    if (periodic)
      reasons.push(
        `repeated ${p.axis === "rows" ? "horizontally" : "vertically"} about ${p.count} times`,
      );
    return { kind: "composition", reasons, periodic };
  }

  /** Mean per-channel RGB error between two RGBA buffers of one size, 0..255. */
  function meanError(a, b) {
    let sum = 0,
      n = 0;
    for (let i = 0; i < a.length && i < b.length; i += 4) {
      sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      n += 3;
    }
    return n ? sum / n : 0;
  }

  const hex = (r, g, b) =>
    "#" +
    [r, g, b]
      .map((v) =>
        Math.round(Math.min(255, Math.max(0, v)))
          .toString(16)
          .padStart(2, "0"),
      )
      .join("");

  /** Per-cell comparison on an n x n grid: mean colour of each, and the error
   *  there. This is what a retry is told — where the render is wrong and
   *  which way — instead of being asked to try again blind. */
  function cellErrors(a, b, w, h, n) {
    const cells = [];
    for (let gy = 0; gy < n; gy++) {
      const row = [];
      for (let gx = 0; gx < n; gx++) {
        const x0 = Math.floor((gx * w) / n),
          x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * w) / n));
        const y0 = Math.floor((gy * h) / n),
          y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * h) / n));
        let ar = 0,
          ag = 0,
          ab = 0,
          br = 0,
          bg = 0,
          bb = 0,
          err = 0,
          k = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const i = (y * w + x) * 4;
            ar += a[i];
            ag += a[i + 1];
            ab += a[i + 2];
            br += b[i];
            bg += b[i + 1];
            bb += b[i + 2];
            err +=
              Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
            k++;
          }
        }
        row.push({
          ref: hex(ar / k, ag / k, ab / k),
          got: hex(br / k, bg / k, bb / k),
          err: +(err / (k * 3)).toFixed(1),
        });
      }
      cells.push(row);
    }
    return cells;
  }

  function verdict(err) {
    if (err == null || !isFinite(err)) return "unmeasured";
    return err < T.close ? "close" : err < T.approximate ? "approximate" : "failed";
  }

  /** Measured colour grid, n x n, row 0 at the top. Area averages. */
  function sampleGrid(rgba, w, h, n) {
    const rows = [];
    for (let gy = 0; gy < n; gy++) {
      const row = [];
      for (let gx = 0; gx < n; gx++) {
        const x0 = Math.floor((gx * w) / n),
          x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * w) / n));
        const y0 = Math.floor((gy * h) / n),
          y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * h) / n));
        let r = 0,
          g = 0,
          b = 0,
          k = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const i = (y * w + x) * 4;
            r += rgba[i];
            g += rgba[i + 1];
            b += rgba[i + 2];
            k++;
          }
        }
        row.push(hex(r / k, g / k, b / k));
      }
      rows.push(row);
    }
    return rows;
  }

  /* ---- DOM helpers -------------------------------------------------------- */

  function imageToRGBA(img, W, H) {
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const x = c.getContext("2d", { willReadFrequently: true });
    x.drawImage(img, 0, 0, W, H);
    return x.getImageData(0, 0, W, H);
  }

  /** Native-resolution centre crop, for grain. */
  function cropRGBA(img, side) {
    const iw = img.naturalWidth || img.width,
      ih = img.naturalHeight || img.height;
    const w = Math.min(side, iw),
      h = Math.min(side, ih);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const x = c.getContext("2d", { willReadFrequently: true });
    x.drawImage(img, Math.floor((iw - w) / 2), Math.floor((ih - h) / 2), w, h, 0, 0, w, h);
    const d = x.getImageData(0, 0, w, h);
    return { rgba: d.data, w, h };
  }

  /** Normalised comparison size for an aspect ratio: 96 on the long side. */
  function compareSize(aspect) {
    const a = isFinite(aspect) && aspect > 0 ? aspect : 1;
    const W = a >= 1 ? COMPARE_RES : Math.max(16, Math.round(COMPARE_RES * a));
    const H = a >= 1 ? Math.max(16, Math.round(COMPARE_RES / a)) : COMPARE_RES;
    return { W, H };
  }

  /** Everything the pipeline needs from a decoded reference. `gridN` is the
   *  measured-colour grid size handed to the model. */
  function measureImage(img, gridN) {
    const iw = img.naturalWidth || img.width,
      ih = img.naturalHeight || img.height;
    const aspect = iw / ih;
    const fw = aspect >= 1 ? FEATURE_RES : Math.max(16, Math.round(FEATURE_RES * aspect));
    const fh = aspect >= 1 ? Math.max(16, Math.round(FEATURE_RES / aspect)) : FEATURE_RES;
    const d = imageToRGBA(img, fw, fh);
    const f = features(d.data, fw, fh, cropRGBA(img, GRAIN_CROP));
    const cls = classify(f);
    const n = gridN || 8;
    return {
      width: iw,
      height: ih,
      aspect: +aspect.toFixed(4),
      features: f,
      classification: cls.kind,
      reasons: cls.reasons,
      grid: { grid: n, aspect: +aspect.toFixed(3), rows: sampleGrid(d.data, fw, fh, n) },
    };
  }

  /** Render vs reference. Both are resampled to one normalised size; the
   *  canvas is whatever drew the document (export path), so what is measured
   *  is what would be exported. */
  function compareImages(refImg, canvas, cellsN) {
    const iw = refImg.naturalWidth || refImg.width,
      ih = refImg.naturalHeight || refImg.height;
    const { W, H } = compareSize(iw / ih);
    const a = imageToRGBA(refImg, W, H).data;
    const b = imageToRGBA(canvas, W, H).data;
    const error = +meanError(a, b).toFixed(2);
    return {
      error,
      verdict: verdict(error),
      cells: cellErrors(a, b, W, H, cellsN || 4),
      w: W,
      h: H,
    };
  }

  window.Reference = Object.freeze({
    FEATURE_RES,
    COMPARE_RES,
    THRESHOLDS: T,
    luminance,
    edgeFractions,
    distinctColours,
    periodicity,
    grainFromCrop,
    features,
    classify,
    meanError,
    cellErrors,
    verdict,
    sampleGrid,
    compareSize,
    imageToRGBA,
    cropRGBA,
    measureImage,
    compareImages,
  });
})();
