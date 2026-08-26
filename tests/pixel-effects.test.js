// @vitest-environment jsdom
/**
 * QA for `blur`, `noise` (§pixel slot) and `grain` (§over slot) — the three
 * effects the layered-reference flow needs and the first pixel effects through
 * the FxStack.READY gate.
 *
 * These three were never dead. Their engines ran, their clamps held and the
 * analyser already emitted them; what they lacked was a panel, so a value the
 * model chose could not afterwards be changed by hand. That is the specific
 * failure mode these tests are pointed at: not "does it draw" alone, but "is
 * every quantity that reaches the draw path also reachable from the panel".
 *
 * The pixel slot is observable in jsdom in a way the materials are not: it
 * hands each effect to Filters.apply by name, so the calls ARE the pass, and
 * the order of the calls IS the stack order. The paint cache is off for the
 * same reason as in tests/shadow.test.js — it blits one bitmap and every pass
 * below it becomes invisible to the recorder.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loadEditor } from "./helpers/load-editor.js";

let editor, ctx;

function box(effects, type) {
  editor.doc = {
    frame: {
      name: "F",
      w: 900,
      h: 600,
      bg: "#ffffff",
      // no artboards: the slab paints its own passes, which the probes below
      // cannot tell from the object's
      artboards: [],
      children: [
        {
          type: type || "rect",
          name: "B",
          x: 100,
          y: 100,
          w: 200,
          h: 160,
          fill: { kind: "solid", color: "#3b6df0" },
          effects,
        },
      ],
    },
  };
  return editor.doc.frame.children[0];
}

/** Every pixel effect handed to the filter bank this render, in stack order. */
function pixelPasses(effects) {
  box(effects);
  const seen = [];
  const orig = window.Filters.apply;
  window.Filters.apply = (type, layer, params) => {
    seen.push({ type, params: JSON.parse(JSON.stringify(params)) });
    return orig(type, layer, params);
  };
  try {
    editor.render();
  } finally {
    window.Filters.apply = orig;
  }
  return seen;
}

/** The grain pass is a pattern fill, and nothing else in these documents makes
 *  one — so counting patterns counts the pass. */
function grainPasses(effects) {
  box(effects);
  let n = 0;
  let composite = null;
  const orig = ctx.createPattern;
  ctx.createPattern = (...a) => {
    n++;
    composite = ctx.globalCompositeOperation;
    return orig.apply(ctx, a);
  };
  try {
    editor.render();
  } finally {
    ctx.createPattern = orig;
  }
  return { n, composite };
}

beforeAll(() => {
  ({ editor, ctx } = loadEditor());
  editor.paintCacheOff = true;
  ["blur", "noise", "grain"].forEach((t) => window.FxStack.READY.add(t));
});
afterAll(() => {
  editor.paintCacheOff = false;
});

describe("blur — reaches the filter bank", () => {
  it("costs no pass at radius zero", () => {
    expect(pixelPasses({ blur: { kind: "gaussian", radius: 0 } })).toHaveLength(0);
  });

  it("runs a gaussian blur and carries its radius", () => {
    const [pass] = pixelPasses({ blur: { kind: "gaussian", radius: 20 } });
    expect(pass.type).toBe("blur");
    expect(pass.params).toMatchObject({ kind: "gaussian", radius: 20 });
  });

  /* The motion-blur case, and a regression: entryOn decided whether an effect
   * was on by reading `radius` and nothing else. A directional blur is driven
   * by DISTANCE — its radius is legitimately 0 — so it reported off and never
   * reached the bank. The layered-reference flow asks for exactly this shape
   * of blur, which is how it was found. */
  it("runs a directional blur driven by distance, with radius still zero", () => {
    const [pass] = pixelPasses({
      blur: { kind: "directional", radius: 0, distance: 30, angle: 45 },
    });
    expect(pass, "the motion blur never reached the filter bank").toBeTruthy();
    expect(pass.params).toMatchObject({ kind: "directional", distance: 30, angle: 45 });
  });

  it("costs no pass when a directional blur has no distance", () => {
    expect(pixelPasses({ blur: { kind: "directional", radius: 0, distance: 0 } })).toHaveLength(0);
  });

  it("runs a zoom blur driven by amount", () => {
    const [pass] = pixelPasses({ blur: { kind: "zoom", radius: 0, amount: 0.4 } });
    expect(pass, "the zoom blur never reached the filter bank").toBeTruthy();
    expect(pass.params).toMatchObject({ kind: "zoom", amount: 0.4 });
  });

  it("costs no pass when a zoom blur has no amount", () => {
    expect(pixelPasses({ blur: { kind: "zoom", radius: 0, amount: 0 } })).toHaveLength(0);
  });

  it("repairs a radius and a kind that arrive out of range", () => {
    // saved files and the model reach this path as readily as the panel does
    const o = box({ blur: { kind: "sideways", radius: 9999, distance: -5 } });
    expect(o.effects.blur.kind).toBe("gaussian");
    expect(o.effects.blur.radius).toBe(200);
    expect(o.effects.blur.distance).toBe(0);
  });
});

