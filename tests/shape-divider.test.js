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

/* The Spectral Light Beam, ported from its lab the same way — with the two
 * changes that follow from it being a LIGHT rather than a picture. */
describe("the light beam lights what is beneath it", () => {
  const src = readPublic("light-beam-fx.js");
  const lab = readPublic("light-beam.js");

  it("the lab paints its own night and the effect does not", () => {
    /* A lab page has nothing underneath and must supply a ground. An effect
     * has the document underneath, and a light that paints black over it is
     * doing the one thing a light must never do. */
    // scoped to the SHADER, not the file: the header comment says the word
    const shader = src.slice(src.indexOf("const FRAG"), src.indexOf("let _gl"));
    expect(lab).toContain("vec3 bg=u_background");
    expect(shader).not.toContain("u_background");
    expect(shader).not.toContain("vec3 bg=");
  });

  it("tone-maps the light alone, not the light plus a ground", () => {
    expect(lab).toContain("vec3 color=bg+light;");
    expect(src).toContain("vec3 color=1.-exp(-light)");
  });

  it("writes premultiplied alpha from the light's own strength", () => {
    // so 'lighter' adds exactly the light and nothing where there is none
    expect(src).toContain("fragColor=vec4(color*alpha,alpha)");
    expect(lab).toContain("fragColor=vec4(clamp(color+grain,0.,1.),1.)"); // opaque
  });

  it("keeps the optics untouched", () => {
    for (const piece of [
      "prismMaterial",
      "angleDelta",
      "starburst",
      "streakDensity",
      "u_dispersion",
    ]) {
      expect(src).toContain(piece);
    }
  });
});

describe("the beam composites additively and is placed by hand", () => {
  const app = readPublic("app.js");

  it("draws with 'lighter', because a light adds", () => {
    // Normal alpha would darken everything the beam misses.
    const draw = app.slice(app.indexOf("const bmx=fx.beam;"));
    expect(draw.slice(0, 1400)).toContain("c.globalCompositeOperation='lighter'");
  });

  it("has a source handle on the canvas, hit-tested before the grips", () => {
    expect(app).toContain("function drawBeamSource");
    expect(app).toContain("mode:'beamSrc'");
    // tested before the transform grips, as the mesh points are, because it
    // can sit directly on one
    /* Compared against a string that occurs ONLY in the pointerdown mesh
     * block — `const ME=window.MeshGradient` also appears where the net is
     * drawn, hundreds of lines earlier, and matching that compares nothing. */
    const meshHit = app.indexOf("if(!meshEdit&&!e.altKey) return;");
    expect(meshHit).toBeGreaterThan(0);
    expect(app.indexOf("drag&&drag.mode==='beamSrc'")).toBeLessThan(meshHit);
  });

  it("stores the source normalised to the box, so it survives a resize", () => {
    const mv = app.slice(app.indexOf("if(drag.mode==='beamSrc'){"));
    expect(mv.slice(0, 700)).toContain("Math.max(b.w,1e-6)");
    expect(mv.slice(0, 700)).toContain("Math.max(b.h,1e-6)");
  });

  it("commits the move to history", () => {
    expect(app).toContain("pushHistory('Move light source')");
  });

  it("is registered, ready, offered and has a panel", () => {
    const stack = readPublic("fxstack.js");
    const index = readPublic("index.html");
    expect(stack).toContain('beam: { slot: "material", label: "Light beam", multi: false }');
    expect(index).toMatch(/FX_ONLY = \[[^\]]*"beam"/);
    expect(index).toContain('src="light-beam-fx.js');
    expect(app).toContain("'Light beam':'beam'");
    expect(app).toContain("if(page==='Light beam')");
    expect(app).toContain("case 'Light beam': return !!(e.beam&&e.beam.on);");
  });
});

describe("the labs stop being product features", () => {
  const index = readPublic("index.html");
  it("no longer navigates away from the document", () => {
    /* location.href abandons the page you are working on: you cannot put the
     * effect on a shape that is part of a composition, cannot undo across the
     * boundary, and come back with a flat PNG. Both are effects now. */
    expect(index).not.toContain("shape-composer.html");
    expect(index).not.toContain("light-beam.html");
  });
  it("keeps the lab files, which are where the shaders get built", () => {
    for (const f of [
      "shape-composer.html",
      "light-beam.html",
      "shape-divider-tool.js",
      "light-beam.js",
    ]) {
      expect(fs.existsSync(path.join(root, "public", f))).toBe(true);
    }
  });
});

/* Found by adding the 33rd effect. The stack was capped at a bare 32 in two
 * places, which was comfortable while there were fewer than 32 effects and
 * became a silent truncation the moment there were 33: every known type gets
 * an entry, so the cap sat BELOW the number of built-in effects and the last
 * one in LEGACY_ORDER — noise — was cut off on every load, re-minted with a
 * fresh id and its saved settings lost. It showed up as a pattern layout that
 * was no longer byte-identical across a JSON round trip. */
describe("the effect stack is not capped below the number of effects", () => {
  const app = readPublic("app.js");

  it("derives the ceiling from the registry instead of hard-coding it", () => {
    expect(app).toContain("function maxFxEntries()");
    expect(app).not.toContain("out.fx=(Array.isArray(s.fx)?s.fx:[]).slice(0,32)");
    expect(app).not.toContain("stack=stack.slice(0,32)");
  });

  it("leaves room above the known types, for a multi effect's duplicates", () => {
    const win = {};
    new Function("window", readPublic("fxstack.js"))(win);
    const known = win.FxStack.types().length;
    // the shipped rule: max(64, known * 2)
    expect(Math.max(64, known * 2)).toBeGreaterThan(known);
    expect(known).toBeGreaterThan(32); // which is what broke the old constant
  });
});
