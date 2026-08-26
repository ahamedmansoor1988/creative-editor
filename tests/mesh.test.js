// @vitest-environment jsdom
/**
 * QA for the `mesh` gradient effect (§4.7), ported from public/lab-mesh.html.
 *
 * jsdom has no WebGL2, so the ENGINE cannot run here and nothing below asserts
 * a pixel — the surface itself was verified in the lab, against the
 * framebuffer, with the acceptance tests the brief specified. What these cover
 * is the part a port gets wrong: the seven places an effect type has to be
 * wired into, the clamps that repair a net arriving from a saved file or the
 * model, and the panel.
 *
 * The engine's absence is itself a supported state — every call site guards on
 * available() — so it is asserted rather than worked around.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loadEditor } from "./helpers/load-editor.js";

let editor, ctx;

function shapeWithMesh(over, type) {
  editor.doc = {
    frame: {
      name: "F",
      w: 900,
      h: 600,
      bg: "#ffffff",
      artboards: [],
      children: [
        {
          type: type || "rect",
          name: "M",
          x: 100,
          y: 100,
          w: 400,
          h: 300,
          fill: { kind: "solid", color: "#cccccc" },
          effects: { mesh: { on: true, ...over } },
        },
      ],
    },
  };
  return editor.doc.frame.children[0];
}

beforeAll(() => {
  ({ editor, ctx } = loadEditor());
  window.FxStack.READY.add("mesh");
});
afterAll(() => {
  window.FxStack.READY.delete("mesh");
});

describe("mesh — wired into the effect system", () => {
  it("is registered as a MATERIAL, not an overlay", () => {
    // the mesh IS what the shape shows; as an overlay it would paint over a
    // fill that is invisible but still casting the shadow
    expect(window.FxStack.slotOf("mesh")).toBe("material");
  });

  it("is offered on the shapes that can render it", () => {
    const pages = (t) => editor.FX_PAGES({ type: t, name: "x", x: 0, y: 0, w: 10, h: 10 });
    expect(pages("rect")).toContain("Mesh");
    expect(pages("path")).toContain("Mesh");
    expect(pages("text"), "text cannot carry a mesh").not.toContain("Mesh");
  });

  it("becomes the active material when switched on", () => {
    const o = shapeWithMesh({});
    const m = window.FxStack.activeMaterial(o.fx);
    expect(m && m.type).toBe("mesh");
  });

  it("keeps effects.mesh a live alias of its fx-stack entry", () => {
    const o = shapeWithMesh({});
    const entry = (o.fx || []).find((e) => e.type === "mesh");
    expect(entry.params).toBe(o.effects.mesh);
  });

  it("refuses to enable on a type that cannot render it", () => {
    expect(shapeWithMesh({}, "text").effects.mesh.on).toBe(false);
  });
});

describe("mesh — the net is repaired, not trusted", () => {
  it("fills an empty net with a default one", () => {
    // the default carries no points: sixteen of them in every object's
    // defaults would enter the compact-serialisation baseline for shapes that
    // never touch the effect
    const m = shapeWithMesh({}).effects.mesh;
    expect(m.points).toHaveLength(m.cols * m.rows);
  });

  it("rebuilds a net whose length disagrees with its grid", () => {
    // a short net is not partially usable — the surface would read past its
    // own data — so it is replaced rather than padded
    const m = shapeWithMesh({ cols: 4, rows: 4, points: [{ x: 0, y: 0, color: [1, 2, 3] }] })
      .effects.mesh;
    expect(m.points).toHaveLength(16);
  });

  it("clamps the grid to the engine's own limits", () => {
    expect(shapeWithMesh({ cols: 99, rows: 99 }).effects.mesh.cols).toBe(10);
    expect(shapeWithMesh({ cols: 0, rows: 0 }).effects.mesh.rows).toBe(4);
  });

  it("allows a point outside the box, which is how the edge is steered", () => {
    const pts = Array.from({ length: 16 }, () => ({ x: 1.15, y: -0.15, color: [10, 20, 30] }));
    const m = shapeWithMesh({ cols: 4, rows: 4, points: pts }).effects.mesh;
    expect(m.points[0].x).toBeCloseTo(1.15);
    expect(m.points[0].y).toBeCloseTo(-0.15);
  });

  it("clamps a colour channel and repairs a malformed one", () => {
    const pts = Array.from({ length: 16 }, () => ({ x: 0.5, y: 0.5, color: [999, -5, "x"] }));
    const m = shapeWithMesh({ cols: 4, rows: 4, points: pts }).effects.mesh;
    expect(m.points[0].color).toEqual([255, 0, 0]);
  });

  it("survives a compact round trip with its net intact", () => {
    const o = shapeWithMesh({ cols: 5, rows: 3 });
    o.effects.mesh.points[4].color = [1, 2, 3];
    const wire = editor.compactDoc({ frame: editor.doc.frame });
    editor.doc = JSON.parse(JSON.stringify(wire));
    const m = editor.doc.frame.children[0].effects.mesh;
    expect(m.cols).toBe(5);
    expect(m.rows).toBe(3);
    expect(m.points).toHaveLength(15);
    expect(m.points[4].color).toEqual([1, 2, 3]);
  });
});

describe("mesh — the panel", () => {
  function openMesh(over) {
    const o = shapeWithMesh(over);
    editor.setSelIds(new Set([o.id]));
    editor.refresh();
    const head = document.querySelector('#fxBody [data-fxsect="Mesh"]');
    if (head && head.getAttribute("aria-expanded") !== "true")
      /** @type {HTMLElement} */ (head).click();
    return { o, sect: head && head.nextElementSibling };
  }

  it("always offers the enable switch", () => {
    const { sect } = openMesh({ on: false });
    expect(sect.querySelector("#mshOn")).toBeTruthy();
  });

  it("says so plainly when the engine cannot run, rather than showing dead controls", () => {
    // jsdom has no WebGL2, so this is the real branch here — and it is the
    // branch a user on an old machine gets
    const { sect } = openMesh({});
    expect(sect.querySelector(".fxWarn"), "an unavailable engine must be stated").toBeTruthy();
    expect(sect.querySelector("#mshC"), "no grid controls when nothing can render").toBeFalsy();
  });
});

