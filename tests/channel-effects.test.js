// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { loadEditor } from "./helpers/load-editor.js";

let editor;
function layer(type = "rect", channelFx = {}) {
  editor.doc = {
    frame: {
      name: "Channels",
      w: 500,
      h: 350,
      bg: "#fff",
      artboards: [],
      children: [
        {
          type,
          name: "Target",
          x: 70,
          y: 50,
          w: 250,
          h: 180,
          text: type === "text" ? "RGB" : undefined,
          fill: { kind: "solid", color: "#8090a0" },
          effects: { channelFx },
        },
      ],
    },
  };
  return editor.doc.frame.children[0];
}
const line = () => ({
  data: new Uint8ClampedArray([
    10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255, 130, 140, 150, 255,
  ]),
});
beforeAll(() => {
  ({ editor } = loadEditor());
});

describe("shared Channel Effects capability", () => {
  it("normalizes all modes and keeps one live stack alias", () => {
    const o = layer("rect", {
      mode: "bad",
      amount: 999,
      angle: 900,
      falloff: 0,
      cx: 3,
      cy: -3,
      mix: 4,
      edge: "bad",
      redX: 999,
    });
    expect(o.effects.channelFx).toMatchObject({
      mode: "rgbSplit",
      amount: 200,
      angle: 180,
      falloff: 0.2,
      cx: 0.5,
      cy: -0.5,
      mix: 1,
      /* Repairs to MIRROR, not clamp. The "Outside pixels" control was removed
       * from the panel — it is a compositing control (Photoshop's Offset
       * filter and Nuke's filter nodes have it; Figma and Sketch do not) and
       * measurement showed it inert where it would be used: on a padded layer
       * at separation 4, all three modes produced identical pixels.
       *
       * The FIELD is still read, so a document authored while the control
       * existed renders as it was saved. Only the default moved, because clamp
       * streaks the border colour outward and mirror is the one of the three
       * that adds nothing of its own. */
      edge: "mirror",
      redX: 200,
    });
    expect(o.fx.find((e) => e.type === "channelFx").params).toBe(o.effects.channelFx);
  });

  it("is a no-op at zero and active only when a mode has displacement", () => {
    const p = { mode: "rgbSplit", amount: 0, mix: 1 };
    const img = line(),
      before = [...img.data];
    window.Filters.channelFxPixels(img, 5, 1, p);
    expect([...img.data]).toEqual(before);
    expect(window.FxStack.entryOn({ type: "channelFx", on: true, params: p })).toBe(false);
  });

  it("RGB Split samples red and blue in opposite directions", () => {
    const img = line();
    window.Filters.channelFxPixels(img, 5, 1, {
      mode: "rgbSplit",
      amount: 1,
      angle: 0,
      mix: 1,
      edge: "clamp",
    });
    expect([...img.data.slice(8, 12)]).toEqual([40, 80, 120, 255]);
  });

  it("Channel Offset gives each channel an independent vector", () => {
    const img = line();
    window.Filters.channelFxPixels(img, 5, 1, {
      mode: "channelOffset",
      mix: 1,
      edge: "clamp",
      redX: 1,
      redY: 0,
      greenX: 0,
      greenY: 0,
      blueX: -1,
      blueY: 0,
    });
    expect([...img.data.slice(8, 12)]).toEqual([40, 80, 120, 255]);
  });

  it("Chromatic Aberration grows radially from its chosen centre", () => {
    const img = line(),
      before = [...img.data];
    window.Filters.channelFxPixels(img, 5, 1, {
      mode: "aberration",
      amount: 2,
      falloff: 1,
      cx: 0,
      cy: 0,
      mix: 1,
      edge: "clamp",
    });
    expect([...img.data]).not.toEqual(before);
    expect(img.data[3]).toBe(255);
  });

  it("uses a reduced-resolution preview while a slider is moving", () => {
    const img = line();
    window.Filters.channelFxPixels(
      img,
      5,
      1,
      { mode: "rgbSplit", amount: 1, angle: 0, mix: 1, edge: "clamp" },
      { draft: true },
    );
    expect([...img.data.slice(0, 3)]).toEqual([...img.data.slice(4, 7)]);
  });

  it("offers the same editable filter to shapes, text, and images", () => {
    for (const type of ["rect", "text", "image"]) {
      const o = layer(type, { mode: "rgbSplit", amount: 8, mix: 1 });
      expect(editor.FX_PAGES(o)).toContain("Channel Effects");
      expect(o.fx.some((e) => e.type === "channelFx" && window.FxStack.entryOn(e))).toBe(true);
    }
  });
});

