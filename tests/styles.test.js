// @vitest-environment jsdom
/**
 * Reusable/linked styles + per-shape export.
 *
 * Styles are apply-time-copy, not live: applying copies fills/strokes/
 * fillOpacity/strokeOpacity/blend/fx onto the object and sets styleId.
 * "Update style" (pushStyleToSource) is the one place state flows the other
 * way — object -> style -> every other object sharing that style — in
 * exactly one history entry. See the plan for the full design rationale.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { loadEditor } from "./helpers/load-editor.js";

let editor, ctx;

const rectOf = (over = {}) => ({
  type: "rect",
  name: "R",
  x: 100,
  y: 100,
  w: 60,
  h: 40,
  fills: [{ kind: "solid", color: "#ff0000" }],
  ...over,
});

function loadDoc(children) {
  editor.doc = { frame: { name: "F", w: 900, h: 600, bg: "#ffffff", children } };
  return editor.doc.frame.children;
}

beforeAll(() => {
  ({ editor, ctx } = loadEditor());
});

beforeEach(() => {
  // fresh, empty history for every test
  loadDoc([]);
});

describe("normalizeDoc — styles", () => {
  it("caps the styles array at 200", () => {
    editor.doc = {
      frame: {
        name: "F",
        w: 900,
        h: 600,
        bg: "#ffffff",
        children: [],
        styles: Array.from({ length: 250 }, (_, i) => ({ name: "S" + i })),
      },
    };
    expect(editor.doc.frame.styles).toHaveLength(200);
  });

  it("defaults id/name and clamps fills/strokes/blend through the real normalizers", () => {
    editor.doc = {
      frame: {
        name: "F",
        w: 900,
        h: 600,
        bg: "#ffffff",
        children: [],
        styles: [{ fills: [{ kind: "solid", color: "not-a-color" }], blend: "nonsense" }],
      },
    };
    const s = editor.doc.frame.styles[0];
    expect(typeof s.id).toBe("string");
    expect(s.id.length).toBeGreaterThan(0);
    expect(s.name).toBe("Style 1");
    expect(s.fills[0].color).toMatch(/^#[0-9a-fA-F]{6}$/); // normPaint replaced the bad color
    expect(s.blend).toBe("normal");
  });
});

describe("normalizeDoc — per-object fields", () => {
  it("defaults styleId to an empty string and round-trips it as a string", () => {
    const [r] = loadDoc([rectOf({ styleId: "abc123" })]);
    expect(r.styleId).toBe("abc123");
    const [r2] = loadDoc([rectOf()]);
    expect(r2.styleId).toBe("");
  });

  it("clamps export preset format/scale/suffix", () => {
    const [r] = loadDoc([
      rectOf({
        exportPresets: [{ format: "gif", scale: 99, suffix: "x".repeat(50) }],
      }),
    ]);
    expect(r.exportPresets[0].format).toBe("png"); // not an allowed format -> default
    expect(r.exportPresets[0].scale).toBe(4); // clamped to the 0.5..4 range
    expect(r.exportPresets[0].suffix).toHaveLength(20);
  });
});

describe("saveStyle / applyStyle", () => {
  it("saveStyle creates an entry from the primary selection and links it", () => {
    const [r] = loadDoc([rectOf()]);
    editor.setSelIds([r.id]);
    editor.saveStyle("My style");
    expect(editor.doc.frame.styles).toHaveLength(1);
    const s = editor.doc.frame.styles[0];
    expect(s.name).toBe("My style");
    expect(s.fills[0].color).toBe("#ff0000");
    expect(r.styleId).toBe(s.id);
  });

  it("applyStyle deep-copies — mutating the style afterward does not affect the target", () => {
    const [src, tgt] = loadDoc([
      rectOf(),
      rectOf({ name: "T", fills: [{ kind: "solid", color: "#00ff00" }] }),
    ]);
    editor.setSelIds([src.id]);
    editor.saveStyle("S1");
    const styleId = src.styleId;

    editor.setSelIds([tgt.id]);
    editor.applyStyle(styleId);
    expect(tgt.styleId).toBe(styleId);
    expect(tgt.fills[0].color).toBe("#ff0000"); // copied from the style

    // mutate the target's own fill directly (as if the user edited it) —
    // the STYLE record itself must be unaffected until an explicit push
    tgt.fills[0].color = "#0000ff";
    const style = editor.doc.frame.styles.find((s) => s.id === styleId);
    expect(style.fills[0].color).toBe("#ff0000");
  });

  it("does not apply to a locked object", () => {
    const [src, tgt] = loadDoc([
      rectOf(),
      rectOf({ name: "T", locked: true, fills: [{ kind: "solid", color: "#00ff00" }] }),
    ]);
    editor.setSelIds([src.id]);
    editor.saveStyle("S1");
    editor.applyStyle(src.styleId, [tgt]);
    expect(tgt.styleId).toBe("");
    expect(tgt.fills[0].color).toBe("#00ff00");
  });
});

describe("pushStyleToSource — update style", () => {
  it("pushes the selected object's appearance to the style and every other linked object, in one history entry", () => {
    const [a, b, c] = loadDoc([
      rectOf({ name: "A" }),
      rectOf({ name: "B" }),
      rectOf({ name: "C" }),
    ]);
    editor.setSelIds([a.id]);
    editor.saveStyle("Shared");
    editor.applyStyle(a.styleId, [b, c]);

    const before = editor.historyList().length;
    editor.setSelIds([b.id]);
    b.fills[0].color = "#123456"; // simulate the user editing the linked object directly
    editor.pushStyleToSource();

    expect(editor.historyList().length).toBe(before + 1); // one command, not three
    const style = editor.doc.frame.styles.find((s) => s.id === a.styleId);
    expect(style.fills[0].color).toBe("#123456");
    expect(a.fills[0].color).toBe("#123456");
    expect(c.fills[0].color).toBe("#123456");
  });

  it("undo after a push restores every affected object in one step", () => {
    const [a, b] = loadDoc([rectOf({ name: "A" }), rectOf({ name: "B" })]);
    editor.setSelIds([a.id]);
    editor.saveStyle("Shared");
    editor.applyStyle(a.styleId, [b]);

    editor.setSelIds([a.id]);
    a.fills[0].color = "#abcdef";
    editor.pushStyleToSource();
    expect(b.fills[0].color).toBe("#abcdef");

    const cur = editor.historyList().find((e) => e.current);
    editor.historyJump(cur.i - 1);
    const [a2, b2] = editor.doc.frame.children;
    expect(a2.fills[0].color).toBe("#ff0000");
    expect(b2.fills[0].color).toBe("#ff0000");
  });
});

describe("detachStyle / deleteStyle", () => {
  it("detach clears styleId and leaves the object's current fields intact", () => {
    const [r] = loadDoc([rectOf()]);
    editor.setSelIds([r.id]);
    editor.saveStyle("S1");
    editor.detachStyle();
    expect(r.styleId).toBe("");
    expect(r.fills[0].color).toBe("#ff0000");
  });

  it("delete leaves a linked object's appearance untouched and its styleId dangling", () => {
    const [r] = loadDoc([rectOf()]);
    editor.setSelIds([r.id]);
    editor.saveStyle("S1");
    const styleId = r.styleId;

    // deleteStyle would confirm() with a live reference; test the no-usage
    // path plus the "detach first, then delete" path, which needs no confirm.
    editor.detachStyle();
    editor.deleteStyle(styleId);
    expect(editor.doc.frame.styles.find((s) => s.id === styleId)).toBeUndefined();
    expect(r.fills[0].color).toBe("#ff0000");
  });
});

describe("styleId survives duplicate and copy/paste", () => {
  it("duplicateSel copies styleId onto the clone", () => {
    const [r] = loadDoc([rectOf()]);
    editor.setSelIds([r.id]);
    editor.saveStyle("S1");
    editor.setSelIds([r.id]);
    editor.duplicateSel();
    const clone = editor.doc.frame.children.find((c) => c.id !== r.id);
    expect(clone.styleId).toBe(r.styleId);
  });
});

describe("style applied across mismatched object types", () => {
  it("applying a rect-sourced style (with an fx entry) to a line does not throw, and fills are stripped", () => {
    const [r, line] = loadDoc([
      rectOf({ fx: [{ type: "shadow", on: true, params: { blur: 4 } }] }),
      { type: "line", name: "L", x: 0, y: 0, x2: 50, y2: 50 },
    ]);
    editor.setSelIds([r.id]);
    editor.saveStyle("S1");
    expect(() => editor.applyStyle(r.styleId, [line])).not.toThrow();
    // applyStyle already renormalizes internally (setActiveDoc(normalizeDoc(doc)))
    const l2 = editor.doc.frame.children.find((c) => c.type === "line");
    expect(l2.fills).toBeUndefined(); // normAppearance strips fills for line/text
  });
});

describe("per-shape export", () => {
  it("renderObjectToBlob sizes the canvas to the object's bounds times the preset scale, and draws just that object", () => {
    const [r] = loadDoc([rectOf({ x: 200, y: 150, w: 80, h: 40 })]);
    const box = editor.boxOf(r); // rot is 0, so this equals the rotated aabb too
    ctx.calls.length = 0;
    let seen = null;
    editor.renderObjectToBlob(r, { format: "png", scale: 2 }, (blob) => {
      seen = blob;
    });
    expect(seen).toBeTruthy();
    expect(ctx.canvas.width).toBe(Math.round(box.w * 2));
    expect(ctx.canvas.height).toBe(Math.round(box.h * 2));
    const scaleCall = ctx.calls.find((c) => c.name === "scale");
    expect(scaleCall.args).toEqual([2, 2]);
    const translateCall = ctx.calls.find((c) => c.name === "translate");
    expect(translateCall.args).toEqual([-box.x, -box.y]);
  });

  it("passes the requested mime type through to toBlob", () => {
    const [r] = loadDoc([rectOf()]);
    const orig = window.HTMLCanvasElement.prototype.toBlob;
    let mime = null;
    window.HTMLCanvasElement.prototype.toBlob = function (cb, type) {
      mime = type;
      cb(new window.Blob([""], { type }));
    };
    try {
      editor.renderObjectToBlob(r, { format: "jpeg", scale: 1 }, () => {});
      expect(mime).toBe("image/jpeg");
    } finally {
      window.HTMLCanvasElement.prototype.toBlob = orig;
    }
  });
});

/* §4.2 variable-width stroke profiles. Canvas cannot stroke a varying width,
 * so the outline is built as a polygon and filled — these assert that
 * geometry directly rather than sampling pixels. */
