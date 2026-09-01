// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { loadEditor } from "./helpers/load-editor.js";

let editor;
const run = (pixels, w, h, p) => {
  const img = { data: new Uint8ClampedArray(pixels) };
  window.Filters.stylizePixels(img, w, h, p);
  return [...img.data];
};
function layer(type = "rect", stylize = {}) {
  editor.doc = {
    frame: {
      name: "Stylize",
      w: 500,
      h: 400,
      bg: "#fff",
      artboards: [],
      children: [
        {
          type,
          name: "Target",
          x: 20,
          y: 20,
          w: 200,
          h: 160,
          text: type === "text" ? "Type" : undefined,
          fill: { kind: "solid", color: "#8090a0" },
          effects: { stylize },
        },
      ],
    },
  };
  return editor.doc.frame.children[0];
}
beforeAll(() => {
  ({ editor } = loadEditor());
});

describe("shared Stylize capability", () => {
  it("normalizes one model and keeps the stack alias live", () => {
    const o = layer("rect", {
      mode: "bad",
      mix: 8,
      levels: 99,
      threshold: -2,
      softness: 9,
      pixelSize: 1,
      dotSize: 999,
      angle: 999,
    });
    expect(o.effects.stylize).toEqual({
      mode: "posterize",
      mix: 1,
      levels: 32,
      threshold: 0,
      softness: 0.5,
      pixelSize: 2,
      dotSize: 100,
      angle: 180,
      foreground: "#111111",
      background: "#ffffff",
    });
    expect(o.fx.find((e) => e.type === "stylize").params).toBe(o.effects.stylize);
  });

  it("is a true no-op at zero mix", () => {
    const input = [35, 100, 220, 255];
    expect(run(input, 1, 1, { mode: "posterize", levels: 2, mix: 0 })).toEqual(input);
    expect(window.FxStack.entryOn({ type: "stylize", on: true, params: { mix: 0 } })).toBe(false);
  });

  it("posterizes channels to the requested number of levels", () => {
    expect(run([40, 140, 240, 255], 1, 1, { mode: "posterize", levels: 2, mix: 1 })).toEqual([
      0, 255, 255, 255,
    ]);
  });

  it("threshold maps luminance to editable foreground and background colors", () => {
    const p = {
      mode: "threshold",
      threshold: 0.5,
      softness: 0,
      foreground: "#112233",
      background: "#ddeeff",
      mix: 1,
    };
    expect(run([0, 0, 0, 255, 255, 255, 255, 255], 2, 1, p)).toEqual([
      17, 34, 51, 255, 221, 238, 255, 255,
    ]);
  });

  it("pixelate uses a block average rather than an arbitrary corner pixel", () => {
    const p = { mode: "pixelate", pixelSize: 2, mix: 1 };
    const out = run(
      [0, 0, 0, 255, 100, 100, 100, 255, 200, 200, 200, 255, 255, 255, 255, 255],
      2,
      2,
      p,
    );
    expect(out[0]).toBe(139);
    expect(out[4]).toBe(139);
    expect(out[8]).toBe(139);
  });

  it("uses the same editable capability on shapes, text, and images", () => {
    for (const type of ["rect", "text", "image"]) {
      const o = layer(type, { mode: "halftone", dotSize: 8, mix: 1 });
      expect(editor.FX_PAGES(o)).toContain("Stylize");
      expect(o.fx.some((e) => e.type === "stylize" && window.FxStack.entryOn(e))).toBe(true);
    }
  });
});

/* HALFTONE IS A TONE REPRODUCTION DEVICE, and that is the only thing worth
 * asserting about it. A screen that renders 50% grey as 69% ink makes every
 * image muddy, and no amount of picking a nicer dot shape rescues it.
 *
 * Ink coverage goes as the dot's AREA, so a radius proportional to
 * sqrt(1 - lum) times a constant cannot be faithful: the original
 * `sqrt(1-lum)*0.68` gave 0.69 coverage at mid grey where 0.50 was wanted and
 * 0.95 at quarter tone where 0.75 was. It also stopped short of the cell's
 * half-diagonal, so pure black kept 1% of the paper white.
 *
 * These measure INK rather than counting dark pixels, because the dot rim is
 * antialiased — and it is antialiased for a reason a pixel count would hide:
 * a hard dist <= radius test samples at pixel centres and loses half a pixel
 * around every dot, which is a systematic shortfall that scales with the
 * perimeter and cannot be corrected by changing the radius.
 */
describe("halftone reproduces tone", () => {
  const W = 120,
    H = 120;
  const flat = (v) => {
    const data = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
      data[i * 4 + 3] = 255;
    }
    return { data, width: W, height: H };
  };
  const inkFor = (v, angle) => {
    const img = flat(v);
    window.Filters.stylizePixels(img, W, H, {
      mode: "halftone",
      dotSize: 10,
      angle: angle || 0,
      mix: 1,
      foreground: "#000000",
      background: "#ffffff",
    });
    let sum = 0;
    for (let i = 0; i < W * H; i++) sum += 1 - img.data[i * 4] / 255;
    return sum / (W * H);
  };

  it("lays down the ink the source tone asks for, across the range", () => {
    for (const v of [64, 128, 191]) {
      const want = 1 - v / 255;
      const got = inkFor(v);
      expect(
        Math.abs(got - want),
        `tone ${v}: laid ${got.toFixed(3)} ink where ${want.toFixed(3)} was wanted`,
      ).toBeLessThan(0.04);
    }
  });

  it("fills solid black completely, leaving no paper showing", () => {
    // the dot has to reach the cell's half-diagonal, not merely its edge
    expect(inkFor(0)).toBeGreaterThan(0.98);
  });

  it("leaves white alone", () => {
    expect(inkFor(255)).toBeLessThan(0.02);
  });

  it("holds its tone when the screen is rotated", () => {
    // a screen angle is a print convention, not a tonal one
    for (const angle of [15, 45, 75]) {
      expect(Math.abs(inkFor(128, angle) - 0.498)).toBeLessThan(0.05);
    }
  });

  it("does not interpret transparent cell centres as black ink", () => {
    const W2=40,H2=40,data=new Uint8ClampedArray(W2*H2*4);
    for(let y=8;y<32;y++) for(let x=8;x<32;x++){
      const i=(y*W2+x)*4; data[i]=data[i+1]=data[i+2]=data[i+3]=255;
    }
    const img={data};
    window.Filters.stylizePixels(img,W2,H2,{mode:"halftone",dotSize:8,angle:45,mix:1,
      foreground:"#000000",background:"#ffffff"});
    const visible=[];
    for(let i=0;i<data.length;i+=4) if(data[i+3]) visible.push(data[i]);
    expect(Math.min(...visible)).toBeGreaterThan(250);
  });

  it("is monotonic: darker in never means less ink out", () => {
    let prev = -1;
    for (const v of [255, 200, 160, 128, 96, 64, 32, 0]) {
      const got = inkFor(v);
      expect(got, `tone ${v} laid less ink than the lighter tone before it`).toBeGreaterThanOrEqual(
        prev - 0.01,
      );
      prev = got;
    }
  });
});
