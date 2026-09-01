// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadEditor } from "./helpers/load-editor.js";

let editor, ctx;
beforeAll(() => {
  ({ editor, ctx } = loadEditor());
  window.GlassEngine = { available: () => true, render: () => true };
  window.GlassObjectEngine = { available: () => true, render: () => document.createElement("canvas") };
});

function shape(glass = {}) {
  editor.doc = { frame: { name: "Glass", w: 600, h: 400, bg: "#fff", artboards: [], children: [{
    type: "rect", name: "Panel", x: 80, y: 60, w: 260, h: 180,
    fill: { kind: "solid", color: "#456789" }, effects: { glass: { on: true, ...glass } },
  }] } };
  const o = editor.doc.frame.children[0];
  editor.setSelIds(new Set([o.id]));
  editor.refresh();
  return o;
}

describe("shared Glass capability", () => {
  beforeEach(() => { window.__engines.close(); });

  it("is one ready catalog entry for all glass modes", () => {
    expect(window.EngineCatalog.get("glass").rendererType).toBe("glass");
    expect(window.EngineCatalog.status("glass")).toBe("ready");
    expect(window.EngineCatalog.resolve("strip")).toBe("glass");
    expect(window.EngineCatalog.resolve("glass3d")).toBe("glass");
    expect(window.EngineCatalog.all().filter(x => /glass/i.test(x.label)).map(x => x.id))
      .toEqual(["glass"]);
  });

  it("normalises its four modes and intrinsic parameters", () => {
    const o = shape({ mode: "reeded", reedStrength: 999, reedWidth: 0, reedAngle: 200,
      ior: 9, roughness: 4, absorption: 20, backdropDistance: 0, bevel: 900,
      edgeIntensity: 900, edgeWidth: -3, edgeSoftness: 800, quality: "impossible" });
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
    expect(o.effects.glass.quality).toBe("standard");
  });

  it("shows modes but does not duplicate reusable noise, glow, blur, or chromatic controls", () => {
    shape({ mode: "backdrop" });
    const panel = document.querySelector("#fxBody");
    expect(document.querySelector('[data-fxsect="Glass"]')).toBeTruthy();
    const options = [...panel.querySelectorAll("#glMode option")].map(x => x.value);
    expect(options).toEqual(["backdrop", "frosted", "reeded", "solid3d"]);
    expect(panel.querySelector("#grAmt, #nzAmt, #goRadius, #chAmount")).toBe(null);
    expect(panel.querySelector("#glDisp")).toBeTruthy();
    for (const id of ["glIor", "glRough", "glAbsorb", "glBackD", "glBevel", "glEdgeIntensity",
      "glEdgeWidth", "glEdgeSoftness", "glQuality"])
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
    const glassAt = ctx.calls.findIndex(call => call.name === "glassRender");
    const grainAt = ctx.calls.findIndex((call, index) => index > glassAt && call.name === "fillRect");
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
    const glassAt = ctx.calls.findIndex(call => call.name === "glassRender");
    const noiseAt = ctx.calls.findIndex(call => call.name === "filterApply" && call.args[0] === "noise");
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
    const glassAt = ctx.calls.findIndex(call => call.name === "glassRender");
    const maskAt = ctx.calls.findIndex((call,index) => index>glassAt&&call.name === "fill");
    const bloomAt = ctx.calls.findIndex(call => call.name === "filterApply" && call.args[0] === "bloom");
    expect(glassAt).toBeGreaterThanOrEqual(0);
    expect(maskAt).toBeGreaterThan(glassAt);
    expect(bloomAt).toBeGreaterThan(maskAt);
  });

  it("routes every pixel effect through the post-Glass pipeline", () => {
    const types = ["blur", "colorAdjust", "colorMap", "channelFx", "stylize",
      "distortion", "warp", "displacement", "haze", "slice"];
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
      const glassAt = ctx.calls.findIndex(call => call.name === "glassRender");
      const filterAt = ctx.calls.findIndex(call => call.name === "filterApply" && call.args[0] === type);
      expect(glassAt, type).toBeGreaterThanOrEqual(0);
      expect(filterAt, type).toBeGreaterThan(glassAt);
    }
    window.Filters = filters;
  });
});
