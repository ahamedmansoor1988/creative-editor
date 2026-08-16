/* Snapping and alignment guides (§2.10, §2.11).
 *
 * ============================ READ THIS FIRST ============================
 * §0 constraint 1 is a HARD requirement, not a style preference:
 *
 *   Do NOT implement snap-target lookup by binning segments into angular
 *   ranges keyed on signed distance from a reference point and binary-
 *   searching those bins. (Adobe US 11,967,010, active until 2041.)
 *
 * This file uses a UNIFORM SPATIAL GRID — one of the three structures §0
 * explicitly approves (uniform grid, R-tree, sorted edge lists). Candidate
 * coordinates are bucketed by floor(coord / CELL) and a query reads the three
 * buckets covering [q-r, q+r]. There is no angular binning, no signed
 * distance from a reference point, and no binary search anywhere in it.
 *
 * If you are optimising this later: angular binning is the natural-feeling
 * speedup and it is exactly the thing that is forbidden. Widen the cell,
 * cache the index, or move to an R-tree instead.
 * ========================================================================
 */
(function () {
  "use strict";

  const CELL = 64; // page units per bucket; ~a screen-ish span at 1:1

  /* A one-dimensional uniform grid of candidate coordinates. Vertical snap
   * lines (x positions) and horizontal ones (y positions) each get their own. */
  function Axis() {
    this.buckets = new Map();
  }
  Axis.prototype.add = function (pos, meta) {
    const k = Math.floor(pos / CELL);
    let b = this.buckets.get(k);
    if (!b) {
      b = [];
      this.buckets.set(k, b);
    }
    b.push({ pos, meta });
  };
  /** Nearest candidate to `pos` within `tol`, or null. Reads only the buckets
   *  that can possibly contain a hit — no ordering, no search tree. */
  Axis.prototype.nearest = function (pos, tol) {
    const lo = Math.floor((pos - tol) / CELL),
      hi = Math.floor((pos + tol) / CELL);
    let best = null;
    for (let k = lo; k <= hi; k++) {
      const b = this.buckets.get(k);
      if (!b) continue;
      for (let i = 0; i < b.length; i++) {
        const d = Math.abs(b[i].pos - pos);
        if (d <= tol && (!best || d < best.d)) best = { d, pos: b[i].pos, meta: b[i].meta };
      }
    }
    return best;
  };

  /* ---- building the index -------------------------------------------- */
  /** Candidates from everything the moving selection could snap to. */
  function buildIndex(o) {
    const V = new Axis(),
      H = new Axis(); // V holds x positions, H holds y
    const S = o.settings;
    if (S.artboard) {
      const f = o.frame;
      V.add(0, { kind: "artboard", label: "left" });
      V.add(f.w, { kind: "artboard", label: "right" });
      V.add(f.w / 2, { kind: "artboard", label: "centre" });
      H.add(0, { kind: "artboard", label: "top" });
      H.add(f.h, { kind: "artboard", label: "bottom" });
      H.add(f.h / 2, { kind: "artboard", label: "middle" });
    }
    if (S.guides)
      (o.guides || []).forEach((g) => {
        (g.axis === "v" ? V : H).add(g.pos, { kind: "guide" });
      });
    if (S.grid && o.grid && o.grid.snap && o.grid.size > 0) {
      // Grid lines are generated on demand around the query, not enumerated —
      // an infinite canvas has unbounded grid lines. Marked so query() knows.
      o.__gridStep = o.grid.size / Math.max(1, o.grid.subdivisions || 1);
    }
    (o.others || []).forEach((t) => {
      const b = t.box;
      if (S.edges) {
        V.add(b.x, { kind: "edge", obj: t.obj, side: "left" });
        V.add(b.x + b.w, { kind: "edge", obj: t.obj, side: "right" });
        H.add(b.y, { kind: "edge", obj: t.obj, side: "top" });
        H.add(b.y + b.h, { kind: "edge", obj: t.obj, side: "bottom" });
      }
      if (S.centers) {
        V.add(b.x + b.w / 2, { kind: "centre", obj: t.obj });
        H.add(b.y + b.h / 2, { kind: "centre", obj: t.obj });
      }
      if (S.anchors && t.anchors)
        t.anchors.forEach((p) => {
          V.add(p.x, { kind: "anchor", obj: t.obj });
          H.add(p.y, { kind: "anchor", obj: t.obj });
        });
    });
    return {
      V,
      H,
      gridStep: o.__gridStep || 0,
      settings: S,
      others: o.others || [],
      frame: o.frame,
    };
  }

  /** Snap one axis. `probes` are the moving selection's own candidate
   *  coordinates on that axis (its left/centre/right, or top/middle/bottom).
   *  Returns {delta, line, meta} for the best hit, or null. */
  function snapAxis(index, axis, probes, tol) {
    const A = axis === "v" ? index.V : index.H;
    let best = null;
    probes.forEach((p) => {
      const hit = A.nearest(p.pos, tol);
      if (hit && (!best || hit.d < best.d))
        best = { d: hit.d, delta: hit.pos - p.pos, line: hit.pos, meta: hit.meta, from: p };
      // grid is computed rather than indexed, so it is checked alongside
      if (index.gridStep > 0) {
        const g = Math.round(p.pos / index.gridStep) * index.gridStep;
        const d = Math.abs(g - p.pos);
        if (d <= tol && (!best || d < best.d))
          best = { d, delta: g - p.pos, line: g, meta: { kind: "grid" }, from: p };
      }
    });
    return best;
  }

  /** Full snap for a moving box. Returns {dx,dy,lines:[{axis,pos,meta}]}. */
  function snapBox(index, box, tol) {
    const vp = [
      { pos: box.x, at: "left" },
      { pos: box.x + box.w / 2, at: "centre" },
      { pos: box.x + box.w, at: "right" },
    ];
    const hp = [
      { pos: box.y, at: "top" },
      { pos: box.y + box.h / 2, at: "middle" },
      { pos: box.y + box.h, at: "bottom" },
    ];
    const v = snapAxis(index, "v", vp, tol);
    const h = snapAxis(index, "h", hp, tol);
    const lines = [];
    if (v) lines.push({ axis: "v", pos: v.line, meta: v.meta });
    if (h) lines.push({ axis: "h", pos: h.line, meta: h.meta });
    return { dx: v ? v.delta : 0, dy: h ? h.delta : 0, lines };
  }

  /** Snap a single point (node editing, pen). */
  function snapPoint(index, x, y, tol) {
    const v = snapAxis(index, "v", [{ pos: x, at: "x" }], tol);
    const h = snapAxis(index, "h", [{ pos: y, at: "y" }], tol);
    const lines = [];
    if (v) lines.push({ axis: "v", pos: v.line, meta: v.meta });
    if (h) lines.push({ axis: "h", pos: h.line, meta: h.meta });
    return { dx: v ? v.delta : 0, dy: h ? h.delta : 0, lines };
  }

  /* ---- equal-spacing detection (§2.11) --------------------------------
   * With three or more boxes in a row, report the gaps that are equal so the
   * canvas can draw the "same distance" indicator. Pure measurement — it does
   * not move anything. */
  function equalGaps(boxes, axis, tolPx, ref) {
    const H = axis === "h";
    /* Only boxes that actually form a ROW with the reference count: they must
     * overlap it on the PERPENDICULAR axis. Without this, one wide header
     * spanning the whole layout sits in the sorted order between the cards and
     * destroys every run — which is the common case, not a rare one. */
    let pool = boxes;
    if (ref) {
      pool = boxes.filter((b) =>
        H ? b.y < ref.y + ref.h && b.y + b.h > ref.y : b.x < ref.x + ref.w && b.x + b.w > ref.x,
      );
    }
    const sorted = [...pool].sort((a, b) => (H ? a.x - b.x : a.y - b.y));
    const gaps = [];
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i],
        b = sorted[i + 1];
      const g = H ? b.x - (a.x + a.w) : b.y - (a.y + a.h);
      if (g < -0.5) continue; // this PAIR overlaps; skip it, not the run
      gaps.push({ g, a, b });
    }
    if (gaps.length < 2) return [];
    const out = [];
    for (let i = 0; i < gaps.length - 1; i++) {
      if (Math.abs(gaps[i].g - gaps[i + 1].g) <= tolPx) out.push(gaps[i], gaps[i + 1]);
    }
    return [...new Set(out)];
  }

  window.SnapEngine = { buildIndex, snapBox, snapPoint, equalGaps, CELL };
})();
