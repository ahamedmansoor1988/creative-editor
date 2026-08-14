// @vitest-environment node
/**
 * Characterization tests for server.js pure logic.
 *
 * These lock in what the code ACTUALLY does today, including its quirks — they
 * are a safety net for the Stage 2 refactor, not an assertion that the current
 * behaviour is ideal. Where today's behaviour is questionable it is marked
 * QUIRK so the refactor can change it deliberately rather than by accident.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { extractJSON, buildSystem, CAPABILITIES } = require("../server.js");

describe("extractJSON", () => {
  it("parses a plain JSON object", () => {
    expect(extractJSON('{"a":1}')).toEqual({ a: 1 });
  });

  it("strips ```json fences the model often adds", () => {
    expect(extractJSON('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("ignores prose surrounding the object", () => {
    expect(extractJSON('Sure! Here you go:\n{"a":1}\nHope that helps.')).toEqual({ a: 1 });
  });

  it("repairs trailing commas", () => {
    expect(extractJSON('{"a":1,}')).toEqual({ a: 1 });
    expect(extractJSON('{"a":[1,2,],}')).toEqual({ a: [1, 2] });
  });

  it("does not mistake braces inside strings for structure", () => {
    expect(extractJSON('{"text":"a { b } c"}')).toEqual({ text: "a { b } c" });
  });

  it("throws when there is no JSON object at all", () => {
    expect(() => extractJSON("no json here")).toThrow(/no JSON object/);
  });

  it("throws when the object is unrepairable", () => {
    expect(() => extractJSON('{"a": :}')).toThrow();
  });

  /* ------------------------------------------------------------------ *
   * Truncation. server.js carries a brace/bracket balancer meant to
   * repair output cut short by max_completion_tokens. Measured behaviour
   * shows it is far weaker than it looks, in two ways that matter. Both
   * are pinned here as BUGs (not merely quirks) for Stage 3.
   * ------------------------------------------------------------------ */

  it("BUG: cannot repair the commonest truncation — output with no '}' at all", () => {
    // The balancer is unreachable here: the guard uses lastIndexOf("}"), which
    // is -1, so it throws before any repair is attempted. A reply cut off
    // mid-array (the typical max-tokens failure) always lands here.
    expect(() => extractJSON('{"frame":{"children":[{"type":"rect"')).toThrow(/no JSON object/);
    expect(() => extractJSON('{"name":"unterminated')).toThrow(/no JSON object/);
  });

  it("BUG: when a '}' exists, everything after the last one is silently dropped", () => {
    // Slicing first "{" .. last "}" discards the truncated tail rather than
    // repairing it, so a design can come back structurally valid but with its
    // children silently missing. Silent data loss, not a parse error.
    expect(extractJSON('{"frame":{"w":900},"children":[{"type":"rect"')).toEqual({
      frame: { w: 900 },
    });
    expect(extractJSON('{"a":{"b":1},"c":[1,2')).toEqual({ a: { b: 1 } });
  });

  it("QUIRK: trailing prose after a complete object is discarded (benign here)", () => {
    expect(extractJSON('{"a":1} and then {oops')).toEqual({ a: 1 });
  });
});

describe("buildSystem", () => {
  const BASE_MARKER = "You generate EDITABLE vector designs";

  it("returns the base schema when nothing matches", () => {
    const s = buildSystem("make it blue", null);
    expect(s).toContain(BASE_MARKER);
    expect(s).not.toContain("Capabilities available for this request");
  });

  it("injects the pattern capability when the prompt mentions stripes", () => {
    const s = buildSystem("add stripes", null);
    expect(s).toContain("Capabilities available for this request");
    expect(s).toContain('"pattern"');
  });

  it("injects the shadow capability on a depth-flavoured prompt", () => {
    expect(buildSystem("give it depth", null)).toContain('"shadow"');
  });

  it("injects the grain capability on a film-flavoured prompt", () => {
    expect(buildSystem("filmic grain please", null)).toContain('"grain"');
  });

  it("injects a capability already used in the document even if the prompt is silent", () => {
    // A modify request must not lose a capability it cannot see.
    const doc = { frame: { children: [{ type: "rect", pattern: { mode: "rows" } }] } };
    const s = buildSystem("make it warmer", doc);
    expect(s).toContain('"pattern"');
  });

  it("injects shadow when the document already has one enabled", () => {
    const doc = { frame: { children: [{ effects: { shadow: { on: true } } }] } };
    expect(buildSystem("tweak", doc)).toContain('"shadow"');
  });

  it("can inject several capabilities at once", () => {
    const s = buildSystem("striped with a shadow and grain", null);
    expect(s).toContain('"pattern"');
    expect(s).toContain('"shadow"');
    expect(s).toContain('"grain"');
  });

  it("tolerates an empty prompt", () => {
    expect(buildSystem("", null)).toContain(BASE_MARKER);
    expect(buildSystem(undefined, null)).toContain(BASE_MARKER);
  });
});

describe("CAPABILITIES registry", () => {
  it("exposes the three known capabilities with the expected shape", () => {
    expect(CAPABILITIES.map((c) => c.id)).toEqual(["pattern-engine", "shadow", "grain"]);
    for (const c of CAPABILITIES) {
      expect(c.match).toBeInstanceOf(RegExp);
      expect(typeof c.inDoc).toBe("function");
      expect(typeof c.doc).toBe("string");
      expect(c.doc.length).toBeGreaterThan(0);
    }
  });
});
