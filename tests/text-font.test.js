// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
import { loadEditor } from "./helpers/load-editor.js";

let editor;
beforeAll(() => ({ editor } = loadEditor()));

function textDoc(over = {}) {
  editor.doc = {
    frame: {
      name: "T",
      w: 800,
      h: 600,
      bg: "#fff",
      artboards: [],
      children: [
        Object.assign(
          {
            type: "text",
            name: "Headline",
            x: 40,
            y: 40,
            text: "Hello world",
            size: 48,
            weight: 600,
            color: "#111111",
            align: "left",
            mode: "point",
            lineHeight: 1.2,
            tracking: 0,
          },
          over,
        ),
      ],
    },
  };
  editor.sel = 0;
  return editor.doc.frame.children[0];
}
const $ = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id));
const change = (id, value) => {
  $(id).value = value;
  $(id).dispatchEvent(new Event("change", { bubbles: true }));
};

describe("typography (docs/research/text-typography.md)", () => {
  it("a text layer carries a font family, Inter by default", () => {
    expect(textDoc().font).toBe("Inter");
    expect(textDoc({ font: "Playfair Display" }).font).toBe("Playfair Display");
  });

  it("the canvas font string names the family, then the fallback stack", () => {
    expect(editor.fontCss(textDoc({ font: "Playfair Display" }))).toBe(
      '600 48px "Playfair Display", Inter, -apple-system, sans-serif',
    );
    expect(editor.fontCss(textDoc())).toBe("600 48px Inter, -apple-system, sans-serif");
  });

  it("line height is a multiplier of the size; 0 means the font's own line box", () => {
    expect(editor.textLayout(textDoc({ lineHeight: 1.2 })).lh).toBeCloseTo(57.6, 3);
    const auto = textDoc({ lineHeight: 0 });
    expect(auto.lineHeight).toBe(0);
    expect(editor.textLayout(auto).lh).toBeGreaterThan(0);
  });

  it("a Google family is linked once, with its weight axis", () => {
    const t = textDoc({ font: "Playfair Display" });
    editor.ensureFont(t);
    editor.ensureFont(t);
    const links = /** @type {HTMLLinkElement[]} */ ([
      ...document.querySelectorAll('link[href*="fonts.googleapis.com"]'),
    ]).filter((l) => /Playfair\+Display:wght@400\.\.900/.test(l.href));
    expect(links).toHaveLength(1);
  });

  it("the Text page shows the rows with the layer's values", () => {
    textDoc({ font: "Lora", tracking: 2.5, caseTf: "upper" });
    expect($("txFont").value).toBe("Lora");
    expect($("txSize").value).toBe("48");
    expect($("txLH").value).toBe("120");
    expect($("txTrack").value).toBe("2.5");
    expect($("txCase").value).toBe("upper");
    expect($("txSizing").value).toBe("width");
    expect($("txValign")).toBeNull();
  });

  it("edits in place: a textarea over the layer, in its font, committed on Escape", () => {
    const t = textDoc({ font: "Lora" });
    const n0 = editor.historySize();
    editor.startTextEdit(t.id, true);
    const ta = /** @type {HTMLTextAreaElement} */ (document.getElementById("textEditor"));
    expect(ta).toBeTruthy();
    expect(ta.value).toBe("Hello world");
    expect(ta.style.font).toContain(`${48 * editor.view.z}px`); // the layer's size at the current zoom
    expect(ta.style.font).toContain("Lora");
    expect(editor.textEditId).toBe(t.id);
    ta.value = "Changed";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    expect(t.text).toBe("Changed");
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.getElementById("textEditor")).toBeNull();
    expect(editor.textEditId).toBeNull();
    expect(t.text).toBe("Changed");
    expect(editor.historySize()).toBe(n0 + 1);
  });

  it("editing the rows writes the layer and keeps history", () => {
    const t = textDoc();
    const n0 = editor.historySize();
    change("txSize", "64");
    expect(t.size).toBe(64);
    change("txLH", "150");
    expect(t.lineHeight).toBeCloseTo(1.5);
    change("txLH", "");
    expect(t.lineHeight).toBe(0);
    change("txTrack", "3");
    expect(t.tracking).toBe(3);
    change("txSizing", "fixed");
    expect(t.mode).toBe("area");
    expect(t.autosize).toBe("fixed");
    expect($("txValign")).toBeTruthy();
    change("txSizing", "width");
    expect(t.mode).toBe("point");
    expect(editor.historySize()).toBeGreaterThan(n0);
  });
});
