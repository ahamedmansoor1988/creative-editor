// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
import { loadEditor } from "./helpers/load-editor.js";

let editor;
beforeAll(() => ({ editor } = loadEditor()));

function card() {
  editor.doc = { frame: { name: "Recipe", w: 600, h: 400, bg: "#fff", artboards: [], children: [{
    type: "rect", name: "Card", x: 100, y: 80, w: 240, h: 160,
    fill: { kind: "solid", color: "#456789" },
    effects: { glow: { on: true, type: "outer", radius: 18, alpha: .7 } },
  }] } };
  const o = editor.doc.frame.children[0];
  editor.setSelIds(new Set([o.id]));
  editor.refresh();
  return o;
}

describe("Effect Recipe inspector", () => {
  it("mounts one focused effect editor instead of every available editor", () => {
    card();
    expect(document.querySelector('#fxBody [data-fxsect="Effects"]')).toBeTruthy();
    expect(document.querySelector('#fxBody [data-fxsect="Glow"]')).toBeTruthy();
    expect(document.querySelector('#fxBody [data-fxsect="Shadow"]')).toBeFalsy();
    expect(document.querySelector("#recipeAdd")).toBeTruthy();
  });

  it("duplicates an effect as an independent parameter set", () => {
    const o = card();
    document.querySelector("#fxBody .fxDup").click();
    const glows = o.fx.filter((e) => e.type === "glow");
    expect(glows).toHaveLength(2);
    expect(glows[0].params).not.toBe(glows[1].params);
    glows[1].params.radius = 77;
    expect(glows[0].params.radius).toBe(18);
    expect(document.querySelectorAll("#fxBody .fxRow")).toHaveLength(2);
    expect(document.querySelectorAll("#fxBody .fxRow.active")).toHaveLength(1);
  });

  it("keeps duplicate parameters separate after document normalisation", () => {
    const o = card();
    const first = o.fx.find((e) => e.type === "glow");
    first.added = true;
    o.fx.splice(o.fx.indexOf(first) + 1, 0, {
      id: "second-glow", type: "glow", on: true, added: true,
      params: { ...first.params, radius: 64, color: "#ff0000" },
    });
    editor.doc = JSON.parse(editor.serializeDocument()).pages[0];
    const glows = editor.doc.frame.children[0].fx.filter((e) => e.type === "glow" && e.added);
    expect(glows).toHaveLength(2);
    expect(glows[0].params).not.toBe(glows[1].params);
    expect(glows.map((e) => e.params.radius)).toEqual([18, 64]);
  });
});
