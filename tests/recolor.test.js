// @vitest-environment node
/**
 * public/recolor.js — a colour named in the prompt, applied to the measured
 * palette. Pure functions over hex strings and [r,g,b] arrays; no canvas.
 *
 * The reference pipeline measures every colour off the reference so the model
 * cannot invent one. That rule was correct and it also meant a prompt saying
 * "in red shades" had nowhere to land — a blue reference came back blue
 * whatever was typed. This is the prompt's one deterministic path to colour.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
let R;

beforeAll(() => {
  const src = fs.readFileSync(path.join(here, "..", "public", "recolor.js"), "utf8");
  const win = {};
  new Function("window", src)(win);
  R = win.Recolor;
});

const hue = (hex) => R.hexToHsl(hex).h;
const sat = (hex) => R.hexToHsl(hex).s;
const lum = (hex) => R.hexToHsl(hex).l;
/** Angular distance on the hue circle. */
const dHue = (a, b) => {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return Math.min(d, 360 - d);
};

describe("what the prompt asks for", () => {
  it("finds a colour word", () => {
    expect(R.intentFromPrompt("recreate the creative in red shades")).toMatchObject({
      name: "red",
      hue: 0,
    });
    expect(R.intentFromPrompt("make it GREEN")).toMatchObject({ name: "green" });
    expect(R.intentFromPrompt("a purple version please")).toMatchObject({ name: "purple" });
  });

  it("takes the last colour named, so 'from blue to red' lands on red", () => {
    expect(R.intentFromPrompt("change this from blue to red").name).toBe("red");
    expect(R.intentFromPrompt("red first, but actually I want teal").name).toBe("teal");
  });

  it("accepts a hex code, which beats any word", () => {
    const i = R.intentFromPrompt("use #ff8800 not blue");
    expect(i.source).toBe("hex");
    expect(dHue(i.hue, 32)).toBeLessThan(2);
    expect(R.intentFromPrompt("go #f00").name).toBe("#ff0000");
  });

  it("tolerates plurals and -ish", () => {
    expect(R.intentFromPrompt("in reds").name).toBe("red");
    expect(R.intentFromPrompt("something greenish").name).toBe("green");
    expect(R.intentFromPrompt("something bluish").name).toBe("blue");
    expect(R.intentFromPrompt("a purply tone").name).toBe("purple");
    expect(R.intentFromPrompt("purplish haze").name).toBe("purple");
  });

  it("does not fire on a word that merely contains a colour", () => {
    // "reduce", "greenwich", "bluetooth" are not colour requests
    expect(R.intentFromPrompt("reduce the noise")).toBeNull();
    expect(R.intentFromPrompt("greenwich mean time")).toBeNull();
    expect(R.intentFromPrompt("bluetooth speaker")).toBeNull();
  });

  it("returns null when no colour is asked for", () => {
    expect(R.intentFromPrompt("")).toBeNull();
    expect(R.intentFromPrompt("recreate this")).toBeNull();
    expect(R.intentFromPrompt(null)).toBeNull();
  });
});

