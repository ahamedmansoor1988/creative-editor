// @vitest-environment jsdom
/**
 * QA for the `shadow` effect — the first promoted through the FxStack.READY
 * gate (§ effect QA pass).
 *
 * jsdom has no canvas, so this cannot assert pixels. What it CAN assert is the
 * thing that actually broke effects in this codebase before: whether the
 * effect reaches the canvas at all. A shadow is configured by setting
 * shadowColor/shadowBlur/shadowOffsetX/Y and then painting, so each fill()
 * records the shadow state in force at that moment. An effect that registers,
 * normalises and shows a panel but never sets those properties is exactly the
 * silent failure the gate exists to catch.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { loadEditor } from "./helpers/load-editor.js";

let editor, ctx;

/** Wrap the stub so every fill/stroke records the shadow state in force. */
function recordShadowAtPaint(c) {
  const seen = [];
  for (const op of ["fill", "stroke", "fillRect", "drawImage"]) {
    const orig = c[op];
    c[op] = (...args) => {
      seen.push({
        op,
        color: c.shadowColor,
        blur: c.shadowBlur,
        dx: c.shadowOffsetX,
        dy: c.shadowOffsetY,
        composite: c.globalCompositeOperation,
      });
      return orig.apply(c, args);
    };
  }
  return seen;
}

/** Paints where a shadow was actually configured. */
const shadowed = (seen) =>
  seen.filter(
    (s) =>
      s.color &&
      s.color !== "" &&
      s.color !== "rgba(0, 0, 0, 0)" &&
      (s.blur > 0 || s.dx !== 0 || s.dy !== 0),
  );

function boxWithShadow(over) {
  editor.doc = {
    frame: {
      name: "F",
      w: 900,
      h: 600,
      bg: "#ffffff",
      // An explicit empty list stays empty. Artboards paint their own drop
      // shadow — rgba(0,0,0,.13) at blur 18/zoom — and the probe below cannot
      // tell that chrome from the object's shadow, so the fixture has none.
      artboards: [],
      children: [
        {
          type: "rect",
          name: "Box",
          x: 350,
          y: 220,
          w: 200,
          h: 160,
          fill: { kind: "solid", color: "#3b6df0" },
          effects: { shadow: { on: true, ...over } },
        },
      ],
    },
  };
  return editor.doc.frame.children[0];
}

beforeAll(() => {
  ({ editor, ctx } = loadEditor());
  /* The per-object paint cache renders an object into a bitmap once and blits
   * it thereafter, so the shared context sees a drawImage and none of the
   * state the effect set. That is correct for the app and useless for
   * inspecting a draw path, so these tests watch the uncached route. */
  editor.paintCacheOff = true;
});

