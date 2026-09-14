// @vitest-environment jsdom
/**
 * Echo — the third structure engine.
 *
 * The repeater lays a GRID and symmetry REFLECTS. Echo makes a receding STACK:
 * each copy a step further, narrower, flatter and turned a little more. It is
 * copies of the real layer, not something a shader draws inside one tile, so
 * it works with any fill and composes with the other two.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { loadEditor } from "./helpers/load-editor.js";

let editor;

/** One layer, optionally carrying an echo; returns the normalized layer. */
function withEcho(echo, over = {}) {
  const child = /** @type {any} */ ({
    type: "ellipse",
    name: "L",
    x: 100,
    y: 100,
    w: 200,
    h: 160,
    fill: { kind: "solid", color: "#f43f5e" },
    ...over,
  });
  if (echo) child.echo = echo;
  editor.doc = {
    frame: { name: "F", w: 900, h: 900, bg: "#ffffff", children: [child] },
  };
  return editor.doc.frame.children[0];
}
const copies = (o) => editor.echoInstances(o);
const centre = (o) => ({ x: o.x + o.w / 2, y: o.y + o.h / 2 });

beforeAll(() => {
  ({ editor } = loadEditor());
});

describe("off is an absent field", () => {
  it("a layer with no echo makes no copies", () => {
    expect(copies(withEcho(null))).toEqual([]);
  });

  it("normalize rejects a non-object and keeps the field absent", () => {
    expect(editor.normalizeEcho(null)).toBeNull();
    expect(withEcho(null).echo).toBeUndefined();
  });

  it("an empty object becomes a complete, clamped default", () => {
    const e = editor.normalizeEcho({});
    expect(e.copies).toBe(4);
    expect(e.widthScale).toBeCloseTo(0.88, 5);
    expect(e.heightScale).toBeCloseTo(0.62, 5);
  });

  it("clamps every value to the range its row offers", () => {
    const e = editor.normalizeEcho({
      copies: 99,
      widthScale: 9,
      heightScale: -1,
      rotation: 900,
      randomness: 7,
      seed: 0,
      stepY: 9999,
    });
    expect(e.copies).toBe(10);
    expect(e.widthScale).toBe(1.5);
    expect(e.heightScale).toBe(0.2);
    expect(e.rotation).toBe(180);
    expect(e.randomness).toBe(1);
    expect(e.seed).toBe(1);
    expect(e.stepY).toBe(200);
  });
});

describe("width and height deform separately", () => {
  /* This is the point of the effect. Keeping the width and losing the height
   * is what reads as a disc turning away; shrinking both is just smaller. */
  it("width alone narrows the copies and leaves their height", () => {
    const o = withEcho({ copies: 2, widthScale: 0.5, heightScale: 1, stepY: 0, stepX: 120 });
    const c = copies(o);
    expect(c[0].w).toBeCloseTo(o.w * 0.5, 5);
    expect(c[0].h).toBeCloseTo(o.h, 5);
    expect(c[1].w).toBeCloseTo(o.w * 0.25, 5);
  });

  it("height alone flattens them and leaves their width", () => {
    const o = withEcho({ copies: 2, widthScale: 1, heightScale: 0.5 });
    const c = copies(o);
    expect(c[0].h).toBeCloseTo(o.h * 0.5, 5);
    expect(c[0].w).toBeCloseTo(o.w, 5);
  });

  it("the sizes COMPOUND, so the stack reads as distance not as a list", () => {
    const o = withEcho({ copies: 3, widthScale: 0.8, heightScale: 0.8 });
    const c = copies(o);
    expect(c[2].w).toBeCloseTo(o.w * 0.8 * 0.8 * 0.8, 4);
  });

  it("a copy that has shrunk away is not emitted as a speck", () => {
    const o = withEcho({ copies: 10, widthScale: 0.2, heightScale: 0.2 });
    expect(copies(o).length).toBeLessThan(10);
    for (const c of copies(o)) expect(c.w).toBeGreaterThan(0.5);
  });
});

