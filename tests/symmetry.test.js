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

  it("the repeater wins when a layer carries both", () => {
    const o = withLayer({}, { mode: "mirror", axis: "both" });
    o.pattern = editor.normalizePattern({ columns: 2, rows: 1 });
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
