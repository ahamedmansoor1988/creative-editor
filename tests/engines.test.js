// @vitest-environment jsdom
/**
 * The engine library — the browsable list of what this editor can do.
 *
 * WHY IT EXISTS, AND WHAT THESE GUARD. The Effects menu was filtered by the
 * QA gate. Batch 1 now deliberately exposes only proven, editable fills and
 * effects through one canonical entry point.
 *
 * The rule these tests exist to hold is narrow and worth stating plainly:
 * never show a clickable engine that does nothing. A row is either actionable,
 * or disabled with the reason visible.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { loadEditor } from "./helpers/load-editor.js";

let editor;
const EC = () => window.EngineCatalog;

function layer(type, extra) {
  editor.doc = {
    frame: {
      name: "F",
      w: 900,
      h: 600,
      bg: "#ffffff",
      artboards: [],
      children: [
        Object.assign(
          {
            type: type || "rect",
            name: "L",
            x: 100,
            y: 100,
            w: 300,
            h: 200,
            fill: { kind: "solid", color: "#3b6df0" },
          },
          extra || {},
        ),
      ],
    },
  };
  const o = editor.doc.frame.children[0];
  editor.setSelIds(new Set([o.id]));
  editor.refresh();
  return o;
}

const open = () => window.__engines.open();
const rows = () => [...document.querySelectorAll(".engRow")];
const row = (id) => document.querySelector('.engRow[data-engine="' + id + '"]');
beforeAll(() => {
  ({ editor } = loadEditor());
});

describe("the panel renders", () => {
  it("has one canonical entry point inside Effects", () => {
    const menu = document.querySelector('[data-menu="effects"]');
    expect(menu.querySelectorAll("#enginesOpen").length).toBe(1);
    expect(menu.querySelectorAll("button[data-fx]").length).toBe(0);
    expect(
      [...menu.querySelectorAll("[data-capability]")].map((b) => b.dataset.capability),
    ).toEqual(["imageFill", "linearGradient", "mesh", "shadow", "innerShadow", "glow", "bloom", "backgroundBlur", "blur", "grain", "noise", "distortion", "warp", "displacement", "colorAdjust", "colorMap", "channelFx", "stylize"]);
  });

  it("opens with only the capabilities a person can use now", () => {
    layer("rect");
    open();
    expect(document.getElementById("enginesPanel").hidden).toBe(false);
    expect(rows().map((r) => r.dataset.engine)).toEqual(
      EC()
        .ready()
        .map((e) => e.id),
    );
  });

  it("offers only useful creation categories", () => {
    layer("rect");
    open();
    const cats = [...document.querySelectorAll(".engCat")].map((b) => b.textContent.trim());
    expect(cats).toEqual(["All", "Fills", "Effects", "Filters"]);
  });

  it("keeps shaders inside Effects instead of hiding them behind a missing category", () => {
    layer("rect");
    open();
    window.__engines.filter = "effect";
    window.__engines.query = "gl";
    window.__engines.render();
    expect(row("glass")).toBeTruthy();
    expect(row("glow")).toBeTruthy();
  });
});

describe("the proven capabilities are discoverable", () => {
  it("lists exactly the engines that can be used today", () => {
    /* Derived, not declared: the catalog's claim is reconciled against
     * FxStack, which owns the gate. Two readiness systems that can disagree is
     * how a menu ends up offering something the renderer ignores. */
    expect(
      EC()
        .ready()
        .map((e) => e.id),
    ).toEqual(["imageFill", "linearGradient", "mesh", "glass", "shadow", "innerShadow", "glow", "bloom", "backgroundBlur", "colorAdjust", "colorMap", "channelFx", "stylize", "distortion", "warp", "displacement", "blur", "grain", "noise"]);
  });

  it("demotes a capability the gate has not passed, rather than believing itself", () => {
    const FS = window.FxStack;
    const had = FS.READY.has("grain");
    FS.READY.delete("grain");
    expect(EC().status("grain")).toBe("experimental");
    if (had) FS.READY.add("grain");
    expect(EC().status("grain")).toBe("ready");
  });
});

