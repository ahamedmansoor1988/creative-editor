// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { loadEditor } from "./helpers/load-editor.js";

let editor;
function shape(effects = {}, type = "rect") {
  editor.doc = {
    frame: { name: "AN", w: 1000, h: 520, bg: "#000000", artboards: [],
      children: [{ type, name: "Tunnel", x: 0, y: 0, w: 1000, h: 520, fill: { kind: "solid", color: "#000000" }, effects }] },
  };
  return editor.doc.frame.children[0];
}
beforeAll(() => {
  ({ editor } = loadEditor());
  editor.paintCacheOff = true;
});

describe("Anemone tunnel", () => {
  it("opens off, with the Figma shader's defaults, as a material", () => {
    const A = shape().effects.anemone;
    expect(A).toMatchObject({ on: false, depth: 2.6, fingers: 16, focus: 2.2, aperture: 0.9, nearColor: "#0b5c45", waterColor: "#3a8a98" });
    expect(window.FxStack.slotOf("anemone")).toBe("material");
  });
  it("holds every number to its slider, rounds the finger count and repairs colours", () => {
    const A = shape({ anemone: { on: true, fingers: 99.4, thickness: 0, focus: "x", deepColor: "lime" } }).effects.anemone;
    expect(A.on).toBe(true);
    expect(A.fingers).toBe(36);
    expect(A.thickness).toBe(0.03);
    expect(A.focus).toBe(2.2);
    expect(A.deepColor).toBe("#dcef8a");
  });
  it("is off for text", () => {
    expect(shape({ anemone: { on: true } }, "text").effects.anemone?.on ?? false).toBe(false);
  });
});
