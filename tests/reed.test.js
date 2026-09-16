// @vitest-environment jsdom
/**
 * Reed glass — half-cylinder ribs refracting the page BENEATH the layer.
 *
 * This is the distinction the effect exists for, and it is the one that was
 * got wrong. A material that builds its colours from its OWN fill can slice
 * itself into strips and will never produce reeded glass, because the subject
 * of reeded glass is whatever is behind it: the layers it is sitting over and
 * the artboard. Put a blue circle and a red rectangle under a reed panel and
 * the part of each shape behind the glass breaks into ribs while the part that
 * sticks out past the panel stays whole and solid. That contrast IS the look,
 * and it is only available to a backdrop material.
 *
 * The engine (public/capsule.js, strip) was here the whole time, panelled and
 * correct, and in neither the quality-passed set nor FX_ONLY — so nothing on
 * the page could reach it and a second, wrong strip engine got built beside it.
 * These hold the registration and the model. The render is WebGL and is
 * checked on the canvas, not here.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { loadEditor } from "./helpers/load-editor.js";

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
          effects: { strip: { on: true, ...params } },
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
  it("is its own catalog row, which is what the picker is built from", () => {
    /* It aliased onto glass, and that alias was why "Add fill or effect"
     * had no row for it: the picker is built from the catalog, so an effect
     * that resolves to another id has no row of its own however ready it is.
     * Promoted, allowed by FX_ONLY, wired to a menu row — and still not
     * reachable the way people actually add effects. */
    const C = /** @type {any} */ (globalThis.window).EngineCatalog;
    expect(C.resolve("strip")).toBe("strip");
    const item = C.get("strip");
    expect(item.id).toBe("strip");
    expect(item.rendererType).toBe("strip");
    expect(item.status).toBe(C.READY);
    expect(item.supportedInputs).toContain("rect");
    expect(item.supportedInputs).not.toContain("text");
    expect(C.ready().map((e) => e.id)).toContain("strip");
  });

  it("it is in the quality-passed set and in the stack order", () => {
    const FS = /** @type {any} */ (globalThis.window).FxStack;
    expect(FS.types()).toContain("strip");
    expect(FS.LEGACY_ORDER).toContain("strip");
  });

  it("it appears exactly once in each list", () => {
    /* Twice now an entry has been added to one list while already present in
     * the other, and the effect then ran twice over. Cheap to pin. */
    const FS = /** @type {any} */ (globalThis.window).FxStack;
    expect(FS.LEGACY_ORDER.filter((t) => t === "strip")).toHaveLength(1);
    expect(FS.types().filter((t) => t === "strip")).toHaveLength(1);
  });

  it("it reads the backdrop — the property the whole effect rests on", () => {
    const FS = /** @type {any} */ (globalThis.window).FxStack;
    expect(FS.isBackdrop("strip")).toBe(true);
    /* And the one built beside it does not, which is why it could never do
     * this job however its own strips were tuned. */
    expect(FS.isBackdrop("fractal")).toBe(false);
  });

  it("it is a material, so it competes with mesh and iridescence", () => {
    const FS = /** @type {any} */ (globalThis.window).FxStack;
    expect(FS.slotOf("strip")).toBe("material");
    expect(FS.meta("strip").multi).toBe(false);
  });

  it("the Effects menu carries a row for it", () => {
    const menu = document.querySelector('[data-menu="effects"] .dropdown');
    const caps = [...menu.querySelectorAll("[data-capability]")].map(
      (b) => /** @type {any} */ (b).dataset.capability,
    );
    expect(caps).toContain("strip");
  });
});

