// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { loadEditor } from "./helpers/load-editor.js";

let editor, ctx;

function shape(over = {}) {
  editor.doc = {
    frame: {
      name: "Inner shadow",
      w: 500,
      h: 400,
      bg: "#ffffff",
      artboards: [],
      children: [{
        type: "ellipse", name: "Lens", x: 100, y: 90, w: 240, h: 180,
        fill: { kind: "solid", color: "#6d5dfc" },
        effects: { innerShadow: { on: true, x: 8, y: 10, blur: 18, spread: 4, ...over } },
      }],
    },
  };
  return editor.doc.frame.children[0];
}

beforeAll(() => {
  ({ editor, ctx } = loadEditor());
  editor.paintCacheOff = true;
});

describe("inner shadow — reusable effect", () => {
  it("keeps the dictionary and ordered stack as one live parameter object", () => {
    const o = shape();
    const entry = o.fx.find((e) => e.type === "innerShadow");
    expect(entry.params).toBe(o.effects.innerShadow);
    expect(window.FxStack.isReady("innerShadow")).toBe(true);
  });

  it("clips the shadow pass to the target shape", () => {
    shape();
    ctx.calls.length = 0;
    editor.render();
    expect(ctx.calls.some((call) => call.name === "ellipse")).toBe(true);
    expect(ctx.calls.some((call) => call.name === "clip")).toBe(true);
    expect(ctx.calls.some((call) => call.name === "fill" && call.args[0] === "evenodd")).toBe(true);
  });

  it("draws no inner-shadow pass when disabled", () => {
    shape({ on: false });
    ctx.calls.length = 0;
    editor.render();
    expect(ctx.calls.some((call) => call.name === "fill" && call.args[0] === "evenodd")).toBe(false);
  });

  it("expands spread softly without painting a geometric black outline", () => {
    shape({ blur: 18, spread: 27 });
    const seen=[];
    const fill=ctx.fill.bind(ctx), stroke=ctx.stroke.bind(ctx);
    ctx.fill=(...args)=>{ seen.push({op:"fill",blur:ctx.shadowBlur,shadow:ctx.shadowColor}); return fill(...args); };
    ctx.stroke=(...args)=>{ seen.push({op:"stroke",style:ctx.strokeStyle}); return stroke(...args); };
    editor.render();
    ctx.fill=fill; ctx.stroke=stroke;
    expect(seen.some(s=>s.op==="fill"&&s.blur===45)).toBe(true);
    expect(seen.some(s=>s.op==="stroke"&&s.style==="#000")).toBe(false);
  });
});
