// @vitest-environment jsdom
/**
 * Symmetry — the second structure engine (mirror and radial repeat).
 * The acceptance test the feature was built against: see
 * docs/research/symmetry.md for the mechanism these assertions encode.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { loadEditor } from "./helpers/load-editor.js";

let editor;

/** @returns {any} a plain layer literal for test documents */
const layerOf = (over = {}) => ({
  type: "rect",
  name: "L",
  x: 100,
  y: 100,
  w: 60,
  h: 40,
  fill: { kind: "solid", color: "#ff0000" },
  ...over,
});

/** Load a doc holding one layer; return the normalized layer. */
function withLayer(over = {}, symmetry = null) {
  const child = layerOf(over);
  if (symmetry) child.symmetry = symmetry;
  editor.doc = {
    frame: { name: "F", w: 900, h: 600, bg: "#ffffff", children: [child] },
  };
  return editor.doc.frame.children[0];
}
const inst = (o) => editor.symmetryInstances(o);
const centre = (o) => ({ x: o.x + o.w / 2, y: o.y + o.h / 2 });

beforeAll(() => {
  ({ editor } = loadEditor());
});

describe("off is an absent field", () => {
  it("a layer with no symmetry emits nothing", () => {
    expect(inst(withLayer())).toEqual([]);
  });

  it("normalize drops a non-object and keeps the field absent", () => {
    const o = withLayer({}, /** @type {any} */ (null));
    expect(o.symmetry).toBeUndefined();
    expect(editor.normalizeSymmetry(null)).toBeNull();
  });

  it("an empty object becomes a complete, clamped default", () => {
    const s = editor.normalizeSymmetry({});
    expect(s.mode).toBe("mirror");
    expect(s.axis).toBe("vertical");
    expect(s.count).toBe(6);
  });

  it("out-of-range values clamp rather than throw", () => {
    const s = editor.normalizeSymmetry({
      mode: "nonsense",
      axis: "sideways",
      count: 999,
      angle: 400,
      radius: "x",
    });
    expect(s.mode).toBe("mirror");
    expect(s.axis).toBe("vertical");
    expect(s.count).toBe(editor.limits.MAX_SYMMETRY_COUNT);
    expect(s.angle).toBe(180);
    expect(s.radius).toBe(0);
  });
});

describe("mirror — a reflection set clear of the layer's own bounds", () => {
  it("a vertical axis makes one copy, flipped in x", () => {
    const o = withLayer({}, { mode: "mirror", axis: "vertical", gap: 0 });
    const out = inst(o);
    expect(out.length).toBe(1);
    expect(out[0].mirrorX).toBe(true);
    expect(out[0].mirrorY).toBe(false);
  });

  it("gap is the exact clear space between the two bounds", () => {
    const o = withLayer({}, { mode: "mirror", axis: "vertical", gap: 20 });
    const copy = inst(o)[0];
    // the layer's right edge to the copy's left edge
    expect(copy.x - (o.x + o.w)).toBe(20);
  });

  it("gap 0 puts the reflection edge to edge", () => {
    const o = withLayer({}, { mode: "mirror", axis: "vertical", gap: 0 });
    expect(inst(o)[0].x).toBe(o.x + o.w);
  });

  it("a horizontal axis reflects downward, flipped in y", () => {
    const o = withLayer({}, { mode: "mirror", axis: "horizontal", gap: 10 });
    const out = inst(o);
    expect(out.length).toBe(1);
    expect(out[0].mirrorY).toBe(true);
    expect(out[0].mirrorX).toBe(false);
    expect(out[0].y - (o.y + o.h)).toBe(10);
  });

  it("both axes make the quad — three copies, one of them diagonal", () => {
    const o = withLayer({}, { mode: "mirror", axis: "both", gap: 0 });
    const out = inst(o);
    expect(out.length).toBe(3);
    const diag = out.find((i) => i.mirrorX && i.mirrorY);
    expect(diag).toBeTruthy();
    expect(diag.x).toBe(o.x + o.w);
    expect(diag.y).toBe(o.y + o.h);
  });

  it("spacing reads the TURNED bounds, so a rotated layer is not padded", () => {
    const o = withLayer({ rot: 90 }, { mode: "mirror", axis: "vertical", gap: 0 });
    const copy = inst(o)[0];
    // a 60x40 box turned 90° is 40 wide; the copy advances by that, not by 60
    expect(Math.round(copy.x - o.x)).toBe(40);
  });

  it("a single-axis copy carries the opposite turn, the diagonal the same", () => {
    const o = withLayer({ rot: 30 }, { mode: "mirror", axis: "both", gap: 0 });
    const out = inst(o);
    expect(out.find((i) => i.mirrorX && !i.mirrorY).rot).toBe(-30);
    expect(out.find((i) => !i.mirrorX && i.mirrorY).rot).toBe(-30);
    expect(out.find((i) => i.mirrorX && i.mirrorY).rot).toBe(30);
  });

  it("reflecting an already-mirrored layer flips it back", () => {
    const o = withLayer({ mirrorX: true }, { mode: "mirror", axis: "vertical" });
    expect(inst(o)[0].mirrorX).toBe(false);
  });
});

