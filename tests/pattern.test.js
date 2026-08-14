// @vitest-environment jsdom
/**
 * Stage 1.2 — linked parent/instance pattern system.
 * Enforces docs/pattern-contract.md. Names map to the Stage 1.2 required-test
 * list; Stage 1.1 guarantees are re-asserted in the "carried forward" block.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { loadEditor } from "./helpers/load-editor.js";

let editor;

/** @returns {any} a plain parent object literal for test documents */
const parentOf = (over = {}) => ({
  type: "ellipse",
  name: "P",
  x: 100,
  y: 100,
  w: 60,
  h: 40,
  fill: { kind: "solid", color: "#ff0000" },
  ...over,
});

/** Load a doc containing one parent; return the normalized parent. */
function withParent(over = {}, pattern = null) {
  const child = parentOf(over);
  if (pattern) child.pattern = pattern;
  editor.doc = { frame: { name: "F", w: 900, h: 600, bg: "#ffffff", children: [child] } };
  return editor.doc.frame.children[0];
}
/** Axis-aligned visual bounds, the unit layout is defined in. */
const B = (o) => editor.instanceBounds(o);

beforeAll(() => {
  ({ editor } = loadEditor());
});

/* ------------------------------------------------------- 1-4 counts */

describe("1-4 — columns × rows, parent excluded", () => {
  it("1 — Columns 7, Rows 1 creates seven horizontal instances", () => {
    const p = withParent({}, { columns: 7, rows: 1, hGap: 5 });
    const inst = editor.patternInstances(p);
    expect(inst).toHaveLength(7);
    expect(new Set(inst.map((i) => Math.round(i.y))).size).toBe(1);
  });

  it("2 — Columns 1, Rows 5 creates five vertical instances", () => {
    const p = withParent({}, { columns: 1, rows: 5, vGap: 5 });
    const inst = editor.patternInstances(p);
    expect(inst).toHaveLength(5);
    expect(new Set(inst.map((i) => Math.round(i.x))).size).toBe(1);
  });

  it("3 — Columns 4, Rows 3 creates twelve grid instances", () => {
    const p = withParent({}, { columns: 4, rows: 3, hGap: 4, vGap: 4 });
    expect(editor.patternInstances(p)).toHaveLength(12);
  });

  it("4 — the parent is not counted among the instances", () => {
    const p = withParent({}, { columns: 3, rows: 2 });
    const inst = editor.patternInstances(p);
    expect(inst).toHaveLength(6);
    expect(inst.some((i) => i.id === p.id)).toBe(false);
    expect(editor.doc.frame.children).toHaveLength(1); // parent still standalone
  });
});

/* --------------------------------------------------- 5-8 exact gaps */

describe("5-8 — gap is exact clear space between ACTUAL bounds", () => {
  it("5 — zero horizontal gap: equal sizes touch exactly", () => {
    const p = withParent({}, { columns: 4, rows: 1, hGap: 0 });
    const inst = editor.patternInstances(p);
    for (let i = 1; i < inst.length; i++) {
      const prev = B(inst[i - 1]);
      expect(B(inst[i]).x - (prev.x + prev.w)).toBeCloseTo(0, 6);
    }
  });

  it("6 — zero horizontal gap: VARIED widths still touch (the Stage 1.1 bug)", () => {
    const p = withParent(
      {},
      { columns: 6, rows: 1, hGap: 0, widthVariation: 1, lockProportions: false, seed: 12345 },
    );
    const inst = editor.patternInstances(p);
    expect(new Set(inst.map((i) => Math.round(i.w))).size).toBeGreaterThan(1); // widths really vary
    for (let i = 1; i < inst.length; i++) {
      const prev = B(inst[i - 1]);
      expect(B(inst[i]).x - (prev.x + prev.w)).toBeCloseTo(0, 6);
    }
  });

  it("7 — zero vertical gap: varied heights leave no gap between row bands", () => {
    const p = withParent(
      {},
      { columns: 3, rows: 4, vGap: 0, heightVariation: 1, lockProportions: false, seed: 999 },
    );
    const inst = editor.patternInstances(p);
    const rows = [...new Set(inst.map((i) => i.instanceIndex % 3 === 0))]; // sanity
    expect(rows.length).toBeGreaterThan(0);
    // Row band = min top .. max bottom of that row's instances.
    const band = (r) => {
      const its = inst.filter((i) => Math.floor(i.instanceIndex / 3) === r).map(B);
      return { top: Math.min(...its.map((b) => b.y)), bot: Math.max(...its.map((b) => b.y + b.h)) };
    };
    for (let r = 1; r < 4; r++) expect(band(r).top - band(r - 1).bot).toBeCloseTo(0, 6);
  });

  it("8 — positive gaps produce exactly the requested clear spacing", () => {
    const hGap = 23,
      vGap = 11;
    const p = withParent({}, { columns: 3, rows: 2, hGap, vGap });
    const inst = editor.patternInstances(p);
    const a = B(inst[0]),
      b = B(inst[1]);
    expect(b.x - (a.x + a.w)).toBeCloseTo(hGap, 6);
    const r0 = B(inst[0]),
      r1 = B(inst[3]);
    expect(r1.y - (r0.y + r0.h)).toBeCloseTo(vGap, 6);
  });
});

