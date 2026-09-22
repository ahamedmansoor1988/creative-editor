import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(path.join(process.cwd(), "public/shape-divider-tool.js"), "utf8");

describe("shape divider tool", () => {
  it("ships editable shapes and stackable divider kinds", () => {
    expect(source).toContain('const SHAPES=["Circle","Rounded rectangle","Polygon","Star","Ring"]');
    expect(source).toContain(
      'const KINDS=["Straight lines","Parabolic curves","Wave lines","Radial spokes"]',
    );
  });

  it("binds each visual parameter as a shader uniform", () => {
    [
      "shape",
      "size",
      "roundness",
      "edgeSmooth",
      "enabled",
      "kind",
      "angle",
      "count",
      "spacing",
      "width",
      "offset",
      "curve",
      "smooth",
    ].forEach((name) => {
      expect(source).toContain(`u_${name}`);
      expect(source).toContain(name);
    });
  });

  it("exposes an embeddable renderer API", () => {
    expect(source).toContain("window.ShapeDividerTool={create,mount");
  });
});
