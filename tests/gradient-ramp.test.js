// @vitest-environment jsdom
/**
 * The gradient ramp — stops drawn ON the gradient, the way Figma, Illustrator
 * and Sketch draw them. Replaces a block per stop.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { loadEditor } from "./helpers/load-editor.js";

let editor;

const gradient = (stops) => ({
  kind: "linear",
  angle: 0,
  space: "srgb",
  stops: stops.map((s) => ({ opacity: 1, mid: 0.5, ...s })),
});

/** A layer carrying one gradient fill; returns the normalized layer. */
function withGradient(stops) {
  editor.doc = {
    frame: {
      name: "F",
      w: 900,
      h: 600,
      bg: "#ffffff",
      children: [{ type: "rect", name: "L", x: 0, y: 0, w: 200, h: 100, fill: gradient(stops) }],
    },
  };
  return editor.doc.frame.children[0];
}

beforeAll(() => {
  ({ editor } = loadEditor());
});

describe("the bar is the ordering", () => {
  it("draws stops in gradient order, not array order", () => {
    const stops = [
      { pos: 1, color: "#000000" },
      { pos: 0, color: "#ffffff" },
      { pos: 0.5, color: "#ff0000" },
    ];
    expect(editor.rampOrder(stops).map((e) => e.i)).toEqual([1, 2, 0]);
  });

  it("keeps array order when two stops share a position, so nothing jumps", () => {
    const stops = [
      { pos: 0.5, color: "#111111" },
      { pos: 0.5, color: "#222222" },
    ];
    expect(editor.rampOrder(stops).map((e) => e.i)).toEqual([0, 1]);
  });

  it("the bar's CSS gradient carries every stop with its colour and position", () => {
    const css = editor.rampGradientCss([
      { pos: 0, color: "#0ea5a4", opacity: 1 },
      { pos: 1, color: "#333333", opacity: 1 },
    ]);
    expect(css).toContain("linear-gradient(90deg");
    expect(css).toContain("rgba(14,165,164,1) 0.00%");
    expect(css).toContain("rgba(51,51,51,1) 100.00%");
  });

  it("stop opacity reaches the bar, so a transparent stop reads as one", () => {
    const css = editor.rampGradientCss([
      { pos: 0, color: "#ffffff", opacity: 0 },
      { pos: 1, color: "#000000", opacity: 1 },
    ]);
    expect(css).toContain("rgba(255,255,255,0)");
  });

  it("a one-stop gradient still yields a valid two-stop CSS image", () => {
    const css = editor.rampGradientCss([{ pos: 0, color: "#123456", opacity: 1 }]);
    expect(css.match(/rgba/g).length).toBe(2);
  });
});

describe("handles and diamonds", () => {
  /** @returns {HTMLDivElement} a detached div holding the ramp markup */
  const render = (stops, sel = 0) => {
    const d = document.createElement("div");
    d.innerHTML = editor.rampHTML(
      stops.map((s) => ({ opacity: 1, mid: 0.5, ...s })),
      sel,
      'data-i="0"',
    );
    return d;
  };

  it("one handle per stop, one diamond per span between them", () => {
    const d = render([
      { pos: 0, color: "#000000" },
      { pos: 0.5, color: "#888888" },
      { pos: 1, color: "#ffffff" },
    ]);
    expect(d.querySelectorAll(".gStop").length).toBe(3);
    expect(d.querySelectorAll(".gMid").length).toBe(2);
  });

  it("two stops leave exactly one diamond", () => {
    const d = render([
      { pos: 0, color: "#000000" },
      { pos: 1, color: "#ffffff" },
    ]);
    expect(d.querySelectorAll(".gMid").length).toBe(1);
  });

  it("a handle sits at its stop's position", () => {
    const d = render([
      { pos: 0, color: "#000000" },
      { pos: 0.25, color: "#ffffff" },
    ]);
    // the browser re-serializes "25.00%" as "25%", so compare the number
    const h = /** @type {HTMLElement} */ (d.querySelector('.gStop[data-s="1"]'));
    expect(parseFloat(h.style.left)).toBeCloseTo(25, 2);
  });

  it("a diamond sits between its two handles, moved by the midpoint", () => {
    const d = render([
      { pos: 0, color: "#000000", mid: 0.25 },
      { pos: 1, color: "#ffffff" },
    ]);
    expect(
      parseFloat(/** @type {HTMLElement} */ (d.querySelector(".gMid")).style.left),
    ).toBeCloseTo(25, 2);
  });

  it("the diamond is centred when the midpoint is half", () => {
    const d = render([
      { pos: 0.2, color: "#000000", mid: 0.5 },
      { pos: 0.8, color: "#ffffff" },
    ]);
    expect(
      parseFloat(/** @type {HTMLElement} */ (d.querySelector(".gMid")).style.left),
    ).toBeCloseTo(50, 2);
  });

  it("only the selected handle is marked, and it says so for a screen reader", () => {
    const d = render(
      [
        { pos: 0, color: "#000000" },
        { pos: 1, color: "#ffffff" },
      ],
      1,
    );
    const on = /** @type {HTMLElement[]} */ ([...d.querySelectorAll(".gStop")]).filter((b) =>
      b.classList.contains("is-sel"),
    );
    expect(on.length).toBe(1);
    expect(on[0].dataset.s).toBe("1");
    expect(on[0].getAttribute("aria-pressed")).toBe("true");
  });

  it("every handle and diamond is a real button, so the ramp is reachable by keyboard", () => {
    const d = render([
      { pos: 0, color: "#000000" },
      { pos: 1, color: "#ffffff" },
    ]);
    for (const b of d.querySelectorAll(".gStop, .gMid")) {
      expect(b.tagName).toBe("BUTTON");
      expect(b.getAttribute("type")).toBe("button");
    }
  });

  it("a handle carries its stop's colour, escaped", () => {
    const d = render([
      { pos: 0, color: "#0ea5a4" },
      { pos: 1, color: "#333333" },
    ]);
    const dot = /** @type {HTMLElement} */ (d.querySelector(".gStop i"));
    expect(dot.style.background).toBe("rgb(14, 165, 164)");
  });
});