describe("the document keeps every parameter inside what the panel can undo", () => {
  it("arrives tuned to read as glass rather than as a sliced shape", () => {
    /* The previous defaults were the engine author's, not a match to any
     * reference: ribWidth 0.12 gave eight fat panels instead of a reeded
     * sheet, and bulge 0.34 with smear 1.6 left the shapes behind it nearly
     * intact, so it read as a shape cut up rather than one seen THROUGH
     * glass. Measured one control at a time on the real engine. */
    const S = withReed().effects.strip;
    expect(S.ribWidth).toBeCloseTo(0.08, 5);
    expect(S.bulge).toBeCloseTo(0.7, 5);
    expect(S.smear).toBeCloseTo(2, 5);
    expect(S.dispersion).toBeCloseTo(0.02, 5);
    expect(S.ior).toBeCloseTo(1.55, 5);
    expect(S.angle).toBe(0);
    /* A rib is a lens: one pixel gathers a range of the page, it does not
     * point-sample one texel. Softness is that gather, and at 0 the output
     * goes back to being hard-edged and jittery — so it is pinned. Sheen and
     * seam are what make the panel visible at all over a flat colour. */
    expect(S.soften).toBeCloseTo(0.8, 5);
    expect(S.sheen).toBeCloseTo(0.45, 5);
    expect(S.seam).toBeCloseTo(0.45, 5);
  });

  it("seam depth can never paint ink over what is behind the glass", () => {
    /* It multiplied straight to zero, so at depth 1 the seams came out as
     * black bars across the subject — ink no glass can produce, and with
     * sheen turned down there was nothing left but the bars. The shader now
     * floors the seam at 40% brightness and confines it to the outer fifth of
     * the rib. The floor lives in the GLSL, so what is pinned here is that
     * the control reaches the value the shader has to survive. */
    expect(withReed({ seam: 5 }).effects.strip.seam).toBe(1);
    expect(withReed({ seam: -1 }).effects.strip.seam).toBe(0);
  });

  it("clamps every control to the range its slider offers", () => {
    const S = withReed({
      bulge: 9,
      ribWidth: 0,
      angle: 400,
      thickness: 9,
      ior: 9,
      dispersion: 9,
      slopeLimit: 0,
      smear: 99,
    }).effects.strip;
    expect(S.bulge).toBe(1);
    expect(S.ribWidth).toBe(0.02);
    expect(S.angle).toBe(90);
    expect(S.thickness).toBe(4);
    expect(S.ior).toBe(2.2);
    expect(S.dispersion).toBe(0.15);
    expect(S.slopeLimit).toBe(0.2);
    expect(S.smear).toBe(12);
  });

  it("a value that is not a number falls back rather than reaching the shader", () => {
    const S = withReed({ ribWidth: "fine", smear: undefined }).effects.strip;
    expect(S.ribWidth).toBeCloseTo(0.08, 5);
    expect(S.smear).toBeCloseTo(2, 5);
  });

  it("it only turns on for the shapes the engine can box", () => {
    expect(withReed({}, { type: "rect" }).effects.strip.on).toBe(true);
    expect(withReed({}, { type: "ellipse" }).effects.strip.on).toBe(true);
    expect(withReed({}, { type: "text", text: "hi", fontSize: 20 }).effects.strip.on).toBe(false);
  });
});

describe("the page's own FX_ONLY gate lets it through", () => {
  /* This is the test that was missing, and its absence is why "reed glass is
   * offered" could be green while the row was hidden in the browser. Every
   * other suite loads the editor with no FX_ONLY at all, so the narrowing that
   * the real page always applies was never exercised. Load it the way
   * index.html does. */
  let gated;
  beforeAll(() => {
    ({ editor: gated } = loadEditor({
      fxOnly: ["mesh", "shadow", "iridescent", "fractal", "strip"],
    }));
  });

  it("narrows the ready set to the listed effects, reed glass among them", () => {
    const FS = /** @type {any} */ (globalThis.window).FxStack;
    expect(FS.isReady("strip")).toBe(true);
    expect(FS.isReady("mesh")).toBe(true);
    expect(FS.isReady("bloom")).toBe(false);
  });

  it("leaves the reed glass row visible in the Effects menu", () => {
    const row = document.querySelector('[data-capability="strip"]');
    expect(row).toBeTruthy();
    expect(/** @type {any} */ (row).hidden).toBe(false);
  });

  it("hides the rows FX_ONLY leaves out, so the gate is doing something", () => {
    const hidden = (id) =>
      /** @type {any} */ (document.querySelector(`[data-capability="${id}"]`)).hidden;
    expect(hidden("bloom")).toBe(true);
    expect(hidden("blur")).toBe(true);
  });

  it("has a row in the Add fill or effect picker, which is how effects get added", () => {
    /* The surface that actually matters, and the one nothing was covering.
     * The menu row can be present and visible while this list has no row at
     * all, because the picker is built from the catalog and the menu is not —
     * which is exactly the state reed glass shipped in. */
    gated.doc = {
      frame: {
        name: "F",
        w: 900,
        h: 600,
        bg: "#ffffff",
        children: [
          {
            type: "rect",
            name: "L",
            x: 10,
            y: 10,
            w: 300,
            h: 200,
            fill: { kind: "solid", color: "#888888" },
          },
        ],
      },
    };
    gated.setSel && gated.setSel([gated.doc.frame.children[0].id]);
    const open = document.getElementById("enginesOpen");
    expect(open).toBeTruthy();
    /** @type {any} */ (open).click();
    const row = document.querySelector('#engList .engRow[data-engine="strip"]');
    expect(row).toBeTruthy();
    expect(/** @type {any} */ (row).querySelector(".engName").textContent).toBe("Reed glass");
  });

  it("offers the panel page once the effect is on", () => {
    gated.doc = {
      frame: {
        name: "F",
        w: 900,
        h: 600,
        bg: "#ffffff",
        children: [
          {
            type: "rect",
            name: "L",
            x: 10,
            y: 10,
            w: 300,
            h: 200,
            fill: { kind: "solid", color: "#888888" },
            effects: { strip: { on: true } },
          },
        ],
      },
    };
    expect(gated.FX_PAGES(gated.doc.frame.children[0])).toContain("Strip");
  });
});
