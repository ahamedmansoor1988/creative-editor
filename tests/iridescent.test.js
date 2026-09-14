// @vitest-environment jsdom
/**
 * Iridescence — the Chromaform material on an arbitrary shape.
 *
 * The material reached a layer by way of the DoLittle Figma plugin, which had
 * already solved the problem an earlier port here got wrong: the source page's
 * shader knew six hard-coded silhouettes and derived its curved normal from an
 * analytic dome for each of them. A vector shape has no closed form, so
 * coverage comes from the shape's own mask and the height field is SOLVED from
 * that mask.
 *
 * What is testable without a GPU: the mask the editor rasterises, and the
 * Poisson solve that turns it into a dome. The rendering is verified on the
 * page, where WebGL 2 exists.
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

/** A solid disc of alpha, as RGBA, for the solver. */
function disc(w, h, r) {
  const px = new Uint8ClampedArray(w * h * 4);
  const cx = w / 2,
    cy = h / 2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r) px[(y * w + x) * 4 + 3] = 255;
  return px;
}

beforeAll(() => {
  ({ editor } = loadEditor());
});

describe("the mask is the shape's own outline", () => {
  it("a key describes what the SHAPE is, not what it looks like", () => {
    /* So a colour change reuses the mask and the dome solved from it. */
    const o = withIridescence();
    const a = editor.shapeMaskKey(o, 64, 64);
    o.fill.color = "#ff0000";
    expect(editor.shapeMaskKey(o, 64, 64)).toBe(a);
  });

  it("a different corner radius is a different mask", () => {
    const o = withIridescence({ type: "rect", radius: 0 });
    const sharp = editor.shapeMaskKey(o, 64, 64);
    o.radius = 40;
    expect(editor.shapeMaskKey(o, 64, 64)).not.toBe(sharp);
  });

  it("a different tile size is a different mask", () => {
    const o = withIridescence();
    expect(editor.shapeMaskKey(o, 64, 64)).not.toBe(editor.shapeMaskKey(o, 128, 128));
  });

  it("a polygon's sides and its star ratio both count", () => {
    const o = withIridescence({ type: "polygon", sides: 5, innerRatio: 1 });
    const regular = editor.shapeMaskKey(o, 64, 64);
    o.innerRatio = 0.4;
    const star = editor.shapeMaskKey(o, 64, 64);
    o.sides = 6;
    expect(star).not.toBe(regular);
    expect(editor.shapeMaskKey(o, 64, 64)).not.toBe(star);
  });

  it("a path's own points are in the key, so editing it rebuilds the mask", () => {
    const o = withIridescence({
      type: "path",
      subpaths: [
        {
          closed: true,
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
          ],
        },
      ],
    });
    const before = editor.shapeMaskKey(o, 64, 64);
    o.subpaths[0].points[1].x = 40;
    expect(editor.shapeMaskKey(o, 64, 64)).not.toBe(before);
  });

  it("a degenerate tile yields no mask rather than a broken one", () => {
    const o = withIridescence();
    expect(editor.shapeMask(o, 0, 64)).toBeNull();
    expect(editor.shapeMask(o, 64, 0)).toBeNull();
  });
});

describe("the dome is solved from the mask, not assumed", () => {
  it("a disc comes back as the hemisphere the original shader used", () => {
    /* Poisson gives (R^2 - r^2)/const for a disc, so the square root is
     * sqrt(1 - (r/R)^2) — exactly the hemisphere. */
    const I = engine();
    const N = 96;
    const f = I.solveDome(disc(N, N, N / 2 - 2), N, N, 64);
    const at = (fx, fy) => {
      const x = Math.round(fx * f.inner[0]) + f.pad;
      const y = Math.round(fy * f.inner[1]) + f.pad;
      return f.data[y * f.width + x];
    };
    const centre = at(0.5, 0.5);
    const mid = at(0.5, 0.25);
    expect(centre).toBeGreaterThan(0.9); // normalised, so the peak is 1
    expect(mid).toBeGreaterThan(0.5);
    expect(mid).toBeLessThan(centre); // it falls away from the centre
  });

  it("the field is zero outside the silhouette and on its border", () => {
    const I = engine();
    const N = 64;
    const f = I.solveDome(disc(N, N, N / 4), N, N, 48);
    // the padded border ring is never covered
    for (let x = 0; x < f.width; x++) {
      expect(f.data[x]).toBe(0);
      expect(f.data[(f.height - 1) * f.width + x]).toBe(0);
    }
  });

  it("every value is normalised into 0..1", () => {
    const I = engine();
    const N = 64;
    const f = I.solveDome(disc(N, N, N / 2 - 2), N, N, 48);
    let max = 0;
    for (let i = 0; i < f.data.length; i++) {
      expect(f.data[i]).toBeGreaterThanOrEqual(0);
      max = Math.max(max, f.data[i]);
    }
    expect(max).toBeCloseTo(1, 3);
  });

  it("an empty mask solves to a flat zero field rather than dividing by zero", () => {
    const I = engine();
    const N = 32;
    const f = I.solveDome(new Uint8ClampedArray(N * N * 4), N, N, 32);
    for (let i = 0; i < f.data.length; i++) expect(f.data[i]).toBe(0);
  });

  it("a wide mask keeps its aspect in the solve grid", () => {
    const I = engine();
    const f = I.solveDome(disc(128, 64, 24), 128, 64, 64);
    expect(f.inner[0]).toBeGreaterThan(f.inner[1]);
  });
});

