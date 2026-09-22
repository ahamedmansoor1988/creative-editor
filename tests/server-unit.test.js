// @vitest-environment node
/**
 * Characterization tests for server.js pure logic.
 *
 * These lock in what the code ACTUALLY does today, including its quirks — they
 * are a safety net for the Stage 2 refactor, not an assertion that the current
 * behaviour is ideal. Where today's behaviour is questionable it is marked
 * QUIRK so the refactor can change it deliberately rather than by accident.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { extractJSON, buildSystem, CAPABILITIES } = require("../server.js");

describe("extractJSON", () => {
  it("parses a plain JSON object", () => {
    expect(extractJSON('{"a":1}')).toEqual({ a: 1 });
  });

  it("strips ```json fences the model often adds", () => {
    expect(extractJSON('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("ignores prose surrounding the object", () => {
    expect(extractJSON('Sure! Here you go:\n{"a":1}\nHope that helps.')).toEqual({ a: 1 });
  });

  it("repairs trailing commas", () => {
    expect(extractJSON('{"a":1,}')).toEqual({ a: 1 });
    expect(extractJSON('{"a":[1,2,],}')).toEqual({ a: [1, 2] });
  });

  it("does not mistake braces inside strings for structure", () => {
    expect(extractJSON('{"text":"a { b } c"}')).toEqual({ text: "a { b } c" });
  });

  it("throws when there is no JSON object at all", () => {
    expect(() => extractJSON("no json here")).toThrow(/no JSON object/);
  });

  it("throws when the object is unrepairable", () => {
    expect(() => extractJSON('{"a": :}')).toThrow();
  });

  /* ------------------------------------------------------------------ *
   * Truncation. server.js carries a brace/bracket balancer meant to
   * repair output cut short by max_completion_tokens. Measured behaviour
   * shows it is far weaker than it looks, in two ways that matter. Both
   * are pinned here as BUGs (not merely quirks) for Stage 3.
   * ------------------------------------------------------------------ */

  it("BUG: cannot repair the commonest truncation — output with no '}' at all", () => {
    // The balancer is unreachable here: the guard uses lastIndexOf("}"), which
    // is -1, so it throws before any repair is attempted. A reply cut off
    // mid-array (the typical max-tokens failure) always lands here.
    expect(() => extractJSON('{"frame":{"children":[{"type":"rect"')).toThrow(/no JSON object/);
    expect(() => extractJSON('{"name":"unterminated')).toThrow(/no JSON object/);
  });

  it("BUG: when a '}' exists, everything after the last one is silently dropped", () => {
    // Slicing first "{" .. last "}" discards the truncated tail rather than
    // repairing it, so a design can come back structurally valid but with its
    // children silently missing. Silent data loss, not a parse error.
    expect(extractJSON('{"frame":{"w":900},"children":[{"type":"rect"')).toEqual({
      frame: { w: 900 },
    });
    expect(extractJSON('{"a":{"b":1},"c":[1,2')).toEqual({ a: { b: 1 } });
  });

  it("QUIRK: trailing prose after a complete object is discarded (benign here)", () => {
    expect(extractJSON('{"a":1} and then {oops')).toEqual({ a: 1 });
  });
});

describe("buildSystem", () => {
  const BASE_MARKER = "You generate EDITABLE vector designs";

  it("returns the base schema when nothing matches", () => {
    const s = buildSystem("make it blue", null);
    expect(s).toContain(BASE_MARKER);
    expect(s).not.toContain("Capabilities available for this request");
  });

  it("injects the pattern capability when the prompt mentions stripes", () => {
    const s = buildSystem("add stripes", null);
    expect(s).toContain("Capabilities available for this request");
    expect(s).toContain('"pattern"');
  });

  it("injects the shadow capability on a depth-flavoured prompt", () => {
    expect(buildSystem("give it depth", null)).toContain('"shadow"');
  });

  it("injects the grain capability on a film-flavoured prompt", () => {
    expect(buildSystem("filmic grain please", null)).toContain('"grain"');
  });

  it("injects a capability already used in the document even if the prompt is silent", () => {
    // A modify request must not lose a capability it cannot see.
    const doc = { frame: { children: [{ type: "rect", pattern: { mode: "rows" } }] } };
    const s = buildSystem("make it warmer", doc);
    expect(s).toContain('"pattern"');
  });

  it("injects shadow when the document already has one enabled", () => {
    const doc = { frame: { children: [{ effects: { shadow: { on: true } } }] } };
    expect(buildSystem("tweak", doc)).toContain('"shadow"');
  });

  it("can inject several capabilities at once", () => {
    const s = buildSystem("striped with a shadow and grain", null);
    expect(s).toContain('"pattern"');
    expect(s).toContain('"shadow"');
    expect(s).toContain('"grain"');
  });

  it("tolerates an empty prompt", () => {
    expect(buildSystem("", null)).toContain(BASE_MARKER);
    expect(buildSystem(undefined, null)).toContain(BASE_MARKER);
  });
});

