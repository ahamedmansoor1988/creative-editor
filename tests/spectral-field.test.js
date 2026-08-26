// @vitest-environment jsdom
/**
 * QA for `spectralField` — a harmonic colour field solved inside a real vector
 * path.
 *
 * WHAT IS TESTED WHERE. jsdom has no rasteriser, so anything that begins with
 * "fill this path" belongs in public/lab-field.html, which runs the square,
 * rounded-rectangle, star and crescent cases against real pixels. What lives
 * here is the half that is pure arithmetic on arrays — the distance
 * transform, the boundary trace, the arc-length parameterisation and the
 * solver itself — plus the wiring, the clamps and the migration.
 *
 * That split is deliberate rather than a limitation. The solver is where the
 * architecture actually lives: whether it diffuses through a shape or across
 * it is decided by four lines of neighbour tests, and those can be checked
 * exactly, on a mask built by hand, with no canvas involved.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loadEditor } from "./helpers/load-editor.js";

let editor;
const SF = () => window.SpectralField;

function shapeWithField(over, type) {
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
          name: "S",
          x: 100,
          y: 100,
          w: 400,
          h: 400,
          fill: { kind: "solid", color: "#cccccc" },
          effects: { spectralField: { on: true, ...over } },
        },
      ],
    },
  };
  return editor.doc.frame.children[0];
}

/** A filled rectangle mask, built directly so no rasteriser is needed. */
function rectMask(w, h, x0, y0, x1, y1) {
  const m = new Float32Array(w * h);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * w + x] = 1;
  return m;
}

beforeAll(() => {
  ({ editor } = loadEditor());
  window.FxStack.READY.add("spectralField");
});
afterAll(() => {
  window.FxStack.READY.delete("spectralField");
});

describe("the effect owns no geometry", () => {
  /* The whole point of the rewrite. The previous version carried a radius and
   * a centre, reconstructed a sphere from them and drew a circle inside every
   * rectangle. Those keys are dropped rather than hidden: a hidden control
   * still leaves the geometry reachable, and reachable geometry comes back. */
  it("has no radius, centre or sphere settings at all", () => {
    const D = SF().DEFAULTS();
    for (const key of [
      "radius",
      "centerX",
      "centerY",
      "concentration",
      "centerFalloff",
      "centerStrength",
      "fresnelPower",
      "fresnelStrength",
      "anchors",
      "rotation",
    ]) {
      expect(D[key], `${key} is still in the model`).toBeUndefined();
    }
  });

  it("strips those keys off anything that still carries them", () => {
    // a document saved by the orb build, or a preset written against it
    const S = SF().normalize({
      radius: 0.92,
      centerX: 0.3,
      centerY: -0.2,
      concentration: 9,
      anchors: [{ id: "a", direction: [0, 0, 1], color: [1, 0, 0], strength: 1 }],
    });
    expect(S.radius).toBeUndefined();
    expect(S.centerX).toBeUndefined();
    expect(S.centerY).toBeUndefined();
    expect(S.anchors).toBeUndefined();
  });

  it("offers no geometry control in the panel", () => {
    const o = shapeWithField({});
    editor.setSelIds(new Set([o.id]));
    editor.refresh();
    const head = document.querySelector('#fxBody [data-fxsect="Spectral Field"]');
    if (head && head.getAttribute("aria-expanded") !== "true")
      /** @type {HTMLElement} */ (head).click();
    for (const id of ["sf_radius", "sf_centerX", "sf_centerY"]) {
      expect(document.getElementById(id), `${id} is still in the panel`).toBeFalsy();
    }
    // and the field's own controls ARE there
    for (const id of ["sf_boundaryOffset", "sf_pearlDepth", "sf_rimWidth", "sfDebug"]) {
      expect(document.getElementById(id), `${id} is missing`).toBeTruthy();
    }
  });
});

