// @vitest-environment jsdom
/**
 * The canvas gradient control and the panel's ramp are ONE editor.
 *
 * They used to be two: the bar in the inspector and the line drawn over the
 * shape edited the same gradient and knew nothing about each other. The line
 * had no midpoints, no way to add a stop, no shared selection — and, for a
 * linear gradient, no way to slide the whole thing across the shape.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { loadEditor } from "./helpers/load-editor.js";

let editor;

const gradient = (kind, stops, over = {}) => ({
  kind,
  angle: 0,
  space: "srgb",
  fx: 0,
  fy: 0,
  stops: stops.map((s) => ({ opacity: 1, mid: 0.5, ...s })),
  ...over,
});

/** One selected rect carrying a gradient fill; returns its handles. */
function handles(kind, stops, over = {}) {
  editor.doc = {
    frame: {
      name: "F",
      w: 900,
      h: 600,
      bg: "#ffffff",
      children: [
        {
          type: "rect",
          name: "B",
          x: 200,
          y: 180,
          w: 500,
          h: 260,
          fill: gradient(kind, stops, over),
        },
      ],
    },
  };
  const o = editor.doc.frame.children[0];
  editor.setSelIds([o.id]);
  return { o, gh: editor.activeGradientHandles() };
}

const TWO = [
  { pos: 0, color: "#0ea5a4" },
  { pos: 1, color: "#f43f5e" },
];
const THREE = [
  { pos: 0, color: "#0ea5a4" },
  { pos: 0.5, color: "#8b5cf6" },
  { pos: 1, color: "#f43f5e" },
];

beforeAll(() => {
  ({ editor } = loadEditor());
});

describe("the line carries what the bar carries", () => {
  it("a handle per stop and a diamond per span between them", () => {
    const { gh } = handles("linear", THREE);
    expect(gh.stops.length).toBe(3);
    expect(gh.mids.length).toBe(2);
  });

  it("two stops leave exactly one diamond", () => {
    expect(handles("linear", TWO).gh.mids.length).toBe(1);
  });

  it("a diamond sits halfway along its span by default", () => {
    const { gh } = handles("linear", TWO);
    expect(gh.mids[0].x).toBeCloseTo((gh.x0 + gh.x1) / 2, 5);
    expect(gh.mids[0].y).toBeCloseTo((gh.y0 + gh.y1) / 2, 5);
  });

  it("a midpoint moves its diamond along the span, not the stop", () => {
    const { gh } = handles("linear", [
      { pos: 0, color: "#000000", mid: 0.25 },
      { pos: 1, color: "#ffffff" },
    ]);
    expect(gh.mids[0].x).toBeCloseTo(gh.x0 + (gh.x1 - gh.x0) * 0.25, 5);
  });

  it("a diamond names the two stops it blends between", () => {
    const { gh } = handles("linear", THREE);
    expect(gh.mids.map((m) => [m.i, m.next])).toEqual([
      [0, 1],
      [1, 2],
    ]);
  });

  it("diamonds follow gradient order, not array order", () => {
    const { gh } = handles("linear", [
      { pos: 1, color: "#f43f5e" },
      { pos: 0, color: "#0ea5a4" },
      { pos: 0.5, color: "#8b5cf6" },
    ]);
    // drawn order is index 1 (pos 0), 2 (pos .5), 0 (pos 1)
    expect(gh.mids.map((m) => [m.i, m.next])).toEqual([
      [1, 2],
      [2, 0],
    ]);
  });
});

describe("one selected stop, shared by both", () => {
  it("the handles report the ramp's selection", () => {
    const { gh } = handles("linear", THREE);
    editor.setRampSel("fill0", 2);
    expect(editor.activeGradientHandles().sel).toBe(2);
    expect(gh.key).toBe("fill0");
  });

  it("the selection clamps when a stop is removed", () => {
    handles("linear", THREE);
    editor.setRampSel("fill0", 2);
    handles("linear", TWO);
    expect(editor.activeGradientHandles().sel).toBe(1);
  });

  it("a layer's gradient and an artboard's keep separate selections", () => {
    editor.setRampSel("fill0", 1);
    editor.setRampSel("artboard", 0);
    expect(editor.rampSel("fill0", 3)).toBe(1);
    expect(editor.rampSel("artboard", 3)).toBe(0);
  });
});

describe("which stops are the ends is a question about position", () => {
  /* The regression this guards: the hit-test read the ends as "index 0 and
   * index length-1". Add a stop in the middle and its index sits outside that
   * guard, so pressing it fell through to the add-a-stop branch and made
   * another one instead of selecting it. */
  it("the ends are the lowest and highest positions, whatever their index", () => {
    const { o } = handles("linear", TWO);
    o.fill.stops.push({ pos: 0.4, color: "#8b5cf6", opacity: 1, mid: 0.5 });
    const ord = editor.rampOrder(o.fill.stops);
    expect(ord[0].i).toBe(0);
    expect(ord[ord.length - 1].i).toBe(1);
    // the stop added last is in the MIDDLE of the gradient, not at an end
    expect(ord.findIndex((e) => e.i === 2)).toBe(1);
  });

  it("stays right when the ends are stored out of order", () => {
    const { o } = handles("linear", [
      { pos: 1, color: "#f43f5e" },
      { pos: 0, color: "#0ea5a4" },
    ]);
    o.fill.stops.push({ pos: 0.5, color: "#8b5cf6", opacity: 1, mid: 0.5 });
    const ord = editor.rampOrder(o.fill.stops);
    expect([ord[0].i, ord[ord.length - 1].i]).toEqual([1, 0]);
  });
});

describe("the line is drawn where the gradient is", () => {
  it("moving the centre moves the whole line", () => {
    const { o, gh } = handles("linear", TWO);
    const before = { x0: gh.x0, x1: gh.x1 };
    o.fill.gx = 0.75;
    const after = editor.activeGradientHandles();
    const shift = o.w * 0.25;
    expect(after.x0 - before.x0).toBeCloseTo(shift, 5);
    expect(after.x1 - before.x1).toBeCloseTo(shift, 5);
  });

  it("a radial line starts at the centre and runs to the radius", () => {
    const { gh } = handles("radial", TWO);
    expect(gh.x0).toBeCloseTo(gh.cx, 5);
    expect(gh.y0).toBeCloseTo(gh.cy, 5);
    expect(gh.x1).toBeGreaterThan(gh.cx);
  });

  it("a linear line runs both ways from the centre", () => {
    const { gh } = handles("linear", TWO);
    expect(gh.x0).toBeLessThan(gh.cx);
    expect(gh.x1).toBeGreaterThan(gh.cx);
  });

  it("no handles for a solid fill", () => {
    editor.doc = {
      frame: {
        name: "F",
        w: 900,
        h: 600,
        bg: "#ffffff",
        children: [
          {
            type: "rect",
            name: "B",
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            fill: { kind: "solid", color: "#000000" },
          },
        ],
      },
    };
    editor.setSelIds([editor.doc.frame.children[0].id]);
    expect(editor.activeGradientHandles()).toBeNull();
  });
});
