// @vitest-environment jsdom
/**
 * Characterization tests for the Pattern Studio (public/studio.js).
 *
 * The real studio.js runs in jsdom against STUB engines: every engine's
 * render() records its arguments and returns a placeholder image. What is
 * pinned here is the studio's own logic — schema-driven controls, theme
 * mapping onto colour slots, undo/redo, presets, motion stepping, card
 * geometry and the mesh net derivation. Pixels are verified in the browser.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { makeCtxStub } from "./helpers/load-editor.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");

/** Recorded engine calls, newest last. */
const calls = { mesh: [], liquid: [], flare: [], light: [], fractal: [], stripes: [] };
const fake = { width: 8, height: 8 };

function installEngines() {
  const rec = (k) =>
    vi.fn((...args) => {
      calls[k].push(args);
      return fake;
    });
  window.LiquidEngine = {
    render: rec("liquid"),
    available: () => true,
    WARPS: ["none", "liquid", "curl", "marble", "wave"],
    MAX: 8,
    SLOTS: 3,
  };
  // Stubs carry only what the studio calls; cast past the editor's fuller shapes.
  window.MeshGradient = /** @type {any} */ ({ render: rec("mesh"), available: () => true });
  window.FlareEngine = {
    render: rec("flare"),
    available: () => true,
    PRESETS: ["reference", "burst", "blades"],
    PALETTES: [
      "Prism (physical)",
      "Rainbow",
      "Duotone",
      "Sunset",
      "Ice",
      "Neon",
      "Ember",
      "Aurora",
    ],
  };
  window.LightEngine = {
    render: rec("light"),
    available: () => true,
    MODES: [
      { id: 0, label: "Single" },
      { id: 33, label: "Star 8" },
    ],
  };
  window.FractalGlassEngine = {
    render: rec("fractal"),
    available: () => true,
    PRESETS: ["repeat", "lens", "even", "spiky"],
    presetValues: (k) =>
      ({ lens: { hMax: 0.86, hMin: 0.15, hShape: 1.45, fade: 0.035 } })[k] || null,
  };
  window.GradientEngine = /** @type {any} */ ({ render: rec("stripes"), available: () => true });
}

let ctx;
function loadStudio() {
  const html = fs.readFileSync(path.join(ROOT, "public", "studio.html"), "utf8");
  const body = html
    .replace(/[\s\S]*<body>/, "")
    .replace(/<\/body>[\s\S]*/, "")
    .replace(/<script[^>]*><\/script>/g, "");
  document.body.innerHTML = body;

  ctx = makeCtxStub();
  ctx.measureText = (t) => ({ width: String(t).length * 10 });
  if (!ctx.createLinearGradient) ctx.createLinearGradient = () => ({ addColorStop() {} });
  window.HTMLCanvasElement.prototype.getContext = /** @type {any} */ (
    function () {
      ctx.canvas = this;
      return ctx;
    }
  );
  window.HTMLCanvasElement.prototype.toBlob = function (cb) {
    cb(new window.Blob([new Uint8Array(this.width * this.height)], { type: "image/png" }));
  };
  if (!window.URL.createObjectURL) window.URL.createObjectURL = () => "blob:stub";
  if (!window.URL.revokeObjectURL) window.URL.revokeObjectURL = () => {};
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // No frame loop in tests: motion is stepped explicitly through __studio.step.
  window.requestAnimationFrame = () => 0;

  installEngines();
  window.localStorage.clear();
  window.eval(fs.readFileSync(path.join(ROOT, "public", "studio.js"), "utf8"));
  if (!window.__studio) throw new Error("studio.js did not expose window.__studio");
  return window.__studio;
}

let S;
const q = (s) => document.querySelector(s);
const qa = (s) => Array.from(document.querySelectorAll(s));
const fire = (el, type) => el.dispatchEvent(new window.Event(type, { bubbles: true }));
const rowByLabel = (label) =>
  qa("#controls .row").find((r) => r.querySelector(".name").textContent === label);

beforeAll(() => {
  S = loadStudio();
});
beforeEach(() => {
  Object.keys(calls).forEach((k) => (calls[k].length = 0));
  ctx.calls.length = 0;
});

