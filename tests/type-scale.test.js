/**
 * The type scale is a constraint, not a suggestion.
 *
 * Every font size in the app lives in 11-14px and comes from a role token.
 * Both halves matter: a raw `font-size: 9px` bypasses the scale silently, and
 * a token redefined to 15px breaks it everywhere at once. These tests read the
 * shipped stylesheet rather than a copy of the rules, so drift fails here
 * before anyone sees it on screen.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const CSS = join(here, "..", "public", "style.css");
const APP = join(here, "..", "public", "app.js");

const MIN = 11;
const MAX = 14;
const ROLES = ["title", "section", "body", "control", "meta"];

let css, app;
beforeAll(() => {
  css = readFileSync(CSS, "utf8");
  app = readFileSync(APP, "utf8");
});

/** Every `--text-<role>: <n>px` declaration, as {role, px}. */
function roleSizes(source) {
  const out = {};
  const re = /--text-(title|section|body|control|meta)\s*:\s*([0-9.]+)px/g;
  let m;
  while ((m = re.exec(source))) out[m[1]] = Number(m[2]);
  return out;
}

describe("type scale", () => {
  it("defines every role exactly once", () => {
    const sizes = roleSizes(css);
    expect(Object.keys(sizes).sort()).toEqual([...ROLES].sort());
  });

  it("keeps every role inside 11-14px", () => {
    const sizes = roleSizes(css);
    for (const [role, px] of Object.entries(sizes)) {
      expect(px, `--text-${role} is ${px}px`).toBeGreaterThanOrEqual(MIN);
      expect(px, `--text-${role} is ${px}px`).toBeLessThanOrEqual(MAX);
    }
  });

  it("orders the roles from title down to meta", () => {
    // hierarchy is size THEN weight; sizes must never invert
    const s = roleSizes(css);
    expect(s.title).toBeGreaterThanOrEqual(s.section);
    expect(s.section).toBeGreaterThanOrEqual(s.body);
    expect(s.body).toBeGreaterThan(s.control);
    expect(s.control).toBeGreaterThan(s.meta);
  });

  it("has no raw px font-size anywhere in the stylesheet", () => {
    // a literal bypasses the scale without tripping any of the checks above
    const raw = css.match(/font-size:\s*[0-9.]+px/g) || [];
    expect(raw).toEqual([]);
  });

  it("routes canvas text through the scale too", () => {
    // canvas has no CSS: the ruler sat at a hardcoded 9px for exactly this
    // reason, below the floor every DOM element respected
    const hardcoded = app.match(/font\s*=\s*['"][0-9.]+px/g) || [];
    expect(hardcoded).toEqual([]);
  });

  it("falls back inside the range when the token cannot be read", () => {
    // cssType's fallbacks run in export/headless paths where :root may be absent
    const fallbacks = [...app.matchAll(/cssType\([^)]*?,\s*['"]([0-9.]+)px['"]\)/g)].map((m) =>
      Number(m[1]),
    );
    expect(fallbacks.length).toBeGreaterThan(0);
    for (const px of fallbacks) {
      expect(px).toBeGreaterThanOrEqual(MIN);
      expect(px).toBeLessThanOrEqual(MAX);
    }
  });
});