describe("applying an analysed recipe", () => {
  /* The model dissects a reference into engines and parameters; this turns
   * that into effects. Everything here arrives from a model, so the tests are
   * mostly about what happens when it is WRONG — a misjudged image should
   * produce a poor result, never a broken document. */
  function shape() {
    editor.doc = {
      frame: {
        name: "F",
        w: 900,
        h: 600,
        bg: "#ffffff",
        artboards: [],
        children: [
          {
            type: "rect",
            name: "R",
            x: 100,
            y: 80,
            w: 700,
            h: 440,
            fill: { kind: "solid", color: "#888888" },
            effects: { mesh: { on: true } },
          },
        ],
      },
    };
    return editor.doc.frame.children[0];
  }

  it("applies a directional blur and grain, as analysed", () => {
    // the recipe the live endpoint returned for images/glass.jpg
    const o = shape();
    const applied = editor.applyRecipe(o, {
      base: "linear",
      effects: [
        { type: "blur", kind: "directional", angle: 90, distance: 150 },
        { type: "grain", amount: 0.4 },
      ],
    });
    expect(applied).toEqual(["blur", "grain"]);
    expect(o.effects.blur).toMatchObject({ kind: "directional", angle: 90, distance: 150 });
    expect(o.effects.grain.amount).toBeCloseTo(0.4);
  });

  it("rescues a directional blur the model gave a radius instead of a distance", () => {
    // it reaches for `radius` out of habit; distance 0 is not a blur at all,
    // and would read as the analysis having been ignored
    const o = shape();
    editor.applyRecipe(o, {
      effects: [{ type: "blur", kind: "directional", angle: 35, distance: 0, radius: 90 }],
    });
    expect(o.effects.blur.distance).toBe(90);
  });

  it("clamps every value, because a misjudged reading must stay a bad result", () => {
    const o = shape();
    editor.applyRecipe(o, {
      effects: [
        { type: "blur", kind: "gaussian", radius: 9999 },
        { type: "grain", amount: 5 },
        { type: "noise", amount: -2, scale: 99 },
      ],
    });
    expect(o.effects.blur.radius).toBe(200);
    expect(o.effects.grain.amount).toBe(1);
    expect(o.effects.noise.amount).toBe(0);
    expect(o.effects.noise.scale).toBe(8);
  });

  it("leaves alone what the recipe does not mention", () => {
    // an analysis pass adds to the user's work rather than replacing it
    const o = shape();
    o.effects.grain.amount = 0.6;
    editor.applyRecipe(o, { effects: [{ type: "blur", kind: "gaussian", radius: 10 }] });
    expect(o.effects.grain.amount).toBeCloseTo(0.6);
  });

  it("survives junk without throwing", () => {
    const o = shape();
    expect(editor.applyRecipe(o, { effects: [null, { type: "nope" }, {}, "x"] })).toEqual([]);
    expect(editor.applyRecipe(o, {})).toEqual([]);
    expect(editor.applyRecipe(o, null)).toEqual([]);
  });

  it("reports only the effects it actually turned on", () => {
    // grain at zero is not grain; saying it was applied would be a lie in the UI
    const o = shape();
    expect(editor.applyRecipe(o, { effects: [{ type: "grain", amount: 0 }] })).toEqual([]);
  });
});