describe("boot", () => {
  it("starts on the liquid engine with the Flow look and a poster card", () => {
    expect(S.state.engine).toBe("liquid");
    expect(S.state.look).toBe("flow");
    expect(S.state.card).toBe("poster");
    expect(S.state.theme).toBeNull();
  });

  it("lists every engine in the engine select, and every look as a tile", () => {
    expect(qa("#engineSelect option").map((o) => o.value)).toEqual(Object.keys(S.ENGINES));
    expect(qa("#templates .tile")).toHaveLength(S.LOOKS.length);
    expect(qa("#themes .theme")).toHaveLength(S.THEMES.length);
    expect(qa("#cardSelect option")).toHaveLength(S.CARDS.length);
  });

  it("builds one control per schema row, plus the studio's own speed slider", () => {
    const rows = S.ENGINES.liquid.schema(S.state.params).flatMap((g) => g.controls);
    const ranges = rows.filter((c) => c.kind === "range").length;
    expect(qa("#controls input[type=range]")).toHaveLength(ranges + 1);
    expect(qa("#controls input[type=color]")).toHaveLength(
      rows.filter((c) => c.kind === "color").length,
    );
    expect(qa("#controls select")).toHaveLength(rows.filter((c) => c.kind === "select").length);
  });

  it("every look names an engine that exists and only overrides keys the engine has", () => {
    S.LOOKS.forEach((l) => {
      const eng = S.ENGINES[l.engine];
      expect(eng, l.id).toBeDefined();
      const d = eng.defaults();
      Object.keys(l.params).forEach((k) => expect(k in d, `${l.id}.${k}`).toBe(true));
    });
  });
});

describe("controls drive params through real input events", () => {
  it("a range input writes its key on `input` and commits on `change`", () => {
    S.applyLook("flow");
    const inp = rowByLabel("Softness").querySelector("input");
    inp.value = "4.5";
    fire(inp, "input");
    expect(S.state.params.power).toBe(4.5);
    expect(rowByLabel("Softness").querySelector(".val").textContent).toBe("4.5");
    fire(inp, "change");
    expect(q("#undoBtn").disabled).toBe(false);
  });

  it("Points rebuilds the panel so the colour rows follow the count", () => {
    const inp = rowByLabel("Points").querySelector("input");
    inp.value = "3";
    fire(inp, "input");
    fire(inp, "change");
    expect(qa("#controls input[type=color]")).toHaveLength(3);
  });

  it("a select with an apply() merges the preset and keeps the choice", () => {
    S.switchEngine("fractal");
    const sel = rowByLabel("Profile").querySelector("select");
    sel.value = "lens";
    fire(sel, "change");
    expect(S.state.params.profile).toBe("lens");
    expect(S.state.params.hMax).toBe(0.86);
    expect(S.state.params.hMin).toBe(0.15);
  });

  it("numeric selects store numbers, not strings", () => {
    S.switchEngine("light");
    const sel = rowByLabel("Figure").querySelector("select");
    sel.value = "33";
    fire(sel, "change");
    expect(S.state.params.mode).toBe(33);
  });

  it("a toggle writes a boolean", () => {
    S.switchEngine("stripes");
    const box = rowByLabel("Bounce").querySelector("input");
    box.checked = true;
    fire(box, "change");
    expect(S.state.params.bounce).toBe(true);
  });
});

describe("themes map onto each engine's colour slots in order", () => {
  const ember = ["#ff5a2d", "#ff0a6c", "#ffb347", "#1636d4", "#fff4ec"];
  const cases = {
    liquid: ember, // 5 points -> 5 colours
    mesh: ember.concat(ember[0]), // 6 slots cycle
    flare: ember.slice(0, 2),
    light: ember.slice(0, 3),
    fractal: ember.slice(0, 4),
    stripes: ember.slice(0, 3).concat(ember[2], ember[3], ember[4]), // ramp 2 starts two colours along
  };
  Object.entries(cases).forEach(([id, expected]) => {
    it(id, () => {
      S.switchEngine(id);
      S.applyTheme("ember");
      expect(S.state.theme).toBe("ember");
      expect(S.ENGINES[id].colors.get(S.state.params)).toEqual(expected);
    });
  });

  it("engines that paint their own ground take the theme background", () => {
    S.switchEngine("flare");
    S.applyTheme("ocean");
    expect(S.state.params.bg).toBe("#05070f");
    S.switchEngine("light");
    S.applyTheme("ocean");
    expect(S.state.params.deep).toBe("#05070f");
    expect(S.state.params.bg).toBe("#05070f");
  });

  it("editing a colour by hand releases the theme", () => {
    S.switchEngine("liquid");
    S.applyTheme("ember");
    const inp = rowByLabel("Colour 1").querySelector("input");
    inp.value = "#123456";
    fire(inp, "input");
    fire(inp, "change");
    expect(S.state.params.cols[0]).toBe("#123456");
    expect(S.state.theme).toBeNull();
  });

  it("a theme survives a look change, and a look change keeps the engine's other params", () => {
    S.applyTheme("ember");
    S.applyLook("marble");
    expect(S.state.theme).toBe("ember");
    expect(S.state.params.cols.slice(0, 5)).toEqual(ember);
    expect(S.state.params.contrast).toBe(2.2);
  });
});