describe("CAPABILITIES registry", () => {
  /* This used to assert the exact list ["pattern-engine","shadow","grain"].
   * The registry legitimately grows every time an engine is added, so that
   * assertion turned every new engine into a test failure — and because it was
   * a snapshot rather than an invariant, the suite simply sat red instead of
   * telling anyone something was wrong. These check properties that must hold
   * no matter how many capabilities exist. */
  it("gives every capability the shape the prompt builder relies on", () => {
    expect(CAPABILITIES.length).toBeGreaterThan(0);
    for (const c of CAPABILITIES) {
      expect(typeof c.id).toBe("string");
      expect(c.id.length).toBeGreaterThan(0);
      expect(c.match).toBeInstanceOf(RegExp);
      expect(typeof c.inDoc).toBe("function");
      expect(typeof c.doc).toBe("string");
      expect(c.doc.length).toBeGreaterThan(0);
    }
  });

  it("keeps ids unique, since they key the injected docs", () => {
    const ids = CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("still carries the core capabilities", () => {
    const ids = CAPABILITIES.map((c) => c.id);
    for (const id of ["pattern-engine", "shadow", "grain"]) expect(ids).toContain(id);
  });

  it("detects the on:true shape it tells the model to emit", () => {
    /* If inDoc cannot recognise the very thing doc instructs the model to
     * produce, the capability can never be seen as already present in a
     * document, and its guidance gets injected on every request forever.
     *
     * Scoped to capabilities that actually document an "on":true flag. Some
     * are switched on by a value instead — grain is live when amount > 0 and
     * has no flag at all — so a blanket {"on":true} probe would be asserting
     * something those were never meant to match. */
    const flagged = CAPABILITIES.filter(
      (c) => c.doc.includes(`"${c.id}":{`) && c.doc.includes('"on":true'),
    );
    expect(flagged.length).toBeGreaterThan(0);
    for (const c of flagged) {
      const sample = `{"effects":{"${c.id}":{"on":true}}}`;
      expect(c.inDoc(sample), `${c.id}.inDoc should match its own documented shape`).toBe(true);
    }
  });

  it("does not report a capability as present in an empty document", () => {
    for (const c of CAPABILITIES) {
      expect(c.inDoc('{"frame":{"children":[]}}'), `${c.id}.inDoc false-positives`).toBe(false);
    }
  });
});

/* 18 Sep 2026. A photograph of orange slabs behind panes of fluted glass came
 * back as a blurred gradient with ribs scratched over it. The recipe route has
 * no word for a shape, so it could never have produced that picture however
 * well its mesh was fitted — and the analyser had read it correctly all along
 * ("flat slabs behind a vertical fluted pane"). Two things followed: the brief
 * can place a material, and the analyser says when a picture has parts. */
describe("a material has a place", () => {
  const { briefToDoc } = require("../server.js");
  const build = (el) =>
    briefToDoc(
      { background: { kind: "solid", colors: ["#ffffff"] }, elements: [el] },
      900,
      600,
      [],
    );

  it("builds a reed pane as a placed layer with no colour of its own", () => {
    const { doc } = build({
      what: "fluted glass pane",
      shape: "rect",
      x: 25,
      y: 50,
      w: 50,
      h: 100,
      material: "reed",
      flutes: 20,
    });
    const pane = doc.frame.children.find((c) => c.name === "fluted glass pane");
    expect(pane).toBeTruthy();
    expect(pane.effects.reed.on).toBe(true);
    // the box it covers: half the width, centred a quarter in
    expect(pane.w).toBeCloseTo(450, 0);
    expect(pane.x).toBeCloseTo(0, 0);
    // 20 ribs across 450px
    expect(pane.effects.reed.fluteW).toBeCloseTo(22.5, 1);
    // a backdrop material shows the layers beneath, never its own fill
    expect(pane.fillOpacity).toBe(0);
  });

  it("measures the rib pitch down the HEIGHT when the ribs run horizontally", () => {
    const { doc } = build({
      what: "pane",
      x: 50,
      y: 50,
      w: 100,
      h: 50,
      material: "reed",
      flutes: 10,
      fluteAngle: 90,
    });
    const pane = doc.frame.children.find((c) => c.name === "pane");
    expect(pane.effects.reed.angle).toBe(90);
    expect(pane.effects.reed.fluteW).toBeCloseTo(30, 1); // 300px tall / 10
  });

  it("leaves an ordinary element alone", () => {
    const { doc } = build({
      what: "slab",
      shape: "rect",
      x: 50,
      y: 50,
      w: 40,
      h: 20,
      color: "#ff8800",
    });
    const slab = doc.frame.children.find((c) => c.name === "slab");
    expect(slab.effects).toBeUndefined();
    expect(slab.fill.color).toBe("#ff8800");
  });

  it("clamps a rib count the model could not have meant", () => {
    const { doc } = build({
      what: "p",
      x: 50,
      y: 50,
      w: 100,
      h: 100,
      material: "reed",
      flutes: 9999,
    });
    const p = doc.frame.children.find((c) => c.name === "p");
    expect(p.effects.reed.fluteW).toBeGreaterThanOrEqual(10);
  });
});

/* 18 Sep 2026. Four angular orange slabs in four quadrants came back as one
 * centred hexagon. Two causes, both in the brief: the side count was
 * hard-coded, and the grouping rule told the model to merge similar shapes. */
describe("shapes keep their own corners and their own places", () => {
  const { briefToDoc } = require("../server.js");
  const build = (els) =>
    briefToDoc({ background: { kind: "solid", colors: ["#ffffff"] }, elements: els }, 900, 600, []);

  it("gives a polygon the side count the brief asked for", () => {
    // It used to be hard-coded 6, so every polygon arrived a hexagon.
    const { doc } = build([
      { what: "badge", shape: "polygon", sides: 8, x: 50, y: 50, w: 40, h: 30, color: "#f5a623" },
    ]);
    expect(doc.frame.children.find((c) => c.name === "badge").sides).toBe(8);
  });

  it("treats a polygon with no side count as a four-cornered slab", () => {
    const { doc } = build([{ what: "slab", shape: "polygon", x: 50, y: 50, w: 40, h: 30 }]);
    expect(doc.frame.children.find((c) => c.name === "slab").type).toBe("rect");
  });

  it("clamps a side count the renderer cannot draw", () => {
    const { doc } = build([
      { what: "s", shape: "polygon", sides: 999, x: 50, y: 50, w: 10, h: 10 },
    ]);
    const s = doc.frame.children.find((c) => c.name === "s");
    expect(s.sides).toBeLessThanOrEqual(24);
    expect(s.sides).toBeGreaterThanOrEqual(3);
  });

  it("keeps four separately placed slabs as four objects", () => {
    const quads = [
      { what: "slab, upper left", shape: "polygon", sides: 4, x: 25, y: 25, w: 40, h: 30 },
      { what: "slab, upper right", shape: "polygon", sides: 4, x: 75, y: 25, w: 40, h: 30 },
      { what: "slab, lower left", shape: "polygon", sides: 4, x: 25, y: 75, w: 40, h: 30 },
      { what: "slab, lower right", shape: "polygon", sides: 4, x: 75, y: 75, w: 40, h: 30 },
    ];
    const { doc } = build(quads);
    const slabs = doc.frame.children.filter((c) => c.name.startsWith("slab"));
    expect(slabs).toHaveLength(4);
    expect(slabs.every((s) => s.type === "rect")).toBe(true);
    // and they are actually in four different places
    expect(new Set(slabs.map((s) => `${s.x},${s.y}`)).size).toBe(4);
  });

  it("lets a shape run off the frame", () => {
    // A slab cropped by the edge has the box it would have had uncropped.
    const { doc } = build([{ what: "slab", shape: "rect", x: 110, y: 50, w: 40, h: 30 }]);
    expect(doc.frame.children.find((c) => c.name === "slab").x).toBeGreaterThan(900 - 180);
  });
});

describe("a four-cornered polygon is a slab, not a diamond", () => {
  const { briefToDoc } = require("../server.js");
  it("draws it as a rect so its edges stay level", () => {
    // The polygon renderer stands a regular quad on its corner; every slab the
    // model named arrived as a diamond.
    const { doc } = briefToDoc(
      {
        background: { kind: "solid", colors: ["#fff"] },
        elements: [
          { what: "slab", shape: "polygon", sides: 4, x: 50, y: 50, w: 40, h: 20, rotation: 12 },
        ],
      },
      900,
      600,
      [],
    );
    const slab = doc.frame.children.find((c) => c.name === "slab");
    expect(slab.type).toBe("rect");
    expect(slab.rot).toBe(12);
  });
  it("still draws a real polygon from five sides up", () => {
    const { doc } = briefToDoc(
      {
        background: { kind: "solid", colors: ["#fff"] },
        elements: [{ what: "star", shape: "polygon", sides: 6, x: 50, y: 50, w: 20, h: 20 }],
      },
      900,
      600,
      [],
    );
    expect(doc.frame.children.find((c) => c.name === "star").type).toBe("polygon");
  });
});

/* 18 Sep 2026. Mansoor, on the batch: "0024 cant be radial. its mesh gradient"
 * and "994 is iridiscent with echo". Both right, and both the same cause —
 * briefToDoc could only give an element a solid, linear or radial paint, so a
 * soap-film sphere and a soft many-colour wash each came out a radial fill
 * that picked ONE colour out of a spectrum. The engines were already shipped;
 * the brief had no word for them. */
describe("an element can be made by an engine", () => {
  const { briefToDoc } = require("../server.js");
  const GRID = [
    ["#ff0000", "#ff8800", "#ffff00", "#00ff00"],
    ["#00ffff", "#0000ff", "#8800ff", "#ff00ff"],
    ["#ffffff", "#cccccc", "#888888", "#444444"],
    ["#000000", "#220000", "#004400", "#000044"],
  ];
  const build = (el, rows) =>
    briefToDoc(
      { background: { kind: "solid", colors: ["#000000"] }, elements: [el] },
      800,
      1000,
      rows || [],
    );

  it("turns an iridescent element into the iridescence engine", () => {
    const { doc } = build({
      what: "sphere",
      shape: "ellipse",
      x: 50,
      y: 30,
      w: 60,
      h: 40,
      material: "iridescent",
    });
    const o = doc.frame.children.find((c) => c.name === "sphere");
    expect(o.type).toBe("ellipse");
    expect(o.effects.iridescent.on).toBe(true);
  });

  it("gives a mesh element colours measured off the reference, not a default palette", () => {
    const { doc } = build(
      { what: "wash", shape: "rect", x: 50, y: 50, w: 100, h: 100, material: "mesh" },
      GRID,
    );
    const m = doc.frame.children.find((c) => c.name === "wash").effects.mesh;
    expect(m.on).toBe(true);
    expect(m.points).toHaveLength(m.cols * m.rows);
    /* Corners of the net come from the corners of the measured grid — as
     * [r,g,b], which is the only format the editor's normaliser keeps. This
     * asserted hex strings and passed for days while every mesh the
     * composition route built rendered as flat #888888: it was checking the
     * format this file invented, not the one the reader wants. */
    expect(m.points[0].color).toEqual([255, 0, 0]);
    expect(m.points[m.points.length - 1].color).toEqual([0, 0, 68]);
    // normalised coordinates, which is what the mesh engine stores
    expect(m.points.every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1)).toBe(true);
  });

  it("says so when there is no colour grid, instead of painting a grey slab", () => {
    /* It used to fill every point with #808080, which renders as a flat grey
     * that looks exactly like a working mesh with no colour in it — the worst
     * failure available, because nothing about it says the colours never
     * arrived. The element keeps its own colour and the miss is reported. */
    const out = briefToDoc(
      {
        background: { kind: "solid", colors: ["#000000"] },
        elements: [
          {
            what: "wash",
            shape: "rect",
            x: 50,
            y: 50,
            w: 50,
            h: 50,
            color: "#c83232",
            material: "mesh",
          },
        ],
      },
      800,
      1000,
      [],
    );
    const o = out.doc.frame.children.find((c) => c.name === "wash");
    expect(o.effects).toBeUndefined();
    expect(o.fill.color).toBe("#c83232");
    expect(out.unsupported.join(" ")).toMatch(/colour grid/);
  });

  it("builds a receding stack for repeat echo, not a grid", () => {
    // A sphere above ever-flatter discs is ONE thing echoed.
    const { doc } = build({
      what: "sphere",
      shape: "ellipse",
      x: 50,
      y: 25,
      w: 60,
      h: 25,
      material: "iridescent",
      repeat: "echo",
      count: 5,
    });
    const o = doc.frame.children.find((c) => c.name === "sphere");
    expect(o.echo).toBeTruthy();
    expect(o.echo.copies).toBe(5);
    expect(o.pattern).toBeUndefined();
    // height collapses faster than width: that is what reads as perspective
    expect(o.echo.heightScale).toBeLessThan(o.echo.widthScale);
    expect(o.echo.stepY).toBeGreaterThan(0);
  });

  it("still lays an even row for repeat horizontal", () => {
    const { doc } = build({
      what: "dots",
      shape: "ellipse",
      x: 50,
      y: 50,
      w: 80,
      h: 10,
      repeat: "horizontal",
      count: 4,
    });
    const o = doc.frame.children.find((c) => c.name === "dots");
    expect(o.pattern.columns).toBe(4);
    expect(o.echo).toBeUndefined();
  });

  it("leaves an ordinary painted element untouched", () => {
    const { doc } = build({
      what: "slab",
      shape: "rect",
      x: 50,
      y: 50,
      w: 40,
      h: 20,
      color: "#ff8800",
    });
    const o = doc.frame.children.find((c) => c.name === "slab");
    expect(o.effects).toBeUndefined();
    expect(o.fill.color).toBe("#ff8800");
  });
});

describe("an echo stack holds together", () => {
  const { briefToDoc } = require("../server.js");
  const stack = (h) =>
    briefToDoc(
      {
        background: { kind: "solid", colors: ["#000"] },
        elements: [
          {
            what: "discs",
            shape: "ellipse",
            x: 50,
            y: 40,
            w: 60,
            h,
            material: "iridescent",
            repeat: "echo",
            count: 5,
          },
        ],
      },
      800,
      1000,
      [],
    ).doc.frame.children.find((c) => c.name === "discs");

  it("steps by a PERCENTAGE of the copy, not by pixels", () => {
    /* The engine does cy += (stepY/100) * h. Handing it the element's height
     * in pixels made the step ~195% and the stack flew apart. The step must
     * not change when the element does. */
    expect(stack(10).echo.stepY).toBe(stack(60).echo.stepY);
    expect(stack(60).echo.stepY).toBeLessThan(150);
  });

  it("puts the copies just clear of one another", () => {
    // The engine's touching point is 100*(1+heightScale)/2.
    const e = stack(25).echo;
    const touching = 100 * ((1 + e.heightScale) / 2);
    expect(e.stepY).toBeGreaterThanOrEqual(touching);
    expect(e.stepY - touching).toBeLessThan(20);
  });

  it("keeps the stack centred under the original", () => {
    expect(stack(25).echo.stepX).toBe(0);
  });
});

describe("iridescence wears the reference's colours", () => {
  const { briefToDoc } = require("../server.js");
  const GRID = [
    ["#ff00aa", "#000000", "#00e5ff", "#000000"],
    ["#000000", "#7b2cff", "#000000", "#ffe100"],
    ["#22ff88", "#000000", "#ff5500", "#000000"],
    ["#000000", "#0044ff", "#000000", "#ff00ee"],
  ];
  const build = (rows) =>
    briefToDoc(
      {
        background: { kind: "solid", colors: ["#000"] },
        elements: [
          { what: "orb", shape: "ellipse", x: 50, y: 50, w: 50, h: 50, material: "iridescent" },
        ],
      },
      800,
      1000,
      rows,
    ).doc.frame.children.find((c) => c.name === "orb").effects.iridescent;

  it("takes five colours measured off the picture", () => {
    const i = build(GRID);
    const picked = [i.colorCore, i.colorLeft, i.colorRight, i.colorTop, i.colorEdge];
    expect(picked.every((c) => /^#[0-9a-f]{6}$/i.test(c))).toBe(true);
    // every one came from the reference, not from the shipped palette
    expect(picked.every((c) => GRID.flat().includes(c))).toBe(true);
    expect(new Set(picked).size).toBeGreaterThan(2);
  });

  it("ignores the ground: a dark field must not yield five blacks", () => {
    // Most of that grid is black. Picking by frequency would return black.
    const i = build(GRID);
    expect([i.colorCore, i.colorLeft, i.colorRight, i.colorTop, i.colorEdge]).not.toContain(
      "#000000",
    );
  });

  it("falls back to the engine's own palette when there is no grid", () => {
    const i = build([]);
    expect(i.on).toBe(true);
    expect(i.colorCore).toBeUndefined();
  });
});

/* 18 Sep 2026. Two references of vivid colour on black came back grey.
 * Saturation is (max-min)/max — a RATIO — so #010100 scores a perfect 1.0
 * while being, to any eye, black. The palette picker filtered on it and
 * chose near-blacks as "lively colours". Chroma is the absolute measure. */
describe("a palette picks colour, not near-black that scores as saturated", () => {
  const { briefToDoc } = require("../server.js");
  const iri = (rows) =>
    briefToDoc(
      {
        background: { kind: "solid", colors: ["#000"] },
        elements: [
          { what: "orb", shape: "ellipse", x: 50, y: 50, w: 50, h: 50, material: "iridescent" },
        ],
      },
      800,
      1000,
      rows,
    ).doc.frame.children.find((c) => c.name === "orb").effects.iridescent;

  /* Measured off 994.jpg: mostly black, with real colour in a few cells. The
   * near-blacks here all score above 0.3 on ratio saturation. */
  const DARK_GROUND = [
    ["#000000", "#010100", "#020605", "#0f0c12"],
    ["#000000", "#e58fcc", "#e0679a", "#020201"],
    ["#000000", "#e96758", "#83275e", "#0a0e1e"],
    ["#000000", "#39c9a1", "#6b4bd6", "#000000"],
  ];

  it("takes the colours a person would point at, not the ground", () => {
    const picked = Object.values(iri(DARK_GROUND)).filter((v) => typeof v === "string");
    const chroma = (h) => {
      const v = parseInt(h.slice(1), 16),
        r = (v >> 16) & 255,
        g = (v >> 8) & 255,
        b = v & 255;
      return Math.max(r, g, b) - Math.min(r, g, b);
    };
    expect(picked.length).toBe(5);
    // every one carries real colour; the near-blacks sit at chroma 1-6
    expect(Math.min(...picked.map(chroma))).toBeGreaterThanOrEqual(40);
  });

  it("does not mistake #010100 for a saturated colour", () => {
    const picked = Object.values(iri(DARK_GROUND)).filter((v) => typeof v === "string");
    for (const nearBlack of ["#010100", "#020201", "#020605", "#0f0c12", "#000000"]) {
      expect(picked).not.toContain(nearBlack);
    }
  });

  it("falls back to the engine's palette rather than inventing one from mud", () => {
    const flat = [
      ["#000000", "#010100"],
      ["#020201", "#000000"],
    ];
    expect(iri(flat).colorCore).toBeUndefined();
  });
});

/* 18 Sep 2026. Groq embeds the reset time in the 429 message, and not always
 * in seconds: a per-minute limit says "try again in 12.3s", the DAILY one
 * says "try again in 21m55.872s". Matching seconds alone read that as 56
 * seconds, so the client retried every minute against a twenty-two minute
 * wall, spent the rest of the day's tokens doing it, and told the user to
 * give it a minute. */
describe("a 429 says how long, and which ceiling", () => {
  /* The REAL function, not a copy of it in the test. A copy here is how the
   * rule came to live in three places and disagree with itself. */
  const { rateLimit } = require("../server.js");
  const parse = (raw) => rateLimit(raw, null);

  it("reads a plain seconds wait", () => {
    expect(parse("Please try again in 12.3s").retryAfter).toBe(13);
  });

  it("reads minutes AND seconds, which is how the daily limit reports", () => {
    // This is the exact string that cost a day's quota.
    const r = parse(
      "on tokens per day (TPD): Limit 200000, Used 199574. Please try again in 21m55.872s",
    );
    expect(r.retryAfter).toBe(1316);
    expect(r.daily).toBe(true);
  });

  it("reads hours", () => {
    expect(parse("Please try again in 1h2m3s").retryAfter).toBe(3723);
  });

  it("does not call a per-minute limit a daily one", () => {
    const r = parse("on input tokens per minute (ITPM): Limit 7000. Please try again in 26.4s");
    expect(r.daily).toBe(false);
    expect(r.retryAfter).toBe(27);
  });

  it("falls back rather than returning zero when the wording changes", () => {
    expect(parse("Rate limit reached.").retryAfter).toBe(20);
  });
});

/* 21 Sep 2026, and the actual cause of the grey slab. Two guesses before this
 * were wrong — the grid was fine, the model's copy was fine — because the
 * colours were arriving correctly and being discarded at the very last step.
 *
 * A mesh point's colour is [r,g,b]. An iridescence colour is "#rrggbb". Two
 * neighbouring effects, two formats, and the mesh normaliser does
 * `Array.isArray(pt.color) ? pt.color : [136,136,136]` — so a hex string is
 * not REJECTED, it is silently replaced by mid-grey. Every point became
 * #888888 and the whole net rendered as one flat slab. */
describe("a mesh point's colour is [r,g,b], not a hex string", () => {
  const { briefToDoc } = require("../server.js");
  const GRID = [
    ["#ff0000", "#00ff00"],
    ["#0000ff", "#ffff00"],
  ];
  const mesh = () =>
    briefToDoc(
      {
        background: { kind: "solid", colors: ["#ffffff"] },
        elements: [{ what: "w", shape: "rect", x: 50, y: 50, w: 100, h: 100, material: "mesh" }],
      },
      900,
      600,
      GRID,
    ).doc.frame.children.find((c) => c.name === "w").effects.mesh;

  it("emits arrays, which is what the editor's normaliser keeps", () => {
    const pts = mesh().points;
    expect(pts.every((p) => Array.isArray(p.color))).toBe(true);
    expect(pts.every((p) => p.color.length === 3)).toBe(true);
    expect(pts.every((p) => p.color.every((v) => Number.isInteger(v) && v >= 0 && v <= 255))).toBe(
      true,
    );
  });

  it("carries the measured colours through, not mid-grey", () => {
    const pts = mesh().points;
    expect(pts[0].color).toEqual([255, 0, 0]);
    // #888888 is what a rejected point becomes; none may be that by accident
    expect(pts.every((p) => p.color.join() === "136,136,136")).toBe(false);
  });

  it("does not hand the editor a string it will quietly throw away", () => {
    /* The normaliser's own line, which is what made this silent:
     *   color: Array.isArray(pt.color) ? pt.color : [136,136,136]
     * A wrong format costs the colour, not an error. */
    const app = require("node:fs").readFileSync(
      require("node:path").join(process.cwd(), "public/app.js"),
      "utf8",
    );
    expect(app).toContain("Array.isArray(pt&&pt.color)?pt.color:[136,136,136]");
    expect(mesh().points.some((p) => typeof p.color === "string")).toBe(false);
  });

  it("iridescence takes hex, and still does — the two formats differ on purpose", () => {
    const iri = briefToDoc(
      {
        background: { kind: "solid", colors: ["#000000"] },
        elements: [
          { what: "orb", shape: "ellipse", x: 50, y: 50, w: 50, h: 50, material: "iridescent" },
        ],
      },
      800,
      1000,
      [
        ["#ff00aa", "#00e5ff", "#7b2cff"],
        ["#ffe100", "#22ff88", "#ff5500"],
        ["#0044ff", "#ff00ee", "#00ffcc"],
      ],
    ).doc.frame.children.find((c) => c.name === "orb").effects.iridescent;
    expect(typeof iri.colorCore).toBe("string");
    expect(iri.colorCore).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

/* 21 Sep 2026. The exact brief the model returned for one centred icon —
 * "rounded square, upper" and "rounded square, lower", each with its own dot
 * and its own "Morpho" — with the subject the pixels measured. The pixels say
 * there is ONE and where. The model keeps its say over what the thing is and
 * how it is arranged inside; it loses its say over how many and where. */
describe("one measured subject overrules a duplicated brief", () => {
  const { briefToDoc } = require("../server.js");
  const brief = () => ({
    background: { kind: "solid", colors: ["#ffffff"] },
    elements: [
      {
        what: "rounded square, upper",
        shape: "rect",
        x: 50,
        y: 25,
        w: 80,
        h: 80,
        color: "#4f6bff",
      },
      { what: "white dot, upper", shape: "ellipse", x: 50, y: 20, w: 15, h: 15, color: "#ffffff" },
      {
        what: "rounded square, lower",
        shape: "rect",
        x: 50,
        y: 75,
        w: 80,
        h: 80,
        color: "#4f6bff",
      },
      { what: "white dot, lower", shape: "ellipse", x: 50, y: 70, w: 15, h: 15, color: "#ffffff" },
    ],
    text: [
      { content: "Morpho", x: 50, y: 35, size: 8, color: "#ffffff", align: "center" },
      { content: "Morpho", x: 50, y: 85, size: 8, color: "#ffffff", align: "center" },
    ],
  });
  // a wide frame with a square icon in the middle, as measured off the pixels
  const subject = { count: 1, ground: "#ffffff", x: 37.5, y: 16.7, w: 25, h: 66.7, coverage: 0.97 };

  it("keeps one square, one dot and one Morpho", () => {
    const { doc, unsupported } = briefToDoc(brief(), 1600, 900, [], subject);
    const names = doc.frame.children.map((c) => c.name);
    expect(names.filter((n) => /rounded square/.test(n))).toHaveLength(1);
    expect(names.filter((n) => /white dot/.test(n))).toHaveLength(1);
    expect(doc.frame.children.filter((c) => c.type === "text")).toHaveLength(1);
    expect(unsupported.join(" | ")).toMatch(/dropped "rounded square/);
    expect(unsupported.join(" | ")).toMatch(/dropped repeated text/);
  });

  it("keeps the copy nearest the measured subject", () => {
    // the subject centre is at y 50: "lower" at y 75 is as far as "upper" at
    // y 25, so the box, not the name, decides — exactly one survives, and it
    // is fitted onto the measured box below. Move the subject up, and the
    // upper copy is the one kept.
    const high = { ...subject, y: 5, h: 45 };
    const { doc, unsupported } = briefToDoc(brief(), 1600, 900, [], high);
    const squares = doc.frame.children.filter((c) => /rounded square/.test(c.name));
    expect(squares).toHaveLength(1);
    expect(squares[0].name).toBe("rounded square, upper");
    expect(unsupported.join(" | ")).toMatch(/dropped "rounded square, lower"/);
  });

  it("keeps the parts of ONE copy together", () => {
    /* the squares are equidistant from the measured centre (y 25 and y 75
     * about 50); the dot and the word are not. Decided per part, the lower
     * square came through with the upper word, which then sat above it. */
    const { doc } = briefToDoc(brief(), 1600, 900, [], subject);
    const sq = doc.frame.children.find((c) => /rounded square/.test(c.name));
    const dot = doc.frame.children.find((c) => /white dot/.test(c.name));
    const word = doc.frame.children.find((c) => c.type === "text");
    const copy = /upper|lower/.exec(sq.name)[0];
    expect(dot.name).toContain(copy);
    // the word sits INSIDE the square, as it does in the brief
    expect(word.y).toBeGreaterThan(sq.y);
    expect(word.y).toBeLessThan(sq.y + sq.h);
    expect(dot.y).toBeGreaterThan(sq.y);
  });

  it("fits what survives onto the measured box, per axis", () => {
    // 1600 x 900 frame; the measured box is 37.5%,16.7% / 25% x 66.7% of it
    const { doc, unsupported } = briefToDoc(brief(), 1600, 900, [], subject);
    const items = doc.frame.children.slice(1);
    const ux = Math.min(...items.map((c) => c.x)),
      uy = Math.min(...items.map((c) => c.y));
    const vx = Math.max(...items.map((c) => c.x + (c.w || 0)));
    const vy = Math.max(...items.map((c) => c.y + (c.h || 0)));
    expect(ux).toBeCloseTo(600, 0);
    expect(uy).toBeCloseTo(150.3, 0);
    expect(vx).toBeCloseTo(1000, 0);
    expect(vy).toBeCloseTo(750.6, 0);
    // the square is no longer a wide 80% x 80% slab: it is as tall as the box says
    const sq = items.find((c) => /rounded square/.test(c.name));
    expect(sq.w).toBeLessThan(sq.h);
    expect(unsupported.join(" | ")).toMatch(/placed onto the measured subject box/);
  });

  it("gives the subject's rect the corner radius the pixels measured", () => {
    const { doc, unsupported } = briefToDoc(brief(), 1600, 900, [], { ...subject, radius: 22 });
    const sq = doc.frame.children.find((c) => /rounded square/.test(c.name));
    // 22% of the shorter side of the measured box (25% of 1600 = 400px)
    expect(sq.radius).toBeCloseTo(88, 0);
    // the small dot inside is not the subject and takes none
    const dot = doc.frame.children.find((c) => /white dot/.test(c.name));
    expect(dot.radius).toBeUndefined();
    expect(unsupported.join(" | ")).toMatch(/corner radius 22% measured/);
  });

  it("leaves a sharp subject sharp", () => {
    const { doc } = briefToDoc(brief(), 1600, 900, [], { ...subject, radius: 0 });
    const sq = doc.frame.children.find((c) => /rounded square/.test(c.name));
    expect(sq.radius).toBeUndefined();
  });

  it("tells the model a full-bleed subject fills the frame, corners and all", () => {
    const { measuredNotes } = require("../server.js");
    const full = measuredNotes({
      subject: { count: 1, ground: "transparent", x: 0, y: 0, w: 100, h: 100, radius: 20 },
    });
    expect(full).toMatch(
      /exactly ONE subject on a plain transparent ground, filling the whole frame/,
    );
    expect(full).toMatch(/corners rounded \(radius 20% of its shorter side\)/);
    const boxed = measuredNotes({ subject });
    expect(boxed).toMatch(/its box starting at 37.5%,16.7% and spanning 25% of the width/);
    expect(boxed).not.toMatch(/corners rounded/); // this fixture measured none
  });

  it("fits a full-bleed subject onto the whole frame", () => {
    const full = {
      count: 1,
      ground: "transparent",
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      radius: 20,
      coverage: 0.97,
    };
    const { doc } = briefToDoc(brief(), 1000, 1000, [], full);
    const sq = doc.frame.children.find((c) => /rounded square/.test(c.name));
    expect(sq.x).toBeCloseTo(0, 0);
    expect(sq.y).toBeCloseTo(0, 0);
    expect(sq.w).toBeCloseTo(1000, 0);
    expect(sq.h).toBeCloseTo(1000, 0);
    expect(sq.radius).toBeCloseTo(200, 0);
  });

  it("changes nothing when the pixels did not measure one subject", () => {
    // 994.jpg is a legitimate stack of discs: two copies are two copies
    const none = { count: 0, ground: "#ffffff" };
    const { doc, unsupported } = briefToDoc(brief(), 1600, 900, [], none);
    expect(doc.frame.children.filter((c) => /rounded square/.test(c.name))).toHaveLength(2);
    expect(doc.frame.children.filter((c) => c.type === "text")).toHaveLength(2);
    expect(unsupported.join(" | ")).not.toMatch(/dropped/);
    // and with no subject at all, the old behaviour exactly
    expect(briefToDoc(brief(), 1600, 900, []).doc.frame.children).toHaveLength(7);
  });
});