describe("moving one colour", () => {
  const rot = (deg) => ({ colorize: false, shift: deg });

  it("moves the hue by exactly the shift", () => {
    /* Rotate by the colour's OWN hue so it must land on 0. (#3366ff is 225,
     * not the 222 a first draft of this test assumed; 8-bit rounding is the
     * only slack left.) */
    const h0 = hue("#3366ff");
    const out = R.shiftHex("#3366ff", rot(-h0));
    expect(dHue(hue(out), 0)).toBeLessThan(1.5);
    const out2 = R.shiftHex("#3366ff", rot(125 - h0));
    expect(dHue(hue(out2), 125)).toBeLessThan(1.5);
  });

  it("keeps lightness and saturation", () => {
    const inHex = "#4a7bd9";
    const out = R.shiftHex(inHex, rot(140));
    expect(Math.abs(sat(out) - sat(inHex))).toBeLessThan(0.02);
    expect(Math.abs(lum(out) - lum(inHex))).toBeLessThan(0.02);
  });

  it("leaves white, black and grey exactly alone", () => {
    for (const g of ["#ffffff", "#000000", "#888888", "#1a1a1a"]) {
      expect(R.shiftHex(g, rot(180))).toBe(g);
    }
  });

  it("round-trips: a full turn is the identity, within rounding", () => {
    const inHex = "#7bd94a";
    expect(R.shiftHex(inHex, rot(360))).toBe(inHex);
  });

  it("moves an [r,g,b] array the same way it moves a hex", () => {
    const [r, g, b] = R.shiftRgb(51, 102, 255, rot(-222)).map(Math.round);
    const viaHex = R.shiftHex("#3366ff", rot(-222));
    expect(R.rgbToHex(r, g, b)).toBe(viaHex);
  });

  it("colorize sets the hue when there was none to rotate from", () => {
    const out = R.shiftHex("#4a6b8c", { colorize: true, target: 0 });
    expect(dHue(hue(out), 0)).toBeLessThan(1.5);
    expect(sat(out)).toBeGreaterThanOrEqual(0.55);
    // but true grey still stays grey: there is nothing to tint
    expect(R.shiftHex("#777777", { colorize: true, target: 0 })).toBe("#777777");
  });

  it("returns anything that is not a hex colour untouched", () => {
    expect(R.shiftHex("data:image/png;base64,AAAA", rot(90))).toBe("data:image/png;base64,AAAA");
    expect(R.shiftHex("red", rot(90))).toBe("red");
  });
});

describe("the reference's dominant hue", () => {
  it("is blue for a blue grid", () => {
    const rows = [
      ["#3b6df0", "#4f7bff", "#ffffff"],
      ["#2c55d1", "#6a8fff", "#888888"],
    ];
    expect(dHue(R.dominantHue(rows), 222)).toBeLessThan(12);
  });

  it("ignores grey and white cells: they do not vote", () => {
    const withGrey = [["#ff2020", "#ffffff", "#808080", "#000000"]];
    const alone = [["#ff2020"]];
    expect(dHue(R.dominantHue(withGrey), R.dominantHue(alone))).toBeLessThan(1);
  });

  it("is null for a picture with no colour in it", () => {
    expect(R.dominantHue([["#ffffff", "#888888", "#000000"]])).toBeNull();
    expect(R.dominantHue([])).toBeNull();
    expect(R.dominantHue(null)).toBeNull();
  });

  it("a strong colour outvotes a faint one", () => {
    const rows = [["#ff0000", "#e8e8ff", "#e8e8ff", "#e8e8ff"]]; // vivid red vs faint blue x3
    expect(dHue(R.dominantHue(rows), 0)).toBeLessThan(20);
  });
});