describe("colour reaches the shader in the space it works in", () => {
  it("converts sRGB hex to linear, matching the reference page", () => {
    const I = engine();
    expect(I.linearRGB("#000000")).toEqual([0, 0, 0]);
    I.linearRGB("#ffffff").forEach((v) => expect(v).toBeCloseTo(1, 6));
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

describe("the editor owns composition, so the shader does not", () => {
  it("the six hard-coded silhouettes are gone", () => {
    expect(SRC).not.toContain("sdRoundBox");
    expect(SRC).not.toContain("sdHex");
    expect(SRC).not.toContain("sdStar");
  });

  it("coverage comes from the mask texture", () => {
    expect(SRC).toContain("uniform sampler2D maskTex");
    expect(SRC).toContain("float mask=maskAt(uv)");
  });

  it("scale, rotation and echoes belong to the layer now", () => {
    const I = withIridescence().effects.iridescent;
    expect(I.scale).toBeUndefined();
    expect(I.rotation).toBeUndefined();
    expect(I.echoes).toBeUndefined();
  });

  it("the shader carries no clock, so a render is reproducible", () => {
    expect(SRC).not.toContain("uniform float time");
  });
});

describe("the document keeps the shader inside what the panel can undo", () => {
  it("arrives with the reference page's own defaults", () => {
    const I = withIridescence({}, {}).effects.iridescent;
    expect(I.spectrum).toBeCloseTo(0.78, 5);
    expect(I.refraction).toBeCloseTo(1.4, 5);
    expect(I.colorCore).toBe("#e8dd19");
  });

  it("clamps every number to the range its row offers", () => {
    const I = withIridescence({}, { spectrum: 40, refraction: -9, hue: 5000, exposure: 0 }).effects
      .iridescent;
    expect(I.spectrum).toBe(1);
    expect(I.refraction).toBe(0);
    expect(I.hue).toBe(360);
    expect(I.exposure).toBe(0.2);
  });

  it("replaces a malformed colour with the default rather than passing it on", () => {
    const I = withIridescence({}, { colorCore: "rgb(1,2,3)" }).effects.iridescent;
    expect(I.colorCore).toBe("#e8dd19");
  });

  it("is a material for a shape, so a text layer cannot carry it on", () => {
    expect(withIridescence({ type: "text", text: "hi" }, {}).effects.iridescent.on).toBe(false);
  });

  it("survives a round trip through JSON", () => {
    withIridescence({}, { spectrum: 0.2, hue: 120, colorLeft: "#112233" });
    editor.doc = JSON.parse(JSON.stringify(editor.doc));
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

  it("the catalog offers it for shapes only", () => {
    const C = /** @type {any} */ (globalThis.window).EngineCatalog;
    const item = C.get("iridescent");
    expect(item.rendererType).toBe("iridescent");
    expect(item.supportedInputs).toContain("rect");
    expect(item.supportedInputs).not.toContain("text");
    expect(item.status).toBe(C.READY);
  });
});

describe("the edge stays clean at every zoom", () => {
  /* Three things were reported from zoomed screenshots: a hard blue line at
   * the boundary, a wavering red artifact along a curve, and too much
   * turbulence in the shades. The first two are one cause. */
  it("the tile is capped, so the solve grid is never far coarser than it", () => {
    /* The rim band lives where the height field meets zero. Let the tile run
     * to the zoom and the grid is six times coarser than the pixels: the
     * silhouette follows the exact mask, the rim follows the coarse grid, and
     * the sliver between them wavers. */
    const APP = readFileSync(join(process.cwd(), "public/app.js"), "utf8");
    expect(APP).toContain("IRI_TILE_LONG=1024");
    expect(APP).toContain("IRI_TILE_LONG/longest");
  });

  it("the cap can go below one, or the paint cache defeats it", () => {
    /* The cache hands the draw a PRE-SCALED object, so o.w is already in the
     * bitmap's pixels and the context scale is 1. A lower bound of 1 pinned
     * the tile to the bitmap and the cap never bit. */
    const APP = readFileSync(join(process.cwd(), "public/app.js"), "utf8");
    expect(APP).not.toContain("clamp(Math.min(want,IRI_TILE_LONG");
  });

  it("spread leans the partners toward the core", () => {
    const I = engine();
    const core = "#ff0000";
    const far = I.leaned("#00ff00", core, 1);
    const none = I.leaned("#00ff00", core, 0);
    const half = I.leaned("#00ff00", core, 0.5);
    expect(none).toEqual(I.linearRGB(core)); // spread 0 is all core
    expect(far).toEqual(I.linearRGB("#00ff00")); // spread 1 is the picker
    for (let i = 0; i < 3; i++) {
      const lo = Math.min(none[i], far[i]),
        hi = Math.max(none[i], far[i]);
      expect(half[i]).toBeGreaterThanOrEqual(lo);
      expect(half[i]).toBeLessThanOrEqual(hi);
    }
  });

  it("spread mixes in LINEAR light, where the shader works", () => {
    const I = engine();
    const mid = I.leaned("#ffffff", "#000000", 0.5)[0];
    // half way between linear 0 and linear 1 is 0.5, not sRGB's 0.22
    expect(mid).toBeCloseTo(0.5, 5);
  });

  it("spread arrives part way, so the default is a material and not a rainbow", () => {
    expect(withIridescence().effects.iridescent.spread).toBeCloseTo(0.35, 5);
  });

  it("spread is clamped like every other number", () => {
    expect(withIridescence({}, { spread: 9 }).effects.iridescent.spread).toBe(1);
    expect(withIridescence({}, { spread: -9 }).effects.iridescent.spread).toBe(0);
  });
});

describe("the palettes are a starting point, not a mode", () => {
  /* Carried across from the plugin's palettes.ts: five sRGB hex per set, in
   * the shader's own order — centre, left lobe, right lobe, upper wash, edge. */
  it("there are seven, each with five colours in the shader's order", () => {
    const P = editor.IRI_PALETTES;
    expect(P.length).toBe(7);
    for (const pal of P) {
      expect(pal.colors.length).toBe(5);
      for (const c of pal.colors) expect(c).toMatch(/^#[0-9a-f]{6}$/);
      expect(pal.label.length).toBeGreaterThan(2);
    }
  });

  it("every set is distinct, so the list is not padded", () => {
    const keys = editor.IRI_PALETTES.map((p) => p.colors.join(","));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("Chromaform is the source page's own set, and the default", () => {
    const I = withIridescence().effects.iridescent;
    expect(editor.iriPaletteId(I)).toBe("chromaform");
  });

  it("a hand-edited colour stops the row claiming a palette", () => {
    /* A row naming a palette the colours had drifted from would be lying. */
    const I = withIridescence().effects.iridescent;
    I.colorTop = "#123456";
    expect(editor.iriPaletteId(I)).toBe("");
  });

  it("identifying a set ignores the case the hex was written in", () => {
    const I = withIridescence().effects.iridescent;
    const pearl = editor.IRI_PALETTES.find((p) => p.id === "pearl");
    ["colorCore", "colorLeft", "colorRight", "colorTop", "colorEdge"].forEach((k, i) => {
      I[k] = pearl.colors[i].toUpperCase();
    });
    expect(editor.iriPaletteId(I)).toBe("pearl");
  });

  it("every palette colour survives the document's own validation", () => {
    /* normalizeDoc replaces anything that is not a six-digit hex, so a palette
     * carrying a bad value would silently become the default. */
    for (const pal of editor.IRI_PALETTES) {
      const I = withIridescence(
        {},
        {
          colorCore: pal.colors[0],
          colorLeft: pal.colors[1],
          colorRight: pal.colors[2],
          colorTop: pal.colors[3],
          colorEdge: pal.colors[4],
        },
      ).effects.iridescent;
      expect(editor.iriPaletteId(I)).toBe(pal.id);
    }
  });
});
