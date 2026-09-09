// @vitest-environment jsdom
/**
 * The mesh tool inside the Pattern Studio: the editor's own net document,
 * handles on the card, the image fit and the prompt.
 *
 * The REAL public/meshgradient.js is loaded for its plain-JS half —
 * defaultPoints, resample, sampleCurve, NODE_FX, PALETTE — so resizing and
 * curves are the editor's. Its WebGL render and the fitter are stubbed and
 * recorded. The other engines are minimal stubs so the registry boots.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { makeCtxStub } from "./helpers/load-editor.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");

const fake = { width: 8, height: 8 };
const renders = [];
const fits = [];
let fitErrorValue = 8.4;
let ctx, real;

function fittedNet(cols, rows) {
  const out = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      out.push({ x: c / (cols - 1), y: r / (rows - 1), color: [10 * (r * cols + c), 20, 30] });
  return out;
}

function loadStudio() {
  const html = fs.readFileSync(path.join(ROOT, "public", "studio.html"), "utf8");
  document.body.innerHTML = html
    .replace(/[\s\S]*<body>/, "")
    .replace(/<\/body>[\s\S]*/, "")
    .replace(/<script[^>]*><\/script>/g, "");

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
  window.requestAnimationFrame = () => 0;

  window.eval(fs.readFileSync(path.join(ROOT, "public", "meshgradient.js"), "utf8"));
  real = window.MeshGradient;
  window.MeshGradient = /** @type {any} */ (
    Object.assign({}, real, {
      available: () => true,
      render: vi.fn((...a) => {
        renders.push(a);
        return fake;
      }),
      fitToImage: vi.fn((img, cols, rows, opts) => {
        fits.push({ cols, rows, opts });
        return fittedNet(cols, rows);
      }),
      fitError: vi.fn(() => fitErrorValue),
    })
  );
  const stub = { render: () => fake, available: () => true };
  window.LiquidEngine = Object.assign({ WARPS: ["none", "liquid"], MAX: 8, SLOTS: 3 }, stub);
  window.FlareEngine = Object.assign({ PRESETS: ["reference"], PALETTES: ["Prism"] }, stub);
  window.LightEngine = Object.assign({ MODES: [{ id: 0, label: "Single" }] }, stub);
  window.FractalGlassEngine = Object.assign(
    { PRESETS: ["repeat"], presetValues: () => null },
    stub,
  );
  window.GradientEngine = /** @type {any} */ (stub);
  window.fetch = /** @type {any} */ (vi.fn(() => Promise.reject(new Error("no network in tests"))));

  window.localStorage.clear();
  window.eval(fs.readFileSync(path.join(ROOT, "public", "picker.js"), "utf8"));
  window.eval(fs.readFileSync(path.join(ROOT, "public", "studio.js"), "utf8"));
  return window.__studio;
}

let S;
const q = (s) => document.querySelector(s);
const qa = (s) => Array.from(document.querySelectorAll(s));
const fire = (el, type) => el.dispatchEvent(new window.Event(type, { bubbles: true }));
const rowByLabel = (label) =>
  qa("#controls .row").find((r) => r.querySelector(".name").textContent === label);
/** Open a colour row's picker, type a hex, commit, close — what a person does. */
const setColour = (row, hex) => {
  row.querySelector(".ui-cswatch").click();
  const inp = document.querySelector(".ui-picker-hex");
  inp.value = hex;
  fire(inp, "input");
  fire(inp, "change");
  window.UIPicker.close();
};
const groupText = (title) =>
  qa("#controls .grp").find((g) => g.querySelector("summary").textContent === title).textContent;
const pointer = (type, x, y) =>
  q("#stage").dispatchEvent(
    new window.MouseEvent(type, { clientX: x, clientY: y, bubbles: true, button: 0 }),
  );
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

beforeAll(() => {
  S = loadStudio();
  // A fixed on-screen size for the stage: 300x375 css px for the 4:5 poster.
  /** @type {any} */ (q("#stage")).getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 300,
    height: 375,
  });
});
beforeEach(() => {
  renders.length = 0;
  fits.length = 0;
  ctx.calls.length = 0;
});