describe("recolouring a whole document", () => {
  const blueGrid = [
    ["#3b6df0", "#4f7bff"],
    ["#2c55d1", "#6a8fff"],
  ];
  const red = { hue: 0, name: "red", source: "word" };

  const doc = () => {
    const fill = { kind: "solid", color: "#3b6df0" };
    return {
      frame: {
        name: "f",
        bg: "#dfe8ff",
        children: [
          // fill IS fills[0]: the same object by identity
          { type: "rect", name: "a", fill, fills: [fill], strokes: [{ color: "#2c55d1" }] },
          {
            type: "rect",
            name: "b",
            fill: {
              kind: "linear",
              stops: [
                { pos: 0, color: "#3b6df0" },
                { pos: 1, color: "#ffffff" },
              ],
            },
          },
          {
            type: "rect",
            name: "c",
            effects: {
              mesh: { on: true, points: [{ x: 0, y: 0, color: [59, 109, 240] }] },
              iridescent: { on: true, colorCore: "#6a8fff", colorEdge: "#2c55d1" },
              shadow: { on: true, color: "#000000" },
            },
            __fxCache: { color: "#3b6df0" },
          },
          { type: "text", name: "t", text: "#3b6df0 in the copy", color: "#ffffff" },
        ],
      },
    };
  };

  it("moves every colour it can find to the requested hue", () => {
    const d = doc();
    const res = R.recolorDoc(d, red, blueGrid);
    expect(res.mode).toBe("rotate");
    const [a, b, c] = d.frame.children;
    expect(dHue(hue(a.fill.color), 0)).toBeLessThan(6);
    expect(dHue(hue(a.strokes[0].color), 0)).toBeLessThan(6);
    expect(dHue(hue(b.fill.stops[0].color), 0)).toBeLessThan(6);
    expect(dHue(hue(d.frame.bg), 0)).toBeLessThan(6);
    expect(dHue(hue(c.effects.iridescent.colorCore), 0)).toBeLessThan(6);
    // the mesh point is an [r,g,b] array and moves too
    const [pr, pg, pb] = c.effects.mesh.points[0].color;
    expect(dHue(hue(R.rgbToHex(pr, pg, pb)), 0)).toBeLessThan(6);
  });

  it("does not shift an aliased fill twice", () => {
    /* obj.fill and obj.fills[0] are ONE object. Visiting it through both
     * paths would rotate it twice and land somewhere else entirely. */
    const d = doc();
    R.recolorDoc(d, red, blueGrid);
    const a = d.frame.children[0];
    expect(a.fill).toBe(a.fills[0]);
    expect(dHue(hue(a.fill.color), 0)).toBeLessThan(6); // once, not twice
  });

  it("leaves white text, a black shadow and the copy's words alone", () => {
    const d = doc();
    R.recolorDoc(d, red, blueGrid);
    const [, , c, t] = d.frame.children;
    expect(t.color).toBe("#ffffff");
    expect(t.text).toBe("#3b6df0 in the copy"); // a hex inside prose is not a colour
    expect(c.effects.shadow.color).toBe("#000000");
    expect(d.frame.children[1].fill.stops[1].color).toBe("#ffffff");
  });

  it("skips private caches", () => {
    const d = doc();
    R.recolorDoc(d, red, blueGrid);
    expect(d.frame.children[2].__fxCache.color).toBe("#3b6df0");
  });

  it("keeps lightness, so what was bright stays bright and what was deep stays deep", () => {
    const d = doc();
    const before = lum(d.frame.children[0].fill.color);
    R.recolorDoc(d, red, blueGrid);
    expect(Math.abs(lum(d.frame.children[0].fill.color) - before)).toBeLessThan(0.02);
  });

  it("colorizes instead when the reference had no hue", () => {
    const d = doc();
    const res = R.recolorDoc(d, red, [["#ffffff", "#888888"]]);
    expect(res.mode).toBe("colorize");
    expect(dHue(hue(d.frame.children[0].fill.color), 0)).toBeLessThan(6);
  });

  it("reports how many colours it touched, and does nothing without an intent", () => {
    const d = doc();
    const res = R.recolorDoc(d, red, blueGrid);
    expect(res.changed).toBeGreaterThan(5);
    expect(res.to).toBe("red");
    expect(R.recolorDoc(doc(), null, blueGrid)).toBeNull();
  });

  it("lands on any target, not just red", () => {
    for (const [name, target] of [
      ["green", 125],
      ["purple", 285],
      ["orange", 28],
    ]) {
      const d = doc();
      R.recolorDoc(d, { hue: target, name, source: "word" }, blueGrid);
      expect(dHue(hue(d.frame.children[0].fill.color), target)).toBeLessThan(6);
    }
  });
});

describe("it is wired into the reference flow", () => {
  const app = fs.readFileSync(path.join(here, "..", "public", "app.js"), "utf8");
  const index = fs.readFileSync(path.join(here, "..", "public", "index.html"), "utf8");

  it("loads", () => {
    expect(index).toContain('src="recolor.js');
  });

  it("recolours after the measurement, not before it", () => {
    /* The measurement is against the reference and the reference is blue; a
     * red document measured against it would score badly and the gates would
     * revert exactly the thing that was asked for. */
    const at = app.indexOf("RC.recolorDoc(doc,intent");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeGreaterThan(app.indexOf("report.error=last.error"));
    expect(at).toBeLessThan(app.indexOf("pushHistory('Recreate from reference')"));
  });

  it("says so in the bar", () => {
    expect(app).toContain("recoloured to ${report.recolor.to}");
  });
});
