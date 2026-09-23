// @vitest-environment jsdom
/**
 * The fill colour row colours the selected mesh point.
 *
 * A mesh replaces the fill, so the fill's own colour changes nothing on
 * screen. Mansoor selected a mesh handle, set the Fill colour to yellow, and
 * watched the mesh stay blue (23 Sep 2026). With a point selected the row
 * now edits that point — the same value the Mesh step's control edits — and
 * with none it says why it will not show and how to pick one.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { loadEditor } from "./helpers/load-editor.js";

const FX_ONLY = ["mesh", "shadow", "iridescent", "reed", "fractal", "noise", "divider", "beam"];
let editor;
beforeAll(() => {
  ({ editor } = loadEditor({ fxOnly: FX_ONLY }));
});

const meshDoc = () => ({
  frame: {
    name: "F",
    w: 600,
    h: 400,
    bg: "#ffffff",
    children: [
      {
        type: "rect",
        name: "Field",
        x: 0,
        y: 0,
        w: 600,
        h: 400,
        fill: { kind: "solid", color: "#3b6df0" },
        effects: {
          mesh: {
            on: true,
            cols: 2,
            rows: 2,
            points: [
              { x: 0, y: 0, color: [40, 80, 220] },
              { x: 1, y: 0, color: [120, 160, 255] },
              { x: 0, y: 1, color: [200, 220, 255] },
              { x: 1, y: 1, color: [60, 110, 240] },
            ],
          },
        },
      },
    ],
  },
});

describe("with a mesh point selected", () => {
  it("the fill's colour row becomes the point's, and editing it recolours the point", () => {
    editor.doc = meshDoc();
    editor.sel = 0;
    editor.setMeshEdit(true);
    editor.meshSel = 2;
    const row = /** @type {HTMLInputElement} */ (document.getElementById("apMeshCol"));
    expect(row).toBeTruthy();
    expect(row.value).toBe("#c8dcff"); // the point's own colour, [200,220,255]
    expect(document.querySelector(".apColor")).toBeNull(); // not the fill's
    row.value = "#ffd60a";
    row.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(editor.doc.frame.children[0].effects.mesh.points[2].color).toEqual([255, 214, 10]);
    // the fill itself is untouched: it is what shows if the mesh is switched off
    expect(editor.doc.frame.children[0].fill.color).toBe("#3b6df0");
  });

  it("with no point selected, the fill row stays and says how to pick one", () => {
    editor.doc = meshDoc();
    editor.sel = 0;
    editor.setMeshEdit(true);
    editor.meshSel = null;
    expect(document.getElementById("apMeshCol")).toBeNull();
    expect(document.querySelector(".apColor")).toBeTruthy();
    expect(document.body.textContent).toMatch(
      /Replaced by Mesh gradient — click a handle on the canvas/,
    );
  });

  it("a plain fill keeps its ordinary colour row and no hint", () => {
    const d = meshDoc();
    delete d.frame.children[0].effects;
    editor.doc = d;
    editor.sel = 0;
    expect(document.querySelector(".apColor")).toBeTruthy();
    expect(document.getElementById("apMeshCol")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Replaced by Mesh gradient/);
  });
});
