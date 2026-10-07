// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEditor } from "./helpers/load-editor.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let editor, L;

beforeAll(() => {
  ({ editor } = loadEditor());
  window.eval(fs.readFileSync(path.join(ROOT, "public", "lensblur.js"), "utf8"));
  L = window.LensBlurEngine;
});

function page(camera, children = []) {
  const d = { frame: { name: "Cam", w: 900, h: 600, bg: "#ffffff", artboards: [], children, camera } };
  editor.normalizeDoc(d);
  return d.frame;
}

describe("page camera", () => {
  it("is off by default, with a real f-stop and a round iris", () => {
    expect(page(undefined).camera).toEqual({ on: false, focus: 0.5, fstop: 2.8, blades: 0, bladeRotation: 0, highlight: 0.6 });
  });
  it("snaps settings to what a lens has", () => {
    const c = page({ on: true, focus: 3, fstop: 3.1, blades: 4, bladeRotation: 999, highlight: -1 }).camera;
    expect(c).toEqual({ on: true, focus: 1, fstop: 2.8, blades: 0, bladeRotation: 180, highlight: 0 });
  });
  it("keeps a layer's depth in 0..1 and leaves it absent when unset", () => {
    const f = page({ on: true }, [
      { type: "rect", x: 0, y: 0, w: 10, h: 10, depth: 7 },
      { type: "rect", x: 0, y: 0, w: 10, h: 10 },
    ]);
    expect(f.children[0].depth).toBe(1);
    expect(f.children[1].depth).toBeUndefined();
  });
});

describe("thin lens", () => {
  it("is sharp at the focus", () => {
    expect(L.coc(0.4, 0.4, 2.8)).toBe(0);
  });
  it("blurs in front of the focus faster than the same distance behind it", () => {
    expect(L.coc(0.3, 0.5, 2.8)).toBeGreaterThan(L.coc(0.7, 0.5, 2.8));
  });
  it("blurs more at a wider aperture (smaller f-number)", () => {
    expect(L.coc(0.1, 0.5, 1.4)).toBeCloseTo(L.coc(0.1, 0.5, 2.8) * 2, 6);
  });
});
