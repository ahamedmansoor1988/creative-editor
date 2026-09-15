// @vitest-environment jsdom
/**
 * Fractal glass — the shape as a rack of glass strips.
 *
 * The engine was ported from the author's own glass-ribbons.html and has had a
 * panel page all along, but it was in neither the quality-passed set nor the
 * catalog, so nothing could reach it: no menu entry, no picker row, no way in.
 * These hold the model and its registration. The render is WebGL and is
 * checked on the canvas, not here.
 *
 * WHAT IT IS, in one line, because the mechanism is easy to mistake for
 * refraction: each strip is a window onto ONE shared colour field, sampled a
 * step apart from its neighbour, and that discontinuity between neighbours is
 * the whole effect. No lensing, no dispersion.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { loadEditor } from "./helpers/load-editor.js";

let editor;

/** A shape carrying fractal glass; returns the normalized layer. */
function withFractal(params = {}, over = {}) {
  editor.doc = {
    frame: {
      name: "F",
      w: 900,
      h: 600,
      bg: "#ffffff",
      children: [
        {
          type: "rect",
          name: "L",
          x: 100,
          y: 100,
          w: 300,
          h: 200,
          fill: { kind: "solid", color: "#8b5cf6" },
          effects: { fractal: { on: true, ...params } },
          ...over,
        },
      ],
    },
  };
  return editor.doc.frame.children[0];
}

beforeAll(() => {
  ({ editor } = loadEditor());
});

describe("it can actually be reached", () => {
  /* Iridescence shipped unreachable for the same reason: built, panelled,
   * and in neither list. */
  it("the catalog knows it, and offers it for shapes", () => {
    const C = /** @type {any} */ (globalThis.window).EngineCatalog;
    const item = C.get("fractal");
    expect(item).toBeTruthy();
    expect(item.rendererType).toBe("fractal");
    expect(item.status).toBe(C.READY);
    expect(item.supportedInputs).toContain("rect");
    expect(item.supportedInputs).not.toContain("text");
  });

  it("it is in the quality-passed set and in the stack order", () => {
    const FS = /** @type {any} */ (globalThis.window).FxStack;
    expect(FS.types()).toContain("fractal");
    expect(FS.LEGACY_ORDER).toContain("fractal");
  });

  it("it is a material, so it competes with mesh and iridescence", () => {
    const FS = /** @type {any} */ (globalThis.window).FxStack;
    expect(FS.slotOf("fractal")).toBe("material");
    expect(FS.meta("fractal").multi).toBe(false);
  });

  it("the Effects menu carries a row for it", () => {
    const menu = document.querySelector('[data-menu="effects"] .dropdown');
    const caps = [...menu.querySelectorAll("[data-capability]")].map(
      (b) => /** @type {any} */ (b).dataset.capability,
    );
    expect(caps).toContain("fractal");
  });
});

describe("the document keeps every parameter inside what the panel can undo", () => {
  it("arrives with the standalone's own defaults", () => {
    const G = withFractal().effects.fractal;
    expect(G.count).toBe(11);
    expect(G.direction).toBe("v");
    expect(G.gap).toBeCloseTo(0.075, 5);
  });

  it("the strip count is a whole number in range", () => {
    expect(withFractal({ count: 999 }).effects.fractal.count).toBe(64);
    expect(withFractal({ count: 1 }).effects.fractal.count).toBe(3);
    expect(withFractal({ count: 7.6 }).effects.fractal.count).toBe(8);
  });

  it("direction is one of two, never anything else", () => {
    expect(withFractal({ direction: "h" }).effects.fractal.direction).toBe("h");
    expect(withFractal({ direction: "sideways" }).effects.fractal.direction).toBe("v");
  });

  it("clamps the numbers that drive the field", () => {
    const G = withFractal({ offset: 99, span: -3, warp: 99, exposure: 0, gamma: 99 }).effects
      .fractal;
    expect(G.offset).toBe(2);
    expect(G.span).toBe(0);
    expect(G.warp).toBe(2);
    expect(G.exposure).toBe(0.05);
    expect(G.gamma).toBe(3);
  });

  it("a value that is not a number falls back rather than reaching the shader", () => {
    const G = withFractal({ count: "lots", sat: undefined }).effects.fractal;
    expect(G.count).toBe(11);
    expect(G.sat).toBeCloseTo(1.25, 5);
  });

  it("null reads as zero, because that is what the coercion does", () => {
    /* Worth pinning rather than leaving to be discovered: the clamp tests
     * Number.isFinite(+v), and +null is 0, so a null arriving from a partial
     * document is kept as zero rather than falling back to the default. It is
     * the one input that does not behave like "missing". */
    expect(withFractal({ gap: null }).effects.fractal.gap).toBe(0);
  });

  it("is a material for a shape, so a text layer cannot carry it on", () => {
    expect(withFractal({}, { type: "text", text: "hi" }).effects.fractal.on).toBe(false);
  });

  it("survives a round trip through JSON", () => {
    withFractal({ count: 21, direction: "h", offset: 0.5 });
    editor.doc = JSON.parse(JSON.stringify(editor.doc));
    const G = editor.doc.frame.children[0].effects.fractal;
    expect(G.count).toBe(21);
    expect(G.direction).toBe("h");
    expect(G.offset).toBeCloseTo(0.5, 5);
  });
});

describe("the panel speaks the book's row language", () => {
  it("its sliders are chips, not ranges taking the row", () => {
    const o = withFractal();
    editor.setSelIds([o.id]);
    editor.refresh();
    const body = document.getElementById("fxBody");
    const sect = [...body.querySelectorAll("[data-fxsect]")].find(
      (h) => /** @type {any} */ (h).dataset.fxsect === "Fractal",
    );
    expect(sect).toBeTruthy();
    const page = sect.nextElementSibling;
    expect(page.querySelectorAll(".ui-pchip").length).toBeGreaterThan(8);
    expect(page.querySelectorAll('input[type="range"]').length).toBe(0);
  });

  it("the layer that has it is never paint-cached into its own box", () => {
    /* It is a material, which is exactly what makes a layer worth caching —
     * the same trap drop shadow fell into. */
    const o = withFractal();
    expect(editor.hasStructure(o)).toBe(false);
    expect(editor.paintCacheable(o)).toBe(true);
  });
});
