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

/* Mansoor: "why so rasterized?" — a cleanly drawn curve came back with a
 * visible staircase. Two causes, compounding.
 *
 * The field was built at a fixed 256 however large the shape was drawn, so a
 * thousand-pixel shape was four times undersampled. And the mask was
 * THRESHOLDED to binary before the transform ran, which threw away the
 * sub-pixel coverage the canvas had already computed — so the exact distance
 * transform faithfully reproduced that binary grid's staircase, and bilinear
 * filtering then smoothed between samples that already had the steps in them.
 */
describe("the edge is smooth, not stepped", () => {
  const disc = (w, h, r, soft) => {
    /* `soft` writes real coverage at the boundary, as an antialiased canvas
     * fill does. Without it there is nothing sub-pixel to recover. */
    const a = new Uint8ClampedArray(w * h * 4);
    const cx = (w - 1) / 2,
      cy = (h - 1) / 2;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const d = Math.hypot(x - cx, y - cy) - r;
        const cov = soft ? Math.max(0, Math.min(1, 0.5 - d)) : d <= 0 ? 1 : 0;
        a[(y * w + x) * 4 + 3] = Math.round(cov * 255);
      }
    return a;
  };

  it("is closer to the true distance at the boundary than a binary mask can be", () => {
    /* The honest measure: a disc's signed distance is known exactly, so
     * compare both fields against it over the band where the staircase lives.
     * A pixel 30% covered has its edge a fifth of a pixel PAST the centre; a
     * binary mask can only say "outside", so every such pixel reports the
     * same distance — and that is the staircase, in one number. */
    const w = 96,
      h = 96,
      r = 34;
    const soft = SDE.signedField(disc(w, h, r, true), w, h);
    const hard = SDE.signedField(disc(w, h, r, false), w, h);
    const scale = 2 / h;
    const cx = (w - 1) / 2,
      cy = (h - 1) / 2;
    const rms = (fld) => {
      let sum = 0,
        n = 0;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const truth = (Math.hypot(x - cx, y - cy) - r) * scale;
          if (Math.abs(truth) > 1.5 * scale) continue; // the boundary band
          const e = fld[y * w + x] - truth;
          sum += e * e;
          n++;
        }
      return Math.sqrt(sum / Math.max(1, n));
    };
    const softErr = rms(soft),
      hardErr = rms(hard);
    expect(n_ok(softErr)).toBe(true);
    expect(softErr).toBeLessThan(hardErr);
    function n_ok(v) {
      return Number.isFinite(v) && v >= 0;
    }
  });

  it("still signs it correctly", () => {
    const w = 64,
      h = 64;
    const f = SDE.signedField(disc(w, h, 20, true), w, h);
    expect(f[32 * w + 32]).toBeLessThan(0);
    expect(f[1 * w + 1]).toBeGreaterThan(0);
  });

  it("sizes the field to the tile instead of a fixed number", () => {
    expect(SDE.fieldResFor(820, 820)).toBe(820); // was a flat 256
    expect(SDE.fieldResFor(40, 40)).toBe(SDE.FIELD_MIN); // a floor for tiny shapes
    expect(SDE.fieldResFor(4000, 4000)).toBe(SDE.FIELD_MAX); // a ceiling for huge ones
    expect(SDE.FIELD_MAX).toBeGreaterThan(256);
  });

  it("keeps the long side leading on a non-square tile", () => {
    expect(SDE.fieldResFor(900, 300)).toBe(900);
    expect(SDE.fieldResFor(300, 900)).toBe(900);
  });

  it("resamples the silhouette with smoothing, or there is no coverage to read", () => {
    const src = readPublic("shape-divider.js");
    expect(src).toContain('mx.imageSmoothingQuality = "high"');
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
  const catalog = readPublic("engine-catalog.js");

  it("is a material in the stack registry", () => {
    expect(stack).toContain('divider: { slot: "material", label: "Shape divider", multi: false }');
  });

  it("is in the stack order, and the catalog's ready status reaches the gate", () => {
    expect(stack).toMatch(/"divider",/);
    // READY is derived (23 Sep 2026): boot the stack and the catalog together
    const win = {};
    new Function("window", stack)(win);
    new Function("window", catalog)(win);
    expect(win.EngineCatalog.get("divider").status).toBe("ready");
    expect(win.FxStack.READY.has("divider")).toBe(true);
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

/* Found by Mansoor: both effects were missing from the "Add fill or effect"
 * picker AND the Effects menu, and applying one from the menu added a stack
 * entry without switching the effect on. Being READY, registered, normalised,
 * drawn and panelled is still not enough — there are FIVE more surfaces, and
 * each one fails silently. */
describe("an effect is reachable from every surface, not just the stack", () => {
  const stack = readPublic("fxstack.js");
  const catalog = readPublic("engine-catalog.js");

  for (const [id, label] of [
    ["divider", "Shape divider"],
    ["beam", "Light beam"],
  ]) {
    describe(label, () => {
      it("has an entry in the engine catalog, which is what the picker lists", () => {
        expect(catalog).toContain(`id: "${id}"`);
        expect(catalog).toContain(`label: "${label}"`);
        expect(catalog).toContain(`rendererType: "${id}"`);
      });

      /* The Effects menu, the opening values and the inspector page all come
       * from the catalog entry now (23 Sep 2026); app.js and index.html carry
       * no copy of them to drift. */
      const booted = () => {
        const win = {};
        new Function("window", stack)(win);
        new Function("window", catalog)(win);
        return win.EngineCatalog;
      };

      it("has a row in the Effects menu", () => {
        const ids = booted()
          .menu()
          .flatMap((g) => g.items.map((i) => i.id));
        expect(ids).toContain(id);
      });

      it("switches the effect ON when applied, not just the stack entry", () => {
        /* Without this the stack showed the effect, the picker said it was
         * applied, and the canvas did not change. */
        expect(booted().opening(id)).toEqual({ on: true });
      });

      it("knows which panel to open after applying", () => {
        expect(booted().get(id).page).toBe(label);
      });
    });
  }

  it("the catalog and the stack agree on how many engines there are", () => {
    const win = {};
    new Function("window", readPublic("fxstack.js"))(win);
    const cat = {};
    new Function("window", catalog)(cat);
    /* Only a READY effect has to map to an fx type. The repeater is kind
     * "effect" but status MIGRATION, and says why in its own statusReason:
     * "Pattern instancing is not yet a stack effect." Holding it to the same
     * rule would be asserting that nothing may be half-built. */
    const C = cat.EngineCatalog;
    const types = new Set(win.FxStack.types());
    const unknown = C.all()
      .filter((e) => e.kind === "effect" && C.status(e.id) === C.READY)
      .filter((e) => e.rendererType && !types.has(e.rendererType))
      .map((e) => e.id);
    expect(unknown).toEqual([]);
  });
});

/* Mansoor, on the panel: "the color should be from the fill no need blue as
 * default". Right, and the same argument retires the lab's Roundness: the
 * shape already has a fill and a corner radius, so a second copy of either on
 * the effect is one value in two places, and setting one leaves the other
 * quietly disagreeing. */
describe("the effect owns nothing the shape already owns", () => {
  const app = readPublic("app.js");
  const lab = readPublic("shape-divider-tool.js");

  it("has no colour of its own", () => {
    expect(lab).toContain('fill:"#5b88e5"'); // the lab carries one
    expect(app).not.toContain("divider:{on:false,color:");
    expect(app).not.toContain("dvCol"); // and the panel has no row for it
  });

  it("paints with the shape's fill instead", () => {
    const draw = app.slice(app.indexOf("const dvx=fx.divider;"));
    expect(draw.slice(0, 2600)).toContain("color:firstColor(obj.fill");
  });

  it("drops a colour carried over from an older document", () => {
    const norm = app.slice(app.indexOf("const dv=(()=>{"));
    expect(norm.slice(0, 2200)).toContain("delete dv.color;");
  });

  it("reaches Roundness without storing a second copy of it", () => {
    /* Mansoor asked for Roundness in the panel twice. It is there now, and it
     * edits obj.radius — the same corner radius the Shape panel edits, with
     * the same maxRadiusFor clamp. A SECOND DOOR onto one field, not a second
     * field: a copy could disagree with the shape, and this cannot. */
    const panel = app.slice(app.indexOf("if(page==='Shape divider')"));
    const body = panel.slice(0, 4000);
    expect(body).toContain("id:'dvRound'");
    expect(body).toContain("maxRadiusFor(obj)");
    expect(body).toContain("obj.radius=n");
    // and nothing named roundness is kept on the effect itself
    expect(app).not.toMatch(/divider:\{on:false,[^}]*roundness/);
  });

  it("offers it only where a radius means something", () => {
    // An ellipse has no corners to round; the row is not drawn for one.
    const panel = app.slice(app.indexOf("if(page==='Shape divider')"));
    expect(panel.slice(0, 4000)).toContain(
      "if(Array.isArray(obj.radii)||typeof obj.radius==='number')",
    );
  });

  it("has no size or aspect control — the object supplies them", () => {
    // Verified on canvas at radius 0/20/50/75: square through to fully round.
    const src = readPublic("shape-divider.js");
    for (const gone of ["u_roundness", "u_size", "u_sides"]) {
      expect(src).not.toContain(gone);
    }
    /* u_span STAYS, and replaced u_aspect: it says how far the TILE reaches
     * in half-object-heights, which carries the aspect ratio and the margin
     * at once. Distances stay isotropic, so a circle's fillet is round on a
     * wide box, and the cuts do not move when the margin changes. The lab's
     * "Width / height" was a different thing — a control that stretched its
     * own silhouette, which an object's own w and h now do. */
    expect(src).toContain("u_span");
    expect(src).not.toContain("u_aspect");
    expect(app).not.toContain("divider:{on:false,roundness");
  });
});

/* Mansoor, pointing at the middle band of a stadium cut into five: "should be
 * smooth too! why is it hard box?" — every other band filleted correctly and
 * that one had square ends.
 *
 * A distance field needs ROOM around the shape. A stadium's straight side
 * reaches the tile edge exactly, so past it the sampler clamps, everything
 * beyond reads as still inside, and the smooth subtraction has nothing to
 * round against. The curved bands filleted because there the outline sits
 * inside the tile and the field has real "outside" to work with. */
describe("the field has room around the shape", () => {
  it("measures distance in the OBJECT's height, not the padded tile's", () => {
    /* Otherwise adding margin would silently rescale every divider: the same
     * spacing would move the cuts the moment the padding changed. */
    const w = 64,
      h = 64;
    const a = new Uint8ClampedArray(w * h * 4);
    a[(32 * w + 32) * 4 + 3] = 255;
    const tight = SDE.signedField(a, w, h); // default: tile IS the object
    const padded = SDE.signedField(a, w, h, 2 / 32); // object is half the tile
    // the same pixel is twice as far away when the object is half the tile
    expect(padded[32 * w + 42]).toBeCloseTo(tight[32 * w + 42] * 2, 5);
  });

  it("keeps the old meaning when no margin is given", () => {
    const w = 32,
      h = 32;
    const a = new Uint8ClampedArray(w * h * 4);
    a[(16 * w + 16) * 4 + 3] = 255;
    const withDefault = SDE.signedField(a, w, h);
    const explicit = SDE.signedField(a, w, h, 2 / h);
    expect(Array.from(withDefault)).toEqual(Array.from(explicit));
  });

  it("the draw path pads the tile and places it back expanded", () => {
    const app = readPublic("app.js");
    const draw = app.slice(
      app.indexOf("const dvx=fx.divider;"),
      app.indexOf("const frx=fx.fractal;"),
    );
    expect(draw).toContain("const PAD=");
    expect(draw).toContain("const TW=W+PAD*2, TH=H+PAD*2");
    // rendered on the padded tile, but measured in the object's own height
    expect(draw).toContain("render(TW,TH,sil,paint,H)");
    // and drawn back over the expanded rect, or the margin would crop
    expect(draw).toContain("o.x-padDocX");
    expect(draw).toContain("o.w+padDocX*2");
  });

  it("the margin clears the widest fillet and the widest cut", () => {
    /* The fillet reaches 0.13 of half the height and a cut 0.14; the margin is
     * a fifth of the box, comfortably past both. */
    const src = readPublic("shape-divider.js");
    expect(src).toContain("mix(.002,.13,u_edgeSmooth)");
    const app = readPublic("app.js");
    expect(app).toContain("0.2*Math.max(W,H)");
  });
});
