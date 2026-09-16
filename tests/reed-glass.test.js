// @vitest-environment jsdom
/**
 * Reed glass — a sheet of fluted glass refracting the layers BENEATH it.
 *
 * The subject is whatever the document already has under the panel: the panel
 * itself has no colour. Put it over a shape and the part behind it breaks into
 * flutes while the part sticking out past it stays whole, and that contrast is
 * the effect. Only a backdrop material can do that, which is why isBackdrop is
 * pinned here rather than left to be discovered.
 *
 * The shader is ported from the author's own reed-glass shader maker and its
 * optics are carried across untouched; what changed is where a sample comes
 * from. The render is WebGL and is checked on the canvas, not here. These hold
 * the model, the clamps, and — the part that has bitten twice — every surface
 * that has to agree before the effect is reachable at all.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { loadEditor } from "./helpers/load-editor.js";

/** The page's own gate. index.html sets this before fxstack.js narrows READY. */
const FX_ONLY = ["mesh", "shadow", "iridescent", "reed"];

let editor;

/** A shape carrying reed glass; returns the normalized layer. */
function withReed(params = {}, over = {}) {
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
          effects: { reed: { on: true, ...params } },
          ...over,
        },
      ],
    },
  };
  return editor.doc.frame.children[0];
}

beforeAll(() => {
  ({ editor } = loadEditor({ fxOnly: FX_ONLY }));
});

describe("every surface that has to agree for it to be reachable", () => {
  /* Two effects have now shipped unreachable, each because one of these
   * surfaces disagreed with the others while the rest looked right. They are
   * checked one at a time so a failure says which. */
  const W = () => /** @type {any} */ (globalThis.window);

  it("the stack has it, once, as a material", () => {
    const FS = W().FxStack;
    expect(FS.types()).toContain("reed");
    expect(FS.slotOf("reed")).toBe("material");
    expect(FS.meta("reed").multi).toBe(false);
    expect(FS.types().filter((t) => t === "reed")).toHaveLength(1);
  });

  it("it is in the stack order, once", () => {
    /* Twice an entry has been added to one list while already in the other and
     * the effect then ran over itself. Cheap to pin. */
    const FS = W().FxStack;
    expect(FS.LEGACY_ORDER).toContain("reed");
    expect(FS.LEGACY_ORDER.filter((t) => t === "reed")).toHaveLength(1);
  });

  it("it reads the backdrop, which is the whole premise", () => {
    expect(W().FxStack.isBackdrop("reed")).toBe(true);
  });

  it("FX_ONLY lets it through, and still gates the others out", () => {
    const FS = W().FxStack;
    expect(FS.isReady("reed")).toBe(true);
    expect(FS.isReady("bloom")).toBe(false);
  });

  it("it is its own catalog row, which is what the picker is built from", () => {
    /* An effect that resolves onto another id has no row of its own however
     * ready it is — that alias is exactly why the previous fluted-glass engine
     * was promoted, allowed, wired to a menu row, and still not reachable the
     * way people actually add effects. */
    const C = W().EngineCatalog;
    expect(C.resolve("reed")).toBe("reed");
    const item = C.get("reed");
    expect(item.id).toBe("reed");
    expect(item.rendererType).toBe("reed");
    expect(item.status).toBe(C.READY);
    expect(item.supportedInputs).toContain("rect");
    expect(item.supportedInputs).not.toContain("text");
    expect(C.ready().map((e) => e.id)).toContain("reed");
  });

  it("the Effects menu row survives the FX_ONLY pass", () => {
    /* Present in the markup is not the same as visible: the menu hides a row
     * whose engine is not ready, and it resolves the id to find that engine. */
    const row = document.querySelector('[data-capability="reed"]');
    expect(row).toBeTruthy();
    expect(/** @type {any} */ (row).hidden).toBe(false);
  });

  it("the Add fill or effect picker carries a row for it", () => {
    withReed({}, { effects: {} });
    const open = document.getElementById("enginesOpen");
    expect(open).toBeTruthy();
    /** @type {any} */ (open).click();
    const row = document.querySelector('#engList .engRow[data-engine="reed"]');
    expect(row).toBeTruthy();
    expect(/** @type {any} */ (row).querySelector(".engName").textContent).toBe("Reed glass");
  });

  it("applying it opens a panel page that exists", () => {
    const o = withReed();
    expect(editor.FX_PAGES(o)).toContain("Reed glass");
  });
});

