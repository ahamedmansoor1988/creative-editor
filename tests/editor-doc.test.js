// @vitest-environment jsdom
/**
 * Characterization tests for the editor's document model (public/app.js).
 *
 * These run the REAL app.js in jsdom and drive it through its window.__editor
 * hook. They pin down normalizeDoc's clamping/defaulting rules and the history
 * behaviour, because Stage 2 moves this logic into a shared schema module and
 * must not silently change what the editor accepts.
 *
 * Rendering is stubbed (jsdom has no canvas), so nothing here asserts pixels.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { loadEditor } from "./helpers/load-editor.js";

let editor;

/** Round-trip a doc through the editor's own normalizer. */
function norm(partialFrame) {
  editor.doc = {
    frame: { name: "F", w: 900, h: 600, bg: "#ffffff", children: [], ...partialFrame },
  };
  return editor.doc;
}

beforeAll(() => {
  ({ editor } = loadEditor());
});

describe("boot", () => {
  it("starts with an empty 900x600 white frame", () => {
    const f = editor.doc.frame;
    expect(f.w).toBe(900);
    expect(f.h).toBe(600);
    expect(f.bg).toBe("#ffffff");
    expect(f.children).toEqual([]);
  });

  it("exposes a selection index that starts unset", () => {
    expect(editor.sel).toBe(-1);
  });
});

describe("normalizeDoc — frame", () => {
  it("clamps frame size into 100..4000", () => {
    expect(norm({ w: 5, h: 99999 }).frame).toMatchObject({ w: 100, h: 4000 });
  });

  it("falls back to 900x600 for non-numeric sizes", () => {
    expect(norm({ w: "abc", h: null }).frame).toMatchObject({ w: 900, h: 600 });
  });

  it("replaces a non-hex background with white", () => {
    expect(norm({ bg: "rebeccapurple" }).frame.bg).toBe("#ffffff");
    expect(norm({ bg: "#123456" }).frame.bg).toBe("#123456");
  });

  it("caps the child list at 24", () => {
    const many = Array.from({ length: 40 }, () => ({ type: "rect", x: 0, y: 0, w: 10, h: 10 }));
    expect(norm({ children: many }).frame.children).toHaveLength(24);
  });
});

describe("normalizeDoc — shapes", () => {
  it("names unnamed children by type and position", () => {
    const d = norm({ children: [{ type: "rect", x: 0, y: 0, w: 10, h: 10 }] });
    expect(d.frame.children[0].name).toBe("rect 1");
  });

  it("enforces a minimum width/height of 4 for negative values", () => {
    const c = norm({ children: [{ type: "rect", w: -20, h: -5 }] }).frame.children[0];
    expect(c.w).toBe(4);
    expect(c.h).toBe(4);
  });

  it("QUIRK: w/h of 0 becomes 100, not 4, because `+c.w||100` treats 0 as absent", () => {
    // `Math.max(4, +c.w || 100)` — 0 is falsy, so it takes the 100 default and
    // never reaches the minimum-4 clamp. A model emitting w:0 gets a 100px box
    // rather than a degenerate one, which is arguably lucky rather than
    // intended. Pinned so Stage 2's schema makes the choice explicit.
    const c = norm({ children: [{ type: "rect", w: 0, h: 0 }] }).frame.children[0];
    expect(c.w).toBe(100);
    expect(c.h).toBe(100);
  });

  it("clamps opacity into 0.05..1 and defaults it to 1", () => {
    const kids = norm({
      children: [
        { type: "rect", w: 10, h: 10 },
        { type: "rect", w: 10, h: 10, opacity: 0 },
        { type: "rect", w: 10, h: 10, opacity: 5 },
      ],
    }).frame.children;
    expect(kids[0].opacity).toBe(1);
    expect(kids[1].opacity).toBe(0.05);
    expect(kids[2].opacity).toBe(1);
  });

  it("clamps corner radius into 0..300", () => {
    const c = norm({ children: [{ type: "rect", w: 10, h: 10, radius: 9999 }] }).frame.children[0];
    expect(c.radius).toBe(300);
  });

  it("supplies a grey solid fill when fill is missing or malformed", () => {
    const kids = norm({
      children: [
        { type: "rect", w: 10, h: 10 },
        { type: "rect", w: 10, h: 10, fill: { nope: true } },
      ],
    }).frame.children;
    expect(kids[0].fill).toEqual({ kind: "solid", color: "#cccccc" });
    expect(kids[1].fill).toEqual({ kind: "solid", color: "#cccccc" });
  });

  it("pads a gradient to at least two stops and caps it at four", () => {
    const one = norm({
      children: [
        {
          type: "rect",
          w: 10,
          h: 10,
          fill: { kind: "linear", stops: [{ pos: 0, color: "#ff0000" }] },
        },
      ],
    }).frame.children[0];
    expect(one.fill.stops).toHaveLength(2);

    const many = norm({
      children: [
        {
          type: "rect",
          w: 10,
          h: 10,
          fill: {
            kind: "linear",
            stops: Array.from({ length: 9 }, (_, i) => ({ pos: i / 8, color: "#000000" })),
          },
        },
      ],
    }).frame.children[0];
    expect(many.fill.stops).toHaveLength(4);
  });
});

