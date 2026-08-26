// @vitest-environment jsdom
/**
 * QA for the `spectralField` effect, ported from public/lab-field.html.
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

function shapeWithField(over, type) {
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
          effects: { spectralField: { on: true, ...over } },
        },
      ],
    },
  };
  return editor.doc.frame.children[0];
}

beforeAll(() => {
  ({ editor } = loadEditor());
  window.FxStack.READY.add("spectralField");
});
afterAll(() => {
  window.FxStack.READY.delete("spectralField");
});

describe("spectral field — wired into the effect system", () => {
  it("is registered as a MATERIAL, not an overlay", () => {
    // the field IS what the shape shows; as an overlay it would paint over a
    // fill that is invisible but still casting the shadow
    expect(window.FxStack.slotOf("spectralField")).toBe("material");
  });

  it("is offered on the shapes that can render it", () => {
    const pages = (t) => editor.FX_PAGES({ type: t, name: "x", x: 0, y: 0, w: 10, h: 10 });
    expect(pages("rect")).toContain("Spectral Field");
    expect(pages("path")).toContain("Spectral Field");
    expect(pages("text"), "text cannot carry a field").not.toContain("Spectral Field");
  });

  it("becomes the active material when switched on", () => {
    const m = window.FxStack.activeMaterial(shapeWithField({}).fx);
    expect(m && m.type).toBe("spectralField");
  });

  it("keeps effects.spectralField a live alias of its fx-stack entry", () => {
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
            effects: { spectralField: { on: true } },
            fx: [{ id: "e1", type: "spectralField", on: true, params: { on: true, rotation: 33 } }],
          },
        ],
      },
    };
    const o = editor.doc.frame.children[0];
    const entry = o.fx.find((e) => e.type === "spectralField");
    expect(entry.params, "the stack entry is not the dictionary object").toBe(
      o.effects.spectralField,
    );
    // and the saved value survived the fold rather than being reset
    expect(o.effects.spectralField.rotation).toBe(33);
    // editing either view must move the other, which is the point of the alias
    entry.params.rotation = 77;
    expect(o.effects.spectralField.rotation).toBe(77);
  });

  it("refuses to enable on a type that cannot render it", () => {
    expect(shapeWithField({}, "text").effects.spectralField.on).toBe(false);
  });

  it("takes a place in the legacy order, so no saved document shifts", () => {
    expect(window.FxStack.LEGACY_ORDER).toContain("spectralField");
  });
});

describe("spectral field — settings are repaired, not trusted", () => {
  it("fills a bare switch with the engine's own defaults", () => {
    // the stored default is `{on}` alone: eight anchors in every object's
    // defaults would enter the serialisation baseline for shapes that never
    // touch the effect
    const O = shapeWithField({}).effects.spectralField;
    expect(O.anchors).toHaveLength(8);
    expect(O.concentration).toBeGreaterThan(0);
    expect(O.centerColor).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("clamps every value that arrives out of range", () => {
    const O = shapeWithField({
      radius: 99,
      centerX: -50,
      concentration: 9999,
      rimWidth: -3,
      fresnelPower: 0,
      centerColor: "not a colour",
    }).effects.spectralField;
    expect(O.radius).toBe(1);
    expect(O.centerX).toBe(-1);
    expect(O.concentration).toBe(24);
    expect(O.rimWidth).toBe(0.3);
    expect(O.fresnelPower).toBe(0.2);
    expect(O.centerColor).toBe("#ffe0d6");
  });

  it("wraps rotation rather than clamping it", () => {
    // an angle has no ends; clamping 370 to 360 would stick the control
    expect(shapeWithField({ rotation: 370 }).effects.spectralField.rotation).toBe(10);
    expect(shapeWithField({ rotation: -90 }).effects.spectralField.rotation).toBe(270);
  });

  it("normalises every anchor direction to a unit vector", () => {
    /* The weighting is exp(k*(N.D - 1)), which assumes both are unit. A
     * direction of length 2 would silently double every exponent and blow the
     * field out — a saved file or a bad drag is enough to produce one. */
    const O = shapeWithField({
      anchors: [{ id: "x", direction: [3, 4, 0], color: [1, 0, 0], strength: 1 }],
    }).effects.spectralField;
    const d = O.anchors[0].direction;
    expect(Math.hypot(d[0], d[1], d[2])).toBeCloseTo(1, 6);
  });

  it("replaces an empty anchor list rather than rendering nothing", () => {
    // with no anchors the weight total is zero and every fragment divides by
    // the epsilon floor: a black disc, which reads as a broken engine
    expect(shapeWithField({ anchors: [] }).effects.spectralField.anchors.length).toBeGreaterThan(0);
  });

  it("survives a compact round trip with its field intact", () => {
    const o = shapeWithField({ rotation: 42, concentration: 7 });
    o.effects.spectralField.anchors[2].color = [0.25, 0.5, 0.75];
    const wire = editor.compactDoc({ frame: editor.doc.frame });
    editor.doc = JSON.parse(JSON.stringify(wire));
    const O = editor.doc.frame.children[0].effects.spectralField;
    expect(O.rotation).toBe(42);
    expect(O.concentration).toBe(7);
    expect(O.anchors[2].color.map((v) => +v.toFixed(3))).toEqual([0.25, 0.5, 0.75]);
  });
});

