// @vitest-environment jsdom
/**
 * Scene mode (lab, 23 Sep 2026): one light for the page, behind a flag.
 *
 * The flag is the control of an experiment — does treating the page as one
 * optical system look different from per-layer rendering? — so what these
 * tests pin first is that OFF is exactly the old renderer: no derived
 * shadow, no derived highlight, no transmission pool. Then the light as a
 * document object, and the geometry the light drives.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEditor } from "./helpers/load-editor.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const readPublic = (f) => fs.readFileSync(path.join(here, "..", "public", f), "utf8");
const FX_ONLY = [
  "mesh",
  "shadow",
  "iridescent",
  "reed",
  "fractal",
  "noise",
  "divider",
  "beam",
  "glass",
];
let editor;
beforeAll(() => {
  ({ editor } = loadEditor({ fxOnly: FX_ONLY }));
});

const doc = (scene) => ({
  frame: {
    name: "F",
    w: 900,
    h: 600,
    bg: "#ffffff",
    scene,
    children: [
      {
        type: "rect",
        name: "a",
        x: 600,
        y: 300,
        w: 100,
        h: 100,
        fill: { kind: "solid", color: "#ff0000" },
        effects: { shadow: { on: true, x: 5, y: 7, blur: 10, alpha: 0.5, color: "#000000" } },
      },
      {
        type: "rect",
        name: "b",
        x: 200,
        y: 300,
        w: 100,
        h: 100,
        fill: { kind: "solid", color: "#00ff00" },
      },
    ],
  },
});

describe("the light is a document object, off by default", () => {
  it("normalises to off, with the light a quarter in and near the top", () => {
    editor.doc = doc(undefined);
    expect(editor.doc.frame.scene).toEqual({ on: false, light: { x: 225, y: 90 } });
    expect(editor.sceneOn()).toBe(false);
  });
  it("keeps what a document says, clamped", () => {
    editor.doc = doc({ on: true, light: { x: 99999, y: "12" } });
    expect(editor.doc.frame.scene).toEqual({ on: true, light: { x: 10000, y: 12 } });
    expect(editor.sceneOn()).toBe(true);
  });
  it("saves and reloads with the page", () => {
    editor.doc = doc({ on: true, light: { x: 300, y: 40 } });
    const text = editor.serializeDocument ? editor.serializeDocument() : JSON.stringify(editor.doc);
    expect(text).toContain('"scene"');
    const j = JSON.parse(text);
    const frame = j.frame || (Array.isArray(j.pages) && j.pages[0] && j.pages[0].frame);
    expect(frame.scene).toEqual({ on: true, light: { x: 300, y: 40 } });
  });
  it("toggles from the View menu, through history", () => {
    editor.doc = doc(undefined);
    expect(readPublic("index.html")).toContain('data-cmd="toggleScene" data-check="scene"');
    editor.toggleScene();
    expect(editor.doc.frame.scene.on).toBe(true);
    editor.toggleScene();
    expect(editor.doc.frame.scene.on).toBe(false);
  });
});

describe("what the light drives", () => {
  it("a shadow falls away from the light, longer the farther the object is", () => {
    editor.doc = doc({ on: true, light: { x: 450, y: 60 } });
    const [a, b] = editor.doc.frame.children;
    const va = editor.sceneShadowVec(a),
      vb = editor.sceneShadowVec(b);
    expect(va.x).toBeGreaterThan(0); // a is right of the light: shadow goes right
    expect(vb.x).toBeLessThan(0); // b is left: shadow goes left
    expect(va.y).toBeGreaterThan(0); // both below the light: shadows go down
    expect(Math.abs(va.x)).toBeCloseTo(Math.abs(vb.x), 5); // symmetric about the light
    const far = { type: "rect", x: 850, y: 550, w: 20, h: 20 };
    expect(Math.hypot(editor.sceneShadowVec(far).x, editor.sceneShadowVec(far).y)).toBeGreaterThan(
      Math.hypot(va.x, va.y),
    );
  });
  it("elevation drops with distance; the glass angle points at the light in the shader's y-up frame", () => {
    editor.doc = doc({ on: true, light: { x: 450, y: 60 } });
    const near = editor.sceneLightAt({ type: "rect", x: 440, y: 100, w: 20, h: 20 });
    const far = editor.sceneLightAt({ type: "rect", x: 850, y: 550, w: 20, h: 20 });
    expect(near.elevation).toBeGreaterThan(far.elevation);
    // an object directly right of the light: the light is to its left, which is 180 in a y-up frame
    const right = editor.sceneLightAt({ type: "rect", x: 800, y: 50, w: 20, h: 20 });
    expect(Math.round(editor.sceneGlassAngle(right))).toBe(180);
    // directly below the light: the light is above it, which is +90 in a y-up frame
    const below = editor.sceneLightAt({ type: "rect", x: 440, y: 400, w: 20, h: 20 });
    expect(Math.round(editor.sceneGlassAngle(below))).toBe(90);
  });
  it("the reed highlight tilts toward the light across the flutes, within the panel's range", () => {
    editor.doc = doc({ on: true, light: { x: 850, y: 300 } });
    const o = { type: "rect", x: 100, y: 250, w: 100, h: 100 };
    expect(editor.sceneReedAngle(o, 0)).toBeGreaterThan(20); // light far to the right of vertical flutes
    editor.doc = doc({ on: true, light: { x: 50, y: 300 } });
    expect(editor.sceneReedAngle(o, 0)).toBeLessThan(-5);
    expect(Math.abs(editor.sceneReedAngle(o, 0))).toBeLessThanOrEqual(80);
  });
});

describe("OFF is the old renderer", () => {
  const app = readPublic("app.js");
  it("every scene read is gated on the flag", () => {
    expect(app).toContain("const so=sceneOn()?sceneShadowVec(obj):{x:sd.x,y:sd.y};");
    expect(app).toContain("const sceneL=sceneOn()?sceneLightAt(obj):null;");
    expect(app).toContain("sceneOn()?{lightAng:sceneReedAngle(obj,rdx.angle)}:{}");
    expect(app).toContain(
      "function paintSceneTransmission(c,obj,matType){\n  if(!sceneOn()||obj.type==='text') return;",
    );
    expect(app).toContain("if(sceneOn()){ const L=sceneLight(); s+='|scene'+L.x+','+L.y; }");
  });
  it("QC-02/03/04/05: off means no light key reaches glass, text shadows follow, the drag clamps and dies with the mode", () => {
    expect(app).toContain(
      "const glassParams=Object.assign({},gla,{lightAngle:sceneL?sceneGlassAngle(sceneL):undefined,lightElevation:sceneL?sceneL.elevation:undefined},{",
    );
    expect(app).toContain(
      "const so=sceneOn()?sceneShadowVec(obj):{x:p.x,y:p.y};   // scene mode: the light decides, for text as for shapes",
    );
    expect(app).toContain(
      "L.x=clamp(Math.round(p.x+drag.dx),-10000,10000); L.y=clamp(Math.round(p.y+drag.dy),-10000,10000);",
    );
    expect(app).toContain("if(!sceneOn()){ drag=null; return; }   // switched off mid-drag");
    expect(app).toContain("toggleScene(){ if(doc){ if(drag&&drag.mode==='light') drag=null;");
  });

  it("the glass engine keeps its pinned light unless one is placed", () => {
    const glass = readPublic("glass.js");
    expect(glass).toContain(
      "gl.uniform1f(loc.lightAngle,P.lightAngle===undefined?45:P.lightAngle);",
    );
    expect(glass).toContain(
      "gl.uniform1f(loc.lightElevation,P.lightElevation===undefined?30:P.lightElevation);",
    );
  });
  it("is not an engine: no catalog entry, no stack registry entry", () => {
    expect(readPublic("engine-catalog.js")).not.toMatch(/id: "light"[\s\S]*scene/);
    expect(readPublic("fxstack.js")).not.toMatch(/scene/);
  });
});
