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

/* 21 Sep 2026, and the other half of it. Weighting the grid by alpha stopped
 * the GRID reading black, but the copy SENT TO THE MODEL was still flattened
 * onto a fresh canvas — transparent black — and encoded as JPEG, which has no
 * alpha. So the model was shown an app icon on a black field, reported a dark
 * ground perfectly reasonably, and the composition came back a grey slab.
 *
 * One mechanism fixes both: a transparent reference is what it looks like ON A
 * PAGE, and the page is white. Composited once at decode, so the grid, the
 * edges and the model's copy are all measuring the same picture. */
describe("a transparent reference is measured on the page, not on black", () => {
  it("composites at decode rather than inheriting a transparent canvas", () => {
    const src = fs.readFileSync(path.join(here, "..", "public", "reference.js"), "utf8");
    const fn = src.slice(src.indexOf("function imageToRGBA"), src.indexOf("function compareSize"));
    expect(fn).toContain('x.fillStyle = "#ffffff"');
    // the fill must come BEFORE the draw that is read out, or it erases the
    // picture; the first draw is the raw one whose alpha plane is kept aside
    const readOut = fn.indexOf("const d = x.getImageData");
    const flatDraw = fn.lastIndexOf("drawImage", readOut);
    expect(fn.indexOf("fillRect")).toBeLessThan(flatDraw);
    expect(flatDraw).toBeLessThan(readOut);
    expect(fn).toContain("d.alpha = alpha");
  });

  it("sends the model the same white ground the pixels are measured on", () => {
    const app = fs.readFileSync(path.join(here, "..", "public", "app.js"), "utf8");
    const fn = app.slice(app.indexOf("async function shrinkForModel"));
    const body = fn.slice(0, 1600);
    expect(body).toContain("x.fillStyle='#ffffff'");
    expect(body.indexOf("fillRect")).toBeLessThan(body.indexOf("x.drawImage"));
  });

  it("routes every image through it, not only the ones big enough to shrink", () => {
    /* A small PNG used to be forwarded untouched, so whether the model saw
     * transparency at all depended on the file's size. */
    const app = fs.readFileSync(path.join(here, "..", "public", "app.js"), "utf8");
    const fn = app.slice(
      app.indexOf("async function shrinkForModel"),
      app.indexOf("async function shrinkForModel") + 1600,
    );
    expect(fn).not.toContain("if(scale>=1) return dataUrl;");
  });
});

/* 21 Sep 2026. "create this" over an app icon came back as two stacked copies
 * stretched to the frame. The model had named the right things; it was free
 * to invent where they were and how many, because nothing MEASURED that. The
 * pipeline measures colour so the model cannot invent it; this measures the
 * subject so it cannot invent placement either. */
describe("where the subject is", () => {
  /** A w x h picture of ground colour g with one solid block of colour c. */
  const scene = (w, h, g, c, box) => {
    const a = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      a[i * 4] = g[0];
      a[i * 4 + 1] = g[1];
      a[i * 4 + 2] = g[2];
      a[i * 4 + 3] = 255;
    }
    const paint = ([x0, y0, bw, bh]) => {
      for (let y = y0; y < y0 + bh; y++)
        for (let x = x0; x < x0 + bw; x++) {
          const i = (y * w + x) * 4;
          a[i] = c[0];
          a[i + 1] = c[1];
          a[i + 2] = c[2];
        }
    };
    (Array.isArray(box[0]) ? box : [box]).forEach(paint);
    return a;
  };

  it("finds one icon on a plain ground and boxes it, in percent", () => {
    // a wide frame, a square subject in the middle: the case that failed
    const w = 160,
      h = 90;
    const s = R.subjectBox(scene(w, h, [255, 255, 255], [80, 110, 240], [60, 15, 40, 60]), w, h);
    expect(s.count).toBe(1);
    expect(s.ground).toBe("#ffffff");
    expect(s.x).toBeCloseTo(37.5, 0);
    expect(s.y).toBeCloseTo(16.7, 0);
    expect(s.w).toBeCloseTo(25, 0);
    expect(s.h).toBeCloseTo(66.7, 0);
    expect(s.coverage).toBeGreaterThan(0.95);
  });

  it("reads the ground off the border, whatever colour it is", () => {
    const w = 64,
      h = 64;
    const s = R.subjectBox(scene(w, h, [10, 12, 20], [230, 90, 40], [20, 20, 24, 24]), w, h);
    expect(s.count).toBe(1);
    expect(s.ground).toBe("#0a0c14");
  });

  it("is NOT one subject when the picture is a field that fills the frame", () => {
    // a gradient: everything differs from the border somewhere, and the box
    // is the whole frame. That is a field, not a thing on a ground.
    const w = 64,
      h = 64;
    const a = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        a[i] = (x * 4) % 256;
        a[i + 1] = 80;
        a[i + 2] = (y * 4) % 256;
        a[i + 3] = 255;
      }
    expect(R.subjectBox(a, w, h).count).toBe(0);
  });

  it("is NOT one subject when there are several things with gaps between them", () => {
    // four slabs in four corners: their joint box is mostly empty ground
    const w = 100,
      h = 100;
    const four = [
      [5, 5, 30, 30],
      [65, 5, 30, 30],
      [5, 65, 30, 30],
      [65, 65, 30, 30],
    ];
    const s = R.subjectBox(scene(w, h, [255, 255, 255], [240, 120, 30], four), w, h);
    expect(s.count).toBe(0);
    expect(s.coverage).toBeLessThan(0.6); // 44%: mostly the ground between them
  });

  it("is nothing when nothing differs from the ground", () => {
    const w = 32,
      h = 32;
    const s = R.subjectBox(scene(w, h, [200, 200, 200], [200, 200, 200], [4, 4, 4, 4]), w, h);
    expect(s.count).toBe(0);
  });

  it("is carried in the features the model is handed", () => {
    const w = 64,
      h = 64;
    const a = scene(w, h, [255, 255, 255], [80, 110, 240], [16, 16, 32, 32]);
    const f = R.features(a, w, h, null);
    expect(f.subject).toBeTruthy();
    expect(f.subject.count).toBe(1);
  });
});

