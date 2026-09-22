// @vitest-environment node
/**
 * public/receipt.js — the run's receipt: five stages from the report.
 *
 * The status line was the whole story and the bar truncates it. `stages()`
 * is pure — report in, five plain stage records out — so it is tested here
 * without a DOM, on the report shapes the flow actually returns.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(here, "..", "public", f), "utf8");
let RC;

beforeAll(() => {
  const win = {};
  new Function("window", read("receipt.js"))(win);
  RC = win.Receipt;
});

/* The report of the real run on 22 Sep 2026: one full-bleed icon, qwen read
 * it once, one square with the measured corners, error 19.96. */
const composition = () => ({
  classification: "composition",
  reasons: [
    "one subject on a plain transparent ground, 100% x 100% of the frame, corner radius 21.3% of its shorter side",
  ],
  features: {
    w: 128,
    h: 128,
    colours: 6,
    periodic: { count: 1, strength: 0.1 },
    subject: { count: 1, ground: "transparent", x: 0, y: 0, w: 100, h: 100, radius: 21.3 },
  },
  frame: { w: 900, h: 900 },
  engines: [],
  brief: {
    background: { kind: "solid", colors: ["#ffffff"] },
    elements: [
      { what: "blue gradient slab", shape: "rect", color: "#4b62f5", colorEnd: "#cfdcff" },
      { what: "white dot", shape: "ellipse", color: "#ffffff" },
    ],
    text: [{ content: "Morpho" }],
  },
  plan: { frame: { children: [{}, {}, {}, {}] } },
  unsupported: [
    "rounded corners",
    "placed onto the measured subject box (100% x 100% of the frame)",
    "corner radius 21.3% measured off the silhouette",
  ],
  ignored: [],
  attempts: [
    { label: "plan", error: 19.96 },
    { label: "retry", error: 19.98 },
  ],
  error: 19.96,
  verdict: "approximate",
  model: "qwen/qwen3.8-27b",
  usage: { total_tokens: 2856 },
  timing: { measure: 40, model: 2168, total: 12439 },
});

describe("five stages from a composition report", () => {
  it("is five, in the pipeline's order", () => {
    expect(RC.stages(composition()).map((s) => s.key)).toEqual([
      "pixels",
      "route",
      "model",
      "build",
      "match",
    ]);
    expect(RC.stages(composition()).map((s) => s.n)).toEqual([1, 2, 3, 4, 5]);
  });

  it("pixels: the measured subject, its box for the thumbnail, its corners", () => {
    const px = RC.stages(composition())[0];
    expect(px.fact).toBe("One subject on a transparent ground");
    expect(px.lines).toContain("fills the frame");
    expect(px.lines).toContain("corners 21.3% of the side");
    expect(px.lines).toContain("6 distinct colours");
    expect(px.box).toEqual({ x: 0, y: 0, w: 100, h: 100 });
    expect(px.aspect).toBe(1);
  });

  it("pixels: a boxed subject says its size, not the frame", () => {
    const r = composition();
    r.features.subject = {
      count: 1,
      ground: "#ffffff",
      x: 31.3,
      y: 16.7,
      w: 37.5,
      h: 66.7,
      radius: 0,
    };
    const px = RC.stages(r)[0];
    expect(px.fact).toBe("One subject on #ffffff");
    expect(px.lines[0]).toBe("37.5 × 66.7% of the frame");
    expect(px.lines.join()).not.toMatch(/corners/);
  });

  it("route: composition, from the pixels, and the choice the segmented control shows", () => {
    const rt = RC.stages(composition())[1];
    expect(rt.fact).toBe("Composition");
    expect(rt.choice).toBe("composition");
    expect(rt.lines).toEqual(["from the pixels"]);
  });

  it("route: says who chose it", () => {
    const a = composition();
    a.routeFromPrompt = { route: "field", word: "mesh gradient" };
    a.classification = "color_field";
    expect(RC.stages(a)[1].lines[0]).toBe("from the prompt: “mesh gradient”");
    expect(RC.stages(a)[1].fact).toBe("Field");
    const b = composition();
    b.routeOverride = "field";
    expect(RC.stages(b)[1].lines[0]).toBe("chosen by you");
    const c = composition();
    c.classification = "material";
    c.escalated = true;
    expect(RC.stages(c)[1].fact).toBe("Material");
    expect(RC.stages(c)[1].choice).toBe("field");
    expect(RC.stages(c)[1].lines).toContain("escalated: the model saw parts");
  });

  it("model: what it read, what it cost, and the detail list for the toggle", () => {
    const md = RC.stages(composition())[2];
    expect(md.fact).toBe("Read 2 things and 1 line of text");
    expect(md.lines).toContain("qwen3.8-27b · 2856 tokens · 2.2 s");
    expect(md.detail.map((d) => d.label)).toEqual(["blue gradient slab", "white dot", "“Morpho”"]);
    expect(md.detail[0].color).toBe("#4b62f5");
    expect(md.detail[2].kind).toBe("text");
  });

  it("model: dropped copies are struck through in the list, not listed twice", () => {
    const r = composition();
    r.brief.elements = [
      { what: "rounded square, upper", shape: "rect", color: "#4f6bff" },
      { what: "white dot, upper", shape: "ellipse", color: "#ffffff" },
      { what: "rounded square, lower", shape: "rect", color: "#4f6bff" },
      { what: "white dot, lower", shape: "ellipse", color: "#ffffff" },
    ];
    r.brief.text = [{ content: "Morpho" }, { content: "Morpho" }];
    r.unsupported = [
      'dropped "rounded square, upper": the reference has one subject',
      'dropped "white dot, upper": the reference has one subject',
      "dropped repeated text: the reference has one subject",
      "placed onto the measured subject box (37.5% x 66.7% of the frame)",
    ];
    const md = RC.stages(r)[2];
    expect(md.lines).toContain("3 copies dropped (one subject)");
    expect(md.detail.map((d) => `${d.kind}:${d.label}`)).toEqual([
      "dropped:rounded square, upper",
      "dropped:white dot, upper",
      "element:rounded square, lower",
      "element:white dot, lower",
      "text:“Morpho”",
      "dropped:“Morpho”",
    ]);
    // and the build stage keeps the note that is not a drop
    expect(RC.stages(r)[3].lines).toContain("placed on the measured box");
  });

  it("pixels: a weak repeat is not reported over a measured subject", () => {
    const r = composition();
    r.features.periodic = { count: 4, strength: 0.4 };
    expect(RC.stages(r)[0].lines.join()).not.toMatch(/repeats/);
    r.features.subject = { count: 0 };
    expect(RC.stages(r)[0].lines).toContain("repeats about 4 times");
  });

  it("times under a second read in milliseconds", () => {
    const r = composition();
    r.timing = { model: 3, total: 135 };
    expect(RC.stages(r)[2].lines[0]).toBe("qwen3.8-27b · 2856 tokens · 3 ms");
    expect(RC.stages(r)[4].lines).toContain("135 ms in all");
  });

  it("build: layers and the notes", () => {
    const b = RC.stages(composition())[3];
    expect(b.fact).toBe("4 layers");
    expect(b.lines).toEqual([
      "rounded corners",
      "placed on the measured box",
      "corners from the pixels",
    ]);
  });

  it("match: the verdict, the error, the attempts, the time", () => {
    const m = RC.stages(composition())[4];
    expect(m.fact).toBe("Approximate");
    expect(m.verdict).toBe("approximate");
    expect(m.lines).toEqual(["19.96 / 255 mean error", "2 attempts", "12.4 s in all"]);
  });
});