describe("radial — copies turned about a pivot", () => {
  it("count is the total, so it emits count-1 copies", () => {
    const o = withLayer({}, { mode: "radial", count: 6, radius: 100 });
    expect(inst(o).length).toBe(5);
  });

  it("radius 0 turns the copies about the layer's own centre", () => {
    const o = withLayer({}, { mode: "radial", count: 4, radius: 0 });
    const c0 = centre(o);
    for (const i of inst(o)) {
      expect(Math.round(centre(i).x)).toBe(Math.round(c0.x));
      expect(Math.round(centre(i).y)).toBe(Math.round(c0.y));
    }
  });

  it("every copy sits the same distance from the pivot", () => {
    const R = 120;
    const o = withLayer({}, { mode: "radial", count: 5, radius: R });
    const c0 = centre(o);
    const pivot = { x: c0.x, y: c0.y + R };
    for (const i of inst(o)) {
      const c = centre(i);
      const d = Math.hypot(c.x - pivot.x, c.y - pivot.y);
      expect(Math.round(d)).toBe(R);
    }
  });

  it("a half turn at count 2 puts the copy opposite the original", () => {
    const R = 100;
    const o = withLayer({}, { mode: "radial", count: 2, radius: R, angle: 0 });
    const out = inst(o);
    expect(out.length).toBe(1);
    const c0 = centre(o);
    expect(Math.round(centre(out[0]).x)).toBe(Math.round(c0.x));
    expect(Math.round(centre(out[0]).y)).toBe(Math.round(c0.y + 2 * R));
  });

  it("turn copies adds each copy's own angle to its rotation", () => {
    const o = withLayer({}, { mode: "radial", count: 4, radius: 50, faceOut: true });
    expect(inst(o).map((i) => Math.round(i.rot))).toEqual([90, 180, 270]);
  });

  it("with turn copies off, every copy keeps the layer's rotation", () => {
    const o = withLayer({ rot: 15 }, { mode: "radial", count: 4, radius: 50, faceOut: false });
    expect(inst(o).map((i) => i.rot)).toEqual([15, 15, 15]);
  });

  it("start angle turns the whole figure", () => {
    const R = 100;
    const o = withLayer({}, { mode: "radial", count: 2, radius: R, angle: 90 });
    const c0 = centre(o);
    const c = centre(inst(o)[0]);
    // a quarter turn about a pivot directly below moves the copy sideways
    expect(Math.round(c.x)).toBe(Math.round(c0.x - R));
    expect(Math.round(c.y)).toBe(Math.round(c0.y + R));
  });
});