describe("the distance field follows the shape, not a circle", () => {
  /* This drives the pearl and the rim. If it were radial, both would be
   * radial, and an elongated rectangle would get a round pale centre. */
  it("is exact Euclidean distance from the real edge", () => {
    const m = rectMask(40, 40, 5, 5, 35, 35); // a 30x30 square
    const d = SF().distanceInside(m, 40, 40);
    /* Distances are to the BOUNDARY, so an edge cell reads half a cell rather
     * than zero — its centre really is half a cell inside the outline. */
    expect(d[20 * 40 + 5]).toBeCloseTo(0.5, 5);
    /* A 30-cell span has its deepest point 14.5 cells from the outline, not
     * 15: cell 20 sits 15 cells from the right edge and 16 from the left, and
     * the boundary correction takes half a cell off the nearer of the two. */
    expect(d[20 * 40 + 20]).toBeCloseTo(14.5, 5);
    // two cells in reads the same wherever it sits along that edge
    expect(d[20 * 40 + 6]).toBeCloseTo(1.5, 5);
    expect(d[10 * 40 + 6]).toBeCloseTo(1.5, 5);
  });

  it("gives a SQUARE its square distance, which a radial field cannot", () => {
    /* The discriminator: near a corner of a square, a point is close to two
     * edges and its distance is small. On any radial field centred in the
     * same box, the same point is far from the centre and would read large —
     * and on the old sphere maths it was outside the domain altogether. */
    const w = 60;
    const m = rectMask(w, w, 5, 5, 55, 55); // a 50x50 square
    const d = SF().distanceInside(m, w, w);
    const corner = d[7 * w + 7]; // just inside a corner
    const edgeMid = d[30 * w + 7]; // same distance from the left edge, mid-height
    expect(corner).toBeCloseTo(2.5, 5);
    expect(edgeMid).toBeCloseTo(2.5, 5);
    // both are 2 from the outline: a corner is not "further in" than an edge
    expect(Math.abs(corner - edgeMid)).toBeLessThan(0.5);
    // and the deepest point is the centre, at half the side
    let max = 0;
    for (let i = 0; i < d.length; i++) if (d[i] > max) max = d[i];
    expect(max).toBeCloseTo(24.5, 5);
  });
});

describe("the boundary is the real perimeter", () => {
  it("traces the outline and parameterises it by arc length", () => {
    const w = 40;
    const m = rectMask(w, w, 5, 5, 35, 35);
    const pts = SF().traceBoundary(m, w, w);
    expect(pts.length, "no outline was traced").toBeGreaterThan(100);
    // every traced point is on the edge of the square, none in the interior
    for (const [x, y] of pts) {
      const onEdge = x === 5 || x === 34 || y === 5 || y === 34;
      expect(onEdge, `traced point ${x},${y} is not on the outline`).toBe(true);
    }
    const { s, total } = SF().arcLength(pts);
    // a 30x30 square has a perimeter of about 120
    expect(total).toBeGreaterThan(110);
    expect(total).toBeLessThan(130);
    expect(s[0]).toBe(0);
    expect(s[s.length - 1]).toBeLessThan(1);
    // arc length only ever increases along the walk
    for (let i = 1; i < s.length; i++) expect(s[i]).toBeGreaterThanOrEqual(s[i - 1]);
  });

  it("walks all four sides rather than a circle inscribed in them", () => {
    const w = 40;
    const pts = SF().traceBoundary(rectMask(w, w, 5, 5, 35, 35), w, w);
    const sides = { top: 0, bottom: 0, left: 0, right: 0 };
    for (const [x, y] of pts) {
      if (y === 5) sides.top++;
      else if (y === 34) sides.bottom++;
      else if (x === 5) sides.left++;
      else if (x === 34) sides.right++;
    }
    for (const k of Object.keys(sides)) {
      expect(sides[k], `the ${k} edge was not walked`).toBeGreaterThan(10);
    }
  });
});

