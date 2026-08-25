// @vitest-environment jsdom
/**
 * QA for the `mesh` gradient effect (§4.7), ported from public/lab-mesh.html.
 *
 * jsdom has no WebGL2, so the ENGINE cannot run here and nothing below asserts
 * a pixel — the surface itself was verified in the lab, against the
 * framebuffer, with the acceptance tests the brief specified. What these cover
 * is the part a port gets wrong: the seven places an effect type has to be
 * wired into, the clamps that repair a net arriving from a saved file or the
 * model, and the panel.
 *
 * The engine's absence is itself a supported state — every call site guards on
 * available() — so it is asserted rather than worked around.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loadEditor } from "./helpers/load-editor.js";

let editor;

function shapeWithMesh(over, type) {
  editor.doc = {
    frame: {
      name: "F",
      w: 900,
      h: 600,
      bg: "#ffffff",
      artboards: [],
      children: [
        {
          type: type || "rect",
          name: "M",
          x: 100,
          y: 100,
          w: 400,
          h: 300,
          fill: { kind: "solid", color: "#cccccc" },
          effects: { mesh: { on: true, ...over } },
        },
      ],
    },
  };
  return editor.doc.frame.children[0];
}

beforeAll(() => {
  ({ editor } = loadEditor());
  window.FxStack.READY.add("mesh");
});
afterAll(() => {
  window.FxStack.READY.delete("mesh");
});

describe("mesh — wired into the effect system", () => {
  it("is registered as a MATERIAL, not an overlay", () => {
    // the mesh IS what the shape shows; as an overlay it would paint over a
    // fill that is invisible but still casting the shadow
    expect(window.FxStack.slotOf("mesh")).toBe("material");
  });

  it("is offered on the shapes that can render it", () => {
    const pages = (t) => editor.FX_PAGES({ type: t, name: "x", x: 0, y: 0, w: 10, h: 10 });
    expect(pages("rect")).toContain("Mesh");
    expect(pages("path")).toContain("Mesh");
    expect(pages("text"), "text cannot carry a mesh").not.toContain("Mesh");
  });

  it("becomes the active material when switched on", () => {
    const o = shapeWithMesh({});
    const m = window.FxStack.activeMaterial(o.fx);
    expect(m && m.type).toBe("mesh");
  });

  it("keeps effects.mesh a live alias of its fx-stack entry", () => {
    const o = shapeWithMesh({});
    const entry = (o.fx || []).find((e) => e.type === "mesh");
    expect(entry.params).toBe(o.effects.mesh);
  });

  it("refuses to enable on a type that cannot render it", () => {
    expect(shapeWithMesh({}, "text").effects.mesh.on).toBe(false);
  });
});

describe("mesh — the net is repaired, not trusted", () => {
  it("fills an empty net with a default one", () => {
    // the default carries no points: sixteen of them in every object's
    // defaults would enter the compact-serialisation baseline for shapes that
    // never touch the effect
    const m = shapeWithMesh({}).effects.mesh;
    expect(m.points).toHaveLength(m.cols * m.rows);
  });

  it("rebuilds a net whose length disagrees with its grid", () => {
    // a short net is not partially usable — the surface would read past its
    // own data — so it is replaced rather than padded
    const m = shapeWithMesh({ cols: 4, rows: 4, points: [{ x: 0, y: 0, color: [1, 2, 3] }] })
      .effects.mesh;
    expect(m.points).toHaveLength(16);
  });

  it("clamps the grid to the engine's own limits", () => {
    expect(shapeWithMesh({ cols: 99, rows: 99 }).effects.mesh.cols).toBe(10);
    expect(shapeWithMesh({ cols: 0, rows: 0 }).effects.mesh.rows).toBe(4);
  });

  it("allows a point outside the box, which is how the edge is steered", () => {
    const pts = Array.from({ length: 16 }, () => ({ x: 1.15, y: -0.15, color: [10, 20, 30] }));
    const m = shapeWithMesh({ cols: 4, rows: 4, points: pts }).effects.mesh;
    expect(m.points[0].x).toBeCloseTo(1.15);
    expect(m.points[0].y).toBeCloseTo(-0.15);
  });

  it("clamps a colour channel and repairs a malformed one", () => {
    const pts = Array.from({ length: 16 }, () => ({ x: 0.5, y: 0.5, color: [999, -5, "x"] }));
    const m = shapeWithMesh({ cols: 4, rows: 4, points: pts }).effects.mesh;
    expect(m.points[0].color).toEqual([255, 0, 0]);
  });

  it("survives a compact round trip with its net intact", () => {
    const o = shapeWithMesh({ cols: 5, rows: 3 });
    o.effects.mesh.points[4].color = [1, 2, 3];
    const wire = editor.compactDoc({ frame: editor.doc.frame });
    editor.doc = JSON.parse(JSON.stringify(wire));
    const m = editor.doc.frame.children[0].effects.mesh;
    expect(m.cols).toBe(5);
    expect(m.rows).toBe(3);
    expect(m.points).toHaveLength(15);
    expect(m.points[4].color).toEqual([1, 2, 3]);
  });
});

describe("mesh — the panel", () => {
  function openMesh(over) {
    const o = shapeWithMesh(over);
    editor.setSelIds(new Set([o.id]));
    editor.refresh();
    const head = document.querySelector('#fxBody [data-fxsect="Mesh"]');
    if (head && head.getAttribute("aria-expanded") !== "true")
      /** @type {HTMLElement} */ (head).click();
    return { o, sect: head && head.nextElementSibling };
  }

  it("always offers the enable switch", () => {
    const { sect } = openMesh({ on: false });
    expect(sect.querySelector("#mshOn")).toBeTruthy();
  });

  it("says so plainly when the engine cannot run, rather than showing dead controls", () => {
    // jsdom has no WebGL2, so this is the real branch here — and it is the
    // branch a user on an old machine gets
    const { sect } = openMesh({});
    expect(sect.querySelector(".fxWarn"), "an unavailable engine must be stated").toBeTruthy();
    expect(sect.querySelector("#mshC"), "no grid controls when nothing can render").toBeFalsy();
  });
});
