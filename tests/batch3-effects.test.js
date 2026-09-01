// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { loadEditor } from "./helpers/load-editor.js";

let editor, ctx;

function shape(effects = {}, type = "rect") {
  editor.doc = { frame: { name: "B3", w: 640, h: 480, bg: "#ffffff", artboards: [],
    children: [{ type, name: "Target", x: 120, y: 100, w: 260, h: 180,
      text: type === "text" ? "Light" : undefined,
      fill: { kind: "solid", color: "#f4d35e" }, effects }] } };
  return editor.doc.frame.children[0];
}

beforeAll(() => {
  ({ editor, ctx } = loadEditor());
  editor.paintCacheOff = true;
});

describe("Bloom", () => {
  it("normalizes and clamps its reusable parameters", () => {
    const o = shape({ bloom: { amount: 9, radius: 999, threshold: -1, knee: 4 } });
    expect(o.effects.bloom).toEqual({ amount: 3, radius: 200, threshold: 0, knee: 1 });
    expect(o.fx.find((e) => e.type === "bloom").params).toBe(o.effects.bloom);
  });

  it("runs in the pixel pipeline and is available for text", () => {
    const o = shape({ bloom: { amount: 1, radius: 24, threshold: .5, knee: .2 } }, "text");
    const seen = [];
    const original = window.Filters.apply;
    window.Filters.apply = (type, ...args) => { seen.push(type); return original(type, ...args); };
    try { editor.render(); } finally { window.Filters.apply = original; }
    expect(seen).toContain("bloom");
    expect(editor.FX_PAGES(o)).toContain("Bloom");
  });

  it("does not feed outer Glow back through Bloom", () => {
    shape({
      glow: { on: true, type: "outer", radius: 40, spread: 10, falloff: 4, alpha: 1, color: "#000000" },
      bloom: { amount: 1.4, radius: 24, threshold: .65, knee: .25 },
    });
    let glowPaints=0, bloomRuns=0;
    const fill=ctx.fill.bind(ctx), apply=window.Filters.apply;
    ctx.fill=(...args)=>{
      if(ctx.shadowColor&&ctx.shadowColor!=="transparent"&&ctx.shadowBlur>0) glowPaints++;
      return fill(...args);
    };
    window.Filters.apply=(type,...args)=>{ if(type==="bloom") bloomRuns++; return apply(type,...args); };
    try{ editor.render(); } finally{ ctx.fill=fill; window.Filters.apply=apply; }
    expect(bloomRuns).toBe(1);
    expect(glowPaints).toBe(3); // one continuous three-band glow, not a second copy inside Bloom
  });
});

describe("Background Blur", () => {
  it("normalizes only on vector shapes", () => {
    expect(shape({ backgroundBlur: { on: true, radius: 500, opacity: -2 } })
      .effects.backgroundBlur).toMatchObject({ on: true, radius: 100, opacity: 0 });
    expect(shape({ backgroundBlur: { on: true, radius: 20 } }, "text")
      .effects.backgroundBlur.on).toBe(false);
  });

  it("reads the existing canvas and clips the softened backdrop to the path", () => {
    shape({ backgroundBlur: { on: true, radius: 24, opacity: .8 } }, "ellipse");
    ctx.calls.length = 0;
    editor.render();
    expect(ctx.calls.some((c) => c.name === "ellipse")).toBe(true);
    expect(ctx.calls.some((c) => c.name === "clip")).toBe(true);
    expect(ctx.calls.filter((c) => c.name === "drawImage").length).toBeGreaterThan(1);
  });

  it("is a backdrop slot, not object Blur in disguise", () => {
    const meta = window.FxStack.meta("backgroundBlur");
    expect(meta.slot).toBe("backdrop");
    expect(meta.backdrop).toBe(true);
    expect(window.EngineCatalog.get("backgroundBlur").status).toBe("ready");
  });
});
