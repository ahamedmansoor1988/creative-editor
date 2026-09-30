// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { loadEditor } from "./helpers/load-editor.js";

let editor;

function shape(effects = {}, type = "rect") {
  editor.doc = {
    frame: {
      name: "GF",
      w: 640,
      h: 640,
      bg: "#ffffff",
      artboards: [],
      children: [
        { type, name: "Frame", x: 0, y: 0, w: 400, h: 400, fill: { kind: "solid", color: "#000000" }, effects },
      ],
    },
  };
  return editor.doc.frame.children[0];
}

beforeAll(() => {
  ({ editor } = loadEditor());
  editor.paintCacheOff = true;
});

describe("Glass frame", () => {
  it("opens with the Figma shader's defaults", () => {
    const g = shape().effects.glassFrame;
    expect(g).toMatchObject({ on: false, squareness: 1, hole: 0.72, dispersion: 0.28, bg: "#000000", transparent: false });
  });

  it("clamps every number to its slider and repairs a bad colour", () => {
    const g = shape({
      glassFrame: { on: true, squareness: 7, tiltX: -400, hole: 0, ior: 9, exposure: "x", bg: "red" },
    }).effects.glassFrame;
    expect(g.on).toBe(true);
    expect(g.squareness).toBe(1);
    expect(g.tiltX).toBe(-90);
    expect(g.hole).toBe(0.2);
    expect(g.ior).toBe(2.2);
    expect(g.exposure).toBe(1.3);
    expect(g.bg).toBe("#000000");
  });

  it("is a material, and off for text", () => {
    expect(window.FxStack.slotOf("glassFrame")).toBe("material");
    expect(shape({ glassFrame: { on: true } }, "text").effects.glassFrame?.on ?? false).toBe(false);
  });
});