/* THE CASE THE PIXEL TESTS ABOVE CANNOT REACH.
 *
 * Every one of them runs on `line()`, which is opaque end to end — and channel
 * displacement is correct on opaque input however the alpha is handled. The
 * capability is offered on shapes, text and gradients, which are exactly the
 * layers that have transparency, so the covered case was the one that could
 * not fail.
 *
 * What went wrong: only RGB was displaced and the original alpha was kept. A
 * channel displaced off the shape then read the transparent background as
 * BLACK, so the edge LOST that channel instead of the layer gaining a halo —
 * a white square came back rgba(255,255,0) at every inside edge on aberration,
 * and rgba(0,255,255) on split and offset.
 *
 * Real dispersion grows the layer: the displaced channel extends past the
 * original silhouette and reads as a coloured halo outside it. That is what
 * After Effects, Nuke and Blender produce, and it is what these assert.
 */
describe("channel displacement over transparency", () => {
  const W = 60,
    H = 60;
  /** An opaque white square on a transparent field — a shape layer, in short. */
  function square() {
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 15; y < 45; y++)
      for (let x = 15; x < 45; x++) {
        const i = (y * W + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = data[i + 3] = 255;
      }
    return { data, width: W, height: H };
  }
  const at = (img, x, y) => {
    const i = (y * W + x) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
  };
  const run = (p) => {
    const img = square();
    window.Filters.channelFxPixels(img, W, H, Object.assign({ mix: 1, edge: "clamp" }, p));
    return img;
  };

  it("grows a halo outside the shape rather than biting a hole in it", () => {
    const img = run({ mode: "aberration", amount: 9, falloff: 1 });
    // outside the original silhouette, which was fully transparent before
    const halo = at(img, 11, 30);
    expect(halo[3], "no halo: the layer was clipped to its old alpha").toBeGreaterThan(0);
    expect(halo[0], "the halo should carry the displaced channel").toBeGreaterThan(halo[2]);
  });

  it("leaves the core of the shape unchanged", () => {
    // dispersion happens at edges; the middle of a flat area has nothing to disperse
    expect(at(run({ mode: "aberration", amount: 9, falloff: 1 }), 30, 30)).toEqual([
      255, 255, 255, 255,
    ]);
  });

  it("does the same for RGB split and channel offset", () => {
    for (const p of [
      { mode: "rgbSplit", amount: 9, angle: 0 },
      { mode: "channelOffset", redX: 9, blueX: -9 },
    ]) {
      const img = run(p);
      const outside = at(img, 11, 30);
      expect(outside[3], p.mode + " produced no halo").toBeGreaterThan(0);
    }
  });

  it("does not fill missing displaced channels with black inside a silhouette", () => {
    for (const p of [
      { mode: "rgbSplit", amount: 9, angle: 0 },
      { mode: "aberration", amount: 9, falloff: 1 },
    ]) {
      const inside = at(run(p), 16, 30);
      expect(inside[0] + inside[1] + inside[2], p.mode + " carved a black edge")
        .toBeGreaterThan(300);
    }
  });

  it("never invents colour where no channel reached", () => {
    /* Well outside the displacement radius nothing should appear at all — a
     * halo that keeps going is just a smear. */
    const img = run({ mode: "aberration", amount: 9, falloff: 1 });
    expect(at(img, 1, 30)).toEqual([0, 0, 0, 0]);
  });

  it("leaves a fully opaque image's alpha alone", () => {
    // the photo case: there is no silhouette to grow, so nothing should move
    const data = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = 200;
      data[i * 4 + 3] = 255;
    }
    const img = { data, width: W, height: H };
    window.Filters.channelFxPixels(img, W, H, {
      mode: "aberration",
      amount: 9,
      falloff: 1,
      mix: 1,
      edge: "clamp",
    });
    for (let i = 0; i < W * H; i++) expect(img.data[i * 4 + 3]).toBe(255);
  });

  it("fades toward the original rather than toward black as mix falls", () => {
    /* Blending in premultiplied space is what makes a partly-applied effect
     * over transparency fade to nothing instead of to a dark edge. */
    const img = run({ mode: "aberration", amount: 9, falloff: 1, mix: 0.5 });
    const edge = at(img, 16, 30);
    expect(edge[0] + edge[1] + edge[2]).toBeGreaterThan(120);
  });
});