describe("the solver runs inside the domain", () => {
  /* The line that makes a crescent work. The stencil tests every neighbour
   * for membership, so colour diffuses the long way round a shape rather than
   * straight across a gap it is not in. */
  it("never averages through a cell outside the shape", () => {
    /* Two separated squares in one grid. Red is fixed on the left block's
     * edge, blue on the right's. If the stencil leaked, the gap between them
     * would carry colour and each block would be pulled toward the other. */
    const w = 60,
      h = 20;
    const m = new Float32Array(w * h);
    const put = (x0, x1) => {
      for (let y = 3; y < 17; y++) for (let x = x0; x < x1; x++) m[y * w + x] = 1;
    };
    put(5, 22);
    put(38, 55);
    const bnd = new Float32Array(w * h * 3).fill(-1);
    for (let y = 3; y < 17; y++) {
      const L = y * w + 5,
        R = y * w + 54;
      bnd[L * 3] = 1;
      bnd[L * 3 + 1] = 0;
      bnd[L * 3 + 2] = 0; // red
      bnd[R * 3] = 0;
      bnd[R * 3 + 1] = 0;
      bnd[R * 3 + 2] = 1; // blue
    }
    const C = SF().solveHarmonic(m, bnd, w, h, 400);
    const at = (x, y) => [C[(y * w + x) * 3], C[(y * w + x) * 3 + 1], C[(y * w + x) * 3 + 2]];
    // the gap is outside the domain and must never be written
    const gap = at(30, 10);
    expect(gap[0] + gap[1] + gap[2]).toBe(0);
    // the left block stays red-dominant, the right blue-dominant
    expect(at(12, 10)[0]).toBeGreaterThan(at(12, 10)[2]);
    expect(at(48, 10)[2]).toBeGreaterThan(at(48, 10)[0]);
  });

  it("a constant boundary gives a constant interior, everywhere", () => {
    /* THE SHARPEST STATEMENT of "the stencil only ever reaches inside".
     *
     * Set every boundary cell to one value and the harmonic solution is that
     * value throughout — there is nothing for it to vary between. A solver
     * that reads its neighbours without testing membership picks up zeros from
     * outside the shape and sags toward black near every edge, which is
     * invisible in any test that only asks WHERE colour was written: such a
     * solver still writes to exactly the right cells. It writes the wrong
     * numbers into them.
     *
     * This is here because the obvious sabotage — deleting two of the four
     * membership tests — passed every other test in this file. */
    const w = 40,
      h = 40;
    const m = rectMask(w, h, 4, 4, 36, 36);
    const bnd = new Float32Array(w * h * 3).fill(-1);
    const V = 0.8;
    /* Only the TOP row is fixed, which leaves the left, right and bottom edge
     * cells free AND adjacent to the outside. That is not a contrived setup:
     * the traced outline is one cell wide and does not land on every edge cell
     * of a curved shape, so free cells beside the outside are the normal case.
     *
     * A first version of this test fixed the whole perimeter ring, and the
     * ring shielded every free cell from the outside — the sabotage could not
     * be seen at all, because no free cell had an outside neighbour to read. */
    for (let x = 4; x < 36; x++) {
      const i = 4 * w + x;
      bnd[i * 3] = V;
      bnd[i * 3 + 1] = V;
      bnd[i * 3 + 2] = V;
    }
    const C = SF().solveHarmonic(m, bnd, w, h, 800);
    let worst = 0;
    for (let y = 5; y < 36; y++) {
      for (let x = 4; x < 36; x++) {
        worst = Math.max(worst, Math.abs(C[(y * w + x) * 3] - V));
      }
    }
    expect(worst, "the field sagged, so the stencil reached outside the shape").toBeLessThan(0.02);
  });

  it("produces a field with no interior extremum, which is what harmonic means", () => {
    /* A harmonic function attains its extremes on the boundary — the maximum
     * principle. It is why this cannot band or blob: every interior value is
     * an average of its neighbours by construction. */
    const w = 40,
      h = 40;
    const m = rectMask(w, h, 4, 4, 36, 36);
    const bnd = new Float32Array(w * h * 3).fill(-1);
    for (let x = 4; x < 36; x++) {
      const top = 4 * w + x,
        bot = 35 * w + x;
      bnd[top * 3] = 1;
      bnd[top * 3 + 1] = 1;
      bnd[top * 3 + 2] = 1;
      bnd[bot * 3] = 0;
      bnd[bot * 3 + 1] = 0;
      bnd[bot * 3 + 2] = 0;
    }
    for (let y = 4; y < 36; y++) {
      for (const x of [4, 35]) {
        const i = y * w + x;
        const v = 1 - (y - 4) / 31;
        bnd[i * 3] = v;
        bnd[i * 3 + 1] = v;
        bnd[i * 3 + 2] = v;
      }
    }
    const C = SF().solveHarmonic(m, bnd, w, h, 600);
    for (let y = 6; y < 34; y++) {
      for (let x = 6; x < 34; x++) {
        const v = C[(y * w + x) * 3];
        expect(v).toBeGreaterThanOrEqual(-1e-3);
        expect(v).toBeLessThanOrEqual(1 + 1e-3);
      }
    }
    // and it decreases monotonically down the middle, following the boundary
    const col = [];
    for (let y = 5; y < 35; y++) col.push(C[(y * w + 20) * 3]);
    for (let i = 1; i < col.length; i++) expect(col[i]).toBeLessThanOrEqual(col[i - 1] + 1e-3);
  });
});

