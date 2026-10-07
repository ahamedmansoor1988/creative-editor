// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { loadEditor } from "./helpers/load-editor.js";

let editor;

function shape(effects = {}, type = "rect") {
  editor.doc = {
    frame: {
      name: "LB",
      w: 640,
      h: 900,
      bg: "#000000",
      artboards: [],
      children: [{ type, name: "Burst", x: 0, y: 0, w: 450, h: 800, fill: { kind: "solid", color: "#000000" }, effects }],
    },
  };
  return editor.doc.frame.children[0];
}

beforeAll(() => {
  ({ editor } = loadEditor());
  editor.paintCacheOff = true;
});

describe("Light burst", () => {
  it("opens off, with the Figma shader's defaults, as a material", () => {
    const L = shape().effects.lightBurst;
    expect(L).toMatchObject({ on: false, cx: 0.5, cy: 0.38, rays: 3, rainbow: 0.8, focus: 0.65, aperture: 0.8, transparent: false, emberColor: "#ff8c26" });
    expect(window.FxStack.slotOf("lightBurst")).toBe("material");
  });

  it("holds every number to its slider, rounds counts and repairs colours", () => {
    const L = shape({ lightBurst: { on: true, cx: 4, rays: 7.6, haloThickness: 0, exposure: "x", seed: 300, emberColor: "orange" } }).effects.lightBurst;
    expect(L.on).toBe(true);
    expect(L.cx).toBe(1);
    expect(L.rays).toBe(8);
    expect(L.haloThickness).toBe(0.002);
    expect(L.exposure).toBe(1.2);
    expect(L.seed).toBe(99);
    expect(L.emberColor).toBe("#ff8c26");
  });

  it("chromatic aberration and background glow start at 0 (earlier designs render as before) and are held to their sliders", () => {
    expect(shape().effects.lightBurst).toMatchObject({ chromatic: 0, glow: 0, glowColor: "#1f4f8f" });
    const L = shape({ lightBurst: { on: true, chromatic: 5, glow: 9, glowColor: "blue" } }).effects.lightBurst;
    expect(L.chromatic).toBe(1);
    expect(L.glow).toBe(1.5);
    expect(L.glowColor).toBe("#1f4f8f");
  });

  it("the background can be a linear or radial gradient; bad values fall back to a solid colour", () => {
    expect(shape().effects.lightBurst).toMatchObject({ bgMode: "solid", bg2: "#0b1a33", bgAngle: 90 });
    const L = shape({ lightBurst: { on: true, bgMode: "radial", bg2: "#123456", bgAngle: 400 } }).effects.lightBurst;
    expect(L).toMatchObject({ bgMode: "radial", bg2: "#123456", bgAngle: 180 });
    expect(shape({ lightBurst: { bgMode: "conic", bg2: "nope" } }).effects.lightBurst).toMatchObject({ bgMode: "solid", bg2: "#0b1a33" });
  });

  it("the engine knows the new settings (they reach the shader and the render cache)", () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "../public/lightburst.js"), "utf8");
    expect(src).toMatch(/chromatic:0, glow:0, glowColor:'#1f4f8f'/);
    expect(src).toMatch(/\['chroma','chromatic'\],\['glow','glow'\]/);
    expect(src).toMatch(/uniform3fv\(loc\.glowCol/);
  });

  it("is off for text", () => {
    expect(shape({ lightBurst: { on: true } }, "text").effects.lightBurst?.on ?? false).toBe(false);
  });
});