/* ------------------------------------------------------- 9-13 size */

describe("9-13 — size controls", () => {
  it("9 — width variation is visibly effective at 100%", () => {
    const p = withParent({ w: 100 }, { columns: 8, rows: 1, widthVariation: 1, seed: 42 });
    const ws = editor.patternInstances(p).map((i) => i.w);
    expect(Math.max(...ws) - Math.min(...ws)).toBeGreaterThan(20);
    expect(Math.min(...ws)).toBeGreaterThan(0); // never zero/negative
  });

  it("10 — height variation is visibly effective at 100%", () => {
    const p = withParent(
      { h: 100 },
      { columns: 8, rows: 1, heightVariation: 1, lockProportions: false, seed: 42 },
    );
    const hs = editor.patternInstances(p).map((i) => i.h);
    expect(Math.max(...hs) - Math.min(...hs)).toBeGreaterThan(20);
  });

  it("0% variation makes every instance identical", () => {
    const p = withParent({}, { columns: 6, rows: 1, widthVariation: 0, heightVariation: 0 });
    const inst = editor.patternInstances(p);
    expect(new Set(inst.map((i) => `${i.w}x${i.h}`)).size).toBe(1);
  });

  it("11 — lock proportions preserves the parent aspect ratio", () => {
    const p = withParent(
      { w: 80, h: 40 },
      {
        columns: 8,
        rows: 1,
        widthVariation: 1,
        heightVariation: 1,
        lockProportions: true,
        seed: 5,
      },
    );
    editor.patternInstances(p).forEach((i) => expect(i.w / i.h).toBeCloseTo(2, 6));
  });

  it("12 — unlocked variation lets width and height differ independently", () => {
    const p = withParent(
      { w: 80, h: 40 },
      {
        columns: 8,
        rows: 1,
        widthVariation: 1,
        heightVariation: 1,
        lockProportions: false,
        seed: 5,
      },
    );
    const ratios = editor.patternInstances(p).map((i) => i.w / i.h);
    expect(new Set(ratios.map((r) => r.toFixed(3))).size).toBeGreaterThan(1);
  });

  it("13 — base scale resizes instances but never the parent", () => {
    const p = withParent({ w: 60, h: 40 }, { columns: 3, rows: 1, baseScale: 0.5 });
    editor.patternInstances(p).forEach((i) => {
      expect(i.w).toBeCloseTo(30, 6);
      expect(i.h).toBeCloseTo(20, 6);
    });
    expect(p.w).toBe(60);
    expect(p.h).toBe(40);
  });
});

/* ---------------------------------------------------- 14-15 offsets */

