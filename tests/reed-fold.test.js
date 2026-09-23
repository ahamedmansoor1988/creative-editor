// @vitest-environment node
/**
 * Reed glass: a ray that leaves the artboard is folded back, not pinned.
 *
 * The page sampler clamped an off-artboard sample to the artboard's edge
 * column. A ray's tilt grows without bound towards a seam (tan of the exit
 * angle, times the air gap), so beside every seam a band of rays all landed on
 * that one column: horizontal streaks, varying only down the panel. Measured
 * live at flute width 310: 40% of a row was the right edge column within 12
 * levels, and the band's colours down the rows were the column's. Folding the
 * point into the page over its span never lands two rays on one texel.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "public", "reedglass.js"), "utf8");
const page = src.slice(src.indexOf("vec3 page(vec2 sp){"), src.indexOf("vec2 here(){"));

describe("the page sampler folds", () => {
  it("maps an off-page point with a triangle wave over the artboard span", () => {
    expect(page).toContain("vec2 span = max(hi - lo, vec2(1.0));");
    expect(page).toContain("vec2 tt = mod(sp - lo, 2.0 * span);");
    expect(page).toContain("sp = lo + (span - abs(tt - span));");
  });

  it("folds before the safety clamp, so the clamp no longer decides where a ray lands", () => {
    expect(page.indexOf("abs(tt - span)")).toBeLessThan(page.indexOf("sp = clamp(sp, lo, hi);"));
  });

  it("still answers the page colour where artboard and texture do not overlap", () => {
    expect(page).toContain("if (hi.x < lo.x || hi.y < lo.y) return uPageBg;");
  });

  it("is a new build, so the cache key and the console stamp say so", () => {
    expect(src).toContain('VERSION: "20260923-fold1"');
    const index = fs.readFileSync(path.join(here, "..", "public", "index.html"), "utf8");
    expect(index).toContain("reedglass.js?v=20260923-fold1");
  });

  /* The fold, run on the CPU as the shader runs it: mod, then a triangle wave. */
  const fold = (v, lo, hi) => {
    const span = Math.max(hi - lo, 1);
    const m = (((v - lo) % (2 * span)) + 2 * span) % (2 * span);
    return lo + (span - Math.abs(m - span));
  };
  it("continues the page in both directions and never pins to an edge", () => {
    const lo = 4,
      hi = 696;
    expect(fold(300, lo, hi)).toBe(300); // inside: untouched
    expect(fold(hi + 10, lo, hi)).toBe(hi - 10); // just past the right edge: mirrored back
    expect(fold(lo - 10, lo, hi)).toBe(lo + 10); // just before the left edge
    // ten rays past the edge land on ten different points, not one column
    const landings = new Set(Array.from({ length: 10 }, (_, k) => fold(hi + 5 + k * 7, lo, hi)));
    expect(landings.size).toBe(10);
    // far away: still inside the span
    for (const v of [-5000, 12345, 99999]) {
      const f = fold(v, lo, hi);
      expect(f).toBeGreaterThanOrEqual(lo);
      expect(f).toBeLessThanOrEqual(hi);
    }
  });
});
