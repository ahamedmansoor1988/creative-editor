/* Spectral Field — a harmonic colour field solved inside a real vector path.
 *
 * THIS EFFECT CREATES NO GEOMETRY. The user's object IS the geometry; the
 * field is only a material evaluated inside it:
 *
 *   user path -> domain Omega -> boundary dOmega -> C_b(s) -> laplacian C = 0
 *
 * There is no circle in that pipeline, no radius, no centre and no sphere.
 *
 * WHAT THIS REPLACED, AND WHY IT HAD TO GO. The first version reconstructed a
 * unit sphere from the disc — `sqrt(1 - dot(p,p))`, a surface normal, colours
 * placed as 3D directions, the pale centre taken from depth z and the rim from
 * atan around a circle. It drew a circle inside every rectangle, because a
 * circle was the only thing it could draw. None of that maths survives here;
 * it was not adjusted, it was deleted. Fitting an ellipse or an SDF to the
 * outline while keeping radial field maths would have preserved exactly the
 * fault worth removing.
 *
 * WHY A HARMONIC SOLVE. Colours live on the PERIMETER, parameterised by
 * normalised arc length, and the interior is their harmonic extension: the
 * solution of laplacian C = 0 with those values on the boundary. That is the
 * smoothest possible interpolation of boundary data, it has no interior
 * extrema — so it cannot produce blobs or rings — and it is defined by the
 * shape rather than by any coordinate system laid over it. On a crescent it
 * diffuses THROUGH the crescent, never across the bite, because the stencil
 * only ever reaches neighbours that are inside.
 *
 * WHY THE FIELD IS SOLVED COARSE AND THE MASK IS NOT. A harmonic function has
 * no high frequencies by construction, so solving it at a fraction of the tile
 * and interpolating loses nothing visible. The domain mask is a different kind
 * of quantity — it carries the vector edge, which is exactly a high frequency —
 * so it is rasterised at full tile resolution and composited last. Bounds are
 * the computational extent; the path is the mathematical domain.
 */