describe("14-15 — layout offsets", () => {
  it("14 — row offset X staggers successive rows", () => {
    const off = 25;
    const p = withParent({}, { columns: 2, rows: 3, hGap: 0, vGap: 0, rowOffsetX: off });
    const inst = editor.patternInstances(p);
    const rowX = (r) => inst.find((i) => i.instanceIndex === r * 2).x;
    expect(rowX(1) - rowX(0)).toBeCloseTo(off, 6);
    expect(rowX(2) - rowX(1)).toBeCloseTo(off, 6);
  });

  it("15 — column offset Y staggers successive columns", () => {
    const off = 14;
    const p = withParent({}, { columns: 3, rows: 2, hGap: 0, vGap: 0, colOffsetY: off });
    const inst = editor.patternInstances(p);
    const colY = (c) => inst.find((i) => i.instanceIndex === c).y;
    expect(colY(1) - colY(0)).toBeCloseTo(off, 6);
    expect(colY(2) - colY(1)).toBeCloseTo(off, 6);
  });
});

/* -------------------------------------------------- 16-19 transform */

describe("16-19 — transform", () => {
  it("16 — base rotation applies uniformly", () => {
    const p = withParent({}, { columns: 4, rows: 1, baseRotation: 30 });
    editor.patternInstances(p).forEach((i) => expect(i.rot).toBeCloseTo(30, 6));
  });

  it("17 — rotation progression follows sequence order", () => {
    const p = withParent({}, { columns: 4, rows: 1, baseRotation: 0, rotationStep: 15 });
    const rots = editor.patternInstances(p).map((i) => i.rot);
    expect(rots).toEqual([0, 15, 30, 45]);
  });

  it("18 — rotation variation is deterministic and bounded", () => {
    const mk = () =>
      editor
        .patternInstances(withParent({}, { columns: 6, rows: 1, rotationVariation: 40, seed: 77 }))
        .map((i) => i.rot);
    const a = mk(),
      b = mk();
    expect(a).toEqual(b);
    a.forEach((r) => expect(Math.abs(r)).toBeLessThanOrEqual(40 + 1e-9));
    expect(new Set(a.map((r) => r.toFixed(4))).size).toBeGreaterThan(1);
  });

  it("19 — mirror modes flip the documented instances", () => {
    const grab = (mirror) =>
      editor.patternInstances(withParent({}, { columns: 2, rows: 2, mirror }));
    expect(grab("none").every((i) => !i.mirrorX && !i.mirrorY)).toBe(true);
    expect(grab("horizontal").every((i) => i.mirrorX)).toBe(true);
    expect(grab("vertical").every((i) => i.mirrorY)).toBe(true);
    // alt-horizontal flips odd COLUMNS
    grab("alt-horizontal").forEach((i) => expect(i.mirrorX).toBe(i.instanceIndex % 2 === 1));
    // alt-vertical flips odd ROWS
    grab("alt-vertical").forEach((i) =>
      expect(i.mirrorY).toBe(Math.floor(i.instanceIndex / 2) % 2 === 1),
    );
  });

  it("25 — rotated bounds drive spacing: gap 0 still touches when rotated", () => {
    const p = withParent({}, { columns: 5, rows: 1, hGap: 0, baseRotation: 37 });
    const inst = editor.patternInstances(p);
    for (let i = 1; i < inst.length; i++) {
      const prev = B(inst[i - 1]);
      expect(B(inst[i]).x - (prev.x + prev.w)).toBeCloseTo(0, 6);
    }
    // and the pitch is the ROTATED width, not the unrotated parent width
    expect(B(inst[0]).w).toBeGreaterThan(p.w);
  });
});

/* ------------------------------------------------- 20-24 advanced */

