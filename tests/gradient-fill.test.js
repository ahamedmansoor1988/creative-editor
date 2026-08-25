// @vitest-environment jsdom
/**
 * QA for gradient FILLS (§4.5/§4.6) — the linear and radial paints in the Fill
 * section, as distinct from the `gradient` stripe effect.
 *
 * The finding here is `space`. It has been in the paint model and the AI schema
 * since gradients landed — normalised, clamped to srgb|linear|oklab, saved and
 * reloaded — and nothing ever read it. addStops did not take it and paintStyle
 * did not pass it, so a document could ask for OKLab and silently be rendered
 * in sRGB. A field that persists and does nothing is worse than a missing one,
 * because the document claims a rendering it never gets.
 *
 * These assert on the STOPS the app hands to canvas, which the context stub now
 * records — canvas itself only ever interpolates in sRGB, so working in another
 * space means emitting sampled stops, and the stops are the evidence.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { loadEditor } from "./helpers/load-editor.js";

let editor, ctx;

function boxWithFill(fill) {
  editor.doc = {
    frame: {
      name: "F",
      w: 900,
      h: 600,
      bg: "#ffffff",
      artboards: [],
      children: [{ type: "rect", name: "Box", x: 100, y: 100, w: 400, h: 300, fill }],
    },
  };
  return editor.doc.frame.children[0];
}

/** Render and hand back the stops of the gradient the object's fill built. */
function rampFor(fill) {
  boxWithFill(fill);
  ctx.gradients.length = 0;
  editor.render();
  const g = ctx.gradients[ctx.gradients.length - 1];
  return g ? g.stops : [];
}

const BLUE_YELLOW = [
  { pos: 0, color: "#0000ff" },
  { pos: 1, color: "#ffff00" },
];

/** Relative luminance of a hex or rgba() stop colour. */
function lum(c) {
  const str = String(c);
  const hex = str.match(/^#([0-9a-f]{6})$/i);
  /** @type {number[]} */
  let rgb;
  if (hex) {
    rgb = [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16) / 255);
  } else {
    const m = str.match(/(\d+),\s*(\d+),\s*(\d+)/);
    rgb = m ? [1, 2, 3].map((i) => Number(m[i]) / 255) : [0, 0, 0];
  }
  const lin = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

beforeAll(() => {
  ({ editor, ctx } = loadEditor());
  editor.paintCacheOff = true;
});

describe("gradient fills — the interpolation space is honoured", () => {
  it("emits only the given stops in sRGB", () => {
    // classic behaviour: canvas interpolates, so two stops stay two stops
    const stops = rampFor({ kind: "linear", space: "srgb", stops: BLUE_YELLOW });
    expect(stops.length).toBe(2);
  });

  it("samples the ramp when a perceptual space is asked for", () => {
    // canvas cannot interpolate in OKLab, so the app must emit the curve
    const stops = rampFor({ kind: "linear", space: "oklab", stops: BLUE_YELLOW });
    expect(stops.length, "OKLab must emit intermediate stops").toBeGreaterThan(2);
  });

  it("keeps blue-to-yellow off the dead grey that sRGB drags it through", () => {
    // the whole point of the feature, asserted rather than asserted-about
    const mid = (space) => {
      const stops = rampFor({ kind: "linear", space, stops: BLUE_YELLOW });
      const near = stops.reduce((a, s) => (Math.abs(s.pos - 0.5) < Math.abs(a.pos - 0.5) ? s : a));
      return near.color;
    };
    const srgbMid = mid("srgb");
    const oklabMid = mid("oklab");
    expect(oklabMid, "OKLab must not produce the same midpoint as sRGB").not.toBe(srgbMid);
    expect(lum(oklabMid), "OKLab's midpoint must be brighter than sRGB's grey").toBeGreaterThan(
      lum(srgbMid),
    );
  });

  it("lifts the midpoint's luminance in linear light", () => {
    const stops = rampFor({ kind: "linear", space: "linear", stops: BLUE_YELLOW });
    const near = stops.reduce((a, s) => (Math.abs(s.pos - 0.5) < Math.abs(a.pos - 0.5) ? s : a));
    expect(lum(near.color)).toBeGreaterThan(0.4);
  });

  it("applies to radial fills too, not just linear", () => {
    const stops = rampFor({ kind: "radial", space: "oklab", stops: BLUE_YELLOW });
    expect(stops.length).toBeGreaterThan(2);
  });

  it("leaves a colour unmoved when both ends are the same", () => {
    // a conversion round trip must not drift, or every flat ramp shifts
    const stops = rampFor({
      kind: "linear",
      space: "oklab",
      stops: [
        { pos: 0, color: "#3b6df0" },
        { pos: 1, color: "#3b6df0" },
      ],
    });
    for (const s of stops) expect(String(s.color).toLowerCase()).toContain("3b6df0");
  });
});

describe("gradient fills — the model and the panel", () => {
  it("accepts only the three documented spaces", () => {
    const sp = (v) => boxWithFill({ kind: "linear", space: v, stops: BLUE_YELLOW }).fill.space;
    expect(sp("oklab")).toBe("oklab");
    expect(sp("linear")).toBe("linear");
    expect(sp("hsluv")).toBe("srgb");
    expect(sp(undefined)).toBe("srgb");
  });

  it("offers the control, which it never had", () => {
    const o = boxWithFill({ kind: "linear", stops: BLUE_YELLOW });
    editor.setSelIds(new Set([o.id]));
    editor.refresh();
    const head = document.querySelector('#fxBody [data-fxsect="Fill"]');
    if (head && head.getAttribute("aria-expanded") !== "true")
      /** @type {HTMLElement} */ (head).click();
    const sel = /** @type {HTMLSelectElement} */ (
      head.nextElementSibling.querySelector(".apSpace")
    );
    expect(sel, "the blend-space control is missing").toBeTruthy();
    expect([...sel.options].map((o2) => o2.value)).toEqual(["srgb", "linear", "oklab"]);
  });

  it("writes the chosen space through to the paint", () => {
    const o = boxWithFill({ kind: "linear", stops: BLUE_YELLOW });
    editor.setSelIds(new Set([o.id]));
    editor.refresh();
    const head = document.querySelector('#fxBody [data-fxsect="Fill"]');
    if (head && head.getAttribute("aria-expanded") !== "true")
      /** @type {HTMLElement} */ (head).click();
    const sel = /** @type {HTMLSelectElement} */ (
      head.nextElementSibling.querySelector(".apSpace")
    );
    sel.value = "oklab";
    sel.dispatchEvent(new window.Event("change", { bubbles: true }));
    expect(editor.doc.frame.children[0].fill.space).toBe("oklab");
  });
});