describe("the mesh document is the editor's", () => {
  it("Soft net is an even 3x3 net in the engine's default palette, no one-shot keys left", () => {
    S.applyLook("softnet");
    const p = S.state.params;
    expect(p.cols).toBe(3);
    expect(p.rows).toBe(3);
    expect(p.points).toHaveLength(9);
    expect([p.points[4].x, p.points[4].y]).toEqual([0.5, 0.5]);
    expect(p.points[4].color).toEqual(rgb(real.PALETTE[4]));
    expect("palette" in p || "scatter" in p || "nodeFx" in p).toBe(false);
  });

  it("Chroma scatters interior points once, deterministically, and writes its channels", () => {
    S.applyLook("chroma");
    const a = JSON.parse(JSON.stringify(S.state.params));
    S.applyLook("chroma");
    expect(S.state.params).toEqual(a);
    expect(a.points).toHaveLength(16);
    expect([a.points[0].x, a.points[0].y]).toEqual([0, 0]);
    expect([a.points[15].x, a.points[15].y]).toEqual([1, 1]);
    for (let c = 0; c < 4; c++) expect(a.points[c].y).toBe(0);
    for (let r = 0; r < 4; r++) expect(a.points[r * 4].x).toBe(0);
    expect(a.points[5].x).not.toBeCloseTo(1 / 3, 3);
    a.points.forEach((pt) => expect(pt.chromatic).toBe(0.5));
    expect("scatter" in a || "nodeFx" in a).toBe(false);
  });

  it("render hands the engine the stored net plus the feather in tile pixels", () => {
    S.applyLook("softnet");
    S.drawNow();
    const [w, h, P] = renders[renders.length - 1];
    expect(P.cols).toBe(3);
    expect(P.points).toHaveLength(9);
    expect(P.inWidth).toBe(0);
    expect(P.scale).toBeGreaterThan(0);
    S.setParam("edge", 0.5);
    S.drawNow();
    const P2 = renders[renders.length - 1][2];
    expect(P2.inWidth).toBeCloseTo(0.25 * Math.min(w, h), 6);
    expect(P2.softness).toBe(1);
  });

  it("changing columns resamples the surface, so a corner keeps its colour", () => {
    S.applyLook("softnet");
    S.setParam("points.0.color", [255, 0, 0]);
    const inp = rowByLabel("Columns").querySelector("input");
    inp.value = "5";
    fire(inp, "input");
    fire(inp, "change");
    const p = S.state.params;
    expect(p.cols).toBe(5);
    expect(p.points).toHaveLength(15);
    expect(p.points[0].color).toEqual([255, 0, 0]);
    expect(groupText("Net")).toMatch(/15 handles/);
  });

  it("drift renders an offset copy and never edits the stored net", () => {
    S.applyLook("softnet");
    S.setParam("drift", 0.2);
    S.setParam("phase", 1);
    S.drawNow();
    const P = renders[renders.length - 1][2];
    const stored = S.state.params.points;
    expect(P.points[4].x).not.toBe(stored[4].x);
    expect([P.points[0].x, P.points[0].y]).toEqual([0, 0]);
    expect([stored[4].x, stored[4].y]).toEqual([0.5, 0.5]);
  });

  it("a theme colours the nodes in order, cycling", () => {
    S.applyLook("softnet");
    S.applyTheme("ember");
    const t = S.THEMES.find((x) => x.id === "ember").colors;
    expect(S.ENGINES.mesh.colors.get(S.state.params)).toEqual(t.concat(t.slice(0, 4)));
  });
});

describe("handles on the card", () => {
  it("the stage draws one handle per point; an export never does", () => {
    S.applyLook("softnet");
    S.setCard("poster");
    ctx.calls.length = 0;
    S.drawNow();
    expect(ctx.calls.filter((c) => c.name === "arc")).toHaveLength(9);
    S.setParam("showNet", false);
    ctx.calls.length = 0;
    S.drawNow();
    expect(ctx.calls.filter((c) => c.name === "arc")).toHaveLength(0);
    S.setParam("showNet", true);
    return S.exportCard("poster", 1).then(() => {
      // the export ran through the same stub after the last reset above
      expect(ctx.calls.filter((c) => c.name === "arc")).toHaveLength(0);
    });
  });

  it("pointer down on a handle selects it, a drag moves it, release commits once", () => {
    S.applyLook("softnet");
    S.setCard("poster");
    // The centre point of a 3x3 net on the 300x375 stage sits at (150, 187.5).
    pointer("pointerdown", 150, 187.5);
    expect(S.ui.meshSel).toBe(4);
    expect(groupText("Selected point")).toMatch(/Point 5 of 9/);
    pointer("pointermove", 180, 187.5);
    expect(S.state.params.points[4].x).toBeCloseTo(0.6, 6);
    expect(S.state.params.points[4].y).toBeCloseTo(0.5, 6);
    S.undo(); // nothing committed yet: undo must not have a drag step to pop
    expect(S.state.params.points[4].x).not.toBeCloseTo(0.6, 6);
    S.redo();
    pointer("pointerdown", 150, 187.5);
    pointer("pointermove", 180, 187.5);
    pointer("pointerup", 180, 187.5);
    expect(S.state.params.points[4].x).toBeCloseTo(0.6, 6);
    S.undo();
    expect(S.state.params.points[4].x).toBeCloseTo(0.5, 6);
    S.redo();
    expect(S.state.params.points[4].x).toBeCloseTo(0.6, 6);
  });

  it("a press away from every handle changes nothing", () => {
    S.applyLook("softnet");
    S.ui.meshSel = null;
    pointer("pointerdown", 40, 100);
    pointer("pointerup", 40, 100);
    expect(S.ui.meshSel).toBeNull();
  });

  it("the selected point's colour control writes [r,g,b] and releases the theme", () => {
    S.applyLook("softnet");
    S.applyTheme("ember");
    pointer("pointerdown", 150, 187.5);
    pointer("pointerup", 150, 187.5);
    setColour(rowByLabel("Colour"), "#ff0000");
    expect(S.state.params.points[4].color).toEqual([255, 0, 0]);
    expect(S.state.theme).toBeNull();
  });
});