describe("instances are live views, never copied state", () => {
  it("a copy inherits the layer's appearance rather than a snapshot", () => {
    const o = withLayer({}, { mode: "mirror", axis: "vertical" });
    o.fill.color = "#00ff00";
    expect(inst(o)[0].fill.color).toBe("#00ff00");
  });

  it("a copy carries no structure of its own, so nothing recurses", () => {
    const o = withLayer({}, { mode: "mirror", axis: "both" });
    for (const i of inst(o)) {
      expect(i.symmetry).toBeUndefined();
      expect(i.pattern).toBeUndefined();
      expect(editor.symmetryInstances(i)).toEqual([]);
    }
  });

  it("copies have distinct ids that name their parent", () => {
    const o = withLayer({}, { mode: "mirror", axis: "both" });
    const ids = inst(o).map((i) => i.id);
    expect(new Set(ids).size).toBe(3);
    for (const i of inst(o)) expect(i.parentId).toBe(o.id);
  });

  it("a text layer is not a symmetry parent", () => {
    const o = withLayer({ type: "text", text: "hi" }, { mode: "mirror", axis: "both" });
    expect(inst(o)).toEqual([]);
  });

  it("a degenerate box emits nothing rather than NaN geometry", () => {
    // normalizeDoc floors a layer's size, so this is asserted on a raw
    // literal: the guard exists for documents built by hand or by the bridge.
    const raw = {
      type: "rect",
      x: 100,
      y: 100,
      w: 0,
      h: 40,
      symmetry: editor.normalizeSymmetry({ mode: "radial", count: 4, radius: 50 }),
    };
    expect(editor.symmetryInstances(raw)).toEqual([]);
    expect(editor.symmetryInstances({ ...raw, w: 60, x: NaN })).toEqual([]);
  });
});

describe("one structure per layer, through one seam", () => {
  it("derivedInstances returns the symmetry copies when only symmetry is set", () => {
    const o = withLayer({}, { mode: "mirror", axis: "both" });
    expect(editor.derivedInstances(o).length).toBe(3);
  });

  it("both engines compose: symmetry reflects the whole repeated field", () => {
    const o = withLayer({}, { mode: "mirror", axis: "vertical" });
    o.pattern = editor.normalizePattern({ columns: 2, rows: 1 });
    const grid = editor.patternInstances(o); // 1 copy: the parent is cell 0
    const mine = editor.symmetryInstances(o); // 1 reflection of the parent
    // the grid, the parent's own reflection, and a reflection of each grid copy
    expect(editor.derivedInstances(o).length).toBe(grid.length + mine.length + grid.length);
  });

  it("every copy in a composed field has its own id", () => {
    const o = withLayer({}, { mode: "mirror", axis: "both" });
    o.pattern = editor.normalizePattern({ columns: 3, rows: 2 });
    const ids = editor.derivedInstances(o).map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id !== o.id)).toBe(true);
  });

  it("a composed copy still carries no structure, so nothing recurses", () => {
    const o = withLayer({}, { mode: "mirror", axis: "both" });
    o.pattern = editor.normalizePattern({ columns: 2, rows: 2 });
    for (const i of editor.derivedInstances(o)) {
      expect(i.pattern).toBeUndefined();
      expect(i.symmetry).toBeUndefined();
      expect(i.parentId).toBe(o.id);
    }
  });

  it("the composed field is capped, so a big grid cannot explode", () => {
    const o = withLayer({}, { mode: "radial", count: 24, radius: 200 });
    o.pattern = editor.normalizePattern({ columns: 20, rows: 20 });
    const n = editor.derivedInstances(o).length;
    expect(n).toBeLessThanOrEqual(editor.limits.MAX_PATTERN_INSTANCES);
    expect(n).toBeGreaterThan(0);
  });

  it("a repeater with no symmetry is untouched by the composition", () => {
    const o = withLayer();
    o.pattern = editor.normalizePattern({ columns: 3, rows: 1 });
    expect(editor.derivedInstances(o)).toEqual(editor.patternInstances(o));
  });

  it("a layer with neither yields nothing", () => {
    expect(editor.derivedInstances(withLayer())).toEqual([]);
  });

  it("symmetry copies are counted in the document's instances", () => {
    withLayer({}, { mode: "radial", count: 4, radius: 60 });
    expect(editor.allInstances().length).toBe(3);
  });
});

