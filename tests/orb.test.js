// @vitest-environment jsdom
/**
 * QA for the `orb` spectral orb, ported from public/lab-orb.html.
 *
 * The SURFACE was verified in the lab against a real framebuffer — all six of
 * the brief's acceptance tests, including the sphere-normal visualisation and
 * resolution independence across 256/1024/2048. jsdom has no WebGL2, so none
 * of that can be repeated here and none of it is attempted.
 *
 * What these cover is the half a port gets wrong: the places an effect type
 * has to be wired into, the clamps that repair settings arriving from a saved
 * file, and the panel. Every one of those was a real bug in an earlier port.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loadEditor } from "./helpers/load-editor.js";

let editor;

function shapeWithOrb(over, type) {
  editor.doc = {
    frame: {
      name: "F",
      w: 900,
      h: 600,
      bg: "#ffffff",
      artboards: [],
      children: [
        {
          type: type || "rect",
          name: "O",
          x: 100,
          y: 100,
          w: 400,
          h: 400,
          fill: { kind: "solid", color: "#cccccc" },
          effects: { orb: { on: true, ...over } },
        },
      ],
    },
  };
  return editor.doc.frame.children[0];
}

beforeAll(() => {
  ({ editor } = loadEditor());
  window.FxStack.READY.add("orb");
});
afterAll(() => {
  window.FxStack.READY.delete("orb");
});

describe("orb — wired into the effect system", () => {
  it("is registered as a MATERIAL, not an overlay", () => {
    // the orb IS what the shape shows; as an overlay it would paint over a
    // fill that is invisible but still casting the shadow
    expect(window.FxStack.slotOf("orb")).toBe("material");
  });

  it("is offered on the shapes that can render it", () => {
    const pages = (t) => editor.FX_PAGES({ type: t, name: "x", x: 0, y: 0, w: 10, h: 10 });
    expect(pages("rect")).toContain("Orb");
    expect(pages("path")).toContain("Orb");
    expect(pages("text"), "text cannot carry an orb").not.toContain("Orb");
  });

  it("becomes the active material when switched on", () => {
    const m = window.FxStack.activeMaterial(shapeWithOrb({}).fx);
    expect(m && m.type).toBe("orb");
  });

  it("keeps effects.orb a live alias of its fx-stack entry", () => {
    /* The alias is what lets the panel, the draw path and the AI registry all
     * address one object. When it breaks, edits land on a copy and the canvas
     * never changes, which reads as the engine being broken.
     *
     * The document below carries a SAVED fx stack on purpose. Built from the
     * dictionary alone, an entry's params start out as the dictionary object
     * and the alias holds however the code is written — a test on that path
     * cannot fail and proves nothing. A saved stack arrives with its own
     * params objects, so the alias exists only because normalizeDoc re-links
     * them, which is the thing worth guarding. */
    editor.doc = {
      frame: {
        name: "F",
        w: 900,
        h: 600,
        bg: "#ffffff",
        artboards: [],
        children: [
          {
            type: "rect",
            name: "O",
            x: 0,
            y: 0,
            w: 200,
            h: 200,
            fill: { kind: "solid", color: "#cccccc" },
            effects: { orb: { on: true } },
            fx: [{ id: "e1", type: "orb", on: true, params: { on: true, rotation: 33 } }],
          },
        ],
      },
    };
    const o = editor.doc.frame.children[0];
    const entry = o.fx.find((e) => e.type === "orb");
    expect(entry.params, "the stack entry is not the dictionary object").toBe(o.effects.orb);
    // and the saved value survived the fold rather than being reset
    expect(o.effects.orb.rotation).toBe(33);
    // editing either view must move the other, which is the point of the alias
    entry.params.rotation = 77;
    expect(o.effects.orb.rotation).toBe(77);
  });

  it("refuses to enable on a type that cannot render it", () => {
    expect(shapeWithOrb({}, "text").effects.orb.on).toBe(false);
  });

  it("takes a place in the legacy order, so no saved document shifts", () => {
    expect(window.FxStack.LEGACY_ORDER).toContain("orb");
  });
});