describe("20-24 — jitter, holes, determinism", () => {
  it("20 — jitter is deterministic and bounded", () => {
    const mk = () =>
      editor
        .patternInstances(
          withParent({}, { columns: 5, rows: 1, hGap: 0, jitterX: 30, jitterY: 20, seed: 8 }),
        )
        .map((i) => ({ x: i.x, y: i.y }));
    const a = mk(),
      b = mk();
    expect(a).toEqual(b);
    const base = editor.patternInstances(withParent({}, { columns: 5, rows: 1, hGap: 0, seed: 8 }));
    a.forEach((v, n) => {
      expect(Math.abs(v.x - base[n].x)).toBeLessThanOrEqual(30 + 1e-9);
      expect(Math.abs(v.y - base[n].y)).toBeLessThanOrEqual(20 + 1e-9);
    });
  });

  it("21 — holes omit whole instances WITHOUT collapsing the remaining slots", () => {
    const none = editor.patternInstances(
      withParent({}, { columns: 6, rows: 2, holes: 0, seed: 3 }),
    );
    const holed = editor.patternInstances(
      withParent({}, { columns: 6, rows: 2, holes: 0.5, seed: 3 }),
    );
    expect(holed.length).toBeLessThan(none.length);
    expect(holed.length).toBeGreaterThan(0);
    // every survivor sits exactly where it sat with no holes
    holed.forEach((i) => {
      const same = none.find((n) => n.instanceIndex === i.instanceIndex);
      expect(i.x).toBeCloseTo(same.x, 9);
      expect(i.y).toBeCloseTo(same.y, 9);
      expect(i.w).toBeCloseTo(same.w, 9); // whole instances, never fragments
    });
  });

  it("22 — the parent is never omitted by holes", () => {
    const p = withParent({}, { columns: 4, rows: 4, holes: 0.9, seed: 1 });
    expect(editor.doc.frame.children).toHaveLength(1);
    expect(editor.doc.frame.children[0].id).toBe(p.id);
  });

  it("23/24 — layout is byte-identical across redraws and JSON round-trips", () => {
    const p = withParent(
      {},
      { columns: 5, rows: 3, widthVariation: 0.8, rotationVariation: 30, jitterX: 10, holes: 0.2 },
    );
    const a = JSON.stringify(editor.patternInstances(p));
    expect(JSON.stringify(editor.patternInstances(p))).toBe(a);
    editor.doc = JSON.parse(JSON.stringify(editor.doc));
    expect(JSON.stringify(editor.patternInstances(editor.doc.frame.children[0]))).toBe(a);
  });

  it("23 — reroll changes the seed's result and stays deterministic afterwards", () => {
    const p = withParent({}, { columns: 5, rows: 1, widthVariation: 0.9, seed: 1 });
    const s1 = JSON.stringify(editor.patternInstances(p));
    p.pattern.seed = 2;
    const s2 = JSON.stringify(editor.patternInstances(p));
    expect(s2).not.toBe(s1);
    expect(JSON.stringify(editor.patternInstances(p))).toBe(s2);
  });
});

/* ------------------------------------------------ 26-28 validation */

describe("26-28 — limits and malformed input", () => {
  it("26 — maximum instance count is enforced predictably (rows shed, never partial)", () => {
    const { MAX_PATTERN_INSTANCES } = editor.limits;
    const p = withParent({}, { columns: 32, rows: 32 }); // 1024 requested
    expect(p.pattern.columns).toBe(32);
    expect(p.pattern.columns * p.pattern.rows).toBeLessThanOrEqual(MAX_PATTERN_INSTANCES);
    const inst = editor.patternInstances(p);
    expect(inst.length).toBe(p.pattern.columns * p.pattern.rows); // a whole grid
    expect(inst.length).toBeLessThanOrEqual(MAX_PATTERN_INSTANCES);
  });

  it("28 — non-finite and out-of-range values are normalized, never NaN", () => {
    const p = withParent(
      {},
      {
        columns: NaN,
        rows: Infinity,
        hGap: -50,
        baseScale: 99,
        widthVariation: 5,
        rotationVariation: -3,
        jitterX: 1e9,
        holes: 2,
        mirror: "sideways",
        seed: NaN,
      },
    );
    const P = p.pattern;
    expect(Number.isFinite(P.columns) && P.columns >= 1).toBe(true);
    expect(P.rows).toBeLessThanOrEqual(editor.limits.MAX_GRID_AXIS);
    expect(P.hGap).toBe(0);
    expect(P.baseScale).toBeLessThanOrEqual(2);
    expect(P.widthVariation).toBe(1);
    expect(P.rotationVariation).toBe(0);
    expect(P.jitterX).toBe(editor.limits.MAX_JITTER);
    expect(P.holes).toBe(editor.limits.MAX_HOLES);
    expect(P.mirror).toBe("none");
    expect(Number.isFinite(P.seed)).toBe(true);
    editor.patternInstances(p).forEach((i) => {
      expect(Number.isFinite(i.x) && Number.isFinite(i.y)).toBe(true);
      expect(i.w > 0 && i.h > 0).toBe(true);
    });
  });

  it("28 — a non-finite parent produces no instances rather than NaN geometry", () => {
    const p = withParent({}, { columns: 3, rows: 1 });
    p.w = NaN;
    expect(editor.patternInstances(p)).toHaveLength(0);
    p.w = 60;
    p.x = Infinity;
    expect(editor.patternInstances(p)).toHaveLength(0);
  });

  it("instances never recurse and text parents never generate", () => {
    const p = withParent({}, { columns: 3, rows: 1 });
    const inst = editor.patternInstances(p);
    expect(inst.every((i) => !i.pattern)).toBe(true);
    expect(editor.patternInstances(inst[0])).toHaveLength(0);
    editor.doc = {
      frame: {
        name: "F",
        w: 900,
        h: 600,
        bg: "#fff",
        children: [{ type: "text", text: "hi", x: 0, y: 0, pattern: { columns: 4, rows: 1 } }],
      },
    };
    expect(editor.allInstances()).toHaveLength(0);
  });
});

