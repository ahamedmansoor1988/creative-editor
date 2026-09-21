// @vitest-environment jsdom
/**
 * Shape Divider — the lab's divider shader, cutting the object the user drew.
 *
 * The port's one real decision is that the body is a SIGNED DISTANCE FIELD
 * built from the silhouette, not an alpha mask. The whole look rests on
 * `smax(shapeD, -cuts, k)` — a smooth subtraction — and smooth needs distance:
 * the fillet where a divider meets the outline is made out of how far away the
 * edge is. Cut a 0/1 mask instead and every join goes hard. So the geometry is
 * what these pin; the render is WebGL and is checked on the canvas.
 *
 * They also hold the surfaces that have to agree before the effect is
 * reachable at all, which is the part that has bitten twice before: an effect
 * can be READY, registered and drawn and still have no row in the picker.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.join(here, "..");
const readPublic = (f) => fs.readFileSync(path.join(root, "public", f), "utf8");

let SDE;
beforeAll(() => {
  const win = {};
  new Function("window", "document", readPublic("shape-divider.js"))(win, {
    createElement: () => ({ getContext: () => null, width: 0, height: 0 }),
  });
  SDE = win.ShapeDividerEngine;
});

/** A filled disc of radius r, as the RGBA a canvas would hand back. */
function disc(w, h, r) {
  const a = new Uint8ClampedArray(w * h * 4);
  const cx = (w - 1) / 2,
    cy = (h - 1) / 2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const inside = Math.hypot(x - cx, y - cy) <= r;
      a[(y * w + x) * 4 + 3] = inside ? 255 : 0;
    }
  return a;
}

describe("the body is a distance field, not a mask", () => {
  it("is negative inside and positive outside", () => {
    const w = 64,
      h = 64,
      r = 20;
    const f = SDE.signedField(disc(w, h, r), w, h);
    const at = (x, y) => f[y * w + x];
    expect(at(32, 32)).toBeLessThan(0); // centre
    expect(at(1, 1)).toBeGreaterThan(0); // corner
  });

  it("carries a real gradient, which is what a mask cannot", () => {
    /* A mask is flat inside: every interior pixel reads the same, so there is
     * nothing for a smooth subtraction to build a fillet out of. Distance
     * falls away steadily from the centre to the edge. */
    const w = 64,
      h = 64;
    const f = SDE.signedField(disc(w, h, 24), w, h);
    const centre = f[32 * w + 32],
      mid = f[32 * w + 44],
      edge = f[32 * w + 55];
    expect(centre).toBeLessThan(mid);
    expect(mid).toBeLessThan(edge);
    expect(new Set([centre, mid, edge]).size).toBe(3);
  });

  it("measures in the shader's units: y spans -1..1 across the box", () => {
    // A disc of radius r in a box of height h reaches -r*(2/h) at its centre.
    const w = 64,
      h = 64,
      r = 20;
    const f = SDE.signedField(disc(w, h, r), w, h);
    expect(f[32 * w + 32]).toBeCloseTo(-r * (2 / h), 1);
  });

  it("is exact, not a chamfer approximation", () => {
    /* The error a chamfer makes shows up on the diagonal — precisely where a
     * divider crosses an outline, which is what this effect is made of. */
    const w = 33,
      h = 33;
    const a = new Uint8ClampedArray(w * h * 4);
    a[(16 * w + 16) * 4 + 3] = 255; // one lit pixel at the centre
    const f = SDE.signedField(a, w, h);
    const diag = f[(16 + 10) * w + (16 + 10)]; // 10,10 away
    expect(diag).toBeCloseTo(Math.hypot(10, 10) * (2 / h), 5);
  });

  it("survives a silhouette that is entirely empty", () => {
    const w = 16,
      h = 16;
    const f = SDE.signedField(new Uint8ClampedArray(w * h * 4), w, h);
    expect(f.length).toBe(w * h);
    expect(f.every((v) => v > 0)).toBe(true);
  });
});

describe("the effect owns no shape of its own", () => {
  const src = readPublic("shape-divider.js");
  const lab = readPublic("shape-divider-tool.js");

  it("the lab has five silhouettes and the effect has none", () => {
    expect(lab).toContain('const SHAPES=["Circle","Rounded rectangle","Polygon","Star","Ring"]');
    expect(src).not.toContain("SHAPES");
    // and no uniform for picking between them
    for (const gone of ["u_shape", "u_size", "u_roundness", "u_sides", "sdStar", "sdPolygon"]) {
      expect(src).not.toContain(gone);
    }
  });

  it("keeps every divider style the lab had", () => {
    expect(SDE.KINDS).toEqual([
      "Straight lines",
      "Parabolic curves",
      "Wave lines",
      "Radial spokes",
    ]);
  });

  it("keeps the smooth subtraction the look depends on", () => {
    expect(src).toContain("smax(shapeD,-cuts");
  });

  it("writes premultiplied alpha, so the cuts are empty and not painted", () => {
    // A background colour here would fill the gaps instead of opening them.
    expect(src).toContain("fragColor=vec4(u_fill*mask,mask)");
    expect(src).not.toContain("u_background");
  });
});

describe("every surface that has to agree before it is reachable", () => {
  const app = readPublic("app.js");
  const stack = readPublic("fxstack.js");
  const index = readPublic("index.html");

  it("is a material in the stack registry", () => {
    expect(stack).toContain('divider: { slot: "material", label: "Shape divider", multi: false }');
  });

  it("is in READY and in the stack order", () => {
    expect(stack).toMatch(/"divider",/);
    const ready = stack.slice(stack.indexOf("const READY"));
    expect(ready).toContain('"divider"');
  });

  it("is offered by the page's own gate", () => {
    expect(index).toMatch(/FX_ONLY = \[[^\]]*"divider"/);
  });

  it("loads its engine", () => {
    expect(index).toContain('src="shape-divider.js');
  });

  it("has a row in the picker, which READY alone does not give it", () => {
    // An effect can be ready, registered and drawn and still have no row.
    expect(app).toContain("'Shape divider':'divider'");
    expect(app).toContain("case 'Shape divider': return !!(e.divider&&e.divider.on);");
  });

  it("has a panel", () => {
    expect(app).toContain("if(page==='Shape divider')");
  });

  it("has defaults and a draw path", () => {
    expect(app).toContain("divider:{on:false,");
    expect(app).toContain("fxOn(obj,'divider')");
  });
});