describe("spectral field — the panel", () => {
  function openField(over) {
    const o = shapeWithField(over);
    editor.setSelIds(new Set([o.id]));
    editor.refresh();
    const head = document.querySelector('#fxBody [data-fxsect="Spectral Field"]');
    if (head && head.getAttribute("aria-expanded") !== "true")
      /** @type {HTMLElement} */ (head).click();
    return { o, sect: head && head.nextElementSibling };
  }

  it("always offers the enable switch", () => {
    expect(openField({ on: false }).sect.querySelector("#sfOn")).toBeTruthy();
  });

  it("says so plainly when the engine cannot run, rather than showing dead controls", () => {
    // jsdom has no WebGL2, so this is the real branch here — and the one a
    // user on an old machine gets
    const { sect } = openField({});
    expect(sect.querySelector(".fxWarn"), "an unavailable engine must be stated").toBeTruthy();
    expect(sect.querySelector("#sf_radius"), "no controls when nothing can render").toBeFalsy();
  });

  it("offers a control for every setting the shader reads", () => {
    /* Generated from a table for this reason: the shadow panel shipped twice
     * with settings the engine used and the panel could not reach. */
    const SO = window.SpectralField;
    const oldAvail = SO.available;
    SO.available = () => true;
    const { sect } = openField({});
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
      expect(sect.querySelector("#sf_" + key), `${key} is missing from the panel`).toBeTruthy();
    }
    expect(sect.querySelector("#sfCC"), "no centre colour").toBeTruthy();
    expect(sect.querySelectorAll('[id^="sf_a"]').length, "no anchor colours").toBe(8);
    SO.available = oldAvail;
  });

  it("writes each control through to the effect", () => {
    const SO = window.SpectralField;
    const oldAvail = SO.available;
    SO.available = () => true;
    const { o, sect } = openField({});
    const drive = (id, v) => {
      const el = /** @type {HTMLInputElement} */ (sect.querySelector("#" + id));
      el.value = String(v);
      el.dispatchEvent(new window.Event("input", { bubbles: true }));
    };
    drive("sf_rotation", 123);
    drive("sf_rimStrength", 75);
    drive("sf_radius", 60);
    expect(o.effects.spectralField.rotation).toBe(123);
    expect(o.effects.spectralField.rimStrength).toBeCloseTo(0.75, 5);
    expect(o.effects.spectralField.radius).toBeCloseTo(0.6, 5);
    SO.available = oldAvail;
  });
});

/* THE RENAME. This shipped as `orb` for one day before the name was changed —
 * the effect is a directional colour field and nothing about it requires a
 * circular outline, so "orb" described the shape it happened to start in
 * rather than what it does.
 *
 * A document saved in that window has to keep working. The alternative is an
 * effect that silently vanishes on load, which is the worst possible outcome
 * of a rename and the reason renames get avoided. */
describe("documents saved under the old name", () => {
  function legacyDoc() {
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
            name: "Old",
            x: 0,
            y: 0,
            w: 300,
            h: 300,
            fill: { kind: "solid", color: "#cccccc" },
            effects: { orb: { on: true, rotation: 120, rimStrength: 0.5 } },
            fx: [
              {
                id: "e1",
                type: "orb",
                on: true,
                params: { on: true, rotation: 120, rimStrength: 0.5 },
              },
            ],
          },
        ],
      },
    };
    return editor.doc.frame.children[0];
  }

  it("carries the settings across rather than losing the effect", () => {
    const o = legacyDoc();
    expect(o.effects.spectralField.on).toBe(true);
    expect(o.effects.spectralField.rotation).toBe(120);
    expect(o.effects.spectralField.rimStrength).toBeCloseTo(0.5);
  });

  it("remaps the stack entry in PLACE, keeping its position", () => {
    /* Worth stating precisely, because the obvious assertions here pass with
     * or without the remap: an entry of an unknown type is dropped anyway and
     * a fresh one appended, so the effect survives either way and the settings
     * come across through the dictionary.
     *
     * What only the remap preserves is WHERE the entry sits. The stack is
     * ordered and that order is the picture — an effect appended to the end
     * composites after everything it used to composite before. */
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
            name: "Old",
            x: 0,
            y: 0,
            w: 300,
            h: 300,
            fill: { kind: "solid", color: "#cccccc" },
            effects: { orb: { on: true }, grain: { amount: 0.5 } },
            fx: [
              { id: "e1", type: "orb", on: true, params: { on: true } },
              { id: "e2", type: "grain", on: true, params: { amount: 0.5 } },
            ],
          },
        ],
      },
    };
    const o = editor.doc.frame.children[0];
    expect(o.fx.some((e) => e.type === "orb")).toBe(false);
    const types = o.fx.map((e) => e.type);
    expect(
      types.indexOf("spectralField"),
      "the migrated entry was appended rather than kept in place",
    ).toBeLessThan(types.indexOf("grain"));
    expect(window.FxStack.activeMaterial(o.fx).type).toBe("spectralField");
  });

  it("leaves no second effect behind under the old name", () => {
    // two entries in the UI for one effect is the specific failure a rename
    // invites, and it is worse than either name alone
    expect(legacyDoc().effects.orb).toBeUndefined();
  });
});