describe("wired into the effect system", () => {
  it("is registered as a MATERIAL", () => {
    expect(window.FxStack.slotOf("spectralField")).toBe("material");
  });

  it("is offered on the shapes that can carry it", () => {
    const pages = (t) => editor.FX_PAGES({ type: t, name: "x", x: 0, y: 0, w: 10, h: 10 });
    expect(pages("rect")).toContain("Spectral Field");
    expect(pages("path")).toContain("Spectral Field");
    expect(pages("text"), "text cannot carry a field").not.toContain("Spectral Field");
  });

  it("becomes the active material when switched on", () => {
    expect(window.FxStack.activeMaterial(shapeWithField({}).fx).type).toBe("spectralField");
  });

  it("clamps every value that arrives out of range", () => {
    const S = shapeWithField({
      intensity: 99,
      spread: -4,
      pearlDepth: 0,
      rimWidth: 50,
      pearlColor: "not a colour",
    }).effects.spectralField;
    expect(S.intensity).toBe(2);
    expect(S.spread).toBe(0);
    expect(S.pearlDepth).toBe(0.02);
    expect(S.rimWidth).toBe(1);
    expect(S.pearlColor).toBe("#ffe0d6");
  });

  it("wraps every stop onto the perimeter", () => {
    // s is a position on a closed loop; 1.25 is a quarter of the way round
    const S = shapeWithField({
      stops: [{ id: "a", s: 1.25, color: [1, 0, 0], strength: 1 }],
    }).effects.spectralField;
    expect(S.stops[0].s).toBeCloseTo(0.25, 6);
  });

  it("replaces an empty stop list rather than solving with no boundary data", () => {
    expect(shapeWithField({ stops: [] }).effects.spectralField.stops.length).toBeGreaterThan(0);
  });

  it("keeps the debug view out of the saved document", () => {
    // a working state, not a setting: a file should never reopen in Domain view
    expect(shapeWithField({ debug: "domain" }).effects.spectralField.debug).toBe("domain");
    expect(shapeWithField({ debug: "nonsense" }).effects.spectralField.debug).toBe(null);
  });

  it("survives a compact round trip", () => {
    const o = shapeWithField({ intensity: 1.4, boundaryOffset: 0.3 });
    o.effects.spectralField.stops[2].color = [0.25, 0.5, 0.75];
    const wire = editor.compactDoc({ frame: editor.doc.frame });
    editor.doc = JSON.parse(JSON.stringify(wire));
    const S = editor.doc.frame.children[0].effects.spectralField;
    expect(S.intensity).toBeCloseTo(1.4);
    expect(S.boundaryOffset).toBeCloseTo(0.3);
    expect(S.stops[2].color.map((v) => +v.toFixed(3))).toEqual([0.25, 0.5, 0.75]);
  });
});

