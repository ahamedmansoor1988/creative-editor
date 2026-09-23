// @vitest-environment node
/**
 * public/structure.js — the repeater, symmetry and echo, testable in node.
 *
 * The first seam cut from app.js (23 Sep 2026): pure geometry that touched no
 * editor state and could only be reached by booting the whole editor in
 * jsdom. These tests run on plain objects. The behaviour tests that already
 * exist (pattern, echo, symmetry, recipe-contract) still run through the
 * editor and did not change.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(here, "..", "public", f), "utf8");
let S;
beforeAll(() => {
  const win = {};
  new Function("window", read("structure.js"))(win);
  S = win.Structure;
});

const rect = (over) => Object.assign({ id: "r", type: "rect", x: 0, y: 0, w: 50, h: 20 }, over);

describe("loads alone, and the editor binds its names from it", () => {
  it("exposes every name the editor used to define", () => {
    for (const n of [
      "normalizePattern",
      "normalizeEcho",
      "normalizeSymmetry",
      "patternInstances",
      "echoInstances",
      "symmetryInstances",
      "derivedInstances",
      "instanceBounds",
      "symmetryOps",
      "applySymmetryOp",
      "rand01",
      "DEFAULT_PATTERN",
      "DEFAULT_ECHO",
      "DEFAULT_SYMMETRY",
      "MAX_PATTERN_INSTANCES",
    ])
      expect(typeof S[n], n).not.toBe("undefined");
  });
  it("app.js defines none of them any more, and aliases them from the module", () => {
    const app = read("app.js");
    for (const n of [
      "patternInstances",
      "echoInstances",
      "derivedInstances",
      "normalizePattern",
      "normalizeEcho",
      "normalizeSymmetry",
      "symmetryOps",
      "instanceBounds",
      "rand01",
    ])
      expect(app, n).not.toMatch(new RegExp("^function " + n + "\\(", "m"));
    expect(app).toMatch(
      /^const \{MAX_PATTERN_INSTANCES, .*derivedInstances\}=window\.Structure;$/m,
    );
    const index = read("index.html");
    expect(index.indexOf('src="structure.js')).toBeLessThan(index.indexOf('src="app.js'));
    expect(read("../tests/helpers/load-editor.js")).toContain('"structure.js"');
  });
});

describe("the repeater", () => {
  it("lays a grid: cells minus the parent, deterministic for a seed", () => {
    const p = S.normalizePattern({ columns: 3, rows: 2, hGap: 10, vGap: 10, seed: 7 });
    const a = S.patternInstances(rect({ pattern: p }));
    expect(a).toHaveLength(5);
    const b = S.patternInstances(rect({ pattern: p }));
    expect(a.map((i) => [i.x, i.y, i.w, i.h])).toEqual(b.map((i) => [i.x, i.y, i.w, i.h]));
    // the first copy sits one width plus one gap to the right
    expect(a[0].x).toBe(60);
    expect(a[0].y).toBe(0);
  });
  it("clamps what the normaliser takes", () => {
    const p = S.normalizePattern({ columns: 999, rows: -4, holes: 3, mirror: "sideways" });
    expect(p.columns).toBe(S.MAX_GRID_AXIS);
    expect(p.rows).toBe(1);
    expect(p.holes).toBe(S.MAX_HOLES);
    expect(p.mirror).toBe("none");
  });
  it("never exceeds the instance ceiling", () => {
    const p = S.normalizePattern({ columns: 32, rows: 32, hGap: 0, vGap: 0 });
    expect(S.patternInstances(rect({ pattern: p })).length).toBeLessThanOrEqual(
      S.MAX_PATTERN_INSTANCES,
    );
  });
});

describe("echo", () => {
  it("stacks copies that shrink and step, compounding", () => {
    const e = S.echoInstances(
      rect({ echo: S.normalizeEcho({ copies: 4, widthScale: 0.88, heightScale: 0.62 }) }),
    );
    expect(e).toHaveLength(4);
    const widths = e.map((i) => i.w);
    for (let k = 1; k < widths.length; k++) expect(widths[k]).toBeLessThan(widths[k - 1]);
    expect(widths[0]).toBeCloseTo(50 * 0.88, 5);
    expect(widths[1]).toBeCloseTo(50 * 0.88 * 0.88, 5);
  });
  it("is the same stack every time for a seed", () => {
    const mk = () =>
      S.echoInstances(rect({ echo: S.normalizeEcho({ copies: 5, randomness: 0.6, seed: 42 }) }));
    expect(mk().map((i) => [i.x, i.y, i.rot])).toEqual(mk().map((i) => [i.x, i.y, i.rot]));
  });
});

describe("symmetry", () => {
  it("radial: count minus one turns about the pivot", () => {
    const out = S.derivedInstances(
      rect({
        x: 100,
        y: 100,
        w: 40,
        h: 40,
        symmetry: S.normalizeSymmetry({ mode: "radial", count: 6 }),
      }),
    );
    expect(out).toHaveLength(5);
    expect(new Set(out.map((i) => Math.round(i.rot))).size).toBe(5);
  });
  it("mirror: one reflection per axis, both gives three", () => {
    const one = S.derivedInstances(
      rect({ symmetry: S.normalizeSymmetry({ mode: "mirror", axis: "vertical", gap: 10 }) }),
    );
    expect(one).toHaveLength(1);
    expect(one[0].x).toBe(60); // width plus the gap, to the right
    const both = S.derivedInstances(
      rect({ symmetry: S.normalizeSymmetry({ mode: "mirror", axis: "both" }) }),
    );
    expect(both).toHaveLength(3);
  });
  it("bounds of a turned layer follow the turn", () => {
    const b = S.instanceBounds(rect({ w: 100, h: 10, rot: 90 }));
    expect(b.w).toBeCloseTo(10, 5);
    expect(b.h).toBeCloseTo(100, 5);
  });
});

describe("all three together", () => {
  it("a grid, each cell stacked, then reflected — and still under the ceiling", () => {
    const o = rect({
      pattern: S.normalizePattern({ columns: 3, rows: 1, hGap: 10 }),
      echo: S.normalizeEcho({ copies: 2 }),
      symmetry: S.normalizeSymmetry({ mode: "mirror", axis: "vertical" }),
    });
    const n = S.derivedInstances(o).length;
    // 2 grid copies + (1 parent + 2 copies) × 2 echoes = 8, then 9 things mirrored once = 17
    expect(n).toBe(17);
    expect(n).toBeLessThanOrEqual(S.MAX_PATTERN_INSTANCES);
  });
});
