// @vitest-environment jsdom
/**
 * The paint cache is keyed by the scale it was rendered at.
 *
 * The bug: the bitmap was rendered at one pixel per document unit and blitted
 * at whatever the view transform was, and the key held no scale term. A
 * bitmap built while zoomed out stayed "valid" zoomed in and was magnified.
 * Measured on the page, a mesh gradient's edge went from a 1 device-pixel
 * transition at 100% to 11 at 1200%.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { loadEditor } from "./helpers/load-editor.js";

let editor;

/** A layer carrying a material, which is what makes it worth caching. */
const meshy = (over = {}) => ({
  type: "rect",
  name: "L",
  x: 100,
  y: 100,
  w: 70,
  h: 260,
  fill: { kind: "solid", color: "#8b5cf6" },
  fx: [{ id: "m1", type: "mesh", added: true, on: true, params: { on: true } }],
  effects: { mesh: { on: true } },
  ...over,
});

function withLayer(over = {}) {
  editor.doc = {
    frame: { name: "F", w: 900, h: 600, bg: "#ffffff", children: [meshy(over)] },
  };
  return editor.doc.frame.children[0];
}

beforeAll(() => {
  ({ editor } = loadEditor());
});

describe("the scale step", () => {
  it("rounds UP to a power of two, so a bitmap is never undersampled", () => {
    expect(editor.paintScaleStep(1)).toBe(1);
    expect(editor.paintScaleStep(1.1)).toBe(2);
    expect(editor.paintScaleStep(2)).toBe(2);
    expect(editor.paintScaleStep(2.5)).toBe(4);
    expect(editor.paintScaleStep(4)).toBe(4);
    expect(editor.paintScaleStep(5)).toBe(8);
  });

  it("holds one step across a range, so a continuous zoom does not rebuild per frame", () => {
    const steps = [2.1, 2.5, 3, 3.9, 4].map(editor.paintScaleStep);
    expect(new Set(steps).size).toBe(1);
    expect(steps[0]).toBe(4);
  });

  it("never goes below one, whatever it is handed", () => {
    expect(editor.paintScaleStep(0.25)).toBe(1);
    expect(editor.paintScaleStep(0)).toBe(1);
    expect(editor.paintScaleStep(-3)).toBe(1);
    expect(editor.paintScaleStep(NaN)).toBe(1);
    expect(editor.paintScaleStep(undefined)).toBe(1);
  });

  it("stops at a ceiling rather than growing without bound", () => {
    expect(editor.paintScaleStep(1000)).toBe(8);
  });

  it("falls back to one for a scale that is not a finite number", () => {
    // safer than the ceiling: a broken transform must not allocate the
    // largest bitmap the cache allows
    expect(editor.paintScaleStep(Infinity)).toBe(1);
  });
});

describe("the signature still tracks what it always did", () => {
  it("changes when the geometry changes", () => {
    const o = withLayer();
    const a = editor.paintSig(o);
    o.w = 120;
    expect(editor.paintSig(o)).not.toBe(a);
  });

  it("changes when an effect parameter changes", () => {
    const o = withLayer();
    const a = editor.paintSig(o);
    o.fx[0].params.on = true;
    o.fx[0].params.cols = 6;
    expect(editor.paintSig(o)).not.toBe(a);
  });

  it("is stable when nothing changed", () => {
    const o = withLayer();
    expect(editor.paintSig(o)).toBe(editor.paintSig(o));
  });

  it("carries no scale of its own — the scale is appended by the draw", () => {
    // the key the draw builds is paintSig(obj) + the quantized scale, so the
    // signature itself must stay scale-free or the two would disagree
    const o = withLayer();
    expect(editor.paintSig(o)).not.toMatch(/@\d/);
  });
});

describe("what may be cached at all", () => {
  it("a layer with a material is worth caching", () => {
    expect(editor.paintCacheable(withLayer())).toBe(true);
  });

  it("a layer that makes copies is never cached, whatever the scale", () => {
    const o = withLayer({ symmetry: { mode: "radial", count: 6, radius: 80 } });
    expect(editor.paintCacheable(o)).toBe(false);
  });

  it("a plain layer is not worth caching", () => {
    const o = withLayer();
    o.fx = [];
    expect(editor.paintCacheable(o)).toBe(false);
  });
});

describe("what the cache renders is the object at that scale", () => {
  /* The bug this guards, found by looking at drop shadow: the cache CONTEXT
   * was scaled by k. A canvas shadow's offset and blur are in device pixels
   * and ignore the transformation matrix, so the geometry grew and every
   * shadow stayed at 1x. A shadow 40px below a card landed 20px below it at
   * k=2 and disappeared under the card's own edge — it read as "drop shadow
   * does nothing", at every zoom where k>1, which on a 2x display is most of
   * them. The fix scales the OBJECT instead, through the same function the
   * exporter uses. */
  const shadowed = () => ({
    type: "rect",
    name: "Card",
    x: 300,
    y: 200,
    w: 300,
    h: 200,
    fill: { kind: "solid", color: "#ffffff" },
    fx: [
      {
        id: "s1",
        type: "shadow",
        added: true,
        on: true,
        params: {
          on: true,
          type: "drop",
          x: 40,
          y: 40,
          blur: 0,
          spread: 0,
          alpha: 1,
          color: "#000000",
          blend: "normal",
        },
      },
    ],
    effects: {
      shadow: {
        on: true,
        type: "drop",
        x: 40,
        y: 40,
        blur: 0,
        spread: 0,
        alpha: 1,
        color: "#000000",
        blend: "normal",
      },
    },
  });

  it("scaling an object scales its shadow offset with its geometry", () => {
    const o = shadowed();
    const s = editor.scaleObjectForRender(o, 2);
    expect(s.x).toBe(600);
    expect(s.w).toBe(600);
    const sd = s.fx.find((e) => e.type === "shadow").params;
    expect(sd.x).toBe(80);
    expect(sd.y).toBe(80);
  });

  it("blur and spread scale too, or the softness would change with the zoom", () => {
    const o = shadowed();
    o.fx[0].params.blur = 18;
    o.fx[0].params.spread = 10;
    const sd = editor.scaleObjectForRender(o, 4).fx.find((e) => e.type === "shadow").params;
    expect(sd.blur).toBe(72);
    expect(sd.spread).toBe(40);
  });

  it("scaling leaves the document object untouched", () => {
    const o = shadowed();
    editor.scaleObjectForRender(o, 8);
    expect(o.x).toBe(300);
    expect(o.fx[0].params.x).toBe(40);
  });

  it("a shadow big enough to leave the box is inside the cache's padding", () => {
    editor.doc = {
      frame: { name: "F", w: 900, h: 600, bg: "#ffffff", children: [shadowed()] },
    };
    const o = editor.doc.frame.children[0];
    // the bitmap covers the object plus the spill; the shadow lands at +40,+40
    const pad = editor.spillPad(o);
    expect(pad).toBeGreaterThanOrEqual(80);
  });
});