(function () {
  "use strict";

  /* ---- SpectralFieldModel ----------------------------------------------- */

  const STOP_LIMIT = 16;
  const clampf = (v, lo, hi) => (!Number.isFinite(v) ? lo : v < lo ? lo : v > hi ? hi : v);

  function srgbToLinear(c) {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function linearToSrgb(c) {
    const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }
  function hexToLinear(hex) {
    const n = parseInt(String(hex).replace("#", ""), 16) || 0;
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map(srgbToLinear);
  }
  function linearToHex(lin) {
    const f = (v) =>
      Math.round(linearToSrgb(v) * 255)
        .toString(16)
        .padStart(2, "0");
    return "#" + f(lin[0]) + f(lin[1]) + f(lin[2]);
  }

  /* Colour stops sit at a position along the PERIMETER, 0..1 by arc length.
   * On a square, s runs along the top edge, down the right, back along the
   * bottom and up the left — the actual outline, not an inscribed circle. */
  const DEFAULT_STOPS = () =>
    [
      ["cyan", 0.02, "#22d3ee"],
      ["aqua", 0.14, "#7dd3fc"],
      ["green", 0.27, "#4ade80"],
      ["magenta", 0.39, "#ec4899"],
      ["violet", 0.52, "#7c3aed"],
      ["blue", 0.64, "#1d4ed8"],
      ["orange", 0.77, "#fb923c"],
      ["yellow", 0.89, "#fbbf24"],
    ].map(([id, s, hex]) => ({ id, s, color: hexToLinear(hex), strength: 1 }));

  /* No radius. No centre. No geometry of any kind — those belong to the
   * object, and duplicating them here is what made the old effect draw its
   * own shape instead of filling the user's. */
  const DEFAULTS = () => ({
    boundaryOffset: 0, // rotates the stops along the perimeter, 0..1
    intensity: 1, // chroma of the field
    spread: 0.5, // how far boundary colour reaches inward

    pearlStrength: 0.55,
    pearlDepth: 0.42, // as a fraction of the shape's inradius
    pearlColor: "#ffe0d6",

    edgeChroma: 0.5,
    rimWidth: 0.12, // fraction of the inradius
    rimStrength: 0.18,

    opacity: 1,
    stops: DEFAULT_STOPS(),
  });

  function normalize(S) {
    const s = Object.assign(DEFAULTS(), S || {});
    /* Legacy Spectral Orb documents carry radius / centerX / centerY. They are
     * DROPPED rather than mapped: they described a circle this effect no
     * longer has, and keeping them would leave the old geometry reachable. */
    delete s.radius;
    delete s.centerX;
    delete s.centerY;
    delete s.concentration;
    delete s.centerStrength;
    delete s.centerFalloff;
    delete s.centerColor;
    delete s.fresnelStrength;
    delete s.fresnelPower;
    delete s.anchors;
    delete s.centerSaturation;
    delete s.edgeSaturation;
    delete s.saturationCurve;
    delete s.rotation;

    s.boundaryOffset = ((+s.boundaryOffset || 0) % 1) + (+s.boundaryOffset < 0 ? 1 : 0);
    s.intensity = clampf(+s.intensity, 0, 2);
    s.spread = clampf(+s.spread, 0, 1);
    s.pearlStrength = clampf(+s.pearlStrength, 0, 1);
    s.pearlDepth = clampf(+s.pearlDepth, 0.02, 1);
    s.edgeChroma = clampf(+s.edgeChroma, 0, 2);
    s.rimWidth = clampf(+s.rimWidth, 0.01, 1);
    s.rimStrength = clampf(+s.rimStrength, 0, 1);
    s.opacity = clampf(+s.opacity, 0, 1);
    if (!/^#[0-9a-fA-F]{6}$/.test(s.pearlColor || "")) s.pearlColor = "#ffe0d6";

    let list = Array.isArray(s.stops) ? s.stops.slice(0, STOP_LIMIT) : [];
    if (!list.length) list = DEFAULT_STOPS();
    s.stops = list.map((st, i) => {
      const c = Array.isArray(st && st.color) ? st.color : [0.5, 0.5, 0.5];
      let p = +(st && st.s);
      if (!Number.isFinite(p)) p = i / list.length;
      return {
        id: (st && st.id) || "s" + i,
        s: ((p % 1) + 1) % 1,
        color: [0, 1, 2].map((k) => clampf(+c[k], 0, 4)),
        strength: clampf(+(st && st.strength), 0, 4) || (st && st.strength === 0 ? 0 : 1),
      };
    });
    return s;
  }

  /* ---- domain: the actual vector path ----------------------------------- */

  /** Rasterise the object's own path into a coverage mask.
   *
   *  The path is drawn by the CALLER, through a callback, because only the
   *  document knows what the object is — a rounded rect, a star, an imported
   *  SVG. Canvas fill() is used deliberately: it is anti-aliased, it honours
   *  the non-zero winding rule, and it handles concave outlines and holes
   *  without this file knowing anything about them. */
  function rasterMask(drawPath, w, h) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, w);
    c.height = Math.max(1, h);
    const cx = c.getContext("2d");
    cx.clearRect(0, 0, c.width, c.height);
    cx.fillStyle = "#fff";
    drawPath(cx, c.width, c.height);
    const d = cx.getImageData(0, 0, c.width, c.height).data;
    const m = new Float32Array(c.width * c.height);
    for (let i = 0, p = 3; i < m.length; i++, p += 4) m[i] = d[p] / 255;
    return m;
  }

  /** Exact Euclidean distance transform (Felzenszwalb & Huttenlocher), run on
   *  the INSIDE so every cell knows how far it is from the real boundary.
   *  Exact rather than a chamfer approximation because this drives the pearl
   *  and the rim: an approximate distance shows up as a lumpy interior. */
  function distanceInside(mask, w, h) {
    const INF = 1e20;
    const f = new Float64Array(Math.max(w, h));
    const dsq = new Float64Array(w * h);
    for (let i = 0; i < dsq.length; i++) dsq[i] = mask[i] > 0.5 ? INF : 0;

    const v = new Int32Array(Math.max(w, h));
    const z = new Float64Array(Math.max(w, h) + 1);
    const pass = (n, get, set) => {
      for (let i = 0; i < n; i++) f[i] = get(i);
      let k = 0;
      v[0] = 0;
      z[0] = -INF;
      z[1] = INF;
      for (let q = 1; q < n; q++) {
        let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        while (s <= z[k]) {
          k--;
          s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        }
        k++;
        v[k] = q;
        z[k] = s;
        z[k + 1] = INF;
      }
      k = 0;
      for (let q = 0; q < n; q++) {
        while (z[k + 1] < q) k++;
        set(q, (q - v[k]) * (q - v[k]) + f[v[k]]);
      }
    };
    for (let x = 0; x < w; x++)
      pass(
        h,
        (y) => dsq[y * w + x],
        (y, val) => (dsq[y * w + x] = val),
      );
    for (let y = 0; y < h; y++)
      pass(
        w,
        (x) => dsq[y * w + x],
        (x, val) => (dsq[y * w + x] = val),
      );
    /* Minus half a cell: the transform measures to the nearest OUTSIDE cell
     * CENTRE, and the boundary itself lies half a cell nearer than that. The
     * correction matters because pearl depth and rim width are expressed as
     * fractions of the inradius, so a systematic half-cell bias would make
     * both slightly wrong on small shapes and invisible on large ones — the
     * hardest kind of error to notice. */
    const out = new Float32Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.sqrt(dsq[i]) - 0.5);
    return out;
  }

  /** Trace the outline and hand back its points in order, so the perimeter can
   *  be parameterised by ARC LENGTH — the real thing, walked around the real
   *  edge. Marching squares on the mask rather than reading the path's own
   *  segments: it gives one uniform representation for a rect, a star and an
   *  imported curve alike, and it is already the outline the fill produced.
   *
   *  Returns the LONGEST closed contour. A shape with holes has more than one;
   *  the outer boundary is the one that carries the colour. */
  function traceBoundary(mask, w, h) {
    const inside = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] > 0.5;
    // the 8-neighbourhood, clockwise, so the walk turns consistently
    const NX = [-1, 0, 1, 1, 1, 0, -1, -1];
    const NY = [-1, -1, -1, 0, 1, 1, 1, 0];

    // start at the first inside cell in scan order: it is on the outer edge
    let sx = -1,
      sy = -1;
    for (let y = 0; y < h && sx < 0; y++) {
      for (let x = 0; x < w; x++) {
        if (inside(x, y)) {
          sx = x;
          sy = y;
          break;
        }
      }
    }
    if (sx < 0) return [];

    /* MOORE TRACING WITH JACOB'S STOPPING CRITERION.
     *
     * The first attempt at this was a four-way walk that preferred turning
     * left and accepted any edge cell. It could step between two cells for
     * ever, and since the outer scan then restarted the walk at the next
     * untraced edge cell, one concave shape was enough to wedge the renderer
     * hard enough to need a page reload. Bounded loops are not a substitute
     * for a terminating algorithm; this one terminates by construction.
     *
     * The rule: having arrived at p from b, sweep p's neighbours clockwise
     * starting one past b. The first inside cell is the next p, and b becomes
     * the direction pointing back the way we came.
     *
     * Stopping on RETURNING TO THE START CELL, not on returning to it with the
     * same backtrack. The stricter form is the textbook one and it never fired
     * here: the walk leaves the start heading right and comes back to it
     * heading up, so the backtracks differ by construction and the loop ran to
     * its cap every time — 12801 points for a 116-cell outline. For a simple
     * closed outline, arriving back at the start IS one full circuit. */
    const pts = [[sx, sy]];
    let px = sx,
      py = sy;
    let bi = 7; // came from the left, which is outside at the scan start
    const CAP = 8 * (w * h) + 64;
    for (let step = 0; step < CAP; step++) {
      let nx = -1,
        ny = -1,
        nb = bi;
      for (let t = 1; t <= 8; t++) {
        const k = (bi + t) % 8;
        const cx = px + NX[k],
          cy = py + NY[k];
        if (inside(cx, cy)) {
          nx = cx;
          ny = cy;
          nb = (k + 5) % 8; // the neighbour we came from, seen from the new cell
          break;
        }
      }
      if (nx < 0) break; // an isolated cell: nothing to trace
      px = nx;
      py = ny;
      bi = nb;
      if (px === sx && py === sy && step > 2) break;
      pts.push([px, py]);
    }
    return pts;
  }

  /** Normalised arc length for each traced point, plus the total perimeter. */
  function arcLength(pts) {
    const n = pts.length;
    const s = new Float32Array(n);
    let total = 0;
    for (let i = 1; i < n; i++) {
      total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      s[i] = total;
    }
    // close the loop so the parameterisation wraps
    total += Math.hypot(pts[0][0] - pts[n - 1][0], pts[0][1] - pts[n - 1][1]);
    if (total > 0) for (let i = 0; i < n; i++) s[i] /= total;
    return { s, total };
  }

  /** The boundary colour function C_b(s): a smooth wrap-around blend of the
   *  stops by their position along the perimeter. Weighted by circular
   *  distance so it is continuous at s = 0, where a linear ramp would leave a
   *  visible seam. */
  function boundaryColour(stops, offset, spread, out) {
    const n = stops.length;
    // concentration follows spread: tight stops at low spread, broad at high
    const k = 40 * Math.pow(0.06, spread);
    return (sv) => {
      let r = 0,
        g = 0,
        b = 0,
        tw = 0;
      for (let i = 0; i < n; i++) {
        const st = stops[i];
        let d = Math.abs(((sv - st.s - offset) % 1) + 1) % 1;
        if (d > 0.5) d = 1 - d; // circular distance: the seam has no edge
        const wgt = Math.exp(-k * d * d) * st.strength;
        r += st.color[0] * wgt;
        g += st.color[1] * wgt;
        b += st.color[2] * wgt;
        tw += wgt;
      }
      const inv = 1 / Math.max(tw, 1e-6);
      out[0] = r * inv;
      out[1] = g * inv;
      out[2] = b * inv;
      return out;
    };
  }

  /* ---- SpectralFieldSolver ---------------------------------------------- */

  /** Solve laplacian C = 0 inside the domain, with the traced perimeter as a
   *  Dirichlet condition.
   *
   *  Gauss-Seidel, run as a CASCADE from coarse to fine. A plain relaxation on
   *  the fine grid moves information one cell per sweep, so a 160-wide domain
   *  needs hundreds of sweeps before the middle hears about the edges at all.
   *  Solving small first and using that as the initial guess carries the
   *  low-frequency part — which is most of a harmonic function — almost for
   *  free.
   *
   *  Every neighbour is tested for membership. That is the line that makes a
   *  crescent work: the stencil never reaches across the bite, so colour
   *  diffuses the long way round the shape as it physically must. */
  function solveHarmonic(mask, bnd, w, h, sweeps) {
    const N = w * h;
    const C = new Float32Array(N * 3);
    const fixed = new Uint8Array(N);
    const solid = new Uint8Array(N);
    for (let i = 0; i < N; i++) solid[i] = mask[i] > 0.5 ? 1 : 0;
    for (let i = 0; i < N; i++) {
      if (bnd[i * 3] >= 0) {
        fixed[i] = 1;
        C[i * 3] = bnd[i * 3];
        C[i * 3 + 1] = bnd[i * 3 + 1];
        C[i * 3 + 2] = bnd[i * 3 + 2];
      }
    }
    // seed the interior with the mean boundary colour so the first sweeps have
    // something sane to relax from rather than black
    let mr = 0,
      mg = 0,
      mb = 0,
      mc = 0;
    for (let i = 0; i < N; i++)
      if (fixed[i]) {
        mr += C[i * 3];
        mg += C[i * 3 + 1];
        mb += C[i * 3 + 2];
        mc++;
      }
    if (mc) {
      mr /= mc;
      mg /= mc;
      mb /= mc;
      for (let i = 0; i < N; i++)
        if (solid[i] && !fixed[i]) {
          C[i * 3] = mr;
          C[i * 3 + 1] = mg;
          C[i * 3 + 2] = mb;
        }
    }
    for (let it = 0; it < sweeps; it++) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (!solid[i] || fixed[i]) continue;
          let r = 0,
            g = 0,
            b = 0,
            n = 0;
          if (x > 0 && solid[i - 1]) {
            r += C[(i - 1) * 3];
            g += C[(i - 1) * 3 + 1];
            b += C[(i - 1) * 3 + 2];
            n++;
          }
          if (x < w - 1 && solid[i + 1]) {
            r += C[(i + 1) * 3];
            g += C[(i + 1) * 3 + 1];
            b += C[(i + 1) * 3 + 2];
            n++;
          }
          if (y > 0 && solid[i - w]) {
            r += C[(i - w) * 3];
            g += C[(i - w) * 3 + 1];
            b += C[(i - w) * 3 + 2];
            n++;
          }
          if (y < h - 1 && solid[i + w]) {
            r += C[(i + w) * 3];
            g += C[(i + w) * 3 + 1];
            b += C[(i + w) * 3 + 2];
            n++;
          }
          if (!n) continue;
          const inv = 1 / n;
          C[i * 3] = r * inv;
          C[i * 3 + 1] = g * inv;
          C[i * 3 + 2] = b * inv;
        }
      }
    }
    return C;
  }

  /* ---- SpectralFieldRenderer -------------------------------------------- */

  /** Solve resolution. The field is harmonic and therefore smooth, so this is
   *  about how finely the DOMAIN is resolved, not how finely the colour is —
   *  a thin crescent needs more cells than a square of the same bounds. */
  function solveSize(w, h) {
    const long = Math.max(w, h);
    const k = Math.min(1, 160 / Math.max(1, long));
    return [Math.max(16, Math.round(w * k)), Math.max(16, Math.round(h * k))];
  }

  function computeField(drawPath, w, h, S, debug) {
    const [sw, sh] = solveSize(w, h);
    const scale = sw / Math.max(1, w);
    const maskLo = rasterMask((cx, cw, ch) => drawPath(cx, cw, ch), sw, sh);
    let solid = 0;
    for (let i = 0; i < maskLo.length; i++) if (maskLo[i] > 0.5) solid++;
    if (!solid) return null;

    const dist = distanceInside(maskLo, sw, sh);
    let maxD = 0;
    for (let i = 0; i < dist.length; i++) if (dist[i] > maxD) maxD = dist[i];
    maxD = Math.max(maxD, 1e-3); // the inradius, in solve cells

    const pts = traceBoundary(maskLo, sw, sh);
    const { s: arcS } = arcLength(pts);

    // Dirichlet values, written only where the traced outline passes
    const bnd = new Float32Array(sw * sh * 3).fill(-1);
    const sMap = new Float32Array(sw * sh).fill(-1);
    const tmp = [0, 0, 0];
    const cb = boundaryColour(S.stops, S.boundaryOffset, S.spread, tmp);
    for (let i = 0; i < pts.length; i++) {
      const idx = pts[i][1] * sw + pts[i][0];
      const col = cb(arcS[i]);
      bnd[idx * 3] = col[0];
      bnd[idx * 3 + 1] = col[1];
      bnd[idx * 3 + 2] = col[2];
      sMap[idx] = arcS[i];
    }

    /* Sweeps scale with the domain: information travels one cell per sweep, so
     * a wider shape needs proportionally more before the interior settles. */
    const C = solveHarmonic(maskLo, bnd, sw, sh, Math.round(60 + maxD * 2.2));

    return { sw, sh, scale, maskLo, dist, maxD, C, sMap, pts, arcS, debug };
  }

  /** Compose the solved field into an ImageData at solve resolution. The
   *  vector edge is NOT applied here — it is composited at full tile
   *  resolution by render(), because it is the one part of this that carries a
   *  high frequency. */
  function shade(F, S) {
    const { sw, sh, maskLo, dist, maxD, C, sMap } = F;
    const img = new ImageData(sw, sh);
    const px = img.data;
    const pearl = hexToLinear(S.pearlColor);
    const pearlD = S.pearlDepth * maxD;
    const rimD = S.rimWidth * maxD;
    const LUM = [0.2126, 0.7152, 0.0722];

    for (let i = 0; i < sw * sh; i++) {
      const p = i * 4;
      if (maskLo[i] <= 0.001) {
        px[p + 3] = 0;
        continue;
      }
      if (F.debug === "domain") {
        px[p] = px[p + 1] = px[p + 2] = 255;
        px[p + 3] = 255;
        continue;
      }
      if (F.debug === "distance") {
        /* Banded on purpose: contours make the shape of the field obvious. A
         * square must show square/diamond contours, never concentric circles. */
        const t = dist[i] / maxD;
        const band = 0.5 + 0.5 * Math.cos(t * Math.PI * 12);
        const v = Math.round(255 * (0.15 + 0.85 * t) * (0.55 + 0.45 * band));
        px[p] = px[p + 1] = px[p + 2] = v;
        px[p + 3] = 255;
        continue;
      }
      if (F.debug === "boundary") {
        const sv = sMap[i];
        if (sv < 0) {
          px[p] = px[p + 1] = px[p + 2] = 28;
          px[p + 3] = 255;
        } else {
          px[p] = Math.round(255 * (0.5 + 0.5 * Math.cos(6.2831853 * sv)));
          px[p + 1] = Math.round(255 * (0.5 + 0.5 * Math.cos(6.2831853 * (sv + 0.33))));
          px[p + 2] = Math.round(255 * (0.5 + 0.5 * Math.cos(6.2831853 * (sv + 0.67))));
          px[p + 3] = 255;
        }
        continue;
      }

      let r = C[i * 3],
        g = C[i * 3 + 1],
        b = C[i * 3 + 2];
      const d = dist[i];

      // chroma rises toward the real boundary, by distance to the real edge
      const lum = r * LUM[0] + g * LUM[1] + b * LUM[2];
      const near = 1 - Math.min(1, d / Math.max(rimD * 4, 1e-3));
      const sat = S.intensity * (1 + S.edgeChroma * near);
      r = lum + (r - lum) * sat;
      g = lum + (g - lum) * sat;
      b = lum + (b - lum) * sat;

      /* PEARL follows the shape, because it is driven by distance to the real
       * outline. On an elongated rectangle it runs along the rectangle; on a
       * crescent it follows the crescent. A radial term could do neither. */
      if (S.pearlStrength > 0) {
        const t = Math.min(1, d / Math.max(pearlD, 1e-3));
        const e = t * t * (3 - 2 * t);
        const k = e * S.pearlStrength;
        r += (pearl[0] - r) * k;
        g += (pearl[1] - g) * k;
        b += (pearl[2] - b) * k;
      }

      // a narrow rim, also measured inward from the real edge
      if (S.rimStrength > 0) {
        const t = 1 - Math.min(1, d / Math.max(rimD, 1e-3));
        const k = t * t * S.rimStrength;
        const l2 = r * LUM[0] + g * LUM[1] + b * LUM[2];
        r += (r - l2) * k;
        g += (g - l2) * k;
        b += (b - l2) * k;
      }

      px[p] = Math.round(linearToSrgb(r) * 255);
      px[p + 1] = Math.round(linearToSrgb(g) * 255);
      px[p + 2] = Math.round(linearToSrgb(b) * 255);
      px[p + 3] = 255;
    }
    return img;
  }

  function render(w, h, settings, opts) {
    const o = opts || {};
    const drawPath = o.drawPath;
    if (typeof drawPath !== "function") return null;
    const W = Math.max(1, Math.round(w)),
      H = Math.max(1, Math.round(h));
    const S = normalize(settings);
    const F = computeField(drawPath, W, H, S, o.debug || null);
    if (!F) return null;

    const lo = document.createElement("canvas");
    lo.width = F.sw;
    lo.height = F.sh;
    lo.getContext("2d").putImageData(shade(F, S), 0, 0);

    const out = document.createElement("canvas");
    out.width = W;
    out.height = H;
    const cx = out.getContext("2d");
    cx.imageSmoothingEnabled = true;
    if ("imageSmoothingQuality" in cx) cx.imageSmoothingQuality = "high";
    cx.drawImage(lo, 0, 0, W, H);

    /* The DOMAIN is applied here, at full resolution, from the same path the
     * document draws. destination-in keeps the field only where the shape is,
     * with the fill's own anti-aliased coverage — so the edge is the vector
     * edge and not a resampled copy of a coarse one. */
    cx.globalCompositeOperation = "destination-in";
    cx.fillStyle = "#fff";
    drawPath(cx, W, H);
    cx.globalCompositeOperation = "source-over";
    if (S.opacity < 1) {
      cx.globalCompositeOperation = "destination-in";
      cx.fillStyle = "rgba(255,255,255," + S.opacity + ")";
      cx.fillRect(0, 0, W, H);
      cx.globalCompositeOperation = "source-over";
    }
    return out;
  }

  /* One tile per (size, settings, path). The path key is the caller's, since
   * only the document knows when its own geometry changed. */
  const cache = new Map();
  const CACHE_MAX = 8;
  function get(w, h, settings, opts) {
    const o = opts || {};
    const k =
      Math.round(w) +
      "x" +
      Math.round(h) +
      "|" +
      (o.pathKey || "") +
      "|" +
      (o.debug || "") +
      "|" +
      JSON.stringify(settings);
    const hit = cache.get(k);
    if (hit) return hit;
    const tile = render(w, h, settings, opts);
    if (!tile) return null;
    cache.set(k, tile);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return tile;
  }

  /* ---- SpectralFieldHandle ---------------------------------------------- */

  /** Where a stop sits on the real perimeter, in 0..1 tile coordinates — so a
   *  handle lands ON the outline of whatever the object actually is. */
  function stopHandle(stop, settings, opts, w, h) {
    const o = opts || {};
    if (typeof o.drawPath !== "function") return null;
    const S = normalize(settings);
    const [sw, sh] = solveSize(w, h);
    const mask = rasterMask(o.drawPath, sw, sh);
    const pts = traceBoundary(mask, sw, sh);
    if (!pts.length) return null;
    const { s } = arcLength(pts);
    const target = ((((+stop.s || 0) + S.boundaryOffset) % 1) + 1) % 1;
    let bi = 0,
      bd = 2;
    for (let i = 0; i < pts.length; i++) {
      let d = Math.abs(s[i] - target);
      if (d > 0.5) d = 1 - d;
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    return { x: (pts[bi][0] + 0.5) / sw, y: (pts[bi][1] + 0.5) / sh };
  }

  /** The inverse: a point in tile coordinates -> the arc-length position of
   *  the nearest point on the real outline. */
  function sFromPoint(x, y, settings, opts, w, h) {
    const o = opts || {};
    if (typeof o.drawPath !== "function") return 0;
    const S = normalize(settings);
    const [sw, sh] = solveSize(w, h);
    const mask = rasterMask(o.drawPath, sw, sh);
    const pts = traceBoundary(mask, sw, sh);
    if (!pts.length) return 0;
    const { s } = arcLength(pts);
    const px = x * sw,
      py = y * sh;
    let bi = 0,
      bd = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = (pts[i][0] - px) * (pts[i][0] - px) + (pts[i][1] - py) * (pts[i][1] - py);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    return (((s[bi] - S.boundaryOffset) % 1) + 1) % 1;
  }

  /** Always true: this runs on the 2D context, so there is no WebGL to lose.
   *  Kept because every material call site guards on it. */
  const available = () => true;

  const DEBUG_VIEWS = ["domain", "boundary", "distance"];

  window.SpectralField = {
    STOP_LIMIT,
    DEBUG_VIEWS,
    DEFAULTS,
    DEFAULT_STOPS,
    normalize,
    available,
    render,
    get,
    stopHandle,
    sFromPoint,
    hexToLinear,
    linearToHex,
    srgbToLinear,
    linearToSrgb,
    // exported for tests: the domain and its parameterisation are the feature
    rasterMask,
    distanceInside,
    traceBoundary,
    arcLength,
    solveHarmonic,
    solveSize,
  };
})();