describe("documents saved under the old name", () => {
  function legacyDoc(extra) {
    editor.doc = {
      frame: {
        name: "F",
        w: 900,
        h: 600,
        bg: "#ffffff",
        artboards: [],
        children: [
          {
            type: "rect",
            name: "Old",
            x: 0,
            y: 0,
            w: 300,
            h: 300,
            fill: { kind: "solid", color: "#cccccc" },
            effects: Object.assign({ orb: { on: true, radius: 0.92, centerX: 0.4 } }, extra || {}),
            fx: [{ id: "e1", type: "orb", on: true, params: { on: true, radius: 0.92 } }],
          },
        ],
      },
    };
    return editor.doc.frame.children[0];
  }

  it("keeps the effect switched on rather than losing it", () => {
    expect(legacyDoc().effects.spectralField.on).toBe(true);
  });

  it("drops the circle geometry it used to carry", () => {
    const S = legacyDoc().effects.spectralField;
    expect(S.radius).toBeUndefined();
    expect(S.centerX).toBeUndefined();
  });

  it("remaps the stack entry in PLACE, keeping its position", () => {
    /* The obvious assertions here pass with or without the remap: an entry of
     * an unknown type is dropped and a fresh one appended, so the effect
     * survives either way. What only the remap preserves is WHERE it sits, and
     * the stack is ordered — appended to the end, an effect composites after
     * everything it used to composite before. */
    const o = legacyDoc({ grain: { amount: 0.5 } });
    o.fx = null;
    editor.doc = {
      frame: {
        name: "F",
        w: 900,
        h: 600,
        bg: "#ffffff",
        artboards: [],
        children: [
          {
            type: "rect",
            name: "Old",
            x: 0,
            y: 0,
            w: 300,
            h: 300,
            fill: { kind: "solid", color: "#cccccc" },
            effects: { orb: { on: true }, grain: { amount: 0.5 } },
            fx: [
              { id: "e1", type: "orb", on: true, params: { on: true } },
              { id: "e2", type: "grain", on: true, params: { amount: 0.5 } },
            ],
          },
        ],
      },
    };
    const obj = editor.doc.frame.children[0];
    expect(obj.fx.some((e) => e.type === "orb")).toBe(false);
    const types = obj.fx.map((e) => e.type);
    expect(
      types.indexOf("spectralField"),
      "the migrated entry was appended rather than kept in place",
    ).toBeLessThan(types.indexOf("grain"));
  });

  it("leaves no second effect behind under the old name", () => {
    expect(legacyDoc().effects.orb).toBeUndefined();
  });
});

/* THE REGRESSION. The bug this replaced drew a circle inside every rectangle,
 * so the test is the count: what share of the shape does the field actually
 * fill? An inscribed circle fills 78.5% of a square and nothing at its
 * corners. Anything less than all of it means geometry is still being
 * invented somewhere.
 *
 * Four shapes, one preset, because a square alone cannot tell a correct
 * solver from one that fits an ellipse to the bounds. The star and the
 * crescent can: a crescent's field must go the long way round, never across
 * the bite, and the inradius each shape reports is what pearl and rim are
 * scaled by. */
