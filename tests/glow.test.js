// @vitest-environment jsdom
/**
 * QA for the `glow` effect (§4.11), second through the FxStack.READY gate.
 *
 * Glow has two distinct renderings behind one parameter set: OUTER lays a
 * zero-offset shadow under the object, INNER clips to the shape and shadows
 * the inverse region so the light falls inward. Both are repeated `falloff*2`
 * times, each pass concentrating the core — so falloff is a real draw-time
 * quantity, not a cosmetic label, and the tests check it as one.
 *
 * As with shadow, jsdom cannot assert pixels; what it can assert is that the
 * effect reaches the canvas and carries its parameters there. The paint cache
 * is off for the same reason it is off in tests/shadow.test.js.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { loadEditor } from "./helpers/load-editor.js";

let editor, ctx;

/** Records the shadow state in force at every paint. */
function recordShadowAtPaint(c) {
  const seen = [];
  for (const op of ["fill", "stroke", "fillRect"]) {
    const orig = c[op];
    c[op] = (...args) => {
      seen.push({
        op,
        args,
        color: c.shadowColor,
        blur: c.shadowBlur,
        dx: c.shadowOffsetX,
        dy: c.shadowOffsetY,
        composite: c.globalCompositeOperation,
      });
      return orig.apply(c, args);
    };
  }
  return seen;
}

const lit = (seen) =>
  seen.filter((s) => s.color && s.color !== "" && s.color !== "transparent" && s.blur > 0);

function boxWithGlow(over) {
  editor.doc = {
    frame: {
      name: "F",
      w: 900,
      h: 600,
      bg: "#ffffff",
      // no artboards: their slab paints its own drop shadow, which this probe
      // cannot tell from the object's own glow
      artboards: [],
      children: [
        {
          type: "rect",
          name: "Box",
          x: 350,
          y: 220,
          w: 200,
          h: 160,
          fill: { kind: "solid", color: "#3b6df0" },
          effects: { glow: { on: true, ...over } },
        },
      ],
    },
  };
  return editor.doc.frame.children[0];
}

beforeAll(() => {
  ({ editor, ctx } = loadEditor());
  editor.paintCacheOff = true;
});

describe("glow — reaches the canvas", () => {
  it("stays off the canvas while it is off", () => {
    boxWithGlow({ on: false, radius: 30 });
    const seen = recordShadowAtPaint(ctx);
    editor.render();
    expect(lit(seen)).toHaveLength(0);
  });

  it("draws nothing at radius zero, which is what off means for a glow", () => {
    // both draw paths guard on radius > 0; an enabled glow with no radius has
    // nothing to paint and must not cost a pass
    boxWithGlow({ radius: 0 });
    const seen = recordShadowAtPaint(ctx);
    editor.render();
    expect(lit(seen)).toHaveLength(0);
  });

  it("paints an outer glow with no offset", () => {
    // outer glow IS a zero-offset shadow laid under the object
    boxWithGlow({ type: "outer", radius: 24 });
    const seen = recordShadowAtPaint(ctx);
    editor.render();
    const g = lit(seen);
    expect(g.length, "the outer glow never reached the canvas").toBeGreaterThan(0);
    expect(g[0].dx).toBe(0);
    expect(g[0].dy).toBe(0);
  });

  it("carries the radius as the blur", () => {
    boxWithGlow({ type: "outer", radius: 77 });
    const seen = recordShadowAtPaint(ctx);
    editor.render();
    expect(lit(seen)[0].blur).toBe(77);
  });

  it("paints an inner glow through a clip instead", () => {
    // inner glow clips to the shape and shadows the inverse region, so its
    // pass is preceded by a clip that the outer path never makes
    boxWithGlow({ type: "inner", radius: 24 });
    ctx.calls.length = 0;
    const seen = recordShadowAtPaint(ctx);
    editor.render();
    expect(lit(seen).length, "the inner glow never reached the canvas").toBeGreaterThan(0);
    expect(
      ctx.calls.some((c) => c.name === "clip"),
      "inner glow must clip to the shape",
    ).toBe(true);
  });

  it("fills the inverse region even-odd, so the light falls inward", () => {
    boxWithGlow({ type: "inner", radius: 24 });
    const seen = recordShadowAtPaint(ctx);
    editor.render();
    expect(
      lit(seen).some((s) => s.op === "fill" && s.args[0] === "evenodd"),
      "the inner pass must fill even-odd",
    ).toBe(true);
  });

  it("repeats the pass with falloff, which is what concentrates the core", () => {
    const passes = (falloff) => {
      boxWithGlow({ type: "outer", radius: 20, falloff });
      const seen = recordShadowAtPaint(ctx);
      editor.render();
      return lit(seen).length;
    };
    expect(passes(2), "a higher falloff must cost more passes").toBeGreaterThan(passes(0.5));
  });

  it("honours its blend mode", () => {
    boxWithGlow({ type: "outer", radius: 20, blend: "screen" });
    const seen = recordShadowAtPaint(ctx);
    editor.render();
    expect(lit(seen)[0].composite).toBe("screen");
  });
});