describe("the step is a share of the copy, not of the page", () => {
  it("a shrinking stack closes up as it goes", () => {
    /* A fixed step in page units pulls the small copies far apart and the
     * perspective falls over. */
    const o = withEcho({ copies: 3, stepY: 80, heightScale: 0.5, widthScale: 1 });
    const c = copies(o);
    const gap1 = centre(c[0]).y - centre(o).y;
    const gap2 = centre(c[1]).y - centre(c[0]).y;
    expect(gap2).toBeLessThan(gap1);
  });

  it("across and down are independent", () => {
    const o = withEcho({ copies: 1, stepX: 50, stepY: 0, widthScale: 1, heightScale: 1 });
    const c = copies(o)[0];
    expect(centre(c).x).toBeCloseTo(centre(o).x + o.w * 0.5, 4);
    expect(centre(c).y).toBeCloseTo(centre(o).y, 5);
  });

  it("rotation accumulates, so each copy turns further than the last", () => {
    const o = withEcho({ copies: 3, rotation: 15 });
    expect(copies(o).map((c) => Math.round(c.rot))).toEqual([15, 30, 45]);
  });

  it("fade thins the copies toward the back and leaves the original alone", () => {
    const o = withEcho({ copies: 4, fade: 1 });
    const c = copies(o);
    expect(o.opacity).toBe(1);
    expect(c[0].opacity).toBeGreaterThan(c[3].opacity);
    expect(c[3].opacity).toBeCloseTo(0, 5);
  });
});

describe("randomness is seeded, so a document always draws the same stack", () => {
  it("the same seed gives the same copies", () => {
    const a = copies(withEcho({ copies: 5, randomness: 0.6, seed: 7 })).map((c) => Math.round(c.x));
    const b = copies(withEcho({ copies: 5, randomness: 0.6, seed: 7 })).map((c) => Math.round(c.x));
    expect(a).toEqual(b);
  });

  it("a different seed gives a different stack", () => {
    const a = copies(withEcho({ copies: 5, randomness: 0.6, seed: 7 })).map((c) => Math.round(c.x));
    const b = copies(withEcho({ copies: 5, randomness: 0.6, seed: 8 })).map((c) => Math.round(c.x));
    expect(a).not.toEqual(b);
  });

  it("randomness 0 is exactly regular", () => {
    const o = withEcho({ copies: 3, randomness: 0, stepX: 0, widthScale: 0.5, heightScale: 0.5 });
    const c = copies(o);
    for (const k of c) expect(centre(k).x).toBeCloseTo(centre(o).x, 5);
  });
});

describe("it is a structure engine like the other two", () => {
  it("a copy carries no structure of its own, so nothing recurses", () => {
    const o = withEcho({ copies: 3 });
    for (const c of copies(o)) {
      expect(c.echo).toBeUndefined();
      expect(c.pattern).toBeUndefined();
      expect(c.symmetry).toBeUndefined();
      expect(editor.echoInstances(c)).toEqual([]);
    }
  });

  it("copies have unique ids that name their parent", () => {
    const o = withEcho({ copies: 4 });
    const ids = copies(o).map((c) => c.id);
    expect(new Set(ids).size).toBe(4);
    for (const c of copies(o)) expect(c.parentId).toBe(o.id);
  });

  it("hasStructure knows about it, so the paint cache leaves it alone", () => {
    expect(editor.hasStructure({ echo: { copies: 2 } })).toBe(true);
  });

  it("the seam returns the stack", () => {
    const o = withEcho({ copies: 3 });
    expect(editor.derivedInstances(o).length).toBe(3);
  });

  it("with a repeater as well, every grid copy gets its own stack", () => {
    const o = withEcho({ copies: 2 });
    o.pattern = editor.normalizePattern({ columns: 3, rows: 1 });
    const grid = editor.patternInstances(o).length; // 2 copies; cell 0 is the parent
    // the grid, plus a stack for the parent and for each grid copy
    expect(editor.derivedInstances(o).length).toBe(grid + 2 * (grid + 1));
  });

  it("the whole field is capped, so a big grid cannot explode", () => {
    const o = withEcho({ copies: 10 });
    o.pattern = editor.normalizePattern({ columns: 20, rows: 20 });
    expect(editor.derivedInstances(o).length).toBeLessThanOrEqual(
      editor.limits.MAX_PATTERN_INSTANCES,
    );
  });

  it("a text layer is not an echo parent", () => {
    expect(copies(withEcho({ copies: 3 }, { type: "text", text: "hi" }))).toEqual([]);
  });

  it("a container never carries one", () => {
    editor.doc = {
      frame: {
        name: "F",
        w: 900,
        h: 900,
        bg: "#ffffff",
        children: [{ type: "group", name: "G", echo: { copies: 3 }, children: [] }],
      },
    };
    expect(editor.doc.frame.children[0].echo).toBeUndefined();
  });

  it("survives a round trip through JSON", () => {
    withEcho({ copies: 5, rotation: 12, seed: 42 });
    editor.doc = JSON.parse(JSON.stringify(editor.doc));
    const e = editor.doc.frame.children[0].echo;
    expect(e.copies).toBe(5);
    expect(e.rotation).toBe(12);
    expect(e.seed).toBe(42);
  });
});
