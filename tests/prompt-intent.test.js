// @vitest-environment node
/**
 * public/prompt-intent.js — what the prompt says about STRUCTURE.
 *
 * The reference flow chose field-vs-composition from the pixels and the
 * model's `parts` flag; the person typing had no say. "create mesh gradient"
 * over an app icon came back a composition with two slabs and two lines of
 * text. This is the prompt's one deterministic path to structure — the
 * sibling of recolor.js for colour — and it matters twice: a field is what
 * was asked for, and the field route is the one that survives a rate limit,
 * because a fitted mesh needs no model call where a composition needs two or
 * three.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(here, "..", "public", f), "utf8");
let PI;

beforeAll(() => {
  const win = {};
  new Function("window", read("prompt-intent.js"))(win);
  PI = win.PromptIntent;
});

describe("what the prompt asks for structurally", () => {
  it("names a field", () => {
    expect(PI.routeFromPrompt("create mesh gradient")).toEqual({
      route: "field",
      word: "mesh gradient",
    });
    expect(PI.routeFromPrompt("create this gradient in green color").route).toBe("field");
    expect(PI.routeFromPrompt("a soft colour field")).toMatchObject({ route: "field" });
    expect(PI.routeFromPrompt("just the background")).toMatchObject({ route: "field" });
    expect(PI.routeFromPrompt("only the colors please")).toMatchObject({ route: "field" });
  });

  it("tolerates a plural", () => {
    expect(PI.routeFromPrompt("two gradients").route).toBe("field");
  });

  it("does not fire on a word that merely contains one", () => {
    expect(PI.routeFromPrompt("regrade the layout")).toBeNull();
    expect(PI.routeFromPrompt("meshing the two icons together")).toBeNull();
  });

  it("returns null when nothing structural is asked", () => {
    expect(PI.routeFromPrompt("")).toBeNull();
    expect(PI.routeFromPrompt("recreate this")).toBeNull();
    expect(PI.routeFromPrompt("recreate this in red shades")).toBeNull(); // colour, not structure
    expect(PI.routeFromPrompt(null)).toBeNull();
  });

  it("is deterministic — the same prompt, the same answer", () => {
    const a = PI.routeFromPrompt("Create Mesh Gradient");
    const b = PI.routeFromPrompt("create mesh gradient");
    expect(a).toEqual(b);
  });
});

describe("it is wired into the reference flow", () => {
  const app = read("app.js");
  const index = read("index.html");

  it("loads", () => {
    expect(index).toContain('src="prompt-intent.js');
  });

  it("forces the field route instead of the composition route", () => {
    expect(app).toContain("if((cls==='composition'||forcedComposition)&&!forcedField){");
  });

  it("asks the analyser as a field when forced, not as a composition", () => {
    // classification:'composition' would route the server to planComposition
    expect(app).toContain("classification:routeCls,");
    expect(app).toContain(
      "const routeCls=forcedField&&cls==='composition'?'color_field':forcedComposition?'composition':cls;",
    );
  });

  it("yields to a route chosen by hand on the receipt", () => {
    // "create mesh gradient" forced the field; clicking Composition on the
    // strip re-ran as a field anyway, and said "chosen by you" over a mesh
    expect(app).toContain(
      "const forcedField=opts.route?opts.route==='field':!!(routeIntent&&routeIntent.route==='field');",
    );
  });

  it("switches escalation off, or the model's parts flag would undo the ask", () => {
    expect(app).toContain("recipe.parts===true&&report.verdict!=='close'&&!forcedField");
  });

  it("says so in the bar", () => {
    expect(app).toContain("(from prompt)");
  });

  it("is read before any route is taken", () => {
    const at = app.indexOf("const routeIntent=PI?PI.routeFromPrompt(opts.prompt):null;");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(app.indexOf("const runComposition=async()=>{"));
  });
});