/* 22 Sep 2026. Mansoor's Morpho icon is FULL-BLEED: the picture is the icon,
 * only its corners cut. With the border's median as the only ground, the
 * edges are all icon, the median is icon, the box is the whole frame with
 * nothing around it — no subject, and the model's two slabs went through.
 * So the ground is tried three ways (transparency, the border median, the
 * colour the four corners share), and a subject must have an EDGE, which is
 * the one thing a radial wash with agreeing corners does not have. */
describe("a full-bleed subject", () => {
  const W = 160,
    H = 160;
  /** The frame IS a rounded rect of colour c (or a gradient from c to c2),
   *  radius r; the corners are transparent (alpha 0) or painted g. */
  const fullBleed = ({ r, c, c2 = null, g, transparent = false }) => {
    const rgba = new Uint8ClampedArray(W * H * 4);
    const alpha = new Uint8Array(W * H);
    const inside = (x, y) => {
      const px = x + 0.5,
        py = y + 0.5;
      const cx = px < r ? r : px > W - r ? W - r : px;
      const cy = py < r ? r : py > H - r ? H - r : py;
      return Math.hypot(px - cx, py - cy) <= r;
    };
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4,
          j = y * W + x;
        if (inside(x, y)) {
          const t = c2 ? (x + y) / (W + H) : 0;
          const col = c2 ? c.map((v, k) => v + (c2[k] - v) * t) : c;
          rgba[i] = col[0];
          rgba[i + 1] = col[1];
          rgba[i + 2] = col[2];
          rgba[i + 3] = 255;
          alpha[j] = 255;
        } else {
          // what flattening onto white leaves in a cut corner
          rgba[i] = g[0];
          rgba[i + 1] = g[1];
          rgba[i + 2] = g[2];
          rgba[i + 3] = 255;
          alpha[j] = transparent ? 0 : 255;
        }
      }
    return { rgba, alpha: transparent ? alpha : null };
  };
  const BLUE = [80, 110, 240],
    WHITE = [255, 255, 255];

  it("with transparent corners: one subject filling the frame, on a transparent ground", () => {
    const { rgba, alpha } = fullBleed({ r: 32, c: BLUE, g: WHITE, transparent: true });
    const s = R.subjectBox(rgba, W, H, alpha);
    expect(s.count).toBe(1);
    expect(s.ground).toBe("transparent");
    expect([s.x, s.y, s.w, s.h]).toEqual([0, 0, 100, 100]);
    expect(Math.abs(s.radius - 20)).toBeLessThan(2);
  });

  it("flattened onto white (a JPEG): the corners' colour is the ground", () => {
    const { rgba } = fullBleed({ r: 32, c: BLUE, g: WHITE, transparent: false });
    const s = R.subjectBox(rgba, W, H, null);
    expect(s.count).toBe(1);
    expect(s.ground).toBe("#ffffff");
    expect([s.x, s.y, s.w, s.h]).toEqual([0, 0, 100, 100]);
    expect(Math.abs(s.radius - 20)).toBeLessThan(2);
  });

  it("keeps a gradient-filled icon whose light end is near the ground", () => {
    // a mesh-like fill running from deep blue to a pale blue 47 off white
    const { rgba } = fullBleed({
      r: 32,
      c: BLUE,
      c2: [208, 220, 255],
      g: WHITE,
      transparent: false,
    });
    const s = R.subjectBox(rgba, W, H, null);
    expect(s.count).toBe(1);
    expect(s.ground).toBe("#ffffff");
  });

  it("a full-bleed circle: the border median is white and the box is the frame", () => {
    const { rgba } = fullBleed({ r: 80, c: BLUE, g: WHITE, transparent: false });
    const s = R.subjectBox(rgba, W, H, null);
    expect(s.count).toBe(1);
    expect(s.radius).toBeGreaterThan(45);
  });

  it("a radial wash whose corners agree is NOT a subject: it has no edge", () => {
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const d = Math.hypot(x - W / 2, y - H / 2) / Math.hypot(W / 2, H / 2); // 0 centre, 1 corner
        const i = (y * W + x) * 4;
        rgba[i] = 255 - 200 * d;
        rgba[i + 1] = 120 - 100 * d;
        rgba[i + 2] = 255 - 60 * d;
        rgba[i + 3] = 255;
      }
    const s = R.subjectBox(rgba, W, H, null);
    expect(s.count).toBe(0);
    expect(R.classify(R.features(rgba, W, H, null)).kind).not.toBe("composition");
  });

  it("a picture with hard edges everywhere is NOT a subject: nothing is ground", () => {
    // a checkerboard fills the frame; the corners are not a ground around anything
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const on = ((x >> 4) + (y >> 4)) & 1;
        const i = (y * W + x) * 4;
        rgba[i] = on ? 240 : 30;
        rgba[i + 1] = on ? 120 : 60;
        rgba[i + 2] = on ? 40 : 200;
        rgba[i + 3] = 255;
      }
    expect(R.subjectBox(rgba, W, H, null).count).toBe(0);
  });

  it("is what the live measurement hands over, alpha and all", () => {
    const { rgba, alpha } = fullBleed({ r: 32, c: BLUE, g: WHITE, transparent: true });
    const f = R.features(rgba, W, H, null, alpha);
    expect(f.subject.count).toBe(1);
    expect(f.subject.ground).toBe("transparent");
    expect(R.classify(f).kind).toBe("composition");
    expect(R.classify(f).reasons[0]).toMatch(
      /one subject on a plain transparent ground, 100% x 100%/,
    );
  });
});

