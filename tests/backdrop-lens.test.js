// @vitest-environment node
/**
 * A backdrop lens added through the Effects picker.
 *
 * Reed glass on a mesh object: both switched on, the stack lets the topmost
 * material win, the mesh goes dark, and the lens refracts the white artboard
 * beneath the object — a white slab with faint lines, and a warning whose
 * advice (reorder) could only flip which of the two vanished. The reference
 * flow already puts a lens on its own layer above (layerOver); the picker
 * now does the same when the object already has a material.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(here, "..", "public", f), "utf8");
let FS;

beforeAll(() => {
  const win = {};
  new Function("window", read("fxstack.js"))(win);
  FS = win.FxStack;
});

describe("which engines are lenses", () => {
  it("the four that read the page beneath are flagged; the paints are not", () => {
    for (const t of ["reed", "glass", "prism", "capsule"])
      expect(FS.meta(t).backdrop, t).toBe(true);
    for (const t of ["mesh", "iridescent", "liquid", "fractal", "light"])
      expect(!!FS.meta(t).backdrop, t).toBe(false);
  });

  it("one material wins on an object, the topmost — the rule the lens must not fight", () => {
    const fx = [
      { id: "a", type: "mesh", on: true, params: {} },
      { id: "b", type: "reed", on: true, params: {} },
    ];
    expect(FS.activeMaterial(fx).type).toBe("reed");
    expect(FS.shadowedMaterials(fx).map((e) => e.type)).toEqual(["mesh"]);
  });
});

describe("the picker puts a lens on its own layer when the object is already painted", () => {
  const app = read("app.js");
  const fn = app.slice(
    app.indexOf("function engApply(item){"),
    app.indexOf("function engApply(item){") + 6000,
  );

  it("decides on the engine's backdrop flag and the object's active material", () => {
    expect(fn).toContain("const activeMat=FS&&obj.fx?FS.activeMaterial(obj.fx):null;");
    expect(fn).toContain("if(meta&&meta.backdrop&&activeMat&&activeMat.type!==type){");
  });

  it("uses the same layerOver the reference flow uses, and selects the new layer", () => {
    expect(fn).toContain("const o=layerOver(obj,list,item.label);");
    expect(fn).toContain("setMaterial(o,type);");
    expect(fn).toContain("setSelIds(new Set([o.id]),o.id);");
  });

  it("says what it did instead of warning about a reorder", () => {
    expect(fn).toMatch(/placed on its own layer above/);
  });

  it("comes before the ordinary push onto the object's stack", () => {
    expect(fn.indexOf("if(meta&&meta.backdrop&&activeMat")).toBeLessThan(
      fn.indexOf("obj.fx.push(entry);"),
    );
  });
});
