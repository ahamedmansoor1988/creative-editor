// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { loadEditor } from "./helpers/load-editor.js";

let editor;

function shape(effects = {}, type = "rect") {
  editor.doc = {
    frame: {
      name: "DM",
      w: 640,
      h: 640,
      bg: "#ffffff",
      artboards: [],
      children: [{ type, name: "Blob", x: 0, y: 0, w: 200, h: 200, fill: { kind: "solid", color: "#ff8fd0" }, effects }],
    },
  };
  return editor.doc.frame.children[0];
}

beforeAll(() => {
  ({ editor } = loadEditor());
  editor.paintCacheOff = true;
});

describe("Dot matrix", () => {
  it("is off until applied, and a pixel effect", () => {
    const o = shape();
    expect(o.effects.dotMatrix.on).toBe(false);
    expect(window.FxStack.slotOf("dotMatrix")).toBe("pixel");
    expect(window.FxStack.inSlot(o.fx, "pixel").map((e) => e.type)).not.toContain("dotMatrix");
  });

  it("clamps its numbers and repairs bad colours and modes", () => {
    const d = shape({ dotMatrix: { on: true, cellSize: 1, contrast: 99, source: "nonsense", dotColor: "teal" } }).effects
      .dotMatrix;
    expect(d.on).toBe(true);
    expect(d.cellSize).toBe(3);
    expect(d.contrast).toBe(8);
    expect(d.source).toBe("brightness");
    expect(d.dotColor).toBe("#8ee6cc");
  });

  it("draws one mark per cell from what the layer rendered", () => {
    // a recording 2D context: bright pixels everywhere -> every cell is a filled dot
    const W = 28,
      H = 28,
      arcs = [];
    const data = new Uint8ClampedArray(W * H * 4).fill(255);
    const ctx = {
      getImageData: () => ({ data }),
      clearRect() {},
      fillRect() {},
      beginPath() {},
      arc: (x, y, r) => arcs.push(r),
      fill() {},
      stroke() {},
      set fillStyle(v) {},
      set strokeStyle(v) {},
      set lineWidth(v) {},
      set globalAlpha(v) {},
    };
    const cv = { width: W, height: H, getContext: () => ctx };
    window.Filters.dotMatrixLayer(cv, { cellSize: 14, variation: 0, threshold: 0.35, contrast: 1.8, dotSize: 1 });
    expect(arcs.length).toBe(4);
    arcs.forEach((r) => expect(r).toBeCloseTo(14 * 0.34, 5));
  });
});
