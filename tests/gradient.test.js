// @vitest-environment jsdom
/**
 * QA for the `gradient` stripe effect (§5.x), third through the FxStack.READY
 * gate.
 *
 * This one was not broken so much as UNREACHABLE. The engine, the model, the
 * clamps, the draw path, the FX_PAGES entry and the fxActive case all existed;
 * the panel branch did not. Opening Gradient rendered an empty section, so not
 * one of its fifteen parameters could be set except by hand-editing a saved
 * document. The tests below therefore lean on the panel: an effect you cannot
 * operate is not shipped, whatever its renderer does.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { loadEditor } from "./helpers/load-editor.js";

let editor;

function boxWithGradient(over) {
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
          name: "Box",
          x: 100,
          y: 100,
          w: 400,
          h: 300,
          fill: { kind: "solid", color: "#3b6df0" },
          effects: { gradient: { on: true, ...over } },
        },
      ],
    },
  };
  return editor.doc.frame.children[0];
}

/** Open the object's Gradient section and hand back its container. */
function openGradient(over) {
  const o = boxWithGradient(over);
  editor.setSelIds(new Set([o.id]));
  editor.refresh();
  const head = document.querySelector('#fxBody [data-fxsect="Gradient"]');
  if (head && head.getAttribute("aria-expanded") !== "true")
    /** @type {HTMLElement} */ (head).click();
  return { o, sect: head && head.nextElementSibling };
}

function drive(el, value, type) {
  if (type === "checkbox") el.checked = value;
  else el.value = String(value);
  el.dispatchEvent(new window.Event(type === "checkbox" ? "change" : "input", { bubbles: true }));
}

beforeAll(() => {
  ({ editor } = loadEditor());
  editor.paintCacheOff = true;
});

describe("gradient — the panel exists at all", () => {
  it("renders controls, not an empty section", () => {
    // the whole finding: this section used to build nothing
    const { sect } = openGradient({});
    expect(sect, "Gradient has no section").toBeTruthy();
    expect(sect.querySelectorAll("input, select, button").length).toBeGreaterThan(5);
  });

  it("offers every band and symmetry parameter the model carries", () => {
    const { sect } = openGradient({});
    for (const id of [
      "grdBH",
      "grdSp",
      "grdDr",
      "grdPh",
      "grdAn",
      "grdS1",
      "grdS2",
      "grdBo",
      "grdMX",
      "grdMY",
    ]) {
      expect(sect.querySelector("#" + id), `${id} is missing from the panel`).toBeTruthy();
    }
  });

  it("matches every slider range to the model's clamp", () => {
    // a panel that offers more than the clamp allows silently re-clamps on
    // the next load; one that offers less makes part of a document uneditable
    const { sect } = openGradient({});
    const range = (id) => {
      const el = /** @type {HTMLInputElement} */ (sect.querySelector("#" + id));
      return [Number(el.min), Number(el.max)];
    };
    expect(range("grdBH")).toEqual([2, 400]);
    expect(range("grdSp")).toEqual([5, 95]);
    expect(range("grdDr")).toEqual([-20, 20]);
    expect(range("grdPh")).toEqual([-0.5, 0.5]);
    expect(range("grdAn")).toEqual([0, 359]);
    expect(range("grdS1")).toEqual([-50, 50]);
    expect(range("grdS2")).toEqual([-50, 50]);
  });

  it("writes each control through to the effect", () => {
    const { o, sect } = openGradient({});
    drive(sect.querySelector("#grdBH"), 120);
    drive(sect.querySelector("#grdSp"), 70);
    drive(sect.querySelector("#grdAn"), 45);
    drive(sect.querySelector("#grdMX"), true, "checkbox");
    expect(o.effects.gradient).toMatchObject({
      bandHeight: 120,
      split: 70,
      angle: 45,
      mirrorX: true,
    });
  });

  it("hides the controls while the effect is off, but keeps the switch", () => {
    const { sect } = openGradient({ on: false });
    expect(sect.querySelector("#grdOn"), "the enable switch must always show").toBeTruthy();
    expect(sect.querySelector("#grdBH"), "parameters should not show when off").toBeFalsy();
  });
});