describe("the field fills the real shape", () => {
  const sq = (v) => v * v;
  const SHAPES = {
    square: [80, 80, (x, y) => x >= 6 && x < 74 && y >= 6 && y < 74],
    roundedRect: [
      80,
      80,
      (x, y) => {
        const r = 20;
        const X = Math.max(6 + r - x, 0, x - (73 - r));
        const Y = Math.max(6 + r - y, 0, y - (73 - r));
        return x >= 6 && x < 74 && y >= 6 && y < 74 && Math.hypot(X, Y) <= r;
      },
    ],
    star: [
      80,
      80,
      (x, y) => {
        const dx = x - 40,
          dy = y - 40;
        return Math.hypot(dx, dy) < 16 + 16 * Math.abs(Math.cos(2.5 * Math.atan2(dy, dx)));
      },
    ],
    crescent: [
      80,
      80,
      (x, y) => sq(x - 38) + sq(y - 40) < sq(32) && !(sq(x - 54) + sq(y - 40) < sq(26)),
    ],
  };

  function solveShape(name) {
    const [w, h, fn] = SHAPES[name];
    const mask = new Float32Array(w * h);
    let cells = 0;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if (fn(x, y)) {
          mask[y * w + x] = 1;
          cells++;
        }
    const pts = SF().traceBoundary(mask, w, h);
    const { s } = SF().arcLength(pts);
    const bnd = new Float32Array(w * h * 3).fill(-1);
    for (let i = 0; i < pts.length; i++) {
      const idx = pts[i][1] * w + pts[i][0];
      bnd[idx * 3] = 0.5 + 0.5 * Math.cos(6.2831853 * s[i]);
      bnd[idx * 3 + 1] = 0.5 + 0.5 * Math.cos(6.2831853 * (s[i] + 0.33));
      bnd[idx * 3 + 2] = 0.5 + 0.5 * Math.cos(6.2831853 * (s[i] + 0.67));
    }
    const C = SF().solveHarmonic(mask, bnd, w, h, 400);
    let filled = 0,
      leaked = 0;
    for (let i = 0; i < w * h; i++) {
      const lit = C[i * 3] + C[i * 3 + 1] + C[i * 3 + 2] > 1e-6;
      if (mask[i] > 0.5) {
        if (lit) filled++;
      } else if (lit) leaked++;
    }
    const dist = SF().distanceInside(mask, w, h);
    let inradius = 0;
    for (const d of dist) if (d > inradius) inradius = d;
    return { cells, filled, leaked, inradius, w, h, mask, C };
  }

  for (const name of Object.keys(SHAPES)) {
    it(`fills every cell of the ${name}, and none outside it`, () => {
      const r = solveShape(name);
      // 100%, not the 78.5% an inscribed circle would manage on a square
      expect(r.filled, `${name} was not filled completely`).toBe(r.cells);
      expect(r.leaked, `${name} leaked colour outside its own outline`).toBe(0);
    });
  }

  it("scales to each shape's own inradius rather than to the bounding box", () => {
    /* All four sit in the same 80x80 grid. If the field were derived from the
     * bounds, these would be equal; they are not, because each is measured
     * from the shape's own outline. Pearl depth and rim width are fractions of
     * this, so it is what makes them follow the geometry. */
    const sqr = solveShape("square").inradius;
    const star = solveShape("star").inradius;
    const cres = solveShape("crescent").inradius;
    expect(sqr).toBeGreaterThan(30);
    expect(star).toBeLessThan(sqr * 0.65); // a star is thin at its points
    expect(cres).toBeLessThan(star); // a crescent is thinner still
  });

  it("solves a crescent the long way round rather than across the bite", () => {
    /* The property no bounding-box method has. The two horns of a crescent are
     * close in space and far apart along the shape, so a field that reached
     * across the gap would blend them; one that respects the domain cannot. */
    const r = solveShape("crescent");
    const { w, C, mask } = r;
    const lit = (x, y) => mask[y * w + x] > 0.5;
    // the concave notch: inside the bounding box, outside the shape
    let checked = 0;
    for (let y = 30; y < 50; y++) {
      for (let x = 46; x < 62; x++) {
        if (lit(x, y)) continue;
        const i = y * w + x;
        expect(C[i * 3] + C[i * 3 + 1] + C[i * 3 + 2]).toBe(0);
        checked++;
      }
    }
    expect(checked, "the notch was empty, so this proved nothing").toBeGreaterThan(50);
  });
});
