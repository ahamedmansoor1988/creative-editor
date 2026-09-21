// @vitest-environment node
/**
 * public/reference.js — reference measurement, classification and render
 * comparison. Pure functions over RGBA buffers; no canvas involved.
 *
 * The calibration block pins the thresholds against the nine references in
 * images/ as MEASURED (see the table at the top of reference.js), so a change
 * that reclassifies one of them fails here rather than in the browser.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
let R;

beforeAll(() => {
  const src = fs.readFileSync(path.join(here, "..", "public", "reference.js"), "utf8");
  const win = {};
  new Function("window", "document", src)(win, undefined);
  R = win.Reference;
});

/** RGBA buffer filled by f(x, y) -> [r, g, b]. */
function image(w, h, f) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = f(x, y);
      const i = (y * w + x) * 4;
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = 255;
    }
  }
  return px;
}
/** Deterministic noise in [-1, 1). */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2147483648 - 1;
  };
}

describe("features and classification", () => {
  it("reads a smooth gradient as a colour field", () => {
    const px = image(128, 96, (x, y) => [x * 2, y * 2, 200 - x]);
    const f = R.features(px, 128, 96);
    expect(f.edge24).toBeLessThan(0.05);
    expect(f.edge64).toBe(0);
    expect(R.classify(f).kind).toBe("color_field");
  });

  it("reads hard-edged bars as a composition with repetition metadata", () => {
    // 8 vertical bars, 16px each: hard edges, strongly periodic across columns
    const px = image(128, 96, (x) => (Math.floor(x / 8) % 2 ? [240, 240, 240] : [20, 20, 40]));
    const f = R.features(px, 128, 96);
    expect(f.edge64).toBeGreaterThan(0.05);
    const c = R.classify(f);
    expect(c.kind).toBe("composition");
    expect(c.periodic).toBe(true);
    expect(f.periodic.axis).toBe("cols");
    expect(f.periodic.lag).toBe(16);
    expect(f.periodic.count).toBe(8);
    expect(c.reasons.join(" ")).toMatch(/repeated vertically about 8 times/);
  });

  it("reads soft periodic ribs over a field as a material", () => {
    // a colour field modulated by soft vertical ribs: edges but no hard ones
    const px = image(128, 96, (x, y) => {
      const rib = 60 * Math.sin((x / 12) * Math.PI * 2);
      return [120 + rib, 80 + y + rib * 0.5, 160 + rib];
    });
    const f = R.features(px, 128, 96);
    expect(f.edge64).toBeLessThan(0.05);
    expect(f.periodic.strength).toBeGreaterThan(0.2);
    expect(f.periodic.amp).toBeGreaterThan(4);
    const c = R.classify(f);
    expect(c.kind).toBe("material");
    expect(c.reasons[0]).toMatch(/periodic vertical structure of about 1[01]/);
  });

  it("counts a palette, not a histogram", () => {
    const px = image(64, 64, (x, y) => (x < 32 ? [255, 0, 0] : y < 32 ? [0, 0, 255] : [0, 200, 0]));
    expect(R.distinctColours(px, 64, 64)).toBe(3);
  });

  it("measures film grain on a native crop and ignores clean renders", () => {
    const clean = image(64, 64, (x, y) => [x * 3, y * 3, 128]);
    expect(R.grainFromCrop(clean, 64, 64).amount).toBe(0);
    const rnd = lcg(7);
    const grainy = image(64, 64, (x, y) => {
      const n = rnd() * 9;
      return [x * 3 + n, y * 3 + n, 128 + n];
    });
    expect(R.grainFromCrop(grainy, 64, 64).amount).toBeGreaterThan(0.4);
  });
});

