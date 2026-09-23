// @vitest-environment node
/**
 * One registry for an effect's product facts.
 *
 * Until 23 Sep 2026 an effect had to be declared on eight surfaces — the
 * stack registry, its order list, its READY gate, the catalog, the Effects
 * menu written by hand in index.html, and three maps in app.js (icon,
 * inspector page, opening values) — and they drifted: iridescence was
 * ordered and never ready, glass was ready and never in the menu. Now the
 * menu, the gate and the three maps derive from the catalog entry.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(here, "..", "public", f), "utf8");

/** fxstack alone, or fxstack then the catalog, on a bare window. */
const boot = (withCatalog, fxOnly) => {
  const win = { FX_ONLY: fxOnly };
  new Function("window", read("fxstack.js"))(win);
  if (withCatalog) new Function("window", read("engine-catalog.js"))(win);
  return win;
};

describe("the gate derives from the catalog", () => {
  it("starts empty, and only the catalog fills it", () => {
    expect(boot(false).FxStack.READY.size).toBe(0);
    const win = boot(true);
    const readyTypes = win.EngineCatalog.CATALOG.filter(
      (e) => e.rendererType && e.status === "ready",
    ).map((e) => e.rendererType);
    expect([...win.FxStack.READY].sort()).toEqual([...new Set(readyTypes)].sort());
    expect(win.FxStack.READY.size).toBe(22);
  });

  it("promote() takes only registered types the page has not narrowed away", () => {
    const win = boot(false, ["mesh"]);
    expect(win.FxStack.promote("nonsense")).toBe(false);
    expect(win.FxStack.promote("reed")).toBe(false); // narrowed away by FX_ONLY
    expect(win.FxStack.promote("mesh")).toBe(true);
    expect([...win.FxStack.READY]).toEqual(["mesh"]);
  });

  it("the page's own narrowing shows in the derived gate exactly as before", () => {
    const index = read("index.html");
    const only = JSON.parse(/window\.FX_ONLY = (\[[^\]]*\])/.exec(index)[1]);
    const win = boot(true, only);
    expect([...win.FxStack.READY].sort()).toEqual(only.slice().sort());
  });
});

describe("the catalog carries what the app used to map by hand", () => {
  const win = boot(true);
  const C = win.EngineCatalog;
  it("every ready capability has an icon and an inspector page", () => {
    for (const e of C.CATALOG.filter((x) => x.status === "ready")) {
      expect(typeof e.icon, e.id).toBe("string");
      expect(typeof e.page, e.id).toBe("string");
    }
  });
  it("opening values, by renderer type, as a copy", () => {
    expect(C.opening("innerShadow")).toEqual({ on: true, blur: 12, alpha: 0.35 });
    expect(C.opening("blur")).toEqual({ kind: "gaussian", radius: 10 });
    expect(C.opening("glass")).toEqual({ on: true, mode: "backdrop" });
    const a = C.opening("grain");
    a.amount = 9;
    expect(C.opening("grain").amount).toBe(0.35);
    expect(C.opening("nonsense")).toBeNull();
  });
  it("the menu: four groups in the catalog's order, ready entries only", () => {
    const m = C.menu();
    expect(m.map((g) => g.label)).toEqual(["Fills", "Effects", "Structure", "Filters"]);
    expect(m.map((g) => g.items.map((i) => i.id))).toEqual([
      [
        "imageFill",
        "linearGradient",
        "mesh",
        "iridescent",
        "glass",
        "reed",
        "fractal",
        "divider",
        "beam",
      ],
      [
        "shadow",
        "innerShadow",
        "glow",
        "bloom",
        "backgroundBlur",
        "blur",
        "grain",
        "noise",
        "distortion",
        "warp",
        "displacement",
      ],
      ["symmetry", "echo"],
      ["colorAdjust", "colorMap", "channelFx", "stylize"],
    ]);
    const all = m.flatMap((g) => g.items.map((i) => i.id));
    for (const id of [
      "innerLens",
      "chromaticVolume",
      "liquidGradient",
      "stripField",
      "chromaticDispersion",
      "repeater",
      "mask",
    ])
      expect(all, id).not.toContain(id);
  });
  it("the menu follows the page's narrowing", () => {
    const narrow = boot(true, ["mesh", "shadow"]).EngineCatalog.menu();
    expect(narrow.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ["Fills", ["imageFill", "linearGradient", "mesh"]],
      ["Effects", ["shadow"]],
      ["Structure", ["symmetry", "echo"]],
    ]);
  });
});

describe("the old surfaces are gone", () => {
  it("app.js keeps no icon, page or opening map of its own", () => {
    const app = read("app.js");
    expect(app).not.toMatch(/const OPENING=/);
    expect(app).not.toMatch(/const PAGE_FOR=/);
    expect(app).not.toMatch(/const ENG_ICON=/);
    expect(app).toContain("applyOpening(type,facade)");
    expect(app).toContain("const page=item.page;");
    expect(app).toContain("window.EngineCatalog.menu().forEach(group=>{");
  });
  it("index.html writes no capability button by hand", () => {
    const index = read("index.html");
    expect(index).not.toMatch(/data-capability=/);
    expect(index).toContain("generated from engine-catalog.js");
  });
  it("fxstack.js lists no ready type by hand", () => {
    const fx = read("fxstack.js");
    expect(fx).toContain("const READY = new Set();");
  });
});
