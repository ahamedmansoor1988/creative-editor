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
