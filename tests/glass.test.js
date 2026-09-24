// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { loadEditor } from "./helpers/load-editor.js";

let editor, ctx;
beforeAll(() => {
  ({ editor, ctx } = loadEditor());
  window.GlassEngine = { available: () => true, render: () => true };
  window.GlassObjectEngine = {
    available: () => true,
    render: () => document.createElement("canvas"),
  };
});

function shape(glass = {}) {
  editor.doc = {
    frame: {
      name: "Glass",
      w: 600,
      h: 400,
      bg: "#fff",
      artboards: [],
      children: [
        {
          type: "rect",
          name: "Panel",
          x: 80,
          y: 60,
          w: 260,
          h: 180,
          fill: { kind: "solid", color: "#456789" },
          effects: { glass: { on: true, ...glass } },
        },
      ],
    },
  };
  const o = editor.doc.frame.children[0];
  editor.setSelIds(new Set([o.id]));
  editor.refresh();
  return o;
}

describe("shared Glass capability", () => {
  beforeEach(() => {
    window.__engines.close();
  });

  /* 24 Sep 2026. The edge used to be sampled through an analytic sine bump
   * whose depth gain divided an already-normalised depth by 80, so it moved
   * the backdrop by 0.01 px at any setting — glass that did not refract
   * (lab/glass-compare: A 3.46 px, B 0.01 px, C 3.05 px at IOR 1.52). The
   * edge is sampled through the refracted ray again, as the original demo
   * does; refrOffset's ray-ratio saturation and maxOff cap are what keep the
   * map from folding, with the two guards pinned below. That is measured, not
   * derived, and the measurement needs WebGL, which this runner lacks: the
   * lab's direct fold test (`npm run lab:glass:folds`, a ramp backdrop decoded
   * checked against the running maximum along every row and column, rim
   * included, after self-testing on three known folds) counts 0 reversals for
   * medium, extreme +/-, IOR 2.4 extreme, reeded, reeded extreme and reeded
   * with dispersion. */
  it("samples the edge through the refracted ray, with the depth gain in the right units", () => {
    const source = fs.readFileSync("public/glass.js", "utf8");
    expect(source).toContain("vec2 stableSampleOffset");
    expect(source).toContain(
      "vec2 edgeSampleOffset = refrOffset(nEdge, 1.0 / max(ior, 1.0), refractPx, maxOff, d) * distanceGain;",
    );
    // the edge ray takes the normal from BEFORE the flutes add their rib slope:
    // through the ribbed normal it folded reeded glass thousands of times (QC-01)
    const nEdgeAt = source.indexOf("vec3 nEdge = n;");
    expect(nEdgeAt).toBeGreaterThan(0);
    expect(nEdgeAt).toBeLessThan(source.indexOf("if (flutes > 0.5) {"));
    // the offset never exceeds 0.7 of the depth into the glass: the map keeps its order at the
    // rim in every direction and outward magnification stays under 3.3x (QC-03, QC-05, QC-06)
    expect(source).toContain(
      "edgeSampleOffset *= min(1.0, 0.7 * d / max(length(edgeSampleOffset), 1e-3));",
    );
    expect(source).not.toContain("dot(edgeSampleOffset, outward) > 0.0");
    // the stand-in and its dead helpers are gone (QC-04)
    expect(source).not.toMatch(/float edgeBand = /);
    expect(source).not.toContain("B * 0.18 * edgeBand");
    expect(source).toContain("float depthGain = clamp(abs(depth) / 80.0, 0.0, 1.25);");
    // refrOffset keeps its saturation and cap: those are the fold guard now
    expect(source).toContain("vec2 o = v / (1.0 + 0.45 * length(v)) * refractPx;");
    expect(source).toContain(
      "return o * min(1.0, maxOff / max(l, 1e-3)) * smoothstep(0.0, 1.5, dPx);",
    );
    // the reed ribs keep their bounded analytic term; dispersion still scales one settled offset
    expect(source).toContain("reedPeriod * 0.06 * reedWave");
    expect(source).not.toContain("vec2 oG = refrOffset");
  });

  it("is one ready catalog entry for all glass modes", () => {
    expect(window.EngineCatalog.get("glass").rendererType).toBe("glass");
    expect(window.EngineCatalog.status("glass")).toBe("ready");
    expect(window.EngineCatalog.resolve("strip")).toBe("glass");
    expect(window.EngineCatalog.resolve("glass3d")).toBe("glass");
    /* The point is that Glass's several MODES share one entry rather than
     * each getting their own. Matching on the word "glass" in a label was a
     * loose way to say that, and it broke the moment Fractal glass — a
     * genuinely separate effect with its own engine — was registered. Ask the
     * real question instead: nothing else renders through the glass renderer. */
    expect(
      window.EngineCatalog.all()
        .filter((x) => x.rendererType === "glass")
        .map((x) => x.id),
    ).toEqual(["glass"]);
    for (const mode of ["strip", "glass3d", "capsule", "backdropGlass"]) {
      expect([mode, window.EngineCatalog.all().some((x) => x.id === mode)]).toEqual([mode, false]);
    }
  });

  it("normalises its four modes and intrinsic parameters", () => {
    const o = shape({
      mode: "reeded",
      reedStrength: 999,
      reedWidth: 0,
      reedAngle: 200,
      ior: 9,
      roughness: 4,
      absorption: 20,
      backdropDistance: 0,
      bevel: 900,
      edgeIntensity: 900,
      edgeWidth: -3,
      edgeSoftness: 800,
      whiteLight: false,
      quality: "impossible",
    });
    expect(o.effects.glass.mode).toBe("reeded");
    expect(o.effects.glass.reedStrength).toBe(100);
    expect(o.effects.glass.reedWidth).toBe(2);
    expect(o.effects.glass.reedAngle).toBe(90);
    expect(o.effects.glass.ior).toBe(2.4);
    expect(o.effects.glass.roughness).toBe(1);
    expect(o.effects.glass.absorption).toBe(6);
    expect(o.effects.glass.backdropDistance).toBe(1);
    expect(o.effects.glass.bevel).toBe(100);
    expect(o.effects.glass.edgeIntensity).toBe(100);
    expect(o.effects.glass.edgeWidth).toBe(0);
    expect(o.effects.glass.edgeSoftness).toBe(100);
    expect(o.effects.glass.whiteLight).toBe(false);
    expect(o.effects.glass.quality).toBe("standard");
  });

  it("shows modes but does not duplicate reusable noise, glow, blur, or chromatic controls", () => {
    shape({ mode: "backdrop" });
    const panel = document.querySelector("#fxBody");
    expect(document.querySelector('[data-fxsect="Glass"]')).toBeTruthy();
    const options = [...panel.querySelectorAll("#glMode option")].map(
      (x) => /** @type {any} */ (x).value,
    );
    expect(options).toEqual(["backdrop", "frosted", "reeded", "solid3d"]);
    expect(panel.querySelector("#grAmt, #nzAmt, #goRadius, #chAmount")).toBe(null);
    expect(panel.querySelector("#glDisp")).toBeTruthy();
    for (const id of [
      "glIor",
      "glRough",
      "glAbsorb",
      "glBackD",
      "glBevel",
      "glEdgeIntensity",
      "glEdgeWidth",
      "glEdgeSoftness",
      "glWhiteLight",
      "glQuality",
    ])
      expect(panel.querySelector("#" + id), id).toBeTruthy();
  });

  it("sends a non-circular ellipse to the dedicated ellipse SDF", () => {
    const o = shape({ mode: "backdrop" });
    o.type = "ellipse";
    o.w = 400;
    o.h = 180;
    let geometry;
    window.GlassEngine.render = (_canvas, _w, _h, geoms) => {
      geometry = geoms[0];
      return true;
    };
    editor.render();
    expect(geometry.shape).toBe(3);
  });

  it("applies reusable Grain after rendering Glass", () => {
    const o = shape({ mode: "backdrop" });
    o.effects.grain = { on: true, amount: 0.94 };
    o.fx.push({ type: "grain", on: true });
    ctx.calls.length = 0;
    window.GlassEngine.render = () => {
      ctx.calls.push({ name: "glassRender" });
      return true;
    };
    editor.render();
    const glassAt = ctx.calls.findIndex((call) => call.name === "glassRender");
    const grainAt = ctx.calls.findIndex(
      (call, index) => index > glassAt && call.name === "fillRect",
    );
    expect(glassAt).toBeGreaterThanOrEqual(0);
    expect(grainAt).toBeGreaterThan(glassAt);
  });

  it("applies Noise after backdrop Glass instead of rendering Glass in a black crop", () => {
    const o = shape({ mode: "backdrop" });
    o.effects.noise = { on: true, amount: 0.3, mono: true, scale: 1, seed: 1 };
    o.fx.push({ type: "noise", on: true, params: o.effects.noise });
    ctx.calls.length = 0;
    const filters = window.Filters;
    window.GlassEngine.render = () => {
      ctx.calls.push({ name: "glassRender" });
      return true;
    };
    window.Filters = {
      ...filters,
      apply(type, canvas) {
        ctx.calls.push({ name: "filterApply", args: [type] });
        return canvas;
      },
    };
    editor.render();
    window.Filters = filters;
    const glassAt = ctx.calls.findIndex((call) => call.name === "glassRender");
    const noiseAt = ctx.calls.findIndex(
      (call) => call.name === "filterApply" && call.args[0] === "noise",
    );
    expect(glassAt).toBeGreaterThanOrEqual(0);
    expect(noiseAt).toBeGreaterThan(glassAt);
  });

  it("isolates backdrop Glass before Bloom so padded pixels stay transparent", () => {
    const o = shape({ mode: "backdrop" });
    o.effects.bloom = { on: true, amount: 1, radius: 24, threshold: 0.65, knee: 0.25 };
    o.fx.push({ type: "bloom", on: true, params: o.effects.bloom });
    ctx.calls.length = 0;
    const filters = window.Filters;
    window.GlassEngine.render = () => {
      ctx.calls.push({ name: "glassRender" });
      return true;
    };
    window.Filters = {
      ...filters,
      apply(type, canvas) {
        ctx.calls.push({ name: "filterApply", args: [type] });
        return canvas;
      },
    };
    editor.render();
    window.Filters = filters;
    const glassAt = ctx.calls.findIndex((call) => call.name === "glassRender");
    const maskAt = ctx.calls.findIndex((call, index) => index > glassAt && call.name === "fill");
    const bloomAt = ctx.calls.findIndex(
      (call) => call.name === "filterApply" && call.args[0] === "bloom",
    );
    expect(glassAt).toBeGreaterThanOrEqual(0);
    expect(maskAt).toBeGreaterThan(glassAt);
    expect(bloomAt).toBeGreaterThan(maskAt);
  });

  it("routes every pixel effect through the post-Glass pipeline", () => {
    const types = [
      "blur",
      "colorAdjust",
      "colorMap",
      "channelFx",
      "stylize",
      "distortion",
      "warp",
      "displacement",
      "haze",
      "slice",
    ];
    const filters = window.Filters;
    for (const type of types) {
      const o = shape({ mode: "backdrop" });
      const params = {
        blur: { kind: "gaussian", radius: 12 },
        colorAdjust: { brightness: 0.2 },
        colorMap: { mode: "gradientMap", amount: 0.5 },
        channelFx: { mode: "rgbSplit", amount: 5, mix: 1 },
        stylize: { mode: "posterize", levels: 4, mix: 1 },
        distortion: { amount: 12 },
        warp: { strength: 12 },
        displacement: { scaleX: 12, scaleY: 0 },
        haze: { density: 0.5 },
        slice: { count: 3, offset: 12 },
      }[type];
      o.effects[type] = params;
      o.fx.push({ type, on: true, params });
      ctx.calls.length = 0;
      window.GlassEngine.render = () => {
        ctx.calls.push({ name: "glassRender" });
        return true;
      };
      window.Filters = {
        ...filters,
        apply(effectType, canvas) {
          ctx.calls.push({ name: "filterApply", args: [effectType] });
          return canvas;
        },
      };
      editor.render();
      const glassAt = ctx.calls.findIndex((call) => call.name === "glassRender");
      const filterAt = ctx.calls.findIndex(
        (call) => call.name === "filterApply" && call.args[0] === type,
      );
      expect(glassAt, type).toBeGreaterThanOrEqual(0);
      expect(filterAt, type).toBeGreaterThan(glassAt);
    }
    window.Filters = filters;
  });
});