describe("gradient — the colour ramps", () => {
  it("edits a stop's colour and position", () => {
    const { o, sect } = openGradient({});
    drive(sect.querySelector(".grdC0"), "#123456");
    expect(o.effects.gradient.g1[0].color).toBe("#123456");
    const pos = sect.querySelectorAll(".grdP1")[1];
    drive(pos, 0.25);
    expect(o.effects.gradient.g2[1].pos).toBeCloseTo(0.25);
  });

  it("adds a stop, up to the engine's own limit", () => {
    const max = window.GradientEngine.MAX_STOPS;
    const { o, sect } = openGradient({});
    const before = o.effects.gradient.g1.length;
    /** @type {HTMLElement} */ (sect.querySelector("#grdAdd0")).click();
    expect(editor.doc.frame.children[0].effects.gradient.g1.length).toBe(before + 1);
    expect(before + 1).toBeLessThanOrEqual(max);
  });

  it("never lets a ramp fall below the two stops a ramp needs", () => {
    const o = boxWithGradient({ g1: [{ color: "#000000", pos: 0 }] });
    expect(o.effects.gradient.g1.length).toBeGreaterThanOrEqual(2);
    const { sect } = openGradient({ g1: [{ color: "#000000", pos: 0 }] });
    expect(
      /** @type {HTMLButtonElement} */ (sect.querySelector("#grdDel0")).disabled,
      "Remove must be disabled at two stops",
    ).toBe(true);
  });

  it("applies a preset to both ramps", () => {
    const { sect } = openGradient({});
    const sel = /** @type {HTMLSelectElement} */ (sect.querySelector("#grdPre"));
    sel.value = "0";
    sel.dispatchEvent(new window.Event("change", { bubbles: true }));
    const g = editor.doc.frame.children[0].effects.gradient;
    const preset = window.GradientEngine.PRESETS[0];
    expect(g.g1[0].color).toBe(preset.g1[0].color);
    expect(g.g2[0].color).toBe(preset.g2[0].color);
  });
});

describe("gradient — the document model", () => {
  it("clamps every parameter into its documented range", () => {
    const g = boxWithGradient({
      bandHeight: 9999,
      split: 999,
      drift: 999,
      g1shift: 999,
      g2shift: -999,
      phase: 9,
      angle: 9999,
    }).effects.gradient;
    expect(g.bandHeight).toBe(400);
    expect(g.split).toBe(95);
    expect(g.drift).toBe(20);
    expect(g.g1shift).toBe(50);
    expect(g.g2shift).toBe(-50);
    expect(g.phase).toBe(0.5);
    expect(g.angle).toBe(359);
  });

  it("caps a ramp at the engine's MAX_STOPS", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ color: "#111111", pos: i / 19 }));
    const g = boxWithGradient({ g1: many }).effects.gradient;
    expect(g.g1.length).toBeLessThanOrEqual(window.GradientEngine.MAX_STOPS);
  });

  it("refuses to enable on a type that cannot render it", () => {
    // normalizeDoc restricts the stripe to fillable shapes
    editor.doc = {
      frame: {
        name: "F",
        w: 900,
        h: 600,
        bg: "#ffffff",
        artboards: [],
        children: [
          {
            type: "text",
            name: "T",
            x: 10,
            y: 10,
            text: "hi",
            effects: { gradient: { on: true } },
          },
        ],
      },
    };
    expect(editor.doc.frame.children[0].effects.gradient.on).toBe(false);
  });

  it("keeps effects.gradient a live alias of its fx-stack entry", () => {
    const o = boxWithGradient({});
    const entry = (o.fx || []).find((e) => e.type === "gradient");
    expect(entry.params).toBe(o.effects.gradient);
  });
});