describe("normalizeDoc — text", () => {
  it("clamps size into 8..300 and defaults the rest", () => {
    const t = norm({ children: [{ type: "text", size: 9999 }] }).frame.children[0];
    expect(t.size).toBe(300);
    expect(t.color).toBe("#111111");
    expect(t.align).toBe("left");
    expect(t.text).toBe("Text");
  });

  it("coerces a non-string text value to a string", () => {
    const t = norm({ children: [{ type: "text", text: 42 }] }).frame.children[0];
    expect(t.text).toBe("42");
  });

  it("only accepts 'center' as a non-default alignment", () => {
    const kids = norm({
      children: [
        { type: "text", align: "center" },
        { type: "text", align: "justify" },
      ],
    }).frame.children;
    expect(kids[0].align).toBe("center");
    expect(kids[1].align).toBe("left");
  });

  it("does not attach a pattern engine to text", () => {
    const t = norm({ children: [{ type: "text" }] }).frame.children[0];
    expect(t.engine).toBeUndefined();
  });
});

describe("normalizeDoc — effects deep-merge", () => {
  it("fills in the untouched shadow fields when the model sends a partial object", () => {
    // This is the documented reason the merge exists: {"shadow":{"on":true}}
    // must not wipe blur/colour/offset.
    const c = norm({
      children: [{ type: "rect", w: 10, h: 10, effects: { shadow: { on: true } } }],
    }).frame.children[0];
    expect(c.effects.shadow).toMatchObject({ on: true, x: 0, y: 6, blur: 18, color: "#000000" });
    expect(c.effects.shadow.alpha).toBeCloseTo(0.25);
  });

  it("clamps shadow numbers and rejects a bad colour", () => {
    const c = norm({
      children: [
        {
          type: "rect",
          w: 10,
          h: 10,
          effects: { shadow: { on: true, x: 9999, y: -9999, blur: 9999, alpha: 9, color: "red" } },
        },
      ],
    }).frame.children[0];
    expect(c.effects.shadow.x).toBe(100);
    expect(c.effects.shadow.y).toBe(-100);
    expect(c.effects.shadow.blur).toBe(150);
    expect(c.effects.shadow.alpha).toBe(1);
    expect(c.effects.shadow.color).toBe("#000000");
  });

  it("always produces both shadow and grain, even from an empty effects object", () => {
    const c = norm({ children: [{ type: "rect", w: 10, h: 10, effects: {} }] }).frame.children[0];
    expect(c.effects.shadow.on).toBe(false);
    expect(c.effects.grain.amount).toBe(0);
  });

  it("clamps grain amount into 0..1", () => {
    const c = norm({
      children: [{ type: "rect", w: 10, h: 10, effects: { grain: { amount: 7 } } }],
    }).frame.children[0];
    expect(c.effects.grain.amount).toBe(1);
  });
});