describe("noise — reaches the filter bank", () => {
  it("costs no pass at amount zero", () => {
    expect(pixelPasses({ noise: { amount: 0 } })).toHaveLength(0);
  });

  it("runs and carries its parameters", () => {
    const [pass] = pixelPasses({ noise: { amount: 0.5, scale: 4, mono: false, seed: 7 } });
    expect(pass.type).toBe("noise");
    expect(pass.params).toMatchObject({ amount: 0.5, scale: 4, mono: false, seed: 7 });
  });

  it("is seeded, so a document looks the same on reload", () => {
    // the panel offers a seed; if the engine ignored it the control would be a
    // lie and two loads of one file would differ
    const a = pixelPasses({ noise: { amount: 0.5, seed: 11 } })[0];
    const b = pixelPasses({ noise: { amount: 0.5, seed: 12 } })[0];
    expect(a.params.seed).toBe(11);
    expect(b.params.seed).toBe(12);
  });

  it("repairs parameters that arrive out of range", () => {
    const o = box({ noise: { amount: 5, scale: 99, seed: -3 } });
    expect(o.effects.noise).toMatchObject({ amount: 1, scale: 32, seed: 1 });
  });
});

describe("grain — reaches the canvas", () => {
  it("costs no pass at amount zero", () => {
    expect(grainPasses({ grain: { amount: 0 } }).n).toBe(0);
  });

  it("paints as an overlay, which is what makes it grain rather than fog", () => {
    const { n, composite } = grainPasses({ grain: { amount: 0.5 } });
    expect(n).toBe(1);
    expect(composite).toBe("overlay");
  });

  it("repairs an amount that arrives out of range", () => {
    expect(box({ grain: { amount: 9 } }).effects.grain.amount).toBe(1);
  });
});

describe("the three compose in stack order", () => {
  /* The layered reference the flow is built around is a gradient, then motion
   * blur, then noise — in that order. Blurring after the noise would smear the
   * noise; the order is the picture. */
  it("blurs before it noises when the stack says so", () => {
    const passes = pixelPasses({
      blur: { kind: "directional", radius: 0, distance: 30 },
      noise: { amount: 0.4 },
    });
    expect(passes.map((p) => p.type)).toEqual(["blur", "noise"]);
  });

  it("runs grain and the pixel passes together on one object", () => {
    const fx = {
      grain: { amount: 0.3 },
      blur: { kind: "gaussian", radius: 8 },
      noise: { amount: 0.4 },
    };
    expect(pixelPasses(fx).map((p) => p.type)).toEqual(["blur", "noise"]);
    expect(grainPasses(fx).n).toBe(1);
  });
});

describe("the panels reach the whole model", () => {
  function openPanel(page, effects) {
    const o = box(effects);
    editor.setSelIds(new Set([o.id]));
    editor.refresh();
    const head = document.querySelector(`#fxBody [data-fxsect="${page}"]`);
    if (head && head.getAttribute("aria-expanded") !== "true")
      /** @type {HTMLElement} */ (head).click();
    return { o, sect: head && head.nextElementSibling };
  }

  function drive(el, value) {
    el.value = String(value);
    el.dispatchEvent(new window.Event("input", { bubbles: true }));
  }

  it("offers a control for every blur parameter, per kind", () => {
    const gauss = openPanel("Blur", { blur: { kind: "gaussian", radius: 10 } });
    expect(gauss.sect.querySelector("#px_kind")).toBeTruthy();
    expect(gauss.sect.querySelector("#px_radius")).toBeTruthy();

    // angle and distance exist only for the kind that uses them — a directional
    // control on a gaussian blur would set a value nothing reads
    const dir = openPanel("Blur", { blur: { kind: "directional", distance: 30 } });
    expect(dir.sect.querySelector("#px_angle"), "no angle control on a motion blur").toBeTruthy();
    expect(
      dir.sect.querySelector("#px_distance"),
      "no distance control on a motion blur",
    ).toBeTruthy();

    const zoom = openPanel("Blur", { blur: { kind: "zoom", amount: 0.3 } });
    expect(zoom.sect.querySelector("#px_amount")).toBeTruthy();
    expect(zoom.sect.querySelector("#px_cx")).toBeTruthy();
    expect(zoom.sect.querySelector("#px_cy")).toBeTruthy();
  });

  it("offers a control for every noise parameter", () => {
    const { sect } = openPanel("Noise", { noise: { amount: 0.4 } });
    for (const id of ["px_amount", "px_scale", "px_mono", "px_seed"]) {
      expect(sect.querySelector("#" + id), `${id} is missing from the panel`).toBeTruthy();
    }
  });

  it("offers a control for grain", () => {
    expect(openPanel("Grain", { grain: { amount: 0.3 } }).sect.querySelector("#grA")).toBeTruthy();
  });

  /* The shadow panel shipped with sliders narrower than its own clamps, so
   * part of every document was uneditable — a value the model or a saved file
   * had set could not be reached by hand. Same check, same reason. */
  it("lets each slider reach the model's full clamped range", () => {
    const range = (sect, id) => {
      const el = /** @type {HTMLInputElement} */ (sect.querySelector("#" + id));
      return [Number(el.min), Number(el.max)];
    };
    const blur = openPanel("Blur", { blur: { kind: "directional", distance: 30 } });
    expect(range(blur.sect, "px_radius")).toEqual([0, 200]);
    expect(range(blur.sect, "px_angle")).toEqual([-180, 180]);
    expect(range(blur.sect, "px_distance")).toEqual([0, 400]);

    const noise = openPanel("Noise", { noise: { amount: 0.4 } });
    expect(range(noise.sect, "px_amount")).toEqual([0, 1]);
    expect(range(noise.sect, "px_scale")).toEqual([1, 32]);
    expect(range(noise.sect, "px_seed")).toEqual([1, 99999]);
  });

  it("writes each control through to the effect", () => {
    const blur = openPanel("Blur", { blur: { kind: "directional", distance: 30 } });
    drive(blur.sect.querySelector("#px_distance"), 120);
    drive(blur.sect.querySelector("#px_angle"), -90);
    expect(blur.o.effects.blur).toMatchObject({ distance: 120, angle: -90 });

    const noise = openPanel("Noise", { noise: { amount: 0.4 } });
    drive(noise.sect.querySelector("#px_amount"), 0.75);
    drive(noise.sect.querySelector("#px_scale"), 6);
    expect(noise.o.effects.noise).toMatchObject({ amount: 0.75, scale: 6 });

    const grain = openPanel("Grain", { grain: { amount: 0.3 } });
    drive(grain.sect.querySelector("#grA"), 80);
    expect(grain.o.effects.grain.amount).toBeCloseTo(0.8, 5);
  });
});