describe("shadow — reaches the canvas", () => {
  it("configures no shadow while it is off", () => {
    boxWithShadow({ on: false });
    const seen = recordShadowAtPaint(ctx);
    editor.render();
    expect(shadowed(seen)).toHaveLength(0);
  });

  it("configures a shadow when it is on", () => {
    boxWithShadow({ y: 6, blur: 18 });
    const seen = recordShadowAtPaint(ctx);
    editor.render();
    expect(shadowed(seen).length, "the shadow never reached the canvas").toBeGreaterThan(0);
  });

  it("carries the offset it was given", () => {
    boxWithShadow({ x: 24, y: -12, blur: 4 });
    const seen = recordShadowAtPaint(ctx);
    editor.render();
    const s = shadowed(seen)[0];
    expect(s.dx).toBe(24);
    expect(s.dy).toBe(-12);
  });

  it("carries the blur it was given", () => {
    boxWithShadow({ blur: 33 });
    const seen = recordShadowAtPaint(ctx);
    editor.render();
    expect(shadowed(seen)[0].blur).toBe(33);
  });

  it("folds alpha into the shadow colour rather than dropping it", () => {
    boxWithShadow({ blur: 10, color: "#ff0000", alpha: 0.5 });
    const seen = recordShadowAtPaint(ctx);
    editor.render();
    const c = shadowed(seen)[0].color;
    expect(c).toMatch(/rgba?\(/);
    expect(c, "the alpha must survive into the colour").toMatch(/0?\.5/);
  });

  it("honours its blend mode", () => {
    boxWithShadow({ blur: 10, blend: "multiply" });
    const seen = recordShadowAtPaint(ctx);
    editor.render();
    expect(shadowed(seen)[0].composite).toBe("multiply");
  });
});

describe("shadow — the document model", () => {
  it("clamps offsets, blur and spread into their documented ranges", () => {
    const o = boxWithShadow({ x: 9999, y: -9999, blur: 9999, spread: 9999, alpha: 9 });
    const s = o.effects.shadow;
    expect(s.x).toBe(100);
    expect(s.y).toBe(-100);
    expect(s.blur).toBe(150);
    expect(s.spread).toBe(100);
    expect(s.alpha).toBe(1);
  });

  it("rejects a colour that is not a hex triplet", () => {
    expect(boxWithShadow({ color: "rebeccapurple" }).effects.shadow.color).toBe("#000000");
  });

  it("keeps effects.shadow a live alias of its fx-stack entry", () => {
    // the aliasing rule: rebuilding one without the other desyncs them silently
    const o = boxWithShadow({ blur: 12 });
    const entry = (o.fx || []).find((e) => e.type === "shadow");
    expect(entry, "shadow must have a stack entry").toBeTruthy();
    expect(entry.params).toBe(o.effects.shadow);
  });
});

describe("shadow — the panel reaches the whole model", () => {
  /** Open an object's Shadow section and return its container. */
  function openShadow(over) {
    const o = boxWithShadow(over);
    editor.setSelIds(new Set([o.id]));
    editor.refresh();
    const head = document.querySelector('#fxBody [data-fxsect="Shadow"]');
    if (head && head.getAttribute("aria-expanded") !== "true")
      /** @type {HTMLElement} */ (head).click();
    return { o, sect: head && head.nextElementSibling };
  }

  function drive(el, value) {
    el.value = String(value);
    el.dispatchEvent(new window.Event("input", { bubbles: true }));
  }

  it("offers every parameter the model carries", () => {
    // spread and blend were modelled, clamped and drawn — with no control, so
    // spread could only ever be 0 and blend only ever normal
    const { sect } = openShadow({ blur: 10 });
    for (const id of ["shX", "shY", "shBlur", "shSpread", "shA", "shC", "shBlend"]) {
      expect(sect.querySelector("#" + id), `${id} is missing from the panel`).toBeTruthy();
    }
  });

  it("lets the sliders reach the model's full clamped range", () => {
    // the panel used to stop at +/-60 offset and 120 blur against clamps of
    // +/-100 and 150, so part of every document was uneditable
    const { sect } = openShadow({ blur: 10 });
    const range = (id) => {
      const el = /** @type {HTMLInputElement} */ (sect.querySelector("#" + id));
      return [Number(el.min), Number(el.max)];
    };
    expect(range("shX")).toEqual([-100, 100]);
    expect(range("shY")).toEqual([-100, 100]);
    expect(range("shBlur")).toEqual([0, 150]);
    expect(range("shSpread")).toEqual([0, 100]);
  });

  it("writes each control through to the effect", () => {
    const { o, sect } = openShadow({ blur: 10 });
    drive(sect.querySelector("#shX"), 42);
    drive(sect.querySelector("#shY"), -18);
    drive(sect.querySelector("#shBlur"), 90);
    drive(sect.querySelector("#shSpread"), 12);
    drive(sect.querySelector("#shA"), 60);
    expect(o.effects.shadow).toMatchObject({ x: 42, y: -18, blur: 90, spread: 12 });
    expect(o.effects.shadow.alpha).toBeCloseTo(0.6);
  });

  it("carries spread into the draw, where it strokes the caster", () => {
    // spread grows the shadow WITHOUT blurring: the caster is stroked at
    // spread*2 before the fill, so a spread shadow paints one more stroke
    const seen = [];
    const countStrokes = () => ctx.calls.filter((c) => c.name === "stroke").length;
    boxWithShadow({ blur: 8, spread: 0 });
    ctx.calls.length = 0;
    editor.render();
    seen.push(countStrokes());
    boxWithShadow({ blur: 8, spread: 20 });
    ctx.calls.length = 0;
    editor.render();
    seen.push(countStrokes());
    expect(seen[1], "spread must add a stroked pass").toBeGreaterThan(seen[0]);
  });
});