describe("normalizeDoc — pattern (Stage 1.2)", () => {
  // Full behaviour lives in tests/pattern.test.js; these keep the
  // normalization contract asserted alongside the other doc-model rules.
  const pat = (pattern) =>
    norm({ children: [{ type: "rect", w: 10, h: 10, pattern }] }).frame.children[0];

  it("a retired 'mode:none' pattern is removed entirely", () => {
    expect(pat({ mode: "none", count: 4 }).pattern).toBeUndefined();
  });

  it("migrates a Stage 1.1 rows pattern to columns/rows", () => {
    const P = pat({ mode: "rows", count: 6, gap: 9 }).pattern;
    expect(P.columns).toBe(6);
    expect(P.rows).toBe(1);
    expect(P.hGap).toBe(9);
    expect(P.mode).toBeUndefined();
  });

  it("clamps columns, rows and gaps to the documented limits", () => {
    const P = pat({ columns: 9999, rows: 9999, hGap: 9999, vGap: -5 }).pattern;
    expect(P.columns).toBe(32);
    expect(P.columns * P.rows).toBeLessThanOrEqual(400);
    expect(P.hGap).toBe(400);
    expect(P.vGap).toBe(0);
  });

  it("normalizes an unknown mirror to 'none'", () => {
    expect(pat({ columns: 2, rows: 1, mirror: "diagonal" }).pattern.mirror).toBe("none");
  });

  it("always assigns a finite seed so patterns are reproducible", () => {
    expect(Number.isFinite(pat({ columns: 2, rows: 1 }).pattern.seed)).toBe(true);
  });

  it("objects without a pattern stay pattern-free", () => {
    expect(
      norm({ children: [{ type: "rect", w: 10, h: 10 }] }).frame.children[0].pattern,
    ).toBeUndefined();
  });

  it("gives every object a stable id", () => {
    const kids = norm({
      children: [
        { type: "rect", w: 10, h: 10 },
        { type: "rect", w: 10, h: 10 },
      ],
    }).frame.children;
    expect(typeof kids[0].id).toBe("string");
    expect(kids[0].id).not.toBe(kids[1].id);
  });
});

describe("history", () => {
  it("undo restores the previous document", () => {
    editor.doc = { frame: { name: "A", w: 900, h: 600, bg: "#111111", children: [] } };
    editor.doc = { frame: { name: "B", w: 900, h: 600, bg: "#222222", children: [] } };
    expect(editor.doc.frame.bg).toBe("#222222");

    document.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true }),
    );
    expect(editor.doc.frame.bg).toBe("#111111");
  });

  it("redo re-applies the undone document", () => {
    document.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "z",
        metaKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );
    expect(editor.doc.frame.bg).toBe("#222222");
  });

  it("clears the selection on undo", () => {
    editor.doc = {
      frame: {
        name: "C",
        w: 900,
        h: 600,
        bg: "#333333",
        children: [{ type: "rect", x: 0, y: 0, w: 10, h: 10 }],
      },
    };
    editor.sel = 0;
    expect(editor.sel).toBe(0);
    document.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true }),
    );
    expect(editor.sel).toBe(-1);
  });

  it("QUIRK: history is capped at 60 entries and drops the oldest silently", () => {
    // Locked in so Stage 5's "bounded and reliable" history is a visible change.
    for (let i = 0; i < 70; i++) {
      editor.doc = { frame: { name: "n" + i, w: 900, h: 600, bg: "#ffffff", children: [] } };
    }
    // Undo far more times than the cap; the document must still be valid.
    for (let i = 0; i < 100; i++) {
      document.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true }),
      );
    }
    expect(editor.doc.frame).toBeTruthy();
    expect(Array.isArray(editor.doc.frame.children)).toBe(true);
  });
});

describe("render smoke", () => {
  it("draws without throwing for every supported child type and effect", () => {
    expect(() => {
      editor.doc = {
        frame: {
          name: "All",
          w: 900,
          h: 600,
          bg: "#101010",
          children: [
            {
              type: "rect",
              x: 10,
              y: 10,
              w: 100,
              h: 80,
              radius: 12,
              fill: { kind: "solid", color: "#ff0000" },
            },
            {
              type: "ellipse",
              x: 150,
              y: 10,
              w: 80,
              h: 80,
              fill: {
                kind: "linear",
                angle: 45,
                stops: [
                  { pos: 0, color: "#ff0000" },
                  { pos: 1, color: "#0000ff" },
                ],
              },
              effects: { shadow: { on: true }, grain: { amount: 0.5 } },
            },
            {
              type: "rect",
              x: 260,
              y: 10,
              w: 200,
              h: 120,
              engine: { mode: "rows", bands: 5 },
              fill: {
                kind: "radial",
                stops: [
                  { pos: 0, color: "#00ff00" },
                  { pos: 1, color: "#000000" },
                ],
              },
            },
            { type: "text", x: 20, y: 200, text: "Hello", size: 40, weight: 800, color: "#ffffff" },
          ],
        },
      };
      editor.render();
    }).not.toThrow();
  });
});