describe("the field route and the failures", () => {
  it("a fitted mesh with a recipe", () => {
    const r = {
      classification: "color_field",
      reasons: ["almost no edges (1.2% soft, 0.1% hard)"],
      features: { w: 128, h: 72, colours: 9, subject: { count: 0 } },
      engines: ["mesh", "grain"],
      recipe: { base: "mesh", effects: [{ type: "grain" }] },
      unsupported: [],
      ignored: ["glow: no layer to attach to"],
      attempts: [{ label: "fitted mesh" }],
      error: 9.83,
      verdict: "close",
      model: "qwen/qwen3.8-27b",
      usage: { total_tokens: 1200 },
      timing: { fit: 300, model: 900, total: 1400 },
      recolor: { to: "green" },
    };
    const st = RC.stages(r);
    expect(st[0].fact).toBe("Almost no edges (1.2% soft, 0.1% hard)");
    expect(st[0].box).toBeUndefined();
    expect(st[1].fact).toBe("Field");
    expect(st[2].fact).toBe("Answered a recipe: mesh + 1 effect");
    expect(st[2].detail.map((d) => d.label)).toEqual(["grain"]);
    expect(st[3].fact).toBe("2 engines");
    expect(st[3].lines).toEqual([
      "engines: mesh, grain",
      "not applied: glow: no layer to attach to",
    ]);
    expect(st[4].lines).toContain("recoloured to green");
  });

  it("a rate limit: the model did not answer, the mesh stood", () => {
    const st = RC.stages({
      classification: "color_field",
      features: {},
      engines: ["mesh"],
      analyserError: "Rate limit (free tier)",
      error: 12.1,
      verdict: "approximate",
      attempts: [{}],
    });
    expect(st[2].fact).toBe("No answer");
    expect(st[2].lines).toEqual(["Rate limit (free tier)"]);
    expect(st[4].lines[0]).toBe("12.1 / 255 mean error");
  });

  it("survives an empty report", () => {
    const st = RC.stages(null);
    expect(st).toHaveLength(5);
    expect(st[4].fact).toBe("Unmeasured");
    expect(st[4].lines).toEqual(["not measured"]);
  });
});

describe("it is wired in", () => {
  const app = read("app.js");
  const index = read("index.html");
  it("loads before the app and has a home above the bar", () => {
    expect(index.indexOf('src="receipt.js')).toBeLessThan(index.indexOf('src="app.js'));
    expect(index.indexOf('<div id="receipt" hidden></div>')).toBeLessThan(
      index.indexOf('<div id="agentBar"'),
    );
  });
  it("is drawn from the report every reference run returns", () => {
    const at = app.indexOf(
      "if(window.Receipt) window.Receipt.render(report,{image:dataUrl,onRoute:",
    );
    expect(at).toBeGreaterThan(0);
    expect(at).toBeGreaterThan(app.indexOf("_lastReference=report;"));
  });
  it("the other route re-runs the same reference with the route forced", () => {
    expect(app).toContain("await recreateFromReference(dataUrl,Object.assign({},opts,{route:r}));");
    expect(app).toContain("if(opts.route) report.routeOverride=opts.route;");
  });
  it("goes away with the reference, and for a plain generate", () => {
    expect(app).toContain("if(!dataUrl&&window.Receipt) window.Receipt.hide();");
    expect(app.indexOf("if(window.Receipt) window.Receipt.hide();\n    let data;")).toBeGreaterThan(
      0,
    );
  });
  it("never puts the model's words into markup", () => {
    const src = read("receipt.js");
    expect(src).not.toMatch(/innerHTML/);
  });
});
