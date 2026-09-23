// @vitest-environment node
/**
 * public/color.js — hex, rgb, alpha strings and blending, testable in node.
 *
 * The second seam cut from app.js (23 Sep 2026). The gradient ramp, the mesh
 * panel, the reference flow's measured palette and the glow blend through
 * these; the behaviour tests that run through the editor did not change.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(here, "..", "public", f), "utf8");
let C;
beforeAll(() => {
  const win = {};
  new Function("window", read("color.js"))(win);
  C = win.Color;
});

describe("loads alone, and the editor binds its names from it", () => {
  it("app.js defines none of them any more, and aliases them from the module", () => {
    const app = read("app.js");
    for (const n of [
      "hexRgb",
      "mixHex",
      "mixIn",
      "hexAlpha",
      "hexToRgba",
      "rampMix",
      "meanHexOf",
      "dominantHexes",
      "stopColor",
      "_linToOklab",
    ])
      expect(app, n).not.toMatch(new RegExp("^function " + n + "\\(", "m"));
    expect(app).not.toMatch(/^const rgbHex=/m);
    expect(app).not.toMatch(/^const HEX6=/m);
    expect(app).toMatch(/^const \{[^}]*mixIn[^}]*\}=window\.Color;$/m);
    const index = read("index.html");
    expect(index.indexOf('src="color.js')).toBeLessThan(index.indexOf('src="app.js'));
    expect(read("../tests/helpers/load-editor.js")).toContain('"color.js"');
  });
});

describe("hex and rgb", () => {
  it("round-trips, and clamps on the way to hex", () => {
    expect(C.hexRgb("#ff8000")).toEqual([255, 128, 0]);
    expect(C.rgbHex([255, 128, 0])).toBe("#ff8000");
    expect(C.rgbHex([300, -4, 12.6])).toBe("#ff000d");
    expect(C.hexRgb(C.rgbHex([1, 2, 3]))).toEqual([1, 2, 3]);
  });
  it("alpha strings", () => {
    expect(C.hexAlpha("#ff8000", 0.5)).toBe("rgba(255,128,0,0.5)");
    expect(C.hexToRgba("#ff8000", 0.25)).toBe("rgba(255,128,0,0.25)");
    expect(C.hexToRgba("ff8000", 1)).toBe("rgba(255,128,0,1)"); // hash optional
    expect(C.hexToRgba("nope", 0.3)).toBe("rgba(0,0,0,0.3)"); // guarded
  });
  it("a gradient stop with opacity becomes an rgba string; without, the hex stays", () => {
    expect(C.stopColor({ color: "#112233" })).toBe("#112233");
    expect(C.stopColor({ color: "#112233", opacity: 0.4 })).toBe("rgba(17,34,51,0.4)");
  });
});

describe("blending", () => {
  it("sRGB midpoint is the channel mean", () => {
    expect(C.mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(C.mixIn("#000000", "#ffffff", 0.5, "srgb")).toBe("#808080");
  });
  it("linear light and OKLab lift the dead grey out of a blue-to-yellow ramp", () => {
    const lum = (h) => C.hexRgb(h).reduce((a, v) => a + v, 0) / 3;
    const srgb = C.mixIn("#0000ff", "#ffff00", 0.5, "srgb");
    const lin = C.mixIn("#0000ff", "#ffff00", 0.5, "linear");
    const lab = C.mixIn("#0000ff", "#ffff00", 0.5, "oklab");
    expect(lum(lin)).toBeGreaterThan(lum(srgb));
    expect(lum(lab)).toBeGreaterThan(lum(srgb));
    expect(lab).toMatch(/^#[0-9a-f]{6}$/);
  });
  it("OKLab round-trips through linear light", () => {
    const rgb = C._hexToRgb("#3b6df0").map(C._srgbToLin);
    const back = C._oklabToLin(C._linToOklab(rgb));
    back.forEach((v, i) => expect(v).toBeCloseTo(rgb[i], 6));
  });
  it("rampMix guards its inputs", () => {
    expect(C.rampMix("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(C.rampMix("bad", "#ffffff", 0.5)).toBe("#ffffff");
    expect(C.rampMix("#000000", "bad", 0.5)).toBe("#000000");
    expect(C.rampMix("bad", "bad", 0.5)).toBe("#888888");
    expect(C.rampMix("#000000", "#ffffff", 7)).toBe("#ffffff"); // t clamped
  });
});

describe("a measured palette", () => {
  it("the mean ignores what is not a colour", () => {
    expect(C.meanHexOf(["#000000", "#ffffff", "nope", null])).toBe("#808080");
    expect(C.meanHexOf([])).toBe("#808080");
  });
  it("dominant colours: most-covered first, near-duplicates folded, n at most", () => {
    const hexes = ["#ff0000", "#fe0101", "#ff0202", "#0000ff", "#0000fe", "#00ff00"];
    const out = C.dominantHexes(hexes, 2);
    expect(out).toHaveLength(2);
    expect(C.hexDist(out[0], "#ff0000")).toBeLessThan(30);
    expect(C.hexDist(out[1], "#0000ff")).toBeLessThan(30);
    expect(C.dominantHexes([], 3)).toEqual(["#808080"]);
  });
  it("distance is euclidean in rgb", () => {
    expect(C.hexDist("#000000", "#ffffff")).toBeCloseTo(Math.sqrt(3) * 255, 6);
    expect(C.HEX6.test("#AbCdEf")).toBe(true);
    expect(C.HEX6.test("#abc")).toBe(false);
  });
});
