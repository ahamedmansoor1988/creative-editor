import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
const source = fs.readFileSync(path.join(process.cwd(), "public/light-beam.js"), "utf8");
describe("spectral light beam", () => {
  it("contains analytic cone, spectrum, falloff, and starburst models", () => {
    ["spectrum", "angleDelta", "longFade", "starburst", "edgeGlow"].forEach((term) =>
      expect(source).toContain(term),
    );
  });
  it("exposes the live editor API", () =>
    expect(source).toContain("window.LightBeamTool={create,mount"));
});