describe("search", () => {
  it("finds an engine by name", () => {
    expect(
      EC()
        .search("grain")
        .map((e) => e.id),
    ).toContain("grain");
  });

  it("finds an engine by what it does, not only what it is called", () => {
    expect(
      EC()
        .search("shadow")
        .map((e) => e.id),
    ).toContain("shadow");
    expect(
      EC()
        .search("refract")
        .map((e) => e.id),
    ).toContain("glass");
  });

  it("finds a capability by its LEGACY name", () => {
    // someone who knows the old word should still land on the new thing
    expect(
      EC()
        .search("capsule")
        .map((e) => e.id),
    ).toEqual(["glass"]);
    expect(
      EC()
        .search("echoes")
        .map((e) => e.id),
    ).toEqual(["repeater"]);
  });

  it("says so when nothing matches, rather than showing an empty box", () => {
    layer("rect");
    open();
    window.__engines.query = "zzzznotathing";
    window.__engines.render();
    expect(rows().length).toBe(0);
    expect(document.getElementById("engList").textContent).toMatch(/no fills or effects match/i);
    window.__engines.query = "";
    window.__engines.render();
  });
});

describe("unfinished capabilities stay out of the creation flow", () => {
  it("does not cover ready engines with engineering status badges", () => {
    layer("rect");
    open();
    expect(row("grain").querySelector(".engBadge")).toBe(null);
    expect(row("glass3d")).toBe(null);
  });

  it("keeps unfinished shaders and generators out of the production picker", () => {
    layer("rect");
    open();
    expect(row("glass3d")).toBe(null);
    expect(row("liquidGradient")).toBe(null);
    expect(row("symmetry")).toBe(null);
  });
});

describe("applying an engine", () => {
  it("turns grain on, and to a value that is actually visible", () => {
    /* Several effects are "on" at zero — grain, noise, blur — so applying
     * with stored defaults would add a stack entry that renders nothing.
     * Clicking a thing and seeing no change is indistinguishable from a
     * broken button. */
    const o = layer("rect");
    open();
    row("grain").click();
    expect(o.effects.grain.amount).toBeGreaterThan(0);
  });

  it("puts it in the document effect stack", () => {
    const o = layer("rect");
    open();
    row("grain").click();
    expect(o.fx.some((e) => e.type === "grain" && window.FxStack.entryOn(e))).toBe(true);
  });

  it("applies Inner Shadow through the reusable effect stack", () => {
    const o = layer("ellipse");
    open();
    row("innerShadow").click();
    expect(o.effects.innerShadow.on).toBe(true);
    const entry = o.fx.find((e) => e.type === "innerShadow");
    expect(entry).toBeTruthy();
    expect(entry.params).toBe(o.effects.innerShadow);
    expect(document.querySelector('[data-fxsect="Inner Shadow"]')).toBeTruthy();
  });

  it("closes after applying and opens the existing inspector controls", () => {
    layer("rect");
    open();
    row("grain").click();
    expect(document.getElementById("enginesPanel").hidden).toBe(true);
    expect(document.querySelector('[data-fxsect="Grain"]')).toBeTruthy();
  });

  it("sets a FILL rather than stacking one, because a fill is what a layer is", () => {
    const o = layer("rect");
    open();
    row("linearGradient").click();
    expect(o.fill.kind).toBe("linear");
    expect(o.fills[0]).toBe(o.fill);
    expect(o.fills[0].kind).toBe("linear");
    expect(o.fill.stops.map((s) => s.pos)).toEqual([0, 1]);
    expect(o.fill.opacity).toBe(1);
    expect((o.fx || []).some((e) => e.type === "linearGradient")).toBe(false);
  });

  it("applies Image Fill through the shared fill stack, not through an engine object", () => {
    const o = layer("ellipse");
    open();
    row("imageFill").click();
    expect(o.fill.kind).toBe("image");
    expect(o.fills[0]).toBe(o.fill);
    expect(o.fill).toMatchObject({
      src: "",
      mode: "fill",
      x: 0.5,
      y: 0.5,
      scale: 1,
      rotation: 0,
      tileScale: 1,
    });
    expect((o.fx || []).some((e) => e.type === "imageFill")).toBe(false);
    expect(document.querySelector('.fxSect .apImgPick[data-i="0"]')).toBeTruthy();
  });

  it("applies Image Fill from the quick menu through that same fill stack", () => {
    const o = layer("path", {
      closed: true,
      fillOn: true,
      points: [
        { x: 100, y: 100 },
        { x: 300, y: 100 },
        { x: 250, y: 260 },
      ],
    });
    document.querySelector('[data-menu="effects"] [data-capability="imageFill"]').click();
    expect(o.fill.kind).toBe("image");
    expect(o.fills[0]).toBe(o.fill);
    expect((o.fx || []).some((e) => e.type === "imageFill")).toBe(false);
  });

  it("updates the live gradient stop when its color control changes", () => {
    const o = layer("rect");
    open();
    row("linearGradient").click();
    const color = document.querySelector('.fxSect .apSC[data-s="0"]');
    color.value = "#ff0066";
    color.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(o.fill.stops[0].color).toBe("#ff0066");
    expect(o.fills[0].stops[0].color).toBe("#ff0066");
  });
});