/* -------------------------------------------------- 27 migration */

describe("27 — migration from Stage 1.1 (and legacy engine)", () => {
  const mig = (pattern) => {
    editor.doc = {
      frame: { name: "F", w: 900, h: 600, bg: "#fff", children: [{ ...parentOf(), pattern }] },
    };
    return editor.doc.frame.children[0];
  };

  it("rows mode → rows 1, columns = previous count", () => {
    const P = mig({ mode: "rows", count: 7, gap: 12, seed: 5 }).pattern;
    expect(P.rows).toBe(1);
    expect(P.columns).toBe(7);
    expect(P.hGap).toBe(12);
    expect(P.vGap).toBe(12);
    expect(P.seed).toBe(5);
  });

  it("columns mode → columns 1, rows = previous count", () => {
    const P = mig({ mode: "columns", count: 4, gap: 3 }).pattern;
    expect(P.columns).toBe(1);
    expect(P.rows).toBe(4);
  });

  it("grid mode preserves previous rows and cols", () => {
    const P = mig({ mode: "grid", count: 3, rows: 2, cols: 5 }).pattern;
    expect(P.rows).toBe(2);
    expect(P.columns).toBe(5);
  });

  it("vary → both variations with proportions locked; empty → holes", () => {
    const P = mig({ mode: "rows", count: 3, vary: 0.4, empty: 0.25 }).pattern;
    expect(P.widthVariation).toBeCloseTo(0.4, 9);
    expect(P.heightVariation).toBeCloseTo(0.4, 9);
    expect(P.lockProportions).toBe(true);
    expect(P.holes).toBeCloseTo(0.25, 9);
  });

  it("mode 'none' removes the pattern entirely, and Coverage is dropped", () => {
    const c = mig({ mode: "none", count: 4 });
    expect(c.pattern).toBeUndefined();
    const P = mig({ mode: "rows", count: 3, window: 0.4 }).pattern;
    expect(P.window).toBeUndefined();
    expect("count" in P || "gap" in P || "mode" in P).toBe(false);
  });

  it("migration is idempotent", () => {
    const once = mig({
      mode: "grid",
      count: 3,
      rows: 2,
      cols: 5,
      vary: 0.3,
      empty: 0.1,
      seed: 9,
    }).pattern;
    const snapshot = JSON.stringify(once);
    editor.doc = JSON.parse(JSON.stringify(editor.doc)); // re-normalize
    expect(JSON.stringify(editor.doc.frame.children[0].pattern)).toBe(snapshot);
  });

  it("the oldest `engine` documents still migrate through to 1.2", () => {
    editor.doc = {
      frame: {
        name: "F",
        w: 900,
        h: 600,
        bg: "#fff",
        children: [{ ...parentOf(), engine: { mode: "mixed", bands: 6, gap: 7, seed: 11 } }],
      },
    };
    const c = editor.doc.frame.children[0];
    expect(c.engine).toBeUndefined();
    expect(c.pattern.columns).toBe(6);
    expect(c.pattern.rows).toBe(1);
    expect(c.pattern.hGap).toBe(7);
  });
});