describe("selection survives a rebuild", () => {
  beforeEach(() => editor.setRampSel("test", 0));

  it("remembers which stop was being edited", () => {
    editor.setRampSel("test", 2);
    expect(editor.rampSel("test", 4)).toBe(2);
  });

  it("clamps to the stops that remain when one is deleted", () => {
    editor.setRampSel("test", 3);
    expect(editor.rampSel("test", 2)).toBe(1);
  });

  it("an owner never asked about starts at the first stop", () => {
    expect(editor.rampSel("never-seen", 3)).toBe(0);
  });

  it("two owners keep separate selections", () => {
    editor.setRampSel("fill0", 1);
    editor.setRampSel("artboard", 2);
    expect(editor.rampSel("fill0", 3)).toBe(1);
    expect(editor.rampSel("artboard", 3)).toBe(2);
  });
});

describe("a click on the bar takes the colour already there", () => {
  it("halfway between two stops is the blend of both", () => {
    expect(editor.rampMix("#000000", "#ffffff", 0.5)).toBe("#808080");
  });

  it("at either end it is that end's colour", () => {
    expect(editor.rampMix("#0ea5a4", "#333333", 0)).toBe("#0ea5a4");
    expect(editor.rampMix("#0ea5a4", "#333333", 1)).toBe("#333333");
  });

  it("a malformed colour falls back rather than producing NaN", () => {
    expect(editor.rampMix("nonsense", "#333333", 0.5)).toBe("#333333");
    expect(editor.rampMix(undefined, undefined, 0.5)).toBe("#888888");
  });
});

describe("the layer's fill still renders what the ramp shows", () => {
  it("a gradient fill round-trips through the document", () => {
    const o = withGradient([
      { pos: 0, color: "#0ea5a4" },
      { pos: 1, color: "#333333" },
    ]);
    expect(o.fill.kind).toBe("linear");
    expect(o.fill.stops.length).toBe(2);
    const back = JSON.parse(JSON.stringify(editor.doc));
    editor.doc = back;
    expect(editor.doc.frame.children[0].fill.stops[1].color).toBe("#333333");
  });

  it("stops out of order still paint in gradient order", () => {
    const o = withGradient([
      { pos: 1, color: "#333333" },
      { pos: 0, color: "#0ea5a4" },
    ]);
    const css = editor.rampGradientCss(o.fill.stops);
    expect(css.indexOf("rgba(14,165,164,1)")).toBeLessThan(css.indexOf("rgba(51,51,51,1)"));
  });
});

describe("the ramp keeps its keys to itself", () => {
  it("a stop's Delete never reaches the handler that deletes the layer", () => {
    // The regression this guards: a focused handle removed its stop and then
    // let Delete bubble to the document, which deleted the whole layer.
    const o = withGradient([
      { pos: 0, color: "#0ea5a4" },
      { pos: 0.5, color: "#8b5cf6" },
      { pos: 1, color: "#333333" },
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    host.innerHTML = editor.rampHTML(o.fill.stops, 1, 'data-i="0"');
    const ramp = host.querySelector(".gRamp");
    let committed = null;
    editor.wireRamp(
      ramp,
      () => o.fill.stops,
      "test-keys",
      () => {},
      (label) => {
        committed = label;
      },
    );
    let reachedDocument = false;
    const spy = () => {
      reachedDocument = true;
    };
    document.addEventListener("keydown", spy);
    const handle = host.querySelector('.gStop[data-s="1"]');
    handle.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "Delete" }));
    document.removeEventListener("keydown", spy);
    host.remove();

    expect(o.fill.stops.length).toBe(2);
    expect(committed).toBe("Remove gradient stop");
    expect(reachedDocument).toBe(false);
  });

  it("an arrow key on a handle moves the stop and stops there", () => {
    const o = withGradient([
      { pos: 0.5, color: "#0ea5a4" },
      { pos: 1, color: "#333333" },
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    host.innerHTML = editor.rampHTML(o.fill.stops, 0, 'data-i="0"');
    const ramp = host.querySelector(".gRamp");
    editor.wireRamp(
      ramp,
      () => o.fill.stops,
      "test-keys-2",
      () => {},
      () => {},
    );
    let reachedDocument = false;
    const spy = () => {
      reachedDocument = true;
    };
    document.addEventListener("keydown", spy);
    const handle = host.querySelector('.gStop[data-s="0"]');
    handle.dispatchEvent(
      new window.KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight", shiftKey: true }),
    );
    document.removeEventListener("keydown", spy);
    host.remove();

    expect(o.fill.stops[0].pos).toBeCloseTo(0.6, 5);
    expect(reachedDocument).toBe(false);
  });

  it("the last two stops cannot be deleted away", () => {
    const o = withGradient([
      { pos: 0, color: "#0ea5a4" },
      { pos: 1, color: "#333333" },
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    host.innerHTML = editor.rampHTML(o.fill.stops, 0, 'data-i="0"');
    const ramp = host.querySelector(".gRamp");
    editor.wireRamp(
      ramp,
      () => o.fill.stops,
      "test-keys-3",
      () => {},
      () => {},
    );
    host
      .querySelector('.gStop[data-s="0"]')
      .dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "Delete" }));
    host.remove();
    expect(o.fill.stops.length).toBe(2);
  });
});
