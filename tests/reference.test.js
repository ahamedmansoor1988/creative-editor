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