describe("Match an image", () => {
  const img = { src: "blob:ref", naturalWidth: 10, naturalHeight: 10 };

  it("fits the current net with the editor's fitter and reports the measured error", async () => {
    S.applyLook("softnet");
    fitErrorValue = 8.4;
    const err = await S.matchImage(img);
    expect(err).toBe(8.4);
    expect(fits).toEqual([{ cols: 3, rows: 3, opts: { moveGeometry: true } }]);
    expect(S.state.params.points[8].color).toEqual([80, 20, 30]);
    expect(S.ui.fitNote).toMatch(/8\.4\/255 \(close\)/);
    expect(S.ui.refImage.img).toBe(img);
    expect(S.state.look).toBeNull();
    expect(q("#controls img.refThumb")).toBeTruthy();
  });

  it("honours the geometry toggle and grades a poor fit honestly", async () => {
    S.ui.fitGeo = false;
    fitErrorValue = 40;
    await S.matchImage(img);
    expect(fits[fits.length - 1].opts).toEqual({ moveGeometry: false });
    expect(S.ui.fitNote).toMatch(/far off/);
    S.ui.fitGeo = true;
  });

  it("does nothing on another engine", async () => {
    S.switchEngine("liquid");
    expect(await S.matchImage(img)).toBeNull();
    expect(fits).toHaveLength(0);
  });
});

describe("AI generate", () => {
  const nine = fittedNet(3, 3);
  let lastFetch = null;
  const reply = (body, ok = true, status = 200) => {
    window.fetch = /** @type {any} */ (
      vi.fn((url, init) => {
        lastFetch = { url, init };
        return Promise.resolve({ ok, status, json: async () => body });
      })
    );
  };

  it("takes the first mesh in the reply, walking groups, and names the model", async () => {
    S.switchEngine("mesh");
    S.ui.aiAvailable = true;
    reply({
      doc: {
        frame: {
          children: [
            { type: "text", text: "x" },
            {
              type: "group",
              children: [
                { type: "rect", effects: { mesh: { on: true, cols: 3, rows: 3, points: nine } } },
              ],
            },
          ],
        },
      },
      model: "mock-model",
    });
    const mesh = await S.generateMesh("dusk over the sea");
    expect(mesh.cols).toBe(3);
    expect(S.state.params.points[8].color).toEqual([80, 20, 30]);
    expect(S.ui.aiNote).toMatch(/mock-model.*3×3/);
    const sent = JSON.parse(lastFetch.init.body);
    expect(sent.prompt).toMatch(/dusk over the sea/);
    expect(sent.prompt).toMatch(/mesh/);
  });

  it("skips a mesh with the wrong point count, uses a default net when points are omitted", () => {
    const wrong = {
      frame: {
        children: [{ effects: { mesh: { on: true, cols: 3, rows: 3, points: nine.slice(0, 5) } } }],
      },
    };
    expect(S.firstMesh(wrong)).toBeNull();
    const omitted = {
      frame: { children: [{ effects: { mesh: { on: true, cols: 4, rows: 2 } } }] },
    };
    const m = S.firstMesh(omitted);
    expect(m.cols).toBe(4);
    expect(m.points).toHaveLength(8);
    expect(
      S.firstMesh({
        frame: {
          children: [
            { fx: [{ type: "mesh", params: { cols: 2, rows: 2, points: fittedNet(2, 2) } }] },
          ],
        },
      }).points,
    ).toHaveLength(4);
  });

  it("a reply without a mesh, a provider error and a missing key all become notes", async () => {
    reply({ doc: { frame: { children: [{ type: "rect" }] } } });
    expect(await S.generateMesh("plain")).toBeNull();
    expect(S.ui.aiNote).toMatch(/no mesh/);
    reply({ error: "bad key", code: "NO_KEY" }, false, 401);
    expect(await S.generateMesh("plain")).toBeNull();
    expect(S.ui.aiNote).toMatch(/not configured/);
    window.fetch = /** @type {any} */ (vi.fn(() => Promise.reject(new Error("offline"))));
    expect(await S.generateMesh("plain")).toBeNull();
    expect(S.ui.aiNote).toMatch(/Generation failed: offline/);
  });

  it("an empty prompt sends nothing", async () => {
    const spy = vi.fn();
    window.fetch = /** @type {any} */ (spy);
    expect(await S.generateMesh("   ")).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("shape", () => {
  it("clips the pattern to the chosen outline and keeps the choice in the snapshot", () => {
    S.applyLook("softnet");
    S.setShape("ellipse");
    ctx.calls.length = 0;
    S.drawNow();
    const names = ctx.calls.map((c) => c.name);
    expect(names.indexOf("ellipse")).toBeGreaterThan(-1);
    expect(names.indexOf("ellipse")).toBeLessThan(names.indexOf("clip"));
    expect(names.indexOf("clip")).toBeLessThan(names.indexOf("drawImage"));
    expect(S.snapshot().shape).toBe("ellipse");
    S.setShape("nope");
    expect(S.state.shape).toBe("rect");
    expect(q("#shapeSelect").value).toBe("rect");
  });
});