describe("glow — the document model", () => {
  it("clamps every parameter into its documented range", () => {
    const g = boxWithGlow({ radius: 9999, spread: 9999, alpha: 9, falloff: 99 }).effects.glow;
    expect(g.radius).toBe(200);
    expect(g.spread).toBe(100);
    expect(g.alpha).toBe(1);
    expect(g.falloff).toBe(4);
  });

  it("accepts only outer or inner as a type", () => {
    expect(boxWithGlow({ type: "sideways" }).effects.glow.type).toBe("outer");
    expect(boxWithGlow({ type: "inner" }).effects.glow.type).toBe("inner");
  });

  it("rejects a colour that is not a hex triplet, defaulting to white", () => {
    expect(boxWithGlow({ color: "gold" }).effects.glow.color).toBe("#ffffff");
  });

  it("keeps effects.glow a live alias of its fx-stack entry", () => {
    const o = boxWithGlow({ radius: 12 });
    const entry = (o.fx || []).find((e) => e.type === "glow");
    expect(entry.params).toBe(o.effects.glow);
  });
});

describe("glow — on the object types that offer it", () => {
  function shapeWithGlow(shape) {
    editor.doc = {
      frame: {
        name: "F",
        w: 900,
        h: 600,
        bg: "#ffffff",
        artboards: [],
        children: [{ effects: { glow: { on: true, type: "outer", radius: 24 } }, ...shape }],
      },
    };
    return editor.doc.frame.children[0];
  }

  const painted = () => {
    const seen = recordShadowAtPaint(ctx);
    editor.render();
    return lit(seen).length;
  };

  it("offers Glow only to types that can carry it", () => {
    // text force-disables glow in normalizeDoc, so it must not be offered one
    const pages = (t) => editor.FX_PAGES({ type: t, name: "x", x: 0, y: 0, w: 10, h: 10 });
    expect(pages("text")).not.toContain("Glow");
    expect(pages("rect")).toContain("Glow");
  });

  it("force-disables glow on text, which cannot render one", () => {
    const o = shapeWithGlow({ type: "text", name: "T", x: 10, y: 10, text: "hi" });
    expect(o.effects.glow.on).toBe(false);
  });

  it("paints a glow on a line, which has no fillable interior", () => {
    // a line is stroke-defined: if the glow pass only ever fills, a line's
    // glow paints nothing and the control is a lie
    const o = shapeWithGlow({ type: "line", name: "L", x: 100, y: 100, x2: 400, y2: 300 });
    expect(o.effects.glow.on, "a line should be allowed a glow").toBe(true);
    expect(painted(), "the line's glow never reached the canvas").toBeGreaterThan(0);
  });

  it("paints a glow on an ellipse", () => {
    shapeWithGlow({ type: "ellipse", name: "E", x: 100, y: 100, w: 200, h: 140 });
    expect(painted()).toBeGreaterThan(0);
  });
});