describe("undo / redo", () => {
  it("round-trips a slider edit", () => {
    S.applyLook("flow");
    const before = S.state.params.power;
    const inp = rowByLabel("Softness").querySelector("input");
    inp.value = "5";
    fire(inp, "input");
    fire(inp, "change");
    S.undo();
    expect(S.state.params.power).toBe(before);
    S.redo();
    expect(S.state.params.power).toBe(5);
  });

  it("undo across an engine switch restores the previous engine and its panel", () => {
    S.applyLook("flow");
    S.switchEngine("mesh");
    expect(q("#engineName").textContent).toBe("Mesh gradient");
    S.undo();
    expect(S.state.engine).toBe("liquid");
    expect(q("#engineName").textContent).toBe("Liquid gradient");
    expect(rowByLabel("Softness")).toBeTruthy();
  });

  it("a new edit clears the redo stack", () => {
    S.applyLook("flow");
    S.switchEngine("mesh");
    S.undo();
    expect(q("#redoBtn").disabled).toBe(false);
    S.switchEngine("flare");
    expect(q("#redoBtn").disabled).toBe(true);
  });

  it("reset returns the current look's params but keeps the theme", () => {
    S.applyLook("marble");
    S.applyTheme("ember");
    S.setParam("contrast", 7);
    S.resetParams();
    expect(S.state.params.contrast).toBe(2.2);
    expect(S.state.theme).toBe("ember");
    expect(S.state.params.cols[0]).toBe("#ff5a2d");
  });
});

describe("presets and autosave", () => {
  it("Save stores the snapshot under the typed name, and loading it restores engine + params", () => {
    S.switchEngine("flare");
    S.setParam("pan", 77);
    q("#presetName").value = "Sunrise";
    q("#savePreset").click();
    const stored = JSON.parse(window.localStorage.getItem("studio.presets.v1"));
    expect(stored.map((p) => p.name)).toEqual(["Sunrise"]);
    expect(stored[0].engine).toBe("flare");
    expect(stored[0].params.pan).toBe(77);

    S.switchEngine("liquid");
    q("#presetList .load").click();
    expect(S.state.engine).toBe("flare");
    expect(S.state.params.pan).toBe(77);
  });

  it("saving the same name again overwrites rather than duplicating", () => {
    S.setParam("pan", 12);
    q("#presetName").value = "Sunrise";
    q("#savePreset").click();
    const stored = JSON.parse(window.localStorage.getItem("studio.presets.v1"));
    expect(stored).toHaveLength(1);
    expect(stored[0].params.pan).toBe(12);
  });

  it("the delete button removes a preset", () => {
    q("#presetList .del").click();
    expect(JSON.parse(window.localStorage.getItem("studio.presets.v1"))).toEqual([]);
    expect(q("#presetList").textContent).toMatch(/Nothing saved yet/);
  });

  it("an empty name does not save", () => {
    q("#presetName").value = "   ";
    q("#savePreset").click();
    expect(JSON.parse(window.localStorage.getItem("studio.presets.v1"))).toEqual([]);
  });

  it("every commit autosaves the whole snapshot", () => {
    S.switchEngine("mesh");
    const saved = JSON.parse(window.localStorage.getItem("studio.state.v1"));
    expect(saved.engine).toBe("mesh");
    expect(saved.card).toBe(S.state.card);
    expect(saved.copy.headline).toBe(S.state.copy.headline);
  });
});

describe("motion steps the engine's clock param", () => {
  it("advances by rate × speed × dt", () => {
    S.applyLook("flow");
    S.state.speed = 2;
    expect(S.step(1)).toBe(true);
    expect(S.state.params.phase).toBeCloseTo(0.7, 6);
    S.state.speed = 1;
  });

  it("wraps inside [min, max] for wrapping engines", () => {
    S.switchEngine("mesh");
    for (let i = 0; i < 100; i++) S.step(0.5);
    expect(S.state.params.phase).toBeGreaterThanOrEqual(0);
    expect(S.state.params.phase).toBeLessThan(Math.PI * 2);
    S.switchEngine("flare");
    for (let i = 0; i < 100; i++) S.step(1);
    expect(S.state.params.pan).toBeGreaterThanOrEqual(-180);
    expect(S.state.params.pan).toBeLessThanOrEqual(180);
  });

  it("a non-wrapping engine falls back to its floor past the ceiling", () => {
    S.applyLook("flow");
    S.setParam("phase", 19.9);
    S.step(1);
    expect(S.state.params.phase).toBe(0);
  });

  it("does nothing for a zero or negative dt", () => {
    const before = S.state.params.phase;
    expect(S.step(0)).toBe(false);
    expect(S.step(-1)).toBe(false);
    expect(S.state.params.phase).toBe(before);
  });
});