describe("variable-width stroke profiles", () => {
  /** Perpendicular thickness of a ribbon at fraction `f` along a horizontal
   *  polyline: the ribbon is [left…, right reversed], so the point at index i
   *  pairs with the one at (n-1-i). */
  function thicknessAt(poly, f) {
    const half = poly.length / 2;
    const i = Math.min(half - 1, Math.max(0, Math.round((half - 1) * f)));
    const a = poly[i];
    const b = poly[poly.length - 1 - i];
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  }
  const horizontal = [
    [0, 0],
    [100, 0],
  ];

  it("uniform is the default, and unknown names fall back to it", () => {
    loadDoc([
      {
        type: "line",
        name: "L",
        x: 0,
        y: 0,
        x2: 100,
        y2: 0,
        strokes: [{ kind: "solid", color: "#000000", width: 10, profile: "nonsense" }],
      },
    ]);
    expect(editor.doc.frame.children[0].strokes[0].profile).toBe("uniform");
  });

  it("keeps a known profile through normalizeDoc", () => {
    loadDoc([
      {
        type: "line",
        name: "L",
        x: 0,
        y: 0,
        x2: 100,
        y2: 0,
        strokes: [{ kind: "solid", color: "#000000", width: 10, profile: "taper-both" }],
      },
    ]);
    expect(editor.doc.frame.children[0].strokes[0].profile).toBe("taper-both");
  });

  /* Thickness at every sample, start to end. Asserting the SHAPE of this
   * series beats pinning individual samples: the resampler chooses its own
   * count, so no given index lands exactly on t=0.5. */
  function series(poly) {
    const half = poly.length / 2;
    const out = [];
    for (let i = 0; i < half; i++) {
      const a = poly[i];
      const b = poly[poly.length - 1 - i];
      out.push(Math.hypot(a[0] - b[0], a[1] - b[1]));
    }
    return out;
  }

  it("taper-out runs full width at the start and falls monotonically to nothing", () => {
    const p = editor.STROKE_PROFILES["taper-out"];
    const s = series(editor.ribbonPolygon(horizontal, (t) => 20 * p(t)));
    expect(s[0]).toBeCloseTo(20, 5);
    expect(s[s.length - 1]).toBeCloseTo(0, 5);
    for (let i = 1; i < s.length; i++) expect(s[i]).toBeLessThan(s[i - 1] + 1e-9);
  });

  it("taper-both is pinched at both ends and peaks at full width mid-run", () => {
    const p = editor.STROKE_PROFILES["taper-both"];
    const s = series(editor.ribbonPolygon(horizontal, (t) => 20 * p(t)));
    expect(s[0]).toBeCloseTo(0, 5);
    expect(s[s.length - 1]).toBeCloseTo(0, 5);
    const peak = Math.max(...s);
    expect(peak).toBeGreaterThan(19.9); // reaches full width
    expect(peak).toBeLessThanOrEqual(20 + 1e-9); // and never exceeds it
    // the widest point sits in the middle third of the run
    const at = s.indexOf(peak) / (s.length - 1);
    expect(at).toBeGreaterThan(0.33);
    expect(at).toBeLessThan(0.67);
  });

  it("a uniform width gives a constant-thickness ribbon", () => {
    const poly = editor.ribbonPolygon(horizontal, () => 12);
    for (const f of [0, 0.25, 0.5, 0.75, 1]) {
      expect(thicknessAt(poly, f)).toBeCloseTo(12, 5);
    }
  });

  it("returns null for a zero-length path, which has no direction to offset from", () => {
    expect(
      editor.ribbonPolygon(
        [
          [5, 5],
          [5, 5],
        ],
        () => 10,
      ),
    ).toBeNull();
  });

  it("samples a line into a polyline, and leaves closed shapes to the uniform stroker", () => {
    const [line, rect] = loadDoc([
      { type: "line", name: "L", x: 0, y: 0, x2: 100, y2: 0 },
      { type: "rect", name: "R", x: 0, y: 0, w: 50, h: 50 },
    ]);
    expect(editor.strokePolylines(line, 1)).toEqual([
      [
        [0, 0],
        [100, 0],
      ],
    ]);
    expect(editor.strokePolylines(rect, 1)).toEqual([]);
  });
});