describe("the analyser and the panel agree on the ranges", () => {
  /* applyRecipe is a second door into the same model, and a door with its own
   * clamps is a door that can set a value the panel cannot show and
   * normalizeDoc will then quietly move. Asserted here because the layered
   * flow drives the model through this door, not the panel. */
  it("accepts the model's noise scale across the range the panel offers", () => {
    const o = box({ noise: { amount: 0 } });
    editor.applyRecipe(o, { effects: [{ type: "noise", amount: 0.5, scale: 20 }] });
    expect(o.effects.noise.scale).toBe(20);
  });

  it("turns a stated radius into a distance for a motion blur", () => {
    // the model reaches for `radius` out of habit; a directional blur with no
    // distance is not a blur, and would read as the analysis being ignored
    const o = box({ blur: { kind: "gaussian", radius: 0 } });
    editor.applyRecipe(o, {
      effects: [{ type: "blur", kind: "directional", radius: 40, angle: 20 }],
    });
    expect(o.effects.blur).toMatchObject({ kind: "directional", distance: 40 });
  });
});

/* THE FILTER MUST DO SOMETHING, NOT MERELY BE CALLED.
 *
 * Everything above checks that an effect reaches Filters.apply, and all of it
 * passed while directional blur was a total no-op: blurLayer opened with
 * `if (r <= 0 && kind !== "zoom") return cv`, so a motion blur — whose radius
 * is legitimately 0 because DISTANCE drives it — got the layer handed straight
 * back. Measured on a real canvas, mean pixel difference was exactly 0 at
 * every angle and distance, against ~11.5 for gaussian and zoom.
 *
 * jsdom has no real 2D raster, so these cannot compare pixels. What they can
 * compare is IDENTITY: blurLayer returns a NEW canvas when it does work and
 * the original object when it bails. That distinction is precisely the bug,
 * and it is checkable here.
 */
describe("blur does work rather than just getting called", () => {
  const layer = () => {
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 48;
    return c;
  };

  it("does real work for a directional blur driven by distance", () => {
    const src = layer();
    const out = window.Filters.apply("blur", src, {
      kind: "directional",
      radius: 0,
      distance: 120,
      angle: 30,
    });
    expect(out, "the motion blur handed the layer straight back").not.toBe(src);
  });

  it("does real work for a gaussian blur with a radius", () => {
    const src = layer();
    expect(window.Filters.apply("blur", src, { kind: "gaussian", radius: 20 })).not.toBe(src);
  });

  it("does real work for a zoom blur driven by amount", () => {
    const src = layer();
    expect(window.Filters.apply("blur", src, { kind: "zoom", radius: 0, amount: 0.5 })).not.toBe(
      src,
    );
  });

  /* The other half of the guard: a blur with nothing to do must still cost
   * nothing, or the fix above would just be "always allocate a canvas". */
  it("leaves the layer alone when there is genuinely nothing to blur", () => {
    const a = layer();
    expect(window.Filters.apply("blur", a, { kind: "gaussian", radius: 0 })).toBe(a);
    const b = layer();
    expect(window.Filters.apply("blur", b, { kind: "directional", radius: 0, distance: 0 })).toBe(
      b,
    );
  });
});