describe("calibration against the nine references in images/", () => {
  // 128px features as measured 6 Sep 2026 (scripts in the session transcript);
  // the expected classes are the routing the regression matrix requires.
  const MEASURED = [
    [
      "gradient-01",
      {
        edge24: 0.037,
        edge64: 0.0,
        colours: 26,
        periodic: { axis: "cols", lag: 2, strength: 0.8, amp: 0.91, count: 64 },
      },
      "color_field",
    ],
    [
      "gradient-02",
      {
        edge24: 0.059,
        edge64: 0.002,
        colours: 31,
        periodic: { axis: "cols", lag: 2, strength: 0.55, amp: 0.65, count: 64 },
      },
      "color_field",
    ],
    [
      "glass",
      {
        edge24: 0.143,
        edge64: 0.034,
        colours: 32,
        periodic: { axis: "cols", lag: 16, strength: 0.28, amp: 8.29, count: 6 },
      },
      "material",
    ],
    [
      "object-01",
      {
        edge24: 0.166,
        edge64: 0.015,
        colours: 30,
        periodic: { axis: "rows", lag: 9, strength: 0.31, amp: 1.7, count: 8 },
      },
      "composition",
    ],
    [
      "grid-01",
      {
        edge24: 0.145,
        edge64: 0.09,
        colours: 20,
        periodic: { axis: "rows", lag: 42, strength: 0.11, amp: 12.04, count: 3 },
      },
      "composition",
    ],
    [
      "hard edges",
      {
        edge24: 0.149,
        edge64: 0.069,
        colours: 18,
        periodic: { axis: "rows", lag: 16, strength: 0.35, amp: 8.39, count: 5 },
      },
      "composition",
    ],
    [
      "obj-02",
      {
        edge24: 0.237,
        edge64: 0.086,
        colours: 13,
        periodic: { axis: "rows", lag: 9, strength: 0.18, amp: 6.33, count: 8 },
      },
      "composition",
    ],
    [
      "object-03",
      {
        edge24: 0.253,
        edge64: 0.065,
        colours: 3,
        periodic: { axis: "cols", lag: 4, strength: 0.75, amp: 9.03, count: 26 },
      },
      "composition",
    ],
    [
      "gla21",
      {
        edge24: 0.382,
        edge64: 0.093,
        colours: 12,
        periodic: { axis: "rows", lag: 6, strength: 0.46, amp: 7.94, count: 21 },
      },
      "composition",
    ],
  ];
  for (const [name, f, expected] of MEASURED) {
    it(`${name} → ${expected}`, () => {
      expect(R.classify(f).kind).toBe(expected);
    });
  }
  it("marks the periodic compositions as repeated geometry, not materials", () => {
    const gla21 = MEASURED.find((m) => m[0] === "gla21")[1];
    const c = R.classify(gla21);
    expect(c.kind).toBe("composition");
    expect(c.periodic).toBe(true);
  });
});

describe("render comparison", () => {
  it("scores identical buffers as close and shifted ones as failed", () => {
    const a = image(32, 32, (x, y) => [x * 4, y * 4, 100]);
    const b = image(32, 32, (x, y) => [x * 4 + 40, y * 4 + 40, 140]);
    expect(R.meanError(a, a)).toBe(0);
    expect(R.verdict(R.meanError(a, a))).toBe("close");
    expect(R.meanError(a, b)).toBeCloseTo(40, 0);
    expect(R.verdict(40)).toBe("failed");
    expect(R.verdict(20)).toBe("approximate");
    expect(R.verdict(NaN)).toBe("unmeasured");
  });

  it("locates the error per cell, with both colours, for an aimed retry", () => {
    const a = image(32, 32, () => [200, 200, 200]);
    const b = image(32, 32, (x, y) => (x >= 24 && y >= 24 ? [0, 0, 0] : [200, 200, 200]));
    const cells = R.cellErrors(a, b, 32, 32, 4);
    expect(cells).toHaveLength(4);
    expect(cells[0][0].err).toBe(0);
    expect(cells[3][3].err).toBe(200);
    expect(cells[3][3].ref).toBe("#c8c8c8");
    expect(cells[3][3].got).toBe("#000000");
  });

  it("samples a measured grid, row 0 at the top", () => {
    const px = image(16, 16, (x, y) => (y < 8 ? [255, 0, 0] : [0, 0, 255]));
    const rows = R.sampleGrid(px, 16, 16, 2);
    expect(rows).toEqual([
      ["#ff0000", "#ff0000"],
      ["#0000ff", "#0000ff"],
    ]);
  });

  it("keeps the comparison size proportional to the reference", () => {
    expect(R.compareSize(2)).toEqual({ W: 96, H: 48 });
    expect(R.compareSize(0.5)).toEqual({ W: 48, H: 96 });
    expect(R.compareSize(NaN)).toEqual({ W: 96, H: 96 });
  });
});