describe("compatibility is explained, never silently ignored", () => {
  it("disables an engine the layer type cannot take, and says which", () => {
    layer("text", { text: "Hi" });
    open();
    expect(row("mesh").disabled).toBe(true);
    expect(row("mesh").querySelector(".engDesc").textContent).toMatch(/text layer/i);
  });

  it("still offers the engines that DO work on that layer", () => {
    layer("text", { text: "Hi" });
    open();
    expect(row("shadow").disabled).toBe(false);
    expect(row("blur").disabled).toBe(false);
  });

  it("explains what to do when nothing is selected", () => {
    editor.setSelIds(new Set());
    editor.refresh();
    open();
    expect(document.getElementById("engTarget").textContent).toMatch(/no layer selected/i);
    expect(row("grain").disabled).toBe(true);
    expect(row("grain").querySelector(".engDesc").textContent).toMatch(/select a layer/i);
  });
});

describe("legacy names keep resolving", () => {
  it("maps every demo composition onto the capability it became", () => {
    /* A demo composition is not an engine: Capsule was demo geometry plus a
     * glass treatment, and only the treatment is reusable. The old renderer
     * types stay valid for documents that use them; they are simply not
     * separate rows in a library a person browses. */
    const R = EC().resolve;
    expect(R("capsule")).toBe("glass");
    expect(R("glassobject")).toBe("glass");
    expect(R("strip")).toBe("glass");
    expect(R("backdropGlass")).toBe("glass");
    expect(R("pattern")).toBe("repeater");
    expect(R("echoes")).toBe("repeater");
    expect(R("repeatTransform")).toBe("repeater");
  });

  it("leaves an unknown id alone rather than inventing a mapping", () => {
    expect(EC().resolve("somethingElse")).toBe("somethingElse");
    expect(EC().get("somethingElse")).toBe(null);
  });

  it("does not list a legacy name as its own engine", () => {
    const ids = EC()
      .all()
      .map((e) => e.id);
    for (const legacy of ["capsule", "strip", "backdropGlass", "reededGlass", "glass3d", "pattern", "echoes"]) {
      expect(ids, legacy + " is duplicated as its own row").not.toContain(legacy);
    }
  });
});

describe("the stack survives a document round trip", () => {
  it("preserves which engines are applied, their order, and their toggles", () => {
    const o = layer("rect");
    open();
    row("grain").click();
    row("blur").click();

    // reorder, so the test proves ORDER survives and not merely membership
    const fx = o.fx;
    const gi = fx.findIndex((e) => e.type === "grain");
    const [grain] = fx.splice(gi, 1);
    fx.push(grain);
    fx.find((e) => e.type === "grain").on = false;
    editor.pushHistory("reorder");

    const seen = () =>
      (editor.doc.frame.children[0].fx || [])
        .filter((e) => ["grain", "blur"].includes(e.type))
        .map((e) => e.type + (window.FxStack.entryOn(e) ? "" : "(off)"))
        .join(" > ");
    const before = seen();
    expect(before).toBe("blur > grain(off)");

    const wire = editor.serializeDocument();
    expect(wire).toMatch(/"fx"/);
    editor.loadDocumentFromText(wire);
    expect(seen()).toBe(before);
  });
});
