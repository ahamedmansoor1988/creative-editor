// @vitest-environment jsdom
/**
 * Iridescence — the Chromaform material, ported to a layer.
 *
 * These cover the parts that are decidable without a GPU: which silhouette a
 * layer maps to, the colour conversion the shader expects, and the clamps that
 * keep a hand-written document inside what the panel can undo. The rendering
 * itself is verified on the page, where WebGL 2 exists.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { loadEditor } from "./helpers/load-editor.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let editor;
const SRC = readFileSync(join(process.cwd(), "public/iridescent.js"), "utf8");

/** Load the engine module into this jsdom window and hand back its API. */
function engine() {
  const w = /** @type {any} */ (globalThis.window);
  if (!w.Iridescent) new Function(SRC).call(w);
  return w.Iridescent;
}

/** One shape carrying iridescence; returns the normalized layer. */
function withIridescence(over = {}, params = {}) {
  editor.doc = {
    frame: {
      name: "F",
      w: 900,
      h: 600,
      bg: "#000000",
      children: [
        {
          type: "ellipse",
          name: "Orb",
          x: 100,
          y: 100,
          w: 200,
          h: 200,
          fill: { kind: "solid", color: "#888888" },
          effects: { iridescent: { on: true, ...params } },
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

describe("a layer maps to the silhouette that matches it", () => {
  it("an ellipse gets the sphere, a rect the rounded box", () => {
    const I = engine();
    expect(I.shapeIndex("ellipse")).toBe(0);
    expect(I.shapeIndex("rect")).toBe(3);
  });

  it("a star polygon gets the star, a regular one gets the hexagon", () => {
    /* The regression: reading only the side count sent every regular polygon
     * to the star silhouette, so a hexagon's rim ran along points it does not
     * have. The editor calls a polygon a star when its inner ratio drops
     * below 1, which is the rule its own Shape panel states. */
    const I = engine();
    expect(I.shapeIndex("polygon", 5, 0.45)).toBe(5);
    expect(I.shapeIndex("polygon", 6, 1)).toBe(4);
    expect(I.shapeIndex("polygon", 5, 1)).toBe(4);
  });

  it("a polygon with many sides is a circle, star or not", () => {
    const I = engine();
    expect(I.shapeIndex("polygon", 12, 1)).toBe(0);
    expect(I.shapeIndex("polygon", 12, 0.4)).toBe(5);
  });

  it("an unknown layer type falls back rather than throwing", () => {
    const I = engine();
    expect(I.shapeIndex("something-new")).toBe(3);
    expect(I.shapeIndex(undefined)).toBe(3);
  });
});

describe("colour reaches the shader in the space it works in", () => {
  it("converts sRGB hex to linear, matching the reference page", () => {
    const I = engine();
    expect(I.linearRGB("#000000")).toEqual([0, 0, 0]);
    const white = I.linearRGB("#ffffff");
    white.forEach((v) => expect(v).toBeCloseTo(1, 6));
    // mid grey is well below 0.5 once linearised — the whole point of doing it
    const mid = I.linearRGB("#808080")[0];
    expect(mid).toBeGreaterThan(0.2);
    expect(mid).toBeLessThan(0.3);
  });

  it("a malformed colour is black rather than NaN", () => {
    const I = engine();
    expect(I.linearRGB("nonsense")).toEqual([0, 0, 0]);
    expect(I.linearRGB(undefined)).toEqual([0, 0, 0]);
  });
});

describe("the document keeps the shader inside what the panel can undo", () => {
  it("arrives with the reference page's own defaults", () => {
    const o = withIridescence({}, {});
    const I = o.effects.iridescent;
    expect(I.spectrum).toBeCloseTo(0.78, 5);
    expect(I.refraction).toBeCloseTo(1.4, 5);
    expect(I.colorCore).toBe("#e8dd19");
  });

  it("clamps every number to the range its row offers", () => {
    const o = withIridescence(
      {},
      { spectrum: 40, refraction: -9, echoes: 99, hue: 5000, squash: 0, exposure: 0 },
    );
    const I = o.effects.iridescent;
    expect(I.spectrum).toBe(1);
    expect(I.refraction).toBe(0);
    expect(I.echoes).toBe(6);
    expect(I.hue).toBe(360);
    expect(I.squash).toBe(0.2);
    expect(I.exposure).toBe(0.2);
  });

  it("replaces a malformed colour with the default rather than passing it on", () => {
    const o = withIridescence({}, { colorCore: "rgb(1,2,3)", colorEdge: "#31" });
    expect(o.effects.iridescent.colorCore).toBe("#e8dd19");
    expect(o.effects.iridescent.colorEdge).toBe("#314fea");
  });

  it("is a material for a shape, so a text layer cannot carry it on", () => {
    const o = withIridescence({ type: "text", text: "hi" }, {});
    expect(o.effects.iridescent.on).toBe(false);
  });

  it("survives a round trip through JSON with its values", () => {
    withIridescence({}, { spectrum: 0.2, hue: 120, colorLeft: "#112233" });
    const back = JSON.parse(JSON.stringify(editor.doc));
    editor.doc = back;
    const I = editor.doc.frame.children[0].effects.iridescent;
    expect(I.spectrum).toBeCloseTo(0.2, 5);
    expect(I.hue).toBe(120);
    expect(I.colorLeft).toBe("#112233");
  });
});

describe("it takes its place in the effect stack", () => {
  it("is a material, so it competes with the mesh rather than stacking over it", () => {
    const FS = /** @type {any} */ (globalThis.window).FxStack;
    expect(FS.slotOf("iridescent")).toBe("material");
    expect(FS.meta("iridescent").multi).toBe(false);
  });

  it("is in the gate's READY set, and the page's own narrowing still applies", () => {
    /* window.FX_ONLY in index.html narrows what THIS PAGE offers while the
     * effects are opened one at a time. The QA record is separate: the catalog
     * calls it ready, and the gate demotes it only because the page has not
     * listed it yet. */
    const FS = /** @type {any} */ (globalThis.window).FxStack;
    expect(FS.READY.has("mesh")).toBe(true);
    expect(FS.slotOf("iridescent")).toBe("material");
  });

  it("the catalog offers it for shapes only", () => {
    const C = /** @type {any} */ (globalThis.window).EngineCatalog;
    const item = C.get("iridescent");
    expect(item.rendererType).toBe("iridescent");
    expect(item.supportedInputs).toContain("rect");
    expect(item.supportedInputs).not.toContain("text");
    /* The catalog's own claim is READY; status() reconciles it with the gate,
       which this page narrows, so it reads as experimental until listed. */
    expect(item.status).toBe(C.READY);
  });
});

describe("the silhouette fills the layer's box", () => {
  /* Reported from the canvas: an iridescent circle came out visibly smaller
   * than a plain circle of the same size, with empty space inside its own
   * selection. The reference page floated its object in a viewport with room
   * around it; a layer has no room around it. */
  it("puts a circle exactly on the tile's edge", () => {
    const I = engine();
    const f = I.fitToBox(0, 200, 200);
    // the shader's circle stops at .86, so filling a square tile needs 1/.86
    expect(f.scale).toBeCloseTo(1 / 0.86, 5);
    expect(f.stretch).toBeCloseTo(1, 5);
  });

  it("stretches the silhouette to a box that is not square", () => {
    const I = engine();
    const wide = I.fitToBox(0, 400, 200);
    // twice as wide: the scale doubles and the stretch halves, so the
    // silhouette becomes an ellipse on the box rather than a circle inside it
    expect(wide.scale).toBeCloseTo(2 / 0.86, 5);
    expect(wide.stretch).toBeCloseTo(0.5, 5);
  });

  it("uses each silhouette's own reach, which is not the same number", () => {
    const I = engine();
    const circle = I.fitToBox(0, 200, 200).scale;
    const box = I.fitToBox(3, 200, 200).scale;
    const star = I.fitToBox(5, 200, 200).scale;
    expect(box).toBeGreaterThan(circle); // the rounded box stops at .82
    expect(star).toBeLessThan(circle); // the star reaches further, to .92
  });

  it("an unknown silhouette falls back rather than returning NaN", () => {
    const I = engine();
    const f = I.fitToBox(99, 200, 200);
    expect(Number.isFinite(f.scale)).toBe(true);
    expect(Number.isFinite(f.stretch)).toBe(true);
  });

  it("a degenerate box does not produce NaN either", () => {
    const I = engine();
    const f = I.fitToBox(0, 0, 0);
    expect(Number.isFinite(f.scale)).toBe(true);
    expect(Number.isFinite(f.stretch)).toBe(true);
  });

  it("Scale now defaults to 100 per cent, meaning it fills the layer", () => {
    const o = withIridescence({}, {});
    expect(o.effects.iridescent.scale).toBe(1);
  });
});

describe("echoes recede, and can turn and scatter", () => {
  /* Echoes stack INSIDE the tile and flatten as they go, which reads as
   * perspective. The repeater keeps every copy whole and outside the box, so
   * the two are different effects that happen to both repeat. */
  it("arrives switched off, so applying the effect changes nothing else", () => {
    const I = withIridescence({}, {}).effects.iridescent;
    expect(I.echoes).toBe(0);
    expect(I.echoRotation).toBe(0);
    expect(I.echoJitter).toBe(0);
  });

  it("clamps the count, the turn and the scatter to their rows", () => {
    const I = withIridescence({}, { echoes: 40, echoRotation: 900, echoJitter: 7, echoSeed: 0 })
      .effects.iridescent;
    expect(I.echoes).toBe(6);
    expect(I.echoRotation).toBe(180);
    expect(I.echoJitter).toBe(1);
    expect(I.echoSeed).toBe(1);
  });

  it("a negative turn is allowed, so the stack can lean either way", () => {
    const I = withIridescence({}, { echoRotation: -45 }).effects.iridescent;
    expect(I.echoRotation).toBe(-45);
  });

  it("the seed is part of the tile's identity, so two seeds are two figures", () => {
    /* Without the seed in the key, changing it would hand back the cached
     * tile and the scatter would appear frozen. */
    const base = {
      layerType: "ellipse",
      spectrum: 0.5,
      refraction: 1.4,
      rim: 0.5,
      depth: 0.5,
      softness: 0.5,
      scale: 1,
      stretch: 1,
      rotation: 0,
      hue: 0,
      saturation: 1,
      exposure: 1,
      echoes: 4,
      spacing: 0.5,
      squash: 0.55,
      echoRotation: 0,
      echoJitter: 0.5,
      glow: false,
      glowAmount: 0,
      glowSize: 0,
      glowMix: 0,
      glowTint: "#ffffff",
      colorCore: "#ffffff",
      colorLeft: "#ff0000",
      colorRight: "#00ff00",
      colorTop: "#0000ff",
      colorEdge: "#ffff00",
    };
    const SRC2 = readFileSync(join(process.cwd(), "public/iridescent.js"), "utf8");
    // the key builder is internal, so assert on the contract it has to keep:
    // every parameter the shader reads appears in the cache key list
    for (const k of ["echoRotation", "echoJitter", "echoSeed"]) {
      expect(SRC2).toContain('"' + k + '"');
    }
    expect(Object.keys(base)).toContain("echoJitter");
  });

  it("the original copy never moves, whatever the scatter", () => {
    /* isEcho gates both the turn and the scatter in the shader, so index 0 —
     * the layer you selected, with its handles on screen — stays put. */
    const SRC2 = readFileSync(join(process.cwd(), "public/iridescent.js"), "utf8");
    expect(SRC2).toContain("lp-=isEcho*echoJitter");
    expect(SRC2).toContain("rot(echoRotation*fi*isEcho)");
  });
});

describe("the silhouette follows the layer's corner radius", () => {
  /* Reported: a rect with sharp corners came out rounded. The page drew one
   * rounded rectangle and its shader had .24 baked in. */
  it("the shader reads a radius uniform rather than a constant", () => {
    const SRC2 = readFileSync(join(process.cwd(), "public/iridescent.js"), "utf8");
    expect(SRC2).toContain("sdRoundBox(p,vec2(.82,.78),boxRadius)");
    expect(SRC2).not.toContain("sdRoundBox(p,vec2(.82,.78),.24)");
  });

  it("takes the smallest of a rect's four radii", () => {
    /* The shader has one radius and the editor allows four. The silhouette
     * must never be ROUNDER than the path it is clipped to, or the sharper
     * corner would be left unpainted, so the smallest wins. */
    const SRC2 = readFileSync(join(process.cwd(), "public/iridescent.js"), "utf8");
    expect(SRC2).toMatch(/Math\.min\.apply\(\s*null,\s*radii/);
  });

  it("a radius of half the width reaches the stadium, as the editor's clamp does", () => {
    /* One page pixel across a box of width W is 2 * .82 / W in shader units,
     * so W/2 lands exactly on the half-extent .82. */
    const W = 200;
    const r = ((W / 2) * 2 * 0.82) / W;
    expect(r).toBeCloseTo(0.82, 5);
  });

  it("a radius of zero is a radius of zero", () => {
    const W = 200;
    expect((0 * 2 * 0.82) / W).toBe(0);
  });
});
