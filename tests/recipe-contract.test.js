// @vitest-environment jsdom
/**
 * The analyser's contract, honoured in full.
 *
 * /api/analyze may return a base (mesh, linear, radial, solid, liquid) and
 * effects of type blur, grain, noise, glass and light. applyRecipeReport
 * applies every one of them or says why it could not — nothing accepted by
 * the schema is dropped in silence any more. The older applyRecipe tests in
 * mesh.test.js still hold; these cover what used to be ignored.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { loadEditor } from "./helpers/load-editor.js";

let editor;
beforeAll(() => ({ editor } = loadEditor()));

function field(extra = {}) {
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
          name: "Field",
          x: 0,
          y: 0,
          w: 900,
          h: 600,
          fill: { kind: "solid", color: "#888888" },
          effects: { mesh: { on: true } },
          ...extra,
        },
      ],
    },
  };
  return editor.doc.frame.children[0];
}
/** A measured grid: red at the top fading to blue at the bottom. */
const GRID = {
  grid: 4,
  aspect: 1.5,
  rows: [
    ["#ff0000", "#ff0000", "#ff0000", "#ff0000"],
    ["#aa0055", "#aa0055", "#aa0055", "#aa0055"],
    ["#5500aa", "#5500aa", "#5500aa", "#5500aa"],
    ["#0000ff", "#0000ff", "#0000ff", "#0000ff"],
  ],
};
const FS = () => window.FxStack;
const material = (o) => (FS().activeMaterial(o.fx) || {}).type || null;

describe("base", () => {
  it("reads a linear fill off the measured grid, along the axis that changes most", () => {
    const o = field();
    const rep = editor.applyRecipeReport(o, { base: "linear", effects: [] }, { grid: GRID });
    expect(rep.applied).toEqual(["linear fill (measured)"]);
    expect(o.fill.kind).toBe("linear");
    expect(o.fill.angle).toBe(90); // top to bottom
    expect(o.fill.stops[0].color).toBe("#ff0000");
    expect(o.fill.stops[2].color).toBe("#0000ff");
    expect(material(o), "a fill is what the layer IS; the mesh no longer wins").toBeNull();
  });

  it("reads a radial fill: centre colour inside, border colour outside", () => {
    const o = field();
    // bright middle, dark border
    const radial = {
      grid: 4,
      aspect: 1,
      rows: [
        ["#101010", "#101010", "#101010", "#101010"],
        ["#101010", "#ffffff", "#ffffff", "#101010"],
        ["#101010", "#ffffff", "#ffffff", "#101010"],
        ["#101010", "#101010", "#101010", "#101010"],
      ],
    };
    editor.applyRecipeReport(o, { base: "radial" }, { grid: radial });
    expect(o.fill.kind).toBe("radial");
    expect(o.fill.stops).toHaveLength(2);
    expect(o.fill.stops[0].color).toBe("#ffffff");
    expect(o.fill.stops[1].color).toBe("#101010");
  });

  it("reads a solid as the grid's mean", () => {
    const o = field();
    editor.applyRecipeReport(o, { base: "solid" }, { grid: GRID });
    expect(o.fill).toMatchObject({ kind: "solid", color: "#800080" });
  });

  it("reports a fill base it cannot measure instead of guessing", () => {
    const o = field();
    const rep = editor.applyRecipeReport(o, { base: "linear", effects: [] });
    expect(rep.applied).toEqual([]);
    expect(rep.ignored).toEqual(["linear fill: needs the measured colour grid"]);
    expect(o.fill.kind).toBe("solid");
  });

  it("makes a mesh the winning material, and says when it could not fit it", () => {
    const o = field({ effects: { mesh: { on: false }, glass: { on: true } } });
    const rep = editor.applyRecipeReport(o, { base: "mesh" });
    expect(material(o)).toBe("mesh");
    expect(rep.applied).toEqual(["mesh (not fitted: no reference image)"]);
  });

  it("switches a liquid base on with the grid's dominant colours", () => {
    const o = field();
    const rep = editor.applyRecipeReport(o, { base: "liquid" }, { grid: GRID });
    expect(rep.applied).toEqual(["liquid"]);
    expect(material(o)).toBe("liquid");
    // the engine keeps a fixed number of colour slots; `count` says how many are live
    expect(o.effects.liquid.count).toBeGreaterThanOrEqual(2);
    const live = o.effects.liquid.cols.slice(0, o.effects.liquid.count);
    expect(new Set(live).size).toBe(live.length);
  });

  it("names a base it has no engine for", () => {
    const o = field();
    expect(editor.applyRecipeReport(o, { base: "hologram" }).ignored).toEqual([
      'base "hologram": no such engine',
    ]);
  });
});