/* 18 Sep 2026. A photograph of reeded glass over orange shapes came back from
 * the pipeline as a bare mesh gradient. The ribs HAD been measured — the
 * classifier returned periodic:true — but the colour-field test was asked
 * first and reads only edges, and a photograph of fluted glass is soft
 * everywhere. It returned a colour field while holding the evidence of a
 * material in its own result. */
describe("a soft surface that repeats is a material, not a colour field", () => {
  const softRibs = {
    edge24: 0.085, // under fieldEdge 0.10 — no hard object edges anywhere
    edge64: 0.004, // under fieldHard 0.01 — this is what claimed "colour field"
    colours: 220,
    periodic: { axis: "cols", lag: 18, count: 20, strength: 0.62, amp: 14.0 },
  };

  it("classifies soft, strongly periodic pixels as a material", () => {
    const c = R.classify(softRibs);
    expect(c.kind).toBe("material");
    expect(c.periodic).toBe(true);
  });

  it("says in words that it saw the ribs", () => {
    expect(R.classify(softRibs).reasons[0]).toMatch(/periodic vertical structure of about 20/);
  });

  it("still calls the same pixels a colour field once the ribs go flat", () => {
    // Only the amplitude changes: a gradient's profile repeats but does not
    // swing. That is the line between a field and a surface.
    const flat = { ...softRibs, periodic: { ...softRibs.periodic, amp: 0.9 } };
    expect(R.classify(flat).kind).toBe("color_field");
  });

  it("does not promote a HARD periodic image out of composition", () => {
    // Slats and grids repeat too; they are arrangements, not surfaces.
    const slats = { ...softRibs, edge64: 0.09 };
    expect(R.classify(slats).kind).toBe("composition");
  });
});

/* 18 Sep 2026, second pass. The reorder above was necessary but not
 * sufficient: Mansoor's own photograph still came back a colour field. The
 * ribs HAD been counted correctly — 43 of 45 — and were then discarded by a
 * lag floor that read "lags 2..3 are pixel noise". At 128px a lag of 2 is the
 * Nyquist limit, so the floor rejected every reference finer than ~32 flutes.
 * The profile is a MEAN down the whole axis, and averaging 128 rows divides
 * noise by about eleven, so amplitude already draws that line. The floor is
 * gone; these hold the line that replaced it. */
describe("fine ribs are ribs, not noise", () => {
  const fine = {
    edge24: 0.0,
    edge64: 0.0,
    colours: 240,
    // 45 flutes measured through the real path: lag 2, the finest resolvable.
    periodic: { axis: "cols", lag: 2, count: 43, strength: 0.833, amp: 9.69 },
  };

  it("accepts a strong, high-amplitude signal at the Nyquist lag", () => {
    expect(R.classify(fine).kind).toBe("material");
  });

  it("still rejects a gradient sitting at the same lag", () => {
    // gradient-01 and -02 both peak at lag 2. Amplitude is what separates
    // them from flutes: 0.91 and 0.65 against 9.69, an order apart.
    for (const amp of [0.91, 0.65]) {
      const g = { ...fine, periodic: { ...fine.periodic, amp } };
      expect(R.classify(g).kind).toBe("color_field");
    }
  });

  it("has no lag threshold left to tune", () => {
    expect(R.THRESHOLDS.periodicLag).toBeUndefined();
  });

  it("reports ribs it cannot resolve as absent rather than as a wrong count", () => {
    // Past Nyquist the flutes average away; amplitude collapses to ~0.4, so
    // the picture reads as the smooth field it has become, not as false ribs.
    const aliased = { ...fine, periodic: { ...fine.periodic, count: 64, amp: 0.4 } };
    expect(R.classify(aliased).kind).toBe("color_field");
  });
});

