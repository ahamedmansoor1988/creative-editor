// @vitest-environment jsdom
/**
 * The engine library — the browsable list of what this editor can do.
 *
 * WHY IT EXISTS, AND WHAT THESE GUARD. The Effects menu was filtered by the
 * QA gate, so every unpromoted capability vanished from the UI entirely. That
 * made a gate meant for "is this safe to ship" double as a discovery policy,
 * and the result was a menu that could not tell a user what the tool had or
 * what was coming. The panel lists everything; what varies is whether a row
 * can be acted on and what it says about itself.
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
const stackLabels = () =>
  [...document.querySelectorAll(".engStackRow")].map((r) =>
    r.textContent.replace(/[●○↑↓×]/g, "").trim(),
  );

beforeAll(() => {
  ({ editor } = loadEditor());
});

describe("the panel renders", () => {
  it("opens and lists every capability, hiding none of them", () => {
    /* Nothing is filtered out. An empty menu teaches nobody what the tool can
     * do, and a row that is missing is a question a user cannot ask. */
    layer("rect");
    open();
    expect(document.getElementById("enginesPanel").hidden).toBe(false);
    expect(rows().length).toBe(EC().all().length);
    expect(rows().length).toBeGreaterThan(15);
  });

  it("offers the four categories plus All", () => {
    layer("rect");
    open();
    const cats = [...document.querySelectorAll(".engCat")].map((b) => b.textContent);
    expect(cats).toEqual(["All", "Fills", "Materials", "Finish", "Structure"]);
  });
});

describe("the seven proven capabilities are discoverable", () => {
  it("lists exactly the engines that can be used today", () => {
    /* Derived, not declared: the catalog's claim is reconciled against
     * FxStack, which owns the gate. Two readiness systems that can disagree is
     * how a menu ends up offering something the renderer ignores. */
    expect(EC().ready().map((e) => e.id)).toEqual([
      "linearGradient",
      "mesh",
      "shadow",
      "glow",
      "blur",
      "grain",
      "noise",
    ]);
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
    expect(EC().search("grain").map((e) => e.id)).toContain("grain");
  });

  it("finds an engine by what it does, not only what it is called", () => {
    expect(EC().search("shadow").map((e) => e.id)).toContain("shadow");
    expect(EC().search("refract").map((e) => e.id)).toContain("backdropGlass");
  });

  it("finds a capability by its LEGACY name", () => {
    // someone who knows the old word should still land on the new thing
    expect(EC().search("capsule").map((e) => e.id)).toEqual(["glass3d"]);
    expect(EC().search("echoes").map((e) => e.id)).toEqual(["repeater"]);
  });

  it("says so when nothing matches, rather than showing an empty box", () => {
    layer("rect");
    open();
    window.__engines.query = "zzzznotathing";
    window.__engines.render();
    expect(rows().length).toBe(0);
    expect(document.getElementById("engList").textContent).toMatch(/no engines match/i);
    window.__engines.query = "";
    window.__engines.render();
  });
});

describe("status is stated on every row", () => {
  it("labels ready, experimental and needs-migration distinctly", () => {
    layer("rect");
    open();
    const badge = (id) => row(id).querySelector(".engBadge").textContent;
    expect(badge("grain")).toBe("Ready");
    expect(badge("liquidGradient")).toBe("Experimental");
    expect(badge("glass3d")).toBe("Needs migration");
  });

  it("disables a needs-migration row and shows why", () => {
    layer("rect");
    open();
    const r = row("glass3d");
    expect(r.disabled).toBe(true);
    expect(r.querySelector(".engDesc").textContent).toMatch(/universal layer input/i);
  });

  it("keeps a needs-migration row VISIBLE, which is the point", () => {
    // the old behaviour removed these entirely; a disabled row that explains
    // itself is honest, a missing one is not
    layer("rect");
    open();
    for (const id of ["glass3d", "reededGlass", "repeater", "mask"]) {
      expect(row(id), id + " is missing from the library").toBeTruthy();
    }
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

  it("puts it in the applied stack", () => {
    layer("rect");
    open();
    row("grain").click();
    expect(stackLabels()).toContain("Grain");
  });

  it("lists nothing for a pristine layer", () => {
    /* normalizeDoc appends an entry for EVERY known type, so "has a stack
     * entry" is true of everything. An earlier version listed Drop shadow,
     * Glow and Mesh gradient on a plain rectangle for exactly that reason. */
    layer("rect");
    open();
    expect(stackLabels()).toEqual([]);
  });

  it("keeps an effect listed after it is toggled off", () => {
    // otherwise the toggle removes the control that would toggle it back
    const o = layer("rect");
    open();
    row("grain").click();
    const entry = o.fx.find((e) => e.type === "grain");
    entry.on = false;
    window.__engines.render();
    expect(stackLabels()).toContain("Grain");
  });

  it("reports what it did", () => {
    layer("rect");
    open();
    row("grain").click();
    expect(document.getElementById("engStatus").textContent).toMatch(/applied/i);
  });

  it("does not let an experimental engine apply silently", () => {
    /* Experimental engines may be applied — they are labelled, not blocked —
     * but they render while their inspector page is still gated, so applying
     * one changes the artwork and leaves nothing to adjust. Saying so is the
     * difference between "experimental" and "broken". */
    layer("rect");
    open();
    const r = row("liquidGradient");
    expect(r.disabled).toBe(false);
    r.click();
    expect(document.getElementById("engStatus").textContent).toMatch(
      /experimental|no parameter controls/i,
    );
  });

  it("sets a FILL rather than stacking one, because a fill is what a layer is", () => {
    const o = layer("rect");
    open();
    row("linearGradient").click();
    expect(o.fill.kind).toBe("linear");
    expect((o.fx || []).some((e) => e.type === "linearGradient")).toBe(false);
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
    expect(document.getElementById("engStack").textContent).toMatch(/select a layer/i);
  });
});

describe("legacy names keep resolving", () => {
  it("maps every demo composition onto the capability it became", () => {
    /* A demo composition is not an engine: Capsule was demo geometry plus a
     * glass treatment, and only the treatment is reusable. The old renderer
     * types stay valid for documents that use them; they are simply not
     * separate rows in a library a person browses. */
    const R = EC().resolve;
    expect(R("capsule")).toBe("glass3d");
    expect(R("glassobject")).toBe("glass3d");
    expect(R("strip")).toBe("reededGlass");
    expect(R("glass")).toBe("backdropGlass");
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
    for (const legacy of ["capsule", "strip", "glass", "pattern", "echoes"]) {
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