describe("the document round-trips", () => {
  it("a saved symmetry survives a reload with its values", () => {
    const o = withLayer({}, { mode: "radial", count: 7, radius: 80, angle: 45 });
    const json = JSON.parse(JSON.stringify(editor.doc));
    editor.doc = json;
    const back = editor.doc.frame.children[0];
    expect(back.symmetry.mode).toBe("radial");
    expect(back.symmetry.count).toBe(7);
    expect(back.symmetry.radius).toBe(80);
    expect(editor.symmetryInstances(back).length).toBe(6);
    expect(o.symmetry.angle).toBe(45);
  });

  it("a container never carries symmetry", () => {
    editor.doc = {
      frame: {
        name: "F",
        w: 900,
        h: 600,
        bg: "#ffffff",
        children: [
          { type: "group", name: "G", symmetry: { mode: "mirror" }, children: [layerOf()] },
        ],
      },
    };
    expect(editor.doc.frame.children[0].symmetry).toBeUndefined();
  });
});

describe("a structure engine is never cached into the parent's own box", () => {
  /* The bug: paintCacheable named `pattern` alone. Symmetry arrived, and a
   * mesh — a material, which is exactly what makes a layer worth caching —
   * drew one shape and no copies, because the cache bitmap is sized to
   * aabbOf(parent) and the copies land outside it. A solid or gradient fill
   * never hit it: nothing expensive is on, so the layer is not cached. */
  const meshy = () => ({
    fx: [{ id: "m1", type: "mesh", added: true, on: true, params: { on: true } }],
    effects: { mesh: { on: true } },
  });

  it("hasStructure is true for either engine and false for a plain layer", () => {
    expect(editor.hasStructure({ symmetry: { mode: "mirror" } })).toBe(true);
    expect(editor.hasStructure({ pattern: { columns: 2 } })).toBe(true);
    expect(editor.hasStructure({})).toBe(false);
    expect(editor.hasStructure(null)).toBe(false);
  });

  it("a mesh layer with symmetry is not paint-cached", () => {
    const o = withLayer(meshy(), { mode: "radial", count: 12, radius: 120 });
    expect(editor.symmetryInstances(o).length).toBe(11);
    expect(editor.paintCacheable(o)).toBe(false);
  });

  it("a mesh layer with a repeater is not paint-cached either", () => {
    const o = withLayer(meshy());
    o.pattern = editor.normalizePattern({ columns: 3, rows: 1 });
    expect(editor.paintCacheable(o)).toBe(false);
  });

  it("a mesh layer with no structure still caches, so nothing got slower", () => {
    const o = withLayer(meshy());
    expect(editor.paintCacheable(o)).toBe(true);
  });

  it("symmetry's lengths scale with the render, like the repeater's gaps", () => {
    const o = withLayer({}, { mode: "radial", count: 6, radius: 100, gap: 20 });
    const scaled = editor.scaleObjectForRender(JSON.parse(JSON.stringify(o)), 2);
    expect(scaled.symmetry.radius).toBe(200);
    expect(scaled.symmetry.gap).toBe(40);
  });
});

describe("the layer you selected paints on top of its copies", () => {
  /* Near a radial pivot the copies overlap, and with the parent painted first
   * it ended up buried under a copy of itself — the thing whose handles are on
   * screen and whose edits you are watching. */
  it("paints every copy, then the parent last", () => {
    const o = withLayer({}, { mode: "radial", count: 5, radius: 80 });
    const painted = [];
    editor.paintWithInstances(o, (x) => painted.push(x.id));
    expect(painted.length).toBe(5);
    expect(painted[painted.length - 1]).toBe(o.id);
    expect(painted.slice(0, -1).every((id) => id !== o.id)).toBe(true);
  });

  it("a layer with no structure is still painted exactly once", () => {
    const o = withLayer();
    const painted = [];
    editor.paintWithInstances(o, (x) => painted.push(x.id));
    expect(painted).toEqual([o.id]);
  });

  it("the repeater follows the same rule, so the order never differs by engine", () => {
    const o = withLayer();
    o.pattern = editor.normalizePattern({ columns: 3, rows: 1 });
    const painted = [];
    editor.paintWithInstances(o, (x) => painted.push(x.id));
    expect(painted[painted.length - 1]).toBe(o.id);
    expect(painted.length).toBe(editor.patternInstances(o).length + 1);
  });
});

