/* Structure — the three engines that make copies of a layer: the repeater
 * (a grid), symmetry (reflections and turns) and echo (a receding stack).
 *
 * Pure geometry. A layer plus a few numbers in, a list of derived instances
 * out: shallow views of the layer with only geometry substituted, so every
 * appearance property is inherited live, and nothing here is ever stored.
 * Deterministic — the only randomness is a hash of (seed, index, channel),
 * so a document draws the same figure every time.
 *
 * Moved out of app.js on 23 Sep 2026 exactly as it was, the first seam cut
 * from that file: these functions touched no editor state, and until now the
 * only way to test them was to boot the whole editor in jsdom. The server's
 * composition builder emits `pattern` and `echo`; with this file loadable in
 * node, what it emits can be checked against what the editor will draw. */
(function () {
  "use strict";

  const VERSION = "20260923-structure1";
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /* ---- linked pattern (see docs/pattern-contract.md) ----
   * A parent owns a pattern definition. Instances are DERIVED at layout time,
   * never stored, so inherited appearance cannot drift and parent-reference
   * cycles are unrepresentable. */
  const MAX_PATTERN_INSTANCES = 400;
  const MAX_GRID_AXIS = 32,
    MAX_GAP = 400,
    MAX_OFFSET = 500,
    MAX_JITTER = 500;
  const MAX_HOLES = 0.9,
    MIN_SIZE_FACTOR = 0.1;
  const MIRRORS = ["none", "horizontal", "vertical", "alt-horizontal", "alt-vertical"];

  /* ---- symmetry (§ structure) ----
   * The second structure engine. Where the repeater lays a GRID, symmetry
   * REFLECTS or TURNS — Illustrator's mirror and radial repeat. Both are pure
   * functions of the layer plus these few numbers: no seed, no randomness, so
   * the same document always draws the same figure. */
  const MAX_SYMMETRY_COUNT = 24,
    MAX_SYMMETRY_RADIUS = 2000,
    MAX_SYMMETRY_GAP = 400;

  const SYMMETRY_MODES = ["mirror", "radial"];
  const SYMMETRY_AXES = ["vertical", "horizontal", "both"];

  /* ---- echo (§ structure) ----
   * The third structure engine. The repeater lays a GRID and symmetry REFLECTS;
   * echo makes a receding STACK — each copy a step further, a little narrower, a
   * little flatter, turned a little more, with a seeded wobble so it does not
   * read as a machine.
   *
   * Width and height deform SEPARATELY because that is what reads as perspective
   * rather than as plain shrinking: a disc turning away keeps its width and
   * loses its height. */

  const MAX_ECHO_COPIES = 10;
  const DEFAULT_ECHO = () => ({
    copies: 4,
    /* Two ways to space a shrinking stack, and they look different.
     *
     * PROPORTIONAL (even off) steps by a share of each copy's OWN size, so the
     * step shrinks with the copies. That is how perspective behaves — equal
     * intervals receding do close up — but it reads as uneven.
     *
     * EVEN (on) holds the GAP between edges constant instead, so every space
     * looks the same however small the copies get. Measured against the
     * original, so it does not drift.
     *
     * 80% of the copy's own height puts each one just clear of the last at the
     * default shrink, which is why proportional starts there. */
    stepX: 0,
    stepY: 80,
    even: false,
    widthScale: 0.88,
    heightScale: 0.62,
    rotation: 0,
    randomness: 0,
    seed: 1,
    fade: 0,
  });
  const DEFAULT_SYMMETRY = () => ({
    mode: "mirror",
    axis: "vertical",
    gap: 0,
    count: 6,
    radius: 0,
    angle: 0,
    faceOut: true,
  });
  const DEFAULT_PATTERN = () => ({
    columns: 4,
    rows: 1,
    hGap: 16,
    vGap: 16,
    rowOffsetX: 0,
    colOffsetY: 0,
    baseScale: 1,
    lockProportions: true,
    widthVariation: 0,
    heightVariation: 0,
    baseRotation: 0,
    rotationStep: 0,
    rotationVariation: 0,
    mirror: "none",
    scaleStep: 0,
    jitterX: 0,
    jitterY: 0,
    holes: 0,
    seed: Math.floor(Math.random() * 99999999),
  });

  /* Deterministic value in [0,1) addressed by (seed, instance index, channel).
   * Deliberately a HASH, not a sequential stream: changing `holes` or adding a
   * row must not reshuffle the instances that were already there. */
  function rand01(seed, i, salt) {
    let a =
      (Math.imul(seed >>> 0, 0x9e3779b1) ^
        Math.imul(i + 1, 0x85ebca77) ^
        Math.imul(salt + 1, 0xc2b2ae3d)) >>>
      0;
    a = Math.imul(a ^ (a >>> 16), 0x7feb352d) >>> 0;
    a = Math.imul(a ^ (a >>> 15), 0x846ca68b) >>> 0;
    return ((a ^ (a >>> 16)) >>> 0) / 4294967296;
  }
  const R_W = 1,
    R_H = 2,
    R_ROT = 3,
    R_JX = 4,
    R_JY = 5,
    R_HOLE = 6;

  /* Migrate + validate a pattern. Returns null when the object has no pattern.
   * Idempotent: the Stage 1.1 branch is keyed on the retired `mode` field, which
   * this function never writes back, so re-running is a no-op. */
  function normalizePattern(raw) {
    if (!raw || typeof raw !== "object") return null;
    let p = raw;
    if ("mode" in p) {
      // ---- Stage 1.1 -> 1.2 migration ----
      if (p.mode === "none") return null; // "Off" is now "no pattern"
      const count = clamp(Math.round(+p.count || 4), 1, MAX_GRID_AXIS);
      const vary = clamp(+p.vary || 0, 0, 1);
      const mapped = {
        columns:
          p.mode === "columns"
            ? 1
            : p.mode === "grid"
              ? clamp(Math.round(+p.cols || count), 1, MAX_GRID_AXIS)
              : count,
        rows:
          p.mode === "rows"
            ? 1
            : p.mode === "grid"
              ? clamp(Math.round(+p.rows || count), 1, MAX_GRID_AXIS)
              : count,
        hGap: +p.gap || 0,
        vGap: +p.gap || 0,
        widthVariation: vary,
        heightVariation: vary,
        lockProportions: true,
        holes: clamp(+p.empty || 0, 0, MAX_HOLES),
        seed: Math.floor(+p.seed) || DEFAULT_PATTERN().seed,
      };
      // `window` (Coverage) is intentionally dropped — see docs/pattern-contract.md §8.
      p = Object.assign(DEFAULT_PATTERN(), mapped);
    }
    const d = DEFAULT_PATTERN();
    const out = Object.assign(d, p);
    const num = (v, def, lo, hi) => {
      const n = +v;
      return Number.isFinite(n) ? clamp(n, lo, hi) : def;
    };
    out.columns = clamp(Math.round(num(out.columns, 4, 1, MAX_GRID_AXIS)), 1, MAX_GRID_AXIS);
    out.rows = clamp(Math.round(num(out.rows, 1, 1, MAX_GRID_AXIS)), 1, MAX_GRID_AXIS);
    // Predictable cap: shed ROWS until the grid fits, never a partial row.
    if (out.columns * out.rows > MAX_PATTERN_INSTANCES) {
      out.rows = Math.max(1, Math.floor(MAX_PATTERN_INSTANCES / out.columns));
    }
    out.hGap = num(out.hGap, 0, 0, MAX_GAP);
    out.vGap = num(out.vGap, 0, 0, MAX_GAP);
    out.rowOffsetX = num(out.rowOffsetX, 0, -MAX_OFFSET, MAX_OFFSET);
    out.colOffsetY = num(out.colOffsetY, 0, -MAX_OFFSET, MAX_OFFSET);
    out.baseScale = num(out.baseScale, 1, 0.1, 2);
    out.lockProportions = !!out.lockProportions;
    out.widthVariation = num(out.widthVariation, 0, 0, 1);
    out.heightVariation = num(out.heightVariation, 0, 0, 1);
    out.baseRotation = num(out.baseRotation, 0, -180, 180);
    out.rotationStep = num(out.rotationStep, 0, -180, 180);
    out.rotationVariation = num(out.rotationVariation, 0, 0, 180);
    /* Progressive size: instance i is scaled by 1 + scaleStep*i (a fan whose
     * spokes grow, dots that shrink along a row), floored so a long run never
     * collapses to nothing. */
    out.scaleStep = num(out.scaleStep, 0, -0.5, 0.5);
    out.mirror = MIRRORS.includes(out.mirror) ? out.mirror : "none";
    out.jitterX = num(out.jitterX, 0, 0, MAX_JITTER);
    out.jitterY = num(out.jitterY, 0, 0, MAX_JITTER);
    out.holes = num(out.holes, 0, 0, MAX_HOLES);
    const s = Math.floor(+out.seed);
    out.seed = Number.isFinite(s) && s !== 0 ? s : DEFAULT_PATTERN().seed;
    delete out.mode;
    delete out.count;
    delete out.cols;
    delete out.gap;
    delete out.vary;
    delete out.window;
    delete out.empty;
    return out;
  }

  /* Clamped, complete, or null — an absent field is the OFF state, the same
   * terms the repeater and symmetry keep. */
  function normalizeEcho(raw) {
    if (!raw || typeof raw !== "object") return null;
    const d = DEFAULT_ECHO();
    const out = Object.assign(d, raw);
    const num = (v, def, lo, hi) => {
      const n = +v;
      return Number.isFinite(n) ? clamp(n, lo, hi) : def;
    };
    out.copies = clamp(Math.round(num(out.copies, 4, 1, MAX_ECHO_COPIES)), 1, MAX_ECHO_COPIES);
    out.stepX = num(out.stepX, 0, -200, 200);
    out.stepY = num(out.stepY, 80, -200, 200);
    out.even = !!out.even;
    out.widthScale = num(out.widthScale, 0.88, 0.2, 1.5);
    out.heightScale = num(out.heightScale, 0.62, 0.2, 1.5);
    out.rotation = num(out.rotation, 0, -180, 180);
    out.randomness = num(out.randomness, 0, 0, 1);
    out.fade = num(out.fade, 0, 0, 1);
    out.seed = clamp(Math.round(num(out.seed, 1, 1, 9999)), 1, 9999);
    return out;
  }

  /* Clamped, complete, or null. Null means "no symmetry on this layer", the
   * same way a missing `pattern` means no repeater: an absent field is the OFF
   * state, so nothing has to store a disabled engine. */
  function normalizeSymmetry(raw) {
    if (!raw || typeof raw !== "object") return null;
    const d = DEFAULT_SYMMETRY();
    const out = Object.assign(d, raw);
    const num = (v, def, lo, hi) => {
      const n = +v;
      return Number.isFinite(n) ? clamp(n, lo, hi) : def;
    };
    out.mode = SYMMETRY_MODES.includes(out.mode) ? out.mode : "mirror";
    out.axis = SYMMETRY_AXES.includes(out.axis) ? out.axis : "vertical";
    out.gap = num(out.gap, 0, -MAX_SYMMETRY_GAP, MAX_SYMMETRY_GAP);
    out.count = clamp(Math.round(num(out.count, 6, 2, MAX_SYMMETRY_COUNT)), 2, MAX_SYMMETRY_COUNT);
    out.radius = num(out.radius, 0, -MAX_SYMMETRY_RADIUS, MAX_SYMMETRY_RADIUS);
    out.angle = num(out.angle, 0, -180, 180);
    out.faceOut = !!out.faceOut;
    return out;
  }

  /* ---- linked pattern layout ----
   * Pure function of (parent, parent.pattern). Returns COMPLETE derived
   * instances positioned OUTSIDE the parent. Each instance is a shallow view of
   * the parent with only geometry substituted, so every appearance property
   * (type, radius, fill, opacity, shadow, grain) is inherited live — there is no
   * copied state that could drift. Deterministic: seeded, never Math.random. */
  function patternInstances(parent) {
    const P = parent && parent.pattern;
    const out = [];
    if (!P) return out;
    if (parent.type === "text") return out; // text parents unsupported
    if (parent.parentId) return out; // instances never recurse
    const pw = parent.w,
      ph = parent.h;
    if (!isFinite(pw) || !isFinite(ph) || pw <= 0 || ph <= 0) return out;
    if (!isFinite(parent.x) || !isFinite(parent.y)) return out;

    const cols = P.columns,
      rows = P.rows;
    const total = cols * rows;
    if (total > MAX_PATTERN_INSTANCES) return out; // normalizePattern prevents this
    const baseW = pw * P.baseScale,
      baseH = ph * P.baseScale;
    const RAD = Math.PI / 180;

    // Pass 1 — intrinsic size + rotation + the AXIS-ALIGNED BOUNDS those imply.
    // Spacing is driven by these actual bounds, never by the parent's size: that
    // substitution was the Stage 1.1 gap bug (see contract §1.2).
    // Ellipses use their EXACT rotated bounding box — the rectangle formula
    // (w|cos|+h|sin|) overestimates it, which padded rotated ellipses apart
    // even at gap 0.
    const aabb = (w, h, a) => {
      const ca = Math.cos(a),
        sa = Math.sin(a);
      if (parent.type === "ellipse") {
        return [
          Math.sqrt(w * w * ca * ca + h * h * sa * sa),
          Math.sqrt(w * w * sa * sa + h * h * ca * ca),
        ];
      }
      return [w * Math.abs(ca) + h * Math.abs(sa), w * Math.abs(sa) + h * Math.abs(ca)];
    };
    // Cell (0,0) is the PARENT itself: the grid grows right of and below it,
    // so the slot directly under the parent is a real instance, not a void.
    const cell = new Array(total);
    const [paw, pah] = aabb(pw, ph, 0);
    cell[0] = { w: pw, h: ph, rot: 0, aw: paw, ah: pah, isParent: true };
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (i === 0) continue;
        const rw = rand01(P.seed, i, R_W);
        const rh = P.lockProportions ? rw : rand01(P.seed, i, R_H);
        const prog = P.scaleStep ? Math.max(0.05, 1 + P.scaleStep * i) : 1;
        const w = baseW * prog * (1 - (1 - MIN_SIZE_FACTOR) * P.widthVariation * rw);
        const h = baseH * prog * (1 - (1 - MIN_SIZE_FACTOR) * P.heightVariation * rh);
        const rot =
          P.baseRotation +
          P.rotationStep * i +
          (P.rotationVariation ? (rand01(P.seed, i, R_ROT) * 2 - 1) * P.rotationVariation : 0);
        const [aw, ah] = aabb(w, h, rot * RAD);
        cell[i] = { w, h, rot, aw, ah };
      }

    // Pass 2 — row heights are the tallest actual bounds in each row, so rows
    // cannot overlap when heights vary.
    const rowH = new Array(rows).fill(0);
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) rowH[r] = Math.max(rowH[r], cell[r * cols + c].ah);

    // Pass 3 — centres. Horizontal advance is sequential over ACTUAL bounds, so
    // hGap is the exact clear space for every adjacent pair, including at 0.
    // Row 0 chains off the parent (cell 0); later rows left-align to the
    // parent's left edge so the column beneath it is populated.
    const pCx = parent.x + pw / 2,
      pCy = parent.y + ph / 2;
    let rowCy = 0;
    for (let r = 0; r < rows; r++) {
      rowCy = r === 0 ? pCy : rowCy + rowH[r - 1] / 2 + P.vGap + rowH[r] / 2;
      let cx = 0;
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c,
          k = cell[i];
        if (i === 0) {
          k.cx = pCx;
          k.cy = pCy;
          cx = pCx;
          continue;
        }
        cx = c === 0 ? parent.x + k.aw / 2 : cx + cell[i - 1].aw / 2 + P.hGap + k.aw / 2;
        k.cx = cx + r * P.rowOffsetX;
        k.cy = rowCy + c * P.colOffsetY;
        if (P.jitterX) k.cx += (rand01(P.seed, i, R_JX) * 2 - 1) * P.jitterX;
        if (P.jitterY) k.cy += (rand01(P.seed, i, R_JY) * 2 - 1) * P.jitterY;
      }
    }

    // Pass 4 — emit. Holes are applied LAST so omitting an instance never moves
    // the survivors; the slot grid above is already fixed. Cell 0 is the parent
    // and is never emitted as an instance.
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c,
          k = cell[i];
        if (i === 0) continue;
        if (P.holes > 0 && rand01(P.seed, i, R_HOLE) < P.holes) continue;
        const x = k.cx - k.w / 2,
          y = k.cy - k.h / 2;
        if (!isFinite(x) || !isFinite(y) || !(k.w > 0) || !(k.h > 0)) continue;
        const m = P.mirror;
        out.push({
          ...parent,
          id: parent.id + "#" + i,
          parentId: parent.id,
          instanceIndex: i,
          x,
          y,
          w: k.w,
          h: k.h,
          rot: k.rot,
          mirrorX: m === "horizontal" || (m === "alt-horizontal" && c % 2 === 1),
          mirrorY: m === "vertical" || (m === "alt-vertical" && r % 2 === 1),
          pattern: undefined,
          symmetry: undefined, // a copy carries no structure
        });
      }
    return out;
  }

  /* ---- echo layout ----
   * Complete derived instances, the shallow-view shape the other two engines
   * emit, so every appearance property is inherited live. Deterministic: the
   * wobble is a hash of (seed, copy, channel), never Math.random.
   *
   * Sizes COMPOUND, because a constant step reads as a list and a compounding
   * one reads as distance. The positional step is a share of the CURRENT size
   * for the same reason: a fixed step in page units pulls the small copies far
   * apart and the perspective falls over. */
  function echoInstances(parent) {
    const E = parent && parent.echo;
    const out = [];
    if (!E) return out;
    if (parent.type === "text") return out;
    if (parent.parentId) return out;
    const pw = parent.w,
      ph = parent.h;
    if (!isFinite(pw) || !isFinite(ph) || pw <= 0 || ph <= 0) return out;
    if (!isFinite(parent.x) || !isFinite(parent.y)) return out;
    const R = (i, ch) => rand01(E.seed, i, ch) * 2 - 1;
    let cx = parent.x + pw / 2,
      cy = parent.y + ph / 2,
      w = pw,
      h = ph;
    /* Even mode holds the EDGE gap constant, and the gap is measured from where
     * the two modes AGREE: the step at which the first copy just touches the
     * original. For a shrink of k that is (1+k)/2 of the size, so the same
     * number means the same thing whichever mode is on and flipping the switch
     * does not move the first copy. Above it a space opens, below it they
     * overlap. */
    const touchX = (1 + E.widthScale) / 2,
      touchY = (1 + E.heightScale) / 2;
    const gapX = (E.stepX / 100 - touchX) * pw,
      gapY = (E.stepY / 100 - touchY) * ph;
    for (let i = 1; i <= E.copies; i++) {
      const w0 = w,
        h0 = h;
      const nw = w * E.widthScale * (1 + R(i, 2) * E.randomness * 0.45);
      const nh = h * E.heightScale * (1 + R(i, 3) * E.randomness * 0.45);
      if (E.even) {
        cx += (E.stepX === 0 ? 0 : w0 / 2 + nw / 2 + gapX) + R(i, 0) * E.randomness * pw * 0.5;
        cy += (E.stepY === 0 ? 0 : h0 / 2 + nh / 2 + gapY) + R(i, 1) * E.randomness * ph * 0.5;
      } else {
        cx += (E.stepX / 100) * w0 + R(i, 0) * E.randomness * w0 * 0.5;
        cy += (E.stepY / 100) * h0 + R(i, 1) * E.randomness * h0 * 0.5;
      }
      w = nw;
      h = nh;
      if (!(w > 0.5 && h > 0.5)) break;
      if (!isFinite(cx) || !isFinite(cy)) break;
      const rot = (parent.rot || 0) + E.rotation * i + R(i, 4) * E.randomness * 60;
      const op =
        (parent.opacity === undefined ? 1 : parent.opacity) * (1 - E.fade * (i / E.copies));
      out.push(
        Object.assign({}, parent, {
          id: parent.id + "^" + i,
          parentId: parent.id,
          instanceIndex: i,
          x: cx - w / 2,
          y: cy - h / 2,
          w: w,
          h: h,
          rot: rot,
          opacity: op,
          pattern: undefined,
          symmetry: undefined,
          echo: undefined,
        }),
      );
    }
    return out;
  }

  /** Axis-aligned visual bounds of an instance's rotated geometry. */
  function instanceBounds(o) {
    // Must mirror the layout's aabb(): ellipses get their exact tangent box,
    // rectangles the rectangle AABB.
    const a = ((o.rot || 0) * Math.PI) / 180,
      ca = Math.cos(a),
      sa = Math.sin(a);
    let aw, ah;
    if (o.type === "ellipse") {
      aw = Math.sqrt(o.w * o.w * ca * ca + o.h * o.h * sa * sa);
      ah = Math.sqrt(o.w * o.w * sa * sa + o.h * o.h * ca * ca);
    } else {
      aw = o.w * Math.abs(ca) + o.h * Math.abs(sa);
      ah = o.w * Math.abs(sa) + o.h * Math.abs(ca);
    }
    const cx = o.x + o.w / 2,
      cy = o.y + o.h / 2;
    return { x: cx - aw / 2, y: cy - ah / 2, w: aw, h: ah };
  }

  /* ---- symmetry as operations on the plane ----
   * A symmetry is a set of RIGID TRANSFORMS — turns about a pivot, or
   * reflections across a line — computed once from the parent. Apply them to
   * the parent alone and you get symmetry. Apply them to the parent AND its
   * repeater copies and the whole field moves as one body, which is the
   * kaleidoscope.
   *
   * Splitting the operations from their application is what makes the second
   * case correct rather than merely plausible: the pivot and the mirror lines
   * belong to the PARENT, so every member turns about the same centre. Letting
   * each copy compute its own pivot spins each shape in place and the field
   * never turns at all — which is exactly what the first attempt drew.
   */
  function symmetryOps(parent) {
    const S = parent && parent.symmetry,
      out = [];
    if (!S) return out;
    const pw = parent.w,
      ph = parent.h;
    if (!isFinite(pw) || !isFinite(ph) || pw <= 0 || ph <= 0) return out;
    if (!isFinite(parent.x) || !isFinite(parent.y)) return out;
    const cx = parent.x + pw / 2,
      cy = parent.y + ph / 2;
    if (S.mode === "radial") {
      const n = S.count,
        step = 360 / n;
      for (let i = 1; i < n; i++)
        out.push({
          kind: "turn",
          i,
          deg: S.angle + step * i,
          px: cx,
          py: cy + S.radius,
          face: S.faceOut,
        });
      return out;
    }
    /* The mirror line sits half a gap beyond the layer's own TURNED bounds, so
     * `gap` is the exact clear space between the layer and its reflection — the
     * same rule the repeater's gaps follow. */
    const b = instanceBounds(parent);
    const lx = cx + (b.w + S.gap) / 2,
      ly = cy + (b.h + S.gap) / 2;
    const doX = S.axis === "vertical" || S.axis === "both";
    const doY = S.axis === "horizontal" || S.axis === "both";
    if (doX) out.push({ kind: "flip", i: 1, fx: lx });
    if (doY) out.push({ kind: "flip", i: 2, fy: ly });
    if (doX && doY) out.push({ kind: "flip", i: 3, fx: lx, fy: ly });
    return out;
  }

  /** One operation applied to one layer. Returns a complete derived instance —
   *  a shallow view of the layer with only geometry substituted, so every
   *  appearance property is inherited live — or null if it would not be finite. */
  function applySymmetryOp(m, op) {
    const w = m.w,
      h = m.h,
      cx = m.x + w / 2,
      cy = m.y + h / 2;
    let nx,
      ny,
      rot = m.rot || 0,
      mx = !!m.mirrorX,
      my = !!m.mirrorY;
    if (op.kind === "turn") {
      const a = (op.deg * Math.PI) / 180,
        ca = Math.cos(a),
        sa = Math.sin(a);
      const dx = cx - op.px,
        dy = cy - op.py;
      nx = op.px + dx * ca - dy * sa;
      ny = op.py + dx * sa + dy * ca;
      if (op.face) rot += op.deg;
    } else {
      const bothAxes = op.fx !== undefined && op.fy !== undefined;
      nx = op.fx !== undefined ? 2 * op.fx - cx : cx;
      ny = op.fy !== undefined ? 2 * op.fy - cy : cy;
      if (op.fx !== undefined) mx = !mx;
      if (op.fy !== undefined) my = !my;
      /* The draw order is rotate(rot) then scale(mirror), and a true reflection
       * of a turned body across a world axis is scale then rotate. The two agree
       * when a single-axis copy carries -rot. Reflecting BOTH axes is a half
       * turn, which commutes, so the diagonal copy keeps +rot. */
      rot = bothAxes ? rot : -rot;
    }
    if (!isFinite(nx) || !isFinite(ny)) return null;
    return {
      ...m,
      x: nx - w / 2,
      y: ny - h / 2,
      rot,
      mirrorX: mx,
      mirrorY: my,
      pattern: undefined,
      symmetry: undefined,
    }; // a copy carries no structure
  }

  /** The parent's own symmetry copies: every operation applied to the parent. */
  function symmetryInstances(parent) {
    const out = [];
    if (!parent || !parent.symmetry) return out;
    if (parent.type === "text") return out; // as with the repeater
    if (parent.parentId) return out; // instances never recurse
    for (const op of symmetryOps(parent)) {
      const c = applySymmetryOp(parent, op);
      if (c)
        out.push({ ...c, id: parent.id + "~" + op.i, parentId: parent.id, instanceIndex: op.i });
    }
    return out;
  }

  /* ONE seam for both structure engines. Every draw, hit-test, export and count
   * path asks this, not either layout directly, so the second engine did not
   * scatter a second call beside the first at fifteen sites.
   *
   * The repeater lays the field out; symmetry moves the whole field. A layer
   * carrying only one of them gets exactly that engine's layout, unchanged.
   * Carrying both, the operations are applied to the parent AND to every copy
   * the repeater made, capped at the repeater's own instance limit. */
  function derivedInstances(parent) {
    if (!parent) return [];
    let grid = parent.pattern ? patternInstances(parent) : [];
    /* Echo stacks the layer. With a repeater as well, every grid copy gets its
     * own stack, so the whole field recedes together. */
    if (parent.echo) {
      const stacked = grid.slice();
      for (const m of [parent].concat(grid)) {
        if (stacked.length >= MAX_PATTERN_INSTANCES) break;
        const lent =
          m === parent ? parent : Object.assign({}, m, { parentId: undefined, echo: parent.echo });
        for (const e of echoInstances(lent)) {
          if (stacked.length >= MAX_PATTERN_INSTANCES) break;
          stacked.push(Object.assign({}, e, { parentId: parent.id }));
        }
      }
      grid = stacked;
    }
    if (!parent.symmetry) return grid;
    const ops = symmetryOps(parent);
    if (!ops.length) return grid;
    const out = grid.slice();
    const field = [parent, ...grid];
    for (const op of ops) {
      for (const m of field) {
        if (out.length >= MAX_PATTERN_INSTANCES) return out;
        const c = applySymmetryOp(m, op);
        if (!c) continue;
        out.push({
          ...c,
          id: parent.id + "~" + op.i + (m === parent ? "" : "#" + m.instanceIndex),
          parentId: parent.id,
          instanceIndex: op.i,
        });
      }
    }
    return out;
  }

  window.Structure = Object.freeze({
    VERSION,
    MAX_PATTERN_INSTANCES,
    MAX_GRID_AXIS,
    MAX_GAP,
    MAX_OFFSET,
    MAX_JITTER,
    MAX_HOLES,
    MIN_SIZE_FACTOR,
    MIRRORS,
    MAX_SYMMETRY_COUNT,
    MAX_SYMMETRY_RADIUS,
    MAX_SYMMETRY_GAP,
    SYMMETRY_MODES,
    SYMMETRY_AXES,
    MAX_ECHO_COPIES,
    DEFAULT_ECHO,
    DEFAULT_SYMMETRY,
    DEFAULT_PATTERN,
    rand01,
    R_W,
    R_H,
    R_ROT,
    R_JX,
    R_JY,
    R_HOLE,
    normalizePattern,
    normalizeEcho,
    normalizeSymmetry,
    patternInstances,
    echoInstances,
    instanceBounds,
    symmetryOps,
    applySymmetryOp,
    symmetryInstances,
    derivedInstances,
  });
})();