describe("glass and light become their own layers", () => {
  it("adds reeded glass directly above the field with the measured rib count", () => {
    const o = field();
    const list = editor.doc.frame.children;
    const rep = editor.applyRecipeReport(
      o,
      {
        effects: [
          {
            type: "glass",
            mode: "reeded",
            count: 12,
            angle: 90,
            depth: 60,
            refraction: 40,
            frost: 10,
          },
        ],
      },
      { list },
    );
    expect(rep.applied).toEqual(["reeded glass (12 ribs)"]);
    expect(list).toHaveLength(2);
    const g = list[1];
    expect(rep.created[0]).toBe(g);
    expect(g.name).toBe("Glass");
    expect([g.x, g.y, g.w, g.h]).toEqual([0, 0, 900, 600]);
    expect(material(g)).toBe("glass");
    expect(g.effects.glass).toMatchObject({
      on: true,
      mode: "reeded",
      reedByCount: true,
      reedCount: 12,
      reedAngle: 90,
      depth: 60,
      refraction: 40,
      frost: 10,
    });
    expect(material(o), "the field keeps its own material").toBe("mesh");
  });

  it("clamps glass values and picks a mode from the frost when none is named", () => {
    const o = field();
    const list = editor.doc.frame.children;
    editor.applyRecipeReport(
      o,
      { effects: [{ type: "glass", frost: 80, depth: 999, refraction: -999, count: 500 }] },
      { list },
    );
    const g = list[1].effects.glass;
    expect(g.mode).toBe("frosted");
    expect(g.depth).toBe(200);
    expect(g.refraction).toBe(-200);
    expect(g.frost).toBe(80);
  });

  it("adds a transparent light layer with a clamped intensity", () => {
    const o = field();
    const list = editor.doc.frame.children;
    const rep = editor.applyRecipeReport(
      o,
      { effects: [{ type: "light", intensity: 99 }] },
      { list },
    );
    expect(rep.applied).toEqual(["light"]);
    const l = list[1];
    expect(l.name).toBe("Light");
    expect(material(l)).toBe("light");
    expect(l.effects.light).toMatchObject({ on: true, intensity: 2.8, transparent: true });
  });

  it("reports glass and light when there is no layer list to add them to", () => {
    // a bare object outside any document: the effect cannot be a sibling
    const o = { type: "rect", x: 0, y: 0, w: 10, h: 10, effects: editor.DEFAULT_EFFECTS(), fx: [] };
    const rep = editor.applyRecipeReport(
      o,
      { effects: [{ type: "glass" }, { type: "light" }] },
      { list: null },
    );
    expect(rep.applied).toEqual([]);
    expect(rep.ignored).toEqual([
      "glass: no layer list to add a glass layer to",
      "light: no layer list to add a light layer to",
    ]);
  });

  it("names an effect it has no engine for", () => {
    const o = field();
    expect(editor.applyRecipeReport(o, { effects: [{ type: "wibble" }] }).ignored).toEqual([
      "wibble: no engine of that name",
    ]);
  });

  it("keeps the old array-returning door unchanged", () => {
    const o = field();
    expect(editor.applyRecipe(o, { effects: [{ type: "grain", amount: 0.3 }] })).toEqual(["grain"]);
  });
});