describe("cards", () => {
  it("every card has a positive native size and a pattern rect inside the unit square", () => {
    S.CARDS.forEach((c) => {
      expect(c.w, c.id).toBeGreaterThan(0);
      expect(c.h, c.id).toBeGreaterThan(0);
      const p = c.pattern;
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.x + p.w).toBeLessThanOrEqual(1.0001);
      expect(p.y + p.h).toBeLessThanOrEqual(1.0001);
    });
  });

  it("drawing a card paints the ground, one pattern image, then the copy", () => {
    S.applyLook("flow");
    S.CARDS.forEach((c) => {
      S.setCard(c.id);
      ctx.calls.length = 0;
      calls.liquid.length = 0;
      S.drawNow();
      const names = ctx.calls.map((k) => k.name);
      expect(
        names.filter((n) => n === "drawImage"),
        c.id,
      ).toHaveLength(1);
      expect(names.indexOf("fillRect"), c.id).toBeLessThan(names.indexOf("drawImage"));
      expect(calls.liquid, c.id).toHaveLength(1);
      if (c.id === "off") expect(names.filter((n) => n === "fillText")).toHaveLength(0);
      else expect(names.filter((n) => n === "fillText").length, c.id).toBeGreaterThan(0);
    });
  });

  it("the pattern is rendered at the card's pattern rect, at backing resolution", () => {
    S.setCard("stat"); // right half only
    S.drawNow();
    const [w, h] = calls.liquid[0];
    const stage = q("#stage");
    expect(w).toBe(Math.round(stage.width * 0.5));
    expect(h).toBe(stage.height);
  });

  it("hiding the UI drops the copy but keeps the pattern", () => {
    S.setCard("poster");
    S.state.showUI = false;
    ctx.calls.length = 0;
    S.drawNow();
    const names = ctx.calls.map((k) => k.name);
    expect(names.filter((n) => n === "fillText")).toHaveLength(0);
    expect(names.filter((n) => n === "drawImage")).toHaveLength(1);
    S.state.showUI = true;
  });

  it("export renders at native size × multiplier and yields a PNG blob", async () => {
    const blob = await S.exportCard("hero", 2);
    expect(blob.type).toBe("image/png");
    expect(blob.size).toBe(3200 * 1800);
  });
});

describe("mesh net derivation", () => {
  it("passes cols×rows normalised points, corners pinned, edges on their edge", () => {
    S.applyLook("chroma"); // 4x4, jitter .4
    S.drawNow();
    const P = calls.mesh[0][2];
    expect(P.cols).toBe(4);
    expect(P.rows).toBe(4);
    expect(P.points).toHaveLength(16);
    P.points.forEach((p) => {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(1);
      expect(p.color).toHaveLength(3);
    });
    expect([P.points[0].x, P.points[0].y]).toEqual([0, 0]);
    expect([P.points[15].x, P.points[15].y]).toEqual([1, 1]);
    // top edge stays on y=0, left edge on x=0
    for (let c = 0; c < 4; c++) expect(P.points[c].y).toBe(0);
    for (let r = 0; r < 4; r++) expect(P.points[r * 4].x).toBe(0);
  });

  it("jitter 0 is a uniform grid regardless of seed", () => {
    S.setParam("jitter", 0);
    S.setParam("seed", 55);
    S.drawNow();
    const P = calls.mesh[0][2];
    expect(P.points[5].x).toBeCloseTo(1 / 3, 9);
    expect(P.points[5].y).toBeCloseTo(1 / 3, 9);
  });

  it("carries the surface channels onto every point", () => {
    S.setParam("metallic", 0.7);
    S.setParam("glow", 0.2);
    S.drawNow();
    const P = calls.mesh[0][2];
    P.points.forEach((p) => {
      expect(p.metallic).toBe(0.7);
      expect(p.glow).toBe(0.2);
    });
  });
});

describe("restore guards", () => {
  it("falls back for unknown engine, card and theme ids", () => {
    window.localStorage.setItem(
      "studio.presets.v1",
      JSON.stringify([
        { name: "Broken", engine: "nope", params: {}, card: "nope", theme: "nope", look: "nope" },
      ]),
    );
    // Re-render the list from storage, then load the entry.
    q("#presetName").value = "tmp";
    q("#savePreset").click();
    qa("#presetList .load")[0].click();
    expect(S.state.engine).toBe("liquid");
    expect(S.state.card).toBe(S.CARDS[0].id);
    expect(S.state.theme).toBeNull();
    expect(S.state.look).toBeNull();
    window.localStorage.removeItem("studio.presets.v1");
  });
});