/* ------------------------------------------- 29/33 carried forward */

describe("29/33 — Stage 1.1 guarantees still hold", () => {
  it("29 — parent fill, gradient, size and position all propagate", () => {
    const p = withParent({}, { columns: 3, rows: 2, hGap: 5, vGap: 5 });
    p.fill = {
      kind: "radial",
      stops: [
        { pos: 0, color: "#abcdef" },
        { pos: 1, color: "#123456" },
      ],
    };
    expect(editor.patternInstances(p).every((i) => i.fill.stops[0].color === "#abcdef")).toBe(true);

    const before = editor.patternInstances(p).map((i) => ({ x: i.x, y: i.y }));
    p.x += 40;
    p.y -= 15;
    editor.patternInstances(p).forEach((i, n) => {
      expect(i.x - before[n].x).toBeCloseTo(40, 6);
      expect(i.y - before[n].y).toBeCloseTo(-15, 6);
    });

    p.w = 120;
    expect(editor.patternInstances(p).every((i) => i.w === 120)).toBe(true);
  });

  it("deleting the parent removes its instances; duplication is independent", () => {
    withParent({}, { columns: 3, rows: 1 });
    editor.sel = 0;
    editor.duplicateSel();
    const [a, b] = editor.doc.frame.children;
    expect(b.id).not.toBe(a.id);
    expect(editor.patternInstances(b).every((i) => i.parentId === b.id)).toBe(true);
    editor.sel = 0;
    editor.deleteSel();
    expect(editor.allInstances().every((i) => i.parentId === b.id)).toBe(true);
  });

  it("33 — Remove pattern drops every instance and undo restores them", () => {
    withParent({}, { columns: 4, rows: 1 });
    expect(editor.allInstances()).toHaveLength(4);
    const p = editor.doc.frame.children[0];
    delete p.pattern;
    // The setter re-normalizes and pushes a history snapshot; a round-trip is
    // the honest way to commit an in-place edit the way the UI does.
    editor.doc = JSON.parse(JSON.stringify(editor.doc));
    expect(editor.allInstances()).toHaveLength(0);
    document.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true }),
    );
    expect(editor.allInstances()).toHaveLength(4);
    document.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "z",
        metaKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );
    expect(editor.allInstances()).toHaveLength(0);
  });
});

/* --------------------------------------------------- 30/34 render */

describe("30/34 — rendering and retired controls", () => {
  it("30 — draws one complete path per object: 1 parent + N instances", () => {
    const { ctx } = loadEditor();
    window.__editor.doc = {
      frame: {
        name: "F",
        w: 900,
        h: 600,
        bg: "#fff",
        children: [{ ...parentOf({ type: "ellipse" }), pattern: { columns: 3, rows: 1, hGap: 8 } }],
      },
    };
    ctx.calls.length = 0;
    window.__editor.render();
    expect(ctx.calls.filter((c) => c.name === "ellipse").length).toBe(4); // parent + 3
    expect(ctx.calls.filter((c) => c.name === "rect").length).toBe(0); // no rectangular slices
  });

  it("rotation and mirror reach the canvas transform", () => {
    const { ctx } = loadEditor();
    window.__editor.doc = {
      frame: {
        name: "F",
        w: 900,
        h: 600,
        bg: "#fff",
        children: [
          {
            ...parentOf({ type: "ellipse" }),
            pattern: { columns: 2, rows: 1, baseRotation: 45, mirror: "horizontal" },
          },
        ],
      },
    };
    ctx.calls.length = 0;
    window.__editor.render();
    expect(ctx.calls.some((c) => c.name === "rotate")).toBe(true);
    expect(ctx.calls.some((c) => c.name === "scale" && c.args[0] === -1)).toBe(true);
  });

  it("34 — Coverage, Empty slots and Off are gone from the model", () => {
    const p = withParent({}, { columns: 3, rows: 1 });
    expect("window" in p.pattern).toBe(false);
    expect("empty" in p.pattern).toBe(false);
    expect("mode" in p.pattern).toBe(false);
    // "no pattern" is the absence of the object, not a mode
    delete p.pattern;
    expect(editor.patternInstances(p)).toHaveLength(0);
  });
});
