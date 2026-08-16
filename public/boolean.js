/* Boolean path operations (§3.3–3.6) and compound-path support (§3.7).
 *
 * §0 of the spec names Clipper2 (Boost Software License 1.0) as the approved
 * implementation, and it is what this uses — vendored as clipper2.mjs and
 * loaded as a module, so there is still no build step. Clipper2 is Vatti-based
 * and handles the degenerate cases a naive Greiner-Hormann does not: shapes
 * that share an edge, collinear overlapping segments, a vertex lying exactly
 * on another shape's edge. Those are ordinary user actions in an editor, not
 * exotic inputs, which is why the robust implementation is worth its weight.
 *
 * Clipper works on integer coordinates, so page units are scaled by SCALE
 * before clipping and divided back after; at 1000 that is sub-thousandth-pixel
 * precision, far finer than anything the canvas can show.
 *
 * Curves are FLATTENED to polylines before clipping and the result comes back
 * as corner anchors. That is a real, visible limitation — a boolean of two
 * circles yields a many-sided polygon, not arcs — so the flattening tolerance
 * is tied to the curve's own size to keep the error under a fraction of a
 * pixel. Refitting the result to béziers is a separate problem and is not
 * attempted here.
 */
(function () {
  "use strict";

  const SCALE = 1000;
  let C2 = null; // filled in when the module finishes loading
  const waiting = [];

  /** Called by the module shim in index.html once clipper2.mjs has loaded. */
  function provide(mod) {
    C2 = mod;
    waiting.splice(0).forEach((fn) => {
      try {
        fn();
      } catch (e) {
        console.warn(e);
      }
    });
  }
  function ready(fn) {
    C2 ? fn() : waiting.push(fn);
  }
  function available() {
    return !!C2;
  }

  /* ---- flattening ---------------------------------------------------- */
  /** Adaptive-ish cubic flattening: step count from the control polygon's
   *  length, so small curves get few segments and large ones get many. */
  function flattenCubic(out, x0, y0, x1, y1, x2, y2, x3, y3, tol) {
    const d =
      Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2);
    const n = Math.max(2, Math.min(160, Math.ceil(d / Math.max(tol, 0.4))));
    for (let i = 1; i <= n; i++) {
      const t = i / n,
        u = 1 - t;
      out.push([
        u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
        u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
      ]);
    }
  }
  /** One subpath's anchors -> a closed polyline in page units. */
  function flattenSubpath(sp, tol) {
    const P = sp.points;
    if (!P || P.length < 2) return null;
    const out = [[P[0].x, P[0].y]];
    const n = P.length;
    const last = sp.closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const a = P[i],
        b = P[(i + 1) % n];
      if (!a.ox && !a.oy && !b.ix && !b.iy)
        out.push([b.x, b.y]); // straight segment
      else
        flattenCubic(out, a.x, a.y, a.x + a.ox, a.y + a.oy, b.x + b.ix, b.y + b.iy, b.x, b.y, tol);
    }
    return out;
  }

  /* ---- shape -> polygons --------------------------------------------- */
  /** Every object type reduced to closed polygons in page space, with its
   *  own rotation/mirror baked in so booleans respect what is on screen. */
  function objectPolys(o, helpers) {
    const { boxOf, addPathTo } = helpers;
    const polys = [];
    const b = boxOf(o);
    const tol = Math.max(0.25, Math.min(b.w, b.h) / 400);
    if (o.type === "path") {
      (o.subpaths || []).forEach((sp) => {
        if (!sp.closed) return; // open paths have no area to clip
        const f = flattenSubpath(sp, tol);
        if (f && f.length > 2) polys.push(f);
      });
    } else {
      // rect / ellipse / polygon: sample the canvas path we already build
      const pts = addPathTo(o, tol);
      if (pts && pts.length > 2) polys.push(pts);
    }
    if (!polys.length) return polys;
    // bake rotation / mirroring about the object's centre
    if (o.rot || o.mirrorX || o.mirrorY) {
      const cx = b.x + b.w / 2,
        cy = b.y + b.h / 2;
      const r = ((o.rot || 0) * Math.PI) / 180,
        cs = Math.cos(r),
        sn = Math.sin(r);
      const mx = o.mirrorX ? -1 : 1,
        my = o.mirrorY ? -1 : 1;
      return polys.map((poly) =>
        poly.map(([x, y]) => {
          let dx = (x - cx) * mx,
            dy = (y - cy) * my;
          return [cx + dx * cs - dy * sn, cy + dx * sn + dy * cs];
        }),
      );
    }
    return polys;
  }

  /* ---- the operation -------------------------------------------------- */
  const OPS = { union: "Union", subtract: "Difference", intersect: "Intersection", exclude: "Xor" };

  /** Run `op` over a list of objects. The FIRST object is the subject; every
   *  other is a clip, which is what makes subtract read as "first minus rest".
   *  Returns subpaths ready to drop into a path object, or null. */
  function compute(op, objs, helpers, fillRule) {
    if (!C2 || objs.length < 2) return null;
    const { Clipper64, Paths64, Path64, Point64, ClipType, FillRule, PathType } = C2;
    const toP64 = (poly) => {
      const p = new Path64();
      let px = null,
        py = null;
      poly.forEach(([x, y]) => {
        const ix = Math.round(x * SCALE),
          iy = Math.round(y * SCALE);
        if (ix !== px || iy !== py) {
          p.push(new Point64(ix, iy));
          px = ix;
          py = iy;
        }
      });
      return p;
    };
    const subj = new Paths64(),
      clip = new Paths64();
    objs.forEach((o, i) => {
      objectPolys(o, helpers).forEach((poly) => {
        const p = toP64(poly);
        if (p.length > 2) (i === 0 ? subj : clip).push(p);
      });
    });
    if (!subj.length) return null;
    const c = new Clipper64();
    c.addPaths(subj, PathType.Subject);
    if (clip.length) c.addPaths(clip, PathType.Clip);
    const sol = new Paths64(),
      open = new Paths64();
    const rule = fillRule === "evenodd" ? FillRule.EvenOdd : FillRule.NonZero;
    try {
      c.execute(ClipType[OPS[op] || "Union"], rule, sol, open);
    } catch (e) {
      console.warn("boolean failed:", e && e.message);
      return null;
    }
    const subpaths = [];
    sol.forEach((p) => {
      const pts = [];
      let px = null,
        py = null;
      p.forEach((pt) => {
        const x = Number(pt.x) / SCALE,
          y = Number(pt.y) / SCALE;
        // Clipper emits repeated vertices at touch points; they add nothing
        if (px !== null && Math.abs(x - px) < 1e-6 && Math.abs(y - py) < 1e-6) return;
        pts.push({ x, y, ox: 0, oy: 0, ix: 0, iy: 0, m: "corner" });
        px = x;
        py = y;
      });
      if (pts.length > 2) subpaths.push({ points: pts, closed: true });
    });
    return subpaths.length ? subpaths : null;
  }

  window.BooleanEngine = { provide, ready, available, compute, OPS: Object.keys(OPS), SCALE };
  // the module shim may have finished before this script ran
  if (window.__clipper2) {
    provide(window.__clipper2);
    delete window.__clipper2;
  }
})();
