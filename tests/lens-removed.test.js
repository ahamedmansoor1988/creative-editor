// @vitest-environment jsdom
/**
 * Standalone Lens was removed as a product capability. These tests pin the
 * removal so it cannot silently return, while asserting that the legitimate
 * "lens" concepts it was NOT allowed to touch are still present:
 *   - Glass (the primary transparent optical material)
 *   - Capsule's internal lens geometry (a different engine)
 *   - Lens Flare
 * An old document that still carries a standalone-Lens entry must load without
 * crashing, with the entry safely dropped rather than converted to Glass.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadEditor } from "./helpers/load-editor.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const P = (f) => join(HERE, "..", f);

let editor;
beforeAll(() => {
  ({ editor } = loadEditor());
});

describe("standalone Lens is gone", () => {
  it("has no engine module or window.LensEngine", () => {
    expect(existsSync(P("public/lens.js"))).toBe(false);
    expect(window.LensEngine).toBeUndefined();
  });

  it("is not in the catalog, the Fx registry, or the ready set", () => {
    const EC = window.EngineCatalog,
      FS = window.FxStack;
    expect(EC.get("lens")).toBeFalsy();
    expect(EC.ready().some((e) => e.id === "lens")).toBe(false);
    expect(FS.types().includes("lens")).toBe(false);
    expect(FS.READY.has("lens")).toBe(false);
    expect(FS.LEGACY_ORDER.includes("lens")).toBe(false);
  });

  it("gives new shapes no effects.lens", () => {
    editor.doc = {
      frame: {
        name: "F",
        w: 900,
        h: 600,
        bg: "#fff",
        artboards: [],
        children: [
          {
            type: "rect",
            name: "R",
            x: 10,
            y: 10,
            w: 100,
            h: 80,
            fill: { kind: "solid", color: "#333" },
          },
        ],
      },
    };
    const o = editor.doc.frame.children[0];
    expect(o.effects.lens).toBeUndefined();
    expect((o.fx || []).some((e) => e.type === "lens")).toBe(false);
  });

  it("loads an OLD document carrying standalone Lens without crashing, dropping it (not converting to Glass)", () => {
    editor.doc = {
      frame: {
        name: "F",
        w: 900,
        h: 600,
        bg: "#fff",
        artboards: [],
        children: [
          {
            type: "ellipse",
            name: "Old",
            x: 100,
            y: 100,
            w: 300,
            h: 200,
            fill: { kind: "solid", color: "#888" },
            effects: { lens: { on: true, curvature: 70, thickness: 55, ior: 1.5 } },
            fx: [
              {
                id: "x1",
                type: "lens",
                on: true,
                added: true,
                params: { on: true, curvature: 70 },
              },
            ],
          },
        ],
      },
    };
    const o = editor.doc.frame.children[0];
    expect(o.effects.lens).toBeUndefined(); // dropped
    expect((o.fx || []).some((e) => e.type === "lens")).toBe(false); // filtered
    expect((o.fx || []).some((e) => e.type === "glass" && e.added)).toBe(false); // NOT converted
  });
});

describe("legitimate lens concepts are preserved", () => {
  it("keeps Glass", () => {
    expect(window.EngineCatalog.get("glass")).toBeTruthy();
    expect(window.FxStack.types().includes("glass")).toBe(true);
  });

  it("keeps Capsule's internal lens geometry (iLens/nLens/uLens in the shader)", () => {
    const src = readFileSync(P("public/capsule.js"), "utf8");
    expect(src).toMatch(/iLens\s*\(/);
    expect(src).toMatch(/nLens\s*\(/);
    expect(src).toMatch(/uLensR|uLensP/);
  });

  it("keeps Lens Flare capability wiring on the server", () => {
    const src = readFileSync(P("server.js"), "utf8");
    expect(src).toMatch(/lens flare/i);
  });
});