describe("orb — settings are repaired, not trusted", () => {
  it("fills a bare switch with the engine's own defaults", () => {
    // the stored default is `{on}` alone: eight anchors in every object's
    // defaults would enter the serialisation baseline for shapes that never
    // touch the effect
    const O = shapeWithOrb({}).effects.orb;
    expect(O.anchors).toHaveLength(8);
    expect(O.concentration).toBeGreaterThan(0);
    expect(O.centerColor).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("clamps every value that arrives out of range", () => {
    const O = shapeWithOrb({
      radius: 99,
      centerX: -50,
      concentration: 9999,
      rimWidth: -3,
      fresnelPower: 0,
      centerColor: "not a colour",
    }).effects.orb;
    expect(O.radius).toBe(1);
    expect(O.centerX).toBe(-1);
    expect(O.concentration).toBe(24);
    expect(O.rimWidth).toBe(0.3);
    expect(O.fresnelPower).toBe(0.2);
    expect(O.centerColor).toBe("#ffe0d6");
  });

  it("wraps rotation rather than clamping it", () => {
    // an angle has no ends; clamping 370 to 360 would stick the control
    expect(shapeWithOrb({ rotation: 370 }).effects.orb.rotation).toBe(10);
    expect(shapeWithOrb({ rotation: -90 }).effects.orb.rotation).toBe(270);
  });

  it("normalises every anchor direction to a unit vector", () => {
    /* The weighting is exp(k*(N.D - 1)), which assumes both are unit. A
     * direction of length 2 would silently double every exponent and blow the
     * field out — a saved file or a bad drag is enough to produce one. */
    const O = shapeWithOrb({
      anchors: [{ id: "x", direction: [3, 4, 0], color: [1, 0, 0], strength: 1 }],
    }).effects.orb;
    const d = O.anchors[0].direction;
    expect(Math.hypot(d[0], d[1], d[2])).toBeCloseTo(1, 6);
  });

  it("replaces an empty anchor list rather than rendering nothing", () => {
    // with no anchors the weight total is zero and every fragment divides by
    // the epsilon floor: a black disc, which reads as a broken engine
    expect(shapeWithOrb({ anchors: [] }).effects.orb.anchors.length).toBeGreaterThan(0);
  });

  it("survives a compact round trip with its field intact", () => {
    const o = shapeWithOrb({ rotation: 42, concentration: 7 });
    o.effects.orb.anchors[2].color = [0.25, 0.5, 0.75];
    const wire = editor.compactDoc({ frame: editor.doc.frame });
    editor.doc = JSON.parse(JSON.stringify(wire));
    const O = editor.doc.frame.children[0].effects.orb;
    expect(O.rotation).toBe(42);
    expect(O.concentration).toBe(7);
    expect(O.anchors[2].color.map((v) => +v.toFixed(3))).toEqual([0.25, 0.5, 0.75]);
  });
});

describe("orb — the panel", () => {
  function openOrb(over) {
    const o = shapeWithOrb(over);
    editor.setSelIds(new Set([o.id]));
    editor.refresh();
    const head = document.querySelector('#fxBody [data-fxsect="Orb"]');
    if (head && head.getAttribute("aria-expanded") !== "true")
      /** @type {HTMLElement} */ (head).click();
    return { o, sect: head && head.nextElementSibling };
  }

  it("always offers the enable switch", () => {
    expect(openOrb({ on: false }).sect.querySelector("#orbOn")).toBeTruthy();
  });

  it("says so plainly when the engine cannot run, rather than showing dead controls", () => {
    // jsdom has no WebGL2, so this is the real branch here — and the one a
    // user on an old machine gets
    const { sect } = openOrb({});
    expect(sect.querySelector(".fxWarn"), "an unavailable engine must be stated").toBeTruthy();
    expect(sect.querySelector("#orb_radius"), "no controls when nothing can render").toBeFalsy();
  });

  it("offers a control for every setting the shader reads", () => {
    /* Generated from a table for this reason: the shadow panel shipped twice
     * with settings the engine used and the panel could not reach. */
    const SO = window.SpectralOrb;
    const oldAvail = SO.available;
    SO.available = () => true;
    const { sect } = openOrb({});
    for (const key of [
      "radius",
      "centerX",
      "centerY",
      "rotation",
      "concentration",
      "intensity",
      "centerStrength",
      "centerFalloff",
      "rimStrength",
      "rimWidth",
      "fresnelStrength",
      "fresnelPower",
    ]) {
      expect(sect.querySelector("#orb_" + key), `${key} is missing from the panel`).toBeTruthy();
    }
    expect(sect.querySelector("#orbCC"), "no centre colour").toBeTruthy();
    expect(sect.querySelectorAll('[id^="orb_a"]').length, "no anchor colours").toBe(8);
    SO.available = oldAvail;
  });

  it("writes each control through to the effect", () => {
    const SO = window.SpectralOrb;
    const oldAvail = SO.available;
    SO.available = () => true;
    const { o, sect } = openOrb({});
    const drive = (id, v) => {
      const el = /** @type {HTMLInputElement} */ (sect.querySelector("#" + id));
      el.value = String(v);
      el.dispatchEvent(new window.Event("input", { bubbles: true }));
    };
    drive("orb_rotation", 123);
    drive("orb_rimStrength", 75);
    drive("orb_radius", 60);
    expect(o.effects.orb.rotation).toBe(123);
    expect(o.effects.orb.rimStrength).toBeCloseTo(0.75, 5);
    expect(o.effects.orb.radius).toBeCloseTo(0.6, 5);
    SO.available = oldAvail;
  });
});