describe("report helpers", () => {
  it("lists the engines a document uses", () => {
    editor.doc = {
      frame: {
        name: "F",
        w: 900,
        h: 600,
        bg: "#fff",
        artboards: [],
        children: [
          {
            type: "rect",
            name: "bg",
            x: 0,
            y: 0,
            w: 900,
            h: 600,
            fill: {
              kind: "linear",
              angle: 0,
              stops: [
                { pos: 0, color: "#000000" },
                { pos: 1, color: "#ffffff" },
              ],
            },
          },
          {
            type: "rect",
            name: "slat",
            x: 0,
            y: 0,
            w: 900,
            h: 20,
            fill: { kind: "solid", color: "#111111" },
            pattern: { columns: 1, rows: 12 },
          },
          { type: "text", name: "t", x: 10, y: 10, text: "Hi", size: 20 },
        ],
      },
    };
    const engines = editor.enginesInDoc(editor.doc);
    expect(engines).toContain("linear fill");
    expect(engines).toContain("pattern ×12");
    expect(engines).toContain("text");
  });

  it("picks dominant colours that are actually different colours", () => {
    const hexes = ["#ff0000", "#fe0101", "#ff0202", "#0000ff", "#0101fe", "#00ff00"];
    const out = editor.dominantHexes(hexes, 5);
    expect(out).toHaveLength(3);
  });
});

describe("pattern scale progression", () => {
  it("grows each instance by scaleStep per index and clamps the field", () => {
    editor.doc = {
      frame: {
        name: "F",
        w: 2000,
        h: 600,
        bg: "#fff",
        artboards: [],
        children: [
          {
            type: "ellipse",
            name: "P",
            x: 10,
            y: 10,
            w: 40,
            h: 40,
            fill: { kind: "solid", color: "#f00" },
            pattern: { columns: 4, rows: 1, hGap: 0, scaleStep: 0.5 },
          },
          {
            type: "ellipse",
            name: "Q",
            x: 10,
            y: 200,
            w: 40,
            h: 40,
            fill: { kind: "solid", color: "#f00" },
            pattern: { columns: 2, rows: 1, scaleStep: 9 },
          },
        ],
      },
    };
    const [p, q] = editor.doc.frame.children;
    expect(p.pattern.scaleStep).toBe(0.5);
    expect(q.pattern.scaleStep, "clamped to the documented range").toBe(0.5);
    const inst = editor.patternInstances(p);
    expect(inst).toHaveLength(3);
    expect(inst[0].w).toBeCloseTo(60); // 1 + 0.5 × 1
    expect(inst[2].w).toBeCloseTo(100); // 1 + 0.5 × 3
  });

  it("never lets a negative step collapse an instance", () => {
    editor.doc = {
      frame: {
        name: "F",
        w: 900,
        h: 600,
        bg: "#fff",
        artboards: [],
        children: [
          {
            type: "rect",
            name: "P",
            x: 10,
            y: 10,
            w: 100,
            h: 100,
            fill: { kind: "solid", color: "#f00" },
            pattern: { columns: 6, rows: 1, scaleStep: -0.5 },
          },
        ],
      },
    };
    const p = editor.doc.frame.children[0];
    const inst = editor.patternInstances(p);
    expect(inst).toHaveLength(5);
    expect(inst[4].w).toBeCloseTo(5); // floor at 0.05
  });
});

describe("a fitted net from outside the editor", () => {
  it("survives normalisation unchanged: cols, rows and every point", () => {
    // the shape mesh-gradient/scripts/fit_mesh.js writes: even grid, sRGB 0..255
    const cols = 5,
      rows = 5;
    const points = [];
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++)
        points.push({
          x: +(c / (cols - 1)).toFixed(4),
          y: +(r / (rows - 1)).toFixed(4),
          color: [r * 40, c * 40, 128],
        });
    editor.doc = {
      frame: {
        name: "F",
        w: 300,
        h: 600,
        bg: "#000000",
        artboards: [],
        children: [
          {
            type: "rect",
            name: "Mesh background",
            x: 0,
            y: 0,
            w: 300,
            h: 600,
            fill: { kind: "solid", color: "#000000" },
            effects: { mesh: { on: true, cols, rows, points } },
          },
        ],
      },
    };
    const m = editor.doc.frame.children[0].effects.mesh;
    expect(m.on).toBe(true);
    expect([m.cols, m.rows]).toEqual([5, 5]);
    expect(m.points).toHaveLength(25);
    expect(m.points[7].color).toEqual([40, 80, 128]);
    expect(m.points[24]).toMatchObject({ x: 1, y: 1 });
  });
});