describe("the whole field moves as one body", () => {
  /* The first attempt let each repeater copy compute its own pivot, so every
   * shape spun in place and the field never turned at all. The operations are
   * the parent's, and they are applied to every member. */
  const centre = (o) => ({ x: o.x + o.w / 2, y: o.y + o.h / 2 });

  it("a turned row fans out — its members keep their distances from the pivot", () => {
    const o = withLayer({ x: 400, y: 275, w: 26, h: 60 }, { mode: "radial", count: 10, radius: 0 });
    o.pattern = editor.normalizePattern({ columns: 4, rows: 1, hGap: 14, vGap: 0 });
    const pivot = centre(o);
    const dists = editor
      .derivedInstances(o)
      .map((i) => Math.round(Math.hypot(centre(i).x - pivot.x, centre(i).y - pivot.y)));
    // four members of the row, so four rings — not one distance
    expect(new Set(dists).size).toBe(4);
  });

  it("a turned row uses every angle of the turn", () => {
    const o = withLayer({}, { mode: "radial", count: 6, radius: 0, faceOut: true });
    o.pattern = editor.normalizePattern({ columns: 3, rows: 1 });
    const angles = new Set(editor.derivedInstances(o).map((i) => Math.round(i.rot)));
    // the grid copies at 0, plus the five turns
    expect(angles.size).toBe(6);
  });

  it("a mirrored row reflects as one body, so its order reverses", () => {
    const o = withLayer(
      { x: 100, y: 100, w: 60, h: 40 },
      { mode: "mirror", axis: "vertical", gap: 0 },
    );
    o.pattern = editor.normalizePattern({ columns: 3, rows: 1, hGap: 20, vGap: 0 });
    const all = editor.derivedInstances(o);
    const flipped = all.filter((i) => i.mirrorX).map((i) => Math.round(i.x));
    // the parent and its two copies sit at 100, 180, 260; the mirror line is
    // at 160, so their reflections land at 160, 80, 0 — the row, reversed
    expect(flipped.sort((a, b) => a - b)).toEqual([0, 80, 160]);
  });

  it("every member of the field is reflected, not just the parent", () => {
    const o = withLayer({}, { mode: "mirror", axis: "vertical" });
    o.pattern = editor.normalizePattern({ columns: 3, rows: 1 });
    const all = editor.derivedInstances(o);
    expect(all.filter((i) => i.mirrorX).length).toBe(editor.patternInstances(o).length + 1);
  });
});

describe("the operations themselves", () => {
  it("a radial symmetry is count-1 turns about one pivot", () => {
    const o = withLayer({}, { mode: "radial", count: 6, radius: 50 });
    const ops = editor.symmetryOps(o);
    expect(ops.length).toBe(5);
    expect(new Set(ops.map((p) => p.px + "," + p.py)).size).toBe(1);
    expect(ops.map((p) => Math.round(p.deg))).toEqual([60, 120, 180, 240, 300]);
  });

  it("a mirror on both axes is three reflections", () => {
    const ops = editor.symmetryOps(withLayer({}, { mode: "mirror", axis: "both" }));
    expect(ops.length).toBe(3);
    expect(ops.every((p) => p.kind === "flip")).toBe(true);
  });

  it("no symmetry means no operations", () => {
    expect(editor.symmetryOps(withLayer())).toEqual([]);
    expect(editor.symmetryOps(null)).toEqual([]);
  });

  it("an operation applied to a layer strips its structure", () => {
    const o = withLayer({}, { mode: "mirror", axis: "vertical" });
    o.pattern = editor.normalizePattern({ columns: 2, rows: 1 });
    const c = editor.applySymmetryOp(o, editor.symmetryOps(o)[0]);
    expect(c.pattern).toBeUndefined();
    expect(c.symmetry).toBeUndefined();
  });

  it("a degenerate member yields null rather than NaN geometry", () => {
    const o = withLayer({}, { mode: "radial", count: 4, radius: 50 });
    const op = editor.symmetryOps(o)[0];
    expect(editor.applySymmetryOp({ x: NaN, y: 0, w: 10, h: 10 }, op)).toBeNull();
  });
});