/* The mesh is a MATERIAL, and the other materials end their block with
 * `return` — they have replaced the fill, and everything below it is the flat
 * fill they are replacing. The mesh was written by copying one of them, so it
 * returned too, and took the whole over-slot half of the pipeline with it:
 * grain, gradient overlay, inner shadow. A mesh with grain on it drew no grain,
 * with the effect enabled and its stack entry reporting on.
 *
 * The engine cannot run in jsdom, and both the material block and the fill
 * guard hinge on available() — so available() and get() are stubbed here to
 * put the path in the state where the bug lived. That is the whole point of
 * the test: without the stub the branch is dead and the regression is
 * invisible, which is how it survived the port in the first place. */
describe("mesh does not swallow the passes below it", () => {
  function withLiveEngine(run) {
    const MG = window.MeshGradient;
    const oldAvail = MG.available,
      oldGet = MG.get;
    MG.available = () => true;
    MG.get = (w, h) => ({ width: w, height: h });
    /* The cache renders the object into its own canvas and blits ONE bitmap,
     * so every pass this test counts happens on a context it cannot see. */
    editor.paintCacheOff = true;
    try {
      return run();
    } finally {
      MG.available = oldAvail;
      MG.get = oldGet;
      editor.paintCacheOff = false;
    }
  }

  /* Assigned as a whole document rather than by poking .effects, because the
   * fx STACK is what fxOn consults and normalizeDoc is what builds it. Poking
   * the dictionary leaves the stack empty, and grain — whose legacy form is an
   * amount with no `on` field — then reads as off no matter what it is set to.
   * The test would have passed the mesh half while silently never enabling the
   * effect it exists to check. */
  function paint(effects) {
    return withLiveEngine(() => {
      editor.doc = {
        frame: {
          name: "F",
          w: 900,
          h: 600,
          bg: "#ffffff",
          artboards: [],
          children: [
            {
              type: "rect",
              name: "M",
              x: 100,
              y: 100,
              w: 400,
              h: 300,
              fill: { kind: "solid", color: "#cccccc" },
              effects,
            },
          ],
        },
      };
      let patterns = 0;
      const realPattern = ctx.createPattern;
      ctx.createPattern = (...a) => {
        patterns++;
        return realPattern.apply(ctx, a);
      };
      ctx.calls.length = 0;
      editor.render();
      ctx.createPattern = realPattern;
      return {
        patterns,
        meshBlits: ctx.calls.filter((c) => c.name === "drawImage").length,
        fills: ctx.calls.filter((c) => c.name === "fill" || c.name === "fillRect").length,
      };
    });
  }

  it("still paints grain over a mesh", () => {
    const withGrain = paint({
      mesh: { on: true },
      grain: { amount: 0.5 },
    });
    /* The grain pass is a pattern fill and nothing else in this document makes
     * one, so the count is the pass. Before the fix it was 0. */
    expect(withGrain.patterns).toBe(1);
    expect(withGrain.meshBlits).toBeGreaterThan(0);
  });

  it("does not paint grain when the effect is off", () => {
    expect(paint({ mesh: { on: true }, grain: { amount: 0 } }).patterns).toBe(0);
  });

  /* Falling through must not un-replace the fill: the mesh covers the shape,
   * and a flat fill painted after it would bury it. */
  it("skips the flat fill it replaces", () => {
    const meshed = paint({ mesh: { on: true } });
    const plainFill = paint({ mesh: { on: false } });
    expect(meshed.meshBlits).toBeGreaterThan(0);
    expect(plainFill.meshBlits).toBe(0);
    /* Exactly one fill fewer: the flat one the mesh stands in for. Asserted as
     * a difference rather than an absolute, so the number stays true when
     * another pass is added to the shape. */
    expect(meshed.fills).toBe(plainFill.fills - 1);
  });
});