/* 22 Sep 2026. A lone rounded square on white measured as a MATERIAL in the
 * live editor — soft anti-aliased edges over a profile whose one plateau
 * counted as periodic — and took the material route, where no subject can be
 * built. One measured subject on a plain ground is a composition, first. */
describe("one measured subject decides the route", () => {
  const soft = {
    edge24: 0.02,
    edge64: 0.004,
    colours: 3,
    periodic: { axis: "rows", lag: 40, strength: 0.9, amp: 12, count: 2 },
  };
  it("routes a thing on a ground to the composition route, whatever its edges", () => {
    expect(R.classify(soft).kind).toBe("material"); // the reading it got before
    const c = R.classify({
      ...soft,
      subject: { count: 1, ground: "#ffffff", x: 31.3, y: 16.7, w: 37.5, h: 66.7, radius: 21.3 },
    });
    expect(c.kind).toBe("composition");
    expect(c.reasons[0]).toMatch(/one subject on a plain #ffffff ground, 37.5% x 66.7%/);
    expect(c.reasons[0]).toMatch(/corner radius 21.3%/);
  });
  it("says nothing about corners when there are none", () => {
    const c = R.classify({
      ...soft,
      subject: { count: 1, ground: "#000000", w: 40, h: 40, radius: 0 },
    });
    expect(c.kind).toBe("composition");
    expect(c.reasons[0]).not.toMatch(/corner/);
  });
  it("changes nothing when the pixels did not find one subject", () => {
    expect(R.classify({ ...soft, subject: { count: 0, ground: "#ffffff" } }).kind).toBe("material");
    expect(R.classify(soft).kind).toBe("material");
  });
  it("is what the live measurement hands over", () => {
    // the icon from the live editor: 1600x900 white, one blue rounded square
    const w = 160,
      h = 90;
    const a = new Uint8ClampedArray(w * h * 4).fill(255);
    for (let y = 15; y < 75; y++)
      for (let x = 50; x < 110; x++) {
        const i = (y * w + x) * 4;
        a[i] = 80;
        a[i + 1] = 110;
        a[i + 2] = 240;
      }
    const f = R.features(a, w, h, null);
    expect(f.subject.count).toBe(1);
    expect(R.classify(f).kind).toBe("composition");
  });
});

/* 21 Sep 2026. The one thing the model can't be trusted with and the pixels
 * can measure: the corner radius. Walked in along the box's diagonal from each
 * corner, the subject begins 0.293r in, so that walk IS the radius. A circle
 * reads as 50% of the shorter side — a pill — and a sharp rect as 0. */
describe("the subject's corner radius, measured", () => {
  /** A w x h picture: ground g, one rounded rect of colour c at box, radius r. */
  const rounded = (w, h, g, c, [x0, y0, bw, bh], r) => {
    const a = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      a[i * 4] = g[0];
      a[i * 4 + 1] = g[1];
      a[i * 4 + 2] = g[2];
      a[i * 4 + 3] = 255;
    }
    const inside = (x, y) => {
      const px = x + 0.5,
        py = y + 0.5;
      const lx = x0 + r,
        rx = x0 + bw - r,
        ty = y0 + r,
        by = y0 + bh - r;
      if (px < x0 || px > x0 + bw || py < y0 || py > y0 + bh) return false;
      const cx = px < lx ? lx : px > rx ? rx : px;
      const cy = py < ty ? ty : py > by ? by : py;
      return Math.hypot(px - cx, py - cy) <= r;
    };
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if (inside(x, y)) {
          const i = (y * w + x) * 4;
          a[i] = c[0];
          a[i + 1] = c[1];
          a[i + 2] = c[2];
        }
    return a;
  };
  const W = 200,
    H = 200,
    G = [255, 255, 255],
    C = [80, 110, 240];

  it("reads a rounded square's radius off the silhouette", () => {
    // box 120 wide, radius 30 -> 25% of the shorter side
    const s = R.subjectBox(rounded(W, H, G, C, [40, 40, 120, 120], 30), W, H);
    expect(s.count).toBe(1);
    expect(Math.abs(s.radius - 25)).toBeLessThan(3);
  });

  it("reads a sharp rectangle as 0", () => {
    const s = R.subjectBox(rounded(W, H, G, C, [40, 60, 120, 80], 0), W, H);
    expect(s.count).toBe(1);
    expect(s.radius).toBeLessThan(1.5);
  });

  it("reads a circle as a pill: 50% of the shorter side", () => {
    const s = R.subjectBox(rounded(W, H, G, C, [40, 40, 120, 120], 60), W, H);
    expect(s.count).toBe(1);
    expect(s.radius).toBeGreaterThan(45);
    expect(s.radius).toBeLessThanOrEqual(50);
  });

  it("is a percent of the SHORTER side on a wide subject", () => {
    // 160 wide, 80 tall, radius 20 -> 25% of 80
    const s = R.subjectBox(rounded(W, H, G, C, [20, 60, 160, 80], 20), W, H);
    expect(Math.abs(s.radius - 25)).toBeLessThan(3);
  });

  it("caps at 50 and never goes negative", () => {
    const s = R.subjectBox(rounded(W, H, G, C, [40, 40, 120, 120], 90), W, H);
    expect(s.radius).toBeLessThanOrEqual(50);
    expect(s.radius).toBeGreaterThanOrEqual(0);
  });

  it("a single solid subject still counts as one; four slabs still do not", () => {
    expect(R.subjectBox(rounded(W, H, G, C, [40, 40, 120, 120], 60), W, H).count).toBe(1); // circle: 78%
    const a = rounded(W, H, G, C, [10, 10, 60, 60], 0);
    // paint three more sharp blocks in the other corners
    for (const [x0, y0] of [
      [130, 10],
      [10, 130],
      [130, 130],
    ])
      for (let y = y0; y < y0 + 60; y++)
        for (let x = x0; x < x0 + 60; x++) {
          const i = (y * W + x) * 4;
          a[i] = C[0];
          a[i + 1] = C[1];
          a[i + 2] = C[2];
        }
    expect(R.subjectBox(a, W, H).count).toBe(0);
  });
});