/* 21 Sep 2026. An app icon came back as a flat grey slab. The colour grid
 * averaged raw RGB and ignored alpha entirely — and a transparent pixel
 * stores 0,0,0 — so every transparent region was MEASURED AS BLACK. An icon
 * is mostly transparent margin, so its corners sampled pure black and its
 * mean was dragged into the mud, and the background, the mesh net and every
 * palette built off that grid inherited it.
 *
 * Transparency is absence, not a colour. */
describe("the colour grid weights by alpha", () => {
  /** A solid block of one colour covering the middle, transparent around it. */
  const iconish = (w, h, colour) => {
    const [r, g, b] = colour;
    const a = new Uint8ClampedArray(w * h * 4);
    const m = Math.round(w * 0.25);
    for (let y = m; y < h - m; y++)
      for (let x = m; x < w - m; x++) {
        const i = (y * w + x) * 4;
        a[i] = r;
        a[i + 1] = g;
        a[i + 2] = b;
        a[i + 3] = 255;
      }
    return a;
  };

  it("does not report transparent margin as black", () => {
    const w = 64,
      h = 64;
    const rows = R.sampleGrid(iconish(w, h, [180, 60, 220]), w, h, 4);
    expect(rows.flat()).not.toContain("#000000");
  });

  it("gives an empty cell the picture's own colour, not an invented one", () => {
    const w = 64,
      h = 64;
    const rows = R.sampleGrid(iconish(w, h, [180, 60, 220]), w, h, 4);
    // the corner cell holds nothing; it takes the mean of what IS there
    expect(rows[0][0]).toBe("#b43cdc");
  });

  it("still measures an opaque picture exactly as before", () => {
    // the nine references are JPEGs: no alpha, so nothing about them moves
    const w = 8,
      h = 8;
    const a = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      a[i * 4] = 10 + i;
      a[i * 4 + 1] = 20;
      a[i * 4 + 2] = 30;
      a[i * 4 + 3] = 255;
    }
    const rows = R.sampleGrid(a, w, h, 2);
    expect(rows).toHaveLength(2);
    expect(rows[0][0]).toMatch(/^#[0-9a-f]{6}$/);
    // green and blue are constant, so they survive the average untouched
    expect(rows[0][0].slice(3)).toBe("141e");
  });

  it("weights a half-transparent pixel at half, not at full", () => {
    const w = 2,
      h = 1;
    const a = new Uint8ClampedArray(w * h * 4);
    a[0] = 255;
    a[3] = 255; // opaque red
    a[4] = 0;
    a[5] = 0;
    a[6] = 255;
    a[7] = 128; // half-alpha blue
    const [cell] = R.sampleGrid(a, w, h, 1).flat();
    const v = parseInt(cell.slice(1), 16);
    const red = (v >> 16) & 255,
      blue = v & 255;
    expect(red).toBeGreaterThan(blue); // the opaque one carries more weight
  });

  it("falls back to white only when there is nothing at all", () => {
    const w = 4,
      h = 4;
    expect(R.sampleGrid(new Uint8ClampedArray(w * h * 4), w, h, 2).flat()).toEqual([
      "#ffffff",
      "#ffffff",
      "#ffffff",
      "#ffffff",
    ]);
  });
});