describe("the document keeps every parameter inside what the panel can undo", () => {
  it("arrives on the reference preset, measured not guessed", () => {
    /* These are the standalone shader maker's reference values, measured off a
     * reference video: 53px flute pitch, each flute an inverted ~3.3x
     * compressed copy of the backdrop. They are pinned because they are the
     * one thing in this effect that came from a measurement rather than a
     * preference, and a future tweak should have to argue with them. */
    const R = withReed().effects.reed;
    expect(R.fluteW).toBe(53);
    expect(R.bulge).toBeCloseTo(0.45, 5);
    expect(R.ior).toBeCloseTo(1.5, 5);
    expect(R.gap).toBeCloseTo(10, 5);
    expect(R.seamDark).toBeCloseTo(0.75, 5);
  });

  it("keeps the panel visible over flat colour", () => {
    /* Refracting a sample inside one flat region changes nothing, so over an
     * empty artboard the only thing that makes the panel an object is the
     * reflection. A default of zero there reads as a broken effect. */
    const R = withReed().effects.reed;
    expect(R.spec).toBeGreaterThan(0);
    expect(R.ambient).toBeGreaterThan(0);
    expect(R.fresnel).toBeGreaterThan(0);
  });

  it("clamps every control to the range its chip offers", () => {
    const R = withReed({
      fluteW: 9999,
      phase: 5,
      bulge: 0,
      ior: 9,
      disp: 9,
      thick: 9,
      gap: 99,
      seamW: 9,
      seamDark: 9,
      fresnel: 9,
      spec: 9,
      lightAng: 999,
      lightW: 0,
      ambient: 9,
    }).effects.reed;
    expect(R.fluteW).toBe(400);
    expect(R.phase).toBe(1);
    expect(R.bulge).toBe(0.05);
    expect(R.ior).toBe(2.4);
    expect(R.disp).toBe(0.08);
    expect(R.thick).toBe(4);
    expect(R.gap).toBe(20);
    expect(R.seamW).toBe(6);
    expect(R.seamDark).toBe(1);
    expect(R.fresnel).toBe(2);
    expect(R.spec).toBe(4);
    expect(R.lightAng).toBe(80);
    expect(R.lightW).toBe(0.05);
    expect(R.ambient).toBe(0.3);
  });

  it("a value that is not a number falls back rather than reaching the shader", () => {
    /* The fallback reads a snapshot taken BEFORE Object.assign, because assign
     * mutates its target: read after it, de.reed and the layer are the same
     * object and the fallback hands back the very value it meant to replace.
     * That shipped once already. */
    const R = withReed({ fluteW: "wide", bulge: undefined, ior: null }).effects.reed;
    expect(R.fluteW).toBe(53);
    expect(R.bulge).toBeCloseTo(0.45, 5);
    expect(R.ior).toBe(1); // +null is 0, clamped to the floor — coercion, not a fallback
  });

  it("it only turns on for shapes the engine can box", () => {
    expect(withReed({}, { type: "rect" }).effects.reed.on).toBe(true);
    expect(withReed({}, { type: "ellipse" }).effects.reed.on).toBe(true);
    expect(withReed({}, { type: "text", text: "hi", fontSize: 20 }).effects.reed.on).toBe(false);
  });
});

describe("it samples the page where the page actually is", () => {
  /* The editor's canvas transform is setTransform(z*dpr, 0, 0, z*dpr,
   * view.x*dpr, view.y*dpr) — a scale AND a pan. A draw path that reads only
   * the scale puts its box, and every ray cast from it, off by the pan: the
   * panel samples a region of the canvas unrelated to what sits behind it, and
   * the artboard rect that keeps the editor's surround out of the picture is
   * tested against the wrong rectangle. At zero pan the offset is zero and all
   * of it looks right, which is why it lasted.
   *
   * Tested on the arithmetic directly: the jsdom canvas never applies that
   * transform, so anything driven through render() sees the identity. */
  const rect = () => /** @type {any} */ (globalThis.window).__editor.canvasRect;

  it("carries the pan into the rect, not just the scale", () => {
    const tm = { a: 2, b: 0, c: 0, d: 2, e: 140, f: 90 };
    expect(rect()(tm, 100, 50, 200, 400)).toEqual({ x: 340, y: 190, w: 400, h: 800 });
  });

  it("places the artboard with the same transform, or the clamp guards nothing", () => {
    const tm = { a: 2, b: 0, c: 0, d: 2, e: 140, f: 90 };
    const art = rect()(tm, 0, 0, 900, 600);
    const box = rect()(tm, 100, 50, 200, 400);
    expect(art).toEqual({ x: 140, y: 90, w: 1800, h: 1200 });
    /* The invariant that keeps the surround out of the panel: a layer on the
     * page samples the page. It holds only if both rects move together. */
    expect(box.x).toBeGreaterThanOrEqual(art.x);
    expect(box.y).toBeGreaterThanOrEqual(art.y);
    expect(box.x + box.w).toBeLessThanOrEqual(art.x + art.w);
    expect(box.y + box.h).toBeLessThanOrEqual(art.y + art.h);
  });

  it("survives a context that reports no usable transform", () => {
    expect(rect()(null, 10, 20, 30, 40)).toEqual({ x: 10, y: 20, w: 30, h: 40 });
    expect(rect()({ a: 0, d: NaN }, 10, 20, 30, 40)).toEqual({ x: 10, y: 20, w: 30, h: 40 });
  });
});

describe("the engine's own contract", () => {
  it("names the presets the panel offers", () => {
    /* The panel reads these off the engine rather than repeating them, and it
     * reaches for them through a guard — an unguarded read of a missing engine
     * took down the WHOLE right panel once, not just its own section. */
    const E = /** @type {any} */ (globalThis.window).ReedGlassEngine;
    if (!E) return; // WebGL engines are not loaded in jsdom; the panel guards for this
    expect(E.PRESETS).toContain("reference");
    expect(E.presetValues("reference")).toEqual({});
    expect(E.presetValues("nope")).toBeNull();
  });
});
