/* Canonical capabilities shown by Creative Editor.
 *
 * PRODUCT METADATA, NOT RUNTIME TRUTH. This file says what a capability IS —
 * its name, what it is for, what it can be applied to, and how far along it
 * is. Whether an effect can actually be applied right now is FxStack's
 * question, and `status()` below asks it rather than restating the answer.
 * Two readiness systems that can disagree is how a menu ends up offering
 * something that does nothing.
 *
 * WHY A CATALOG SEPARATE FROM THE FX REGISTRY. The registry is a list of
 * renderers; several of them are demo compositions rather than capabilities.
 * Capsule is demo geometry plus a glass treatment — only the treatment is an
 * engine, so `capsule` resolves to glass3d rather than appearing beside it.
 * Legacy renderer types stay valid for documents that already use them; they
 * are simply not separate entries in a library a person browses.
 *
 * WHY NOTHING IS HIDDEN. An empty menu teaches nobody what the tool can do.
 * Everything is listed; what varies is whether a row can be acted on and what
 * it says about itself. A row that is disabled and explains why is honest. A
 * row that is missing is a question the user cannot ask.
 */
(function () {
  "use strict";

  /* Three states, not a boolean, because the visibility rules need to tell
   * "you can use this, it may change" apart from "you cannot use this yet".
   *   ready         — proven, actionable
   *   experimental  — usable, may change, labelled so nobody is surprised
   *   migration     — visible and DISABLED, with the reason stated
   */
  const READY = "ready";
  const EXPERIMENTAL = "experimental";
  const MIGRATION = "migration";

  /* What a capability can be applied to. Kept as data because the answer
   * differs per engine and will widen as the universal effect contract lands;
   * a hard-coded check in the panel would have to be found and edited then. */
  const ALL_LAYERS = ["rect", "ellipse", "polygon", "path", "text", "image", "group"];
  const SHAPES = ["rect", "ellipse", "polygon", "path"];

  const CATALOG = [
    /* ---- fills ---------------------------------------------------------
     * A fill is what the layer IS, not something laid over it. Linear
     * gradient has no renderer type at all: applying it sets the layer's
     * fill. Mesh gradient is stored and rendered as a MATERIAL effect and
     * that is not being changed to suit a menu heading — it is shown here
     * because that is where someone would look for it. */
    {
      id: "linearGradient",
      label: "Linear gradient",
      category: "fill",
      status: READY,
      kind: "fill", // sets obj.fill, does not push a stack entry
      rendererType: null,
      supportedInputs: SHAPES.concat("text"),
      description: "A straight ramp between colour stops, at any angle.",
    },
    {
      id: "mesh",
      label: "Mesh gradient",
      category: "fill",
      status: READY,
      kind: "effect",
      rendererType: "mesh",
      supportedInputs: SHAPES,
      description: "A grid of colour points blended into one smooth surface.",
    },

    /* ---- materials ------------------------------------------------------
     * All of these read or refract what is behind them, and all of them
     * currently assume a rectangular source. That is the migration. */
    {
      id: "backdropGlass",
      label: "Backdrop glass",
      category: "material",
      status: MIGRATION,
      kind: "effect",
      rendererType: "glass",
      supportedInputs: SHAPES,
      statusReason: "Needs the universal layer input before it works on arbitrary shapes.",
      description: "Refracts and blurs whatever sits behind the layer.",
    },
    {
      id: "glass3d",
      label: "Glass 3D",
      category: "material",
      status: MIGRATION,
      kind: "effect",
      rendererType: "glass3d",
      supportedInputs: SHAPES,
      statusReason: "Requires universal layer input.",
      description: "A thick glass body with depth, edges and internal falloff.",
    },
    {
      id: "innerLens",
      label: "Inner lens",
      category: "material",
      status: MIGRATION,
      kind: "effect",
      rendererType: "glass2",
      supportedInputs: SHAPES,
      statusReason: "Requires universal layer input.",
      description: "Magnifies the layer's own contents from within.",
    },
    {
      id: "reededGlass",
      label: "Reeded glass",
      category: "material",
      status: MIGRATION,
      kind: "effect",
      rendererType: "strip",
      supportedInputs: SHAPES,
      statusReason: "Requires universal layer input.",
      description: "Fluted vertical ribs that slice and offset what is behind.",
    },
    {
      id: "chromaticVolume",
      label: "Chromatic volume",
      category: "material",
      status: MIGRATION,
      kind: "effect",
      rendererType: "prism",
      supportedInputs: SHAPES,
      statusReason: "Requires universal layer input.",
      description: "Splits light through a solid body, by depth.",
    },
    {
      id: "liquidGradient",
      label: "Liquid gradient",
      category: "material",
      status: EXPERIMENTAL,
      kind: "effect",
      rendererType: "liquid",
      supportedInputs: SHAPES,
      description: "Folded, flowing colour with no visible stops.",
    },
    {
      id: "stripField",
      label: "Strip field",
      category: "material",
      status: EXPERIMENTAL,
      kind: "effect",
      rendererType: "blob",
      supportedInputs: SHAPES,
      description: "Soft banded colour masses across the layer.",
    },

    /* ---- finish ---------------------------------------------------------
     * Applied over a layer once it already looks like itself. */
    {
      id: "shadow",
      label: "Drop shadow",
      category: "finish",
      status: READY,
      kind: "effect",
      rendererType: "shadow",
      supportedInputs: ALL_LAYERS,
      description: "Offset, blurred silhouette behind the layer.",
    },
    {
      id: "glow",
      label: "Glow",
      category: "finish",
      status: READY,
      kind: "effect",
      rendererType: "glow",
      supportedInputs: ALL_LAYERS,
      description: "Light spreading inward or outward from the edge.",
    },
    {
      id: "blur",
      label: "Blur",
      category: "finish",
      status: READY,
      kind: "effect",
      rendererType: "blur",
      supportedInputs: ALL_LAYERS,
      description: "Gaussian, directional or zoom softening.",
    },
    {
      id: "grain",
      label: "Grain",
      category: "finish",
      status: READY,
      kind: "effect",
      rendererType: "grain",
      supportedInputs: SHAPES.concat("image"),
      description: "Fine overlay texture, composited as light.",
    },
    {
      id: "noise",
      label: "Noise",
      category: "finish",
      status: READY,
      kind: "effect",
      rendererType: "noise",
      supportedInputs: ALL_LAYERS,
      description: "Seeded per-pixel grain, monochrome or colour.",
    },
    {
      id: "chromaticDispersion",
      label: "Chromatic dispersion",
      category: "finish",
      status: MIGRATION,
      kind: "effect",
      rendererType: "distortion",
      supportedInputs: ALL_LAYERS,
      statusReason: "Requires universal layer input.",
      description: "Separates red, green and blue along an axis.",
    },

    /* ---- structure ------------------------------------------------------
     * These change how many of the layer there are, or where. */
    {
      id: "repeater",
      label: "Repeater",
      category: "structure",
      status: MIGRATION,
      kind: "effect",
      rendererType: "pattern",
      supportedInputs: ALL_LAYERS,
      statusReason: "Pattern instancing is not yet a stack effect.",
      description: "Repeats the layer along a transform.",
    },
    {
      id: "symmetry",
      label: "Symmetry",
      category: "structure",
      status: MIGRATION,
      kind: "effect",
      rendererType: null,
      supportedInputs: ALL_LAYERS,
      statusReason: "No renderer yet.",
      description: "Mirrors the layer across one or more axes.",
    },
    {
      id: "mask",
      label: "Mask",
      category: "structure",
      status: MIGRATION,
      kind: "effect",
      rendererType: null,
      supportedInputs: ALL_LAYERS,
      statusReason: "No renderer yet.",
      description: "Limits the layer to the shape of another.",
    },
  ];

  const CATEGORIES = [
    { id: "fill", label: "Fills" },
    { id: "material", label: "Materials" },
    { id: "finish", label: "Finish" },
    { id: "structure", label: "Structure" },
  ];

  /* Old names that must keep resolving. These were demo compositions or
   * earlier spellings; documents saved with them still load, and a search for
   * the old name still finds the capability it became. */
  const ALIASES = Object.freeze({
    capsule: "glass3d",
    glassobject: "glass3d",
    glassObject: "glass3d",
    strip: "reededGlass",
    glass: "backdropGlass",
    glass2: "innerLens",
    pattern: "repeater",
    echoes: "repeater",
    repeatTransform: "repeater",
    prism: "chromaticVolume",
    liquid: "liquidGradient",
    blob: "stripField",
    distortion: "chromaticDispersion",
  });

  function resolve(id) {
    return Object.prototype.hasOwnProperty.call(ALIASES, id) ? ALIASES[id] : id;
  }
  function get(id) {
    const canonical = resolve(id);
    return CATALOG.find((item) => item.id === canonical) || null;
  }

  /** EFFECTIVE status, which is the catalog's claim reconciled with what the
   *  runtime will actually do.
   *
   *  FxStack is the authority on whether an effect can be applied: it owns the
   *  QA gate, and an entry this file calls ready is still gated if it has not
   *  been through it. Taking the stricter of the two is what stops the panel
   *  offering a button the renderer will ignore.
   *
   *  A fill has no renderer type and so no gate to consult — it is applied by
   *  setting the layer's fill, not by pushing a stack entry. */
  function status(id) {
    const item = get(id);
    if (!item) return null;
    if (item.kind === "fill" || !item.rendererType) return item.status;
    const FS = typeof window !== "undefined" && window.FxStack;
    if (!FS || typeof FS.isReady !== "function") return item.status;
    if (item.status === READY && !FS.isReady(item.rendererType)) {
      return EXPERIMENTAL; // the catalog is ahead of the gate; believe the gate
    }
    return item.status;
  }

  /** Can this capability be applied to this layer, and if not, why not.
   *  Returns { ok, reason } so the panel can disable a row AND say something
   *  useful, rather than leaving a dead control to be discovered by clicking. */
  function compatibility(id, layer) {
    const item = get(id);
    if (!item) return { ok: false, reason: "Unknown capability." };
    const st = status(id);
    if (st === MIGRATION) {
      return { ok: false, reason: item.statusReason || "Not available yet." };
    }
    if (!layer) return { ok: false, reason: "Select a layer first." };
    if (item.supportedInputs && !item.supportedInputs.includes(layer.type)) {
      return { ok: false, reason: "Not available for a " + layer.type + " layer." };
    }
    return { ok: true, reason: "" };
  }

  function all() {
    return CATALOG.slice();
  }
  /** Everything actionable today — used by tests and by "what can I use now". */
  function ready() {
    return CATALOG.filter((item) => status(item.id) === READY);
  }
  /** Retained: earlier callers used this name for the same question. */
  function visible() {
    return ready();
  }

  /** Free-text match over name, description and category, plus the legacy
   *  names — someone who knows the old word should still find the thing. */
  function search(q) {
    const needle = String(q || "")
      .trim()
      .toLowerCase();
    if (!needle) return all();
    const legacyFor = (id) =>
      Object.keys(ALIASES).filter((k) => ALIASES[k] === id);
    return CATALOG.filter((item) => {
      const hay = [
        item.id,
        item.label,
        item.category,
        item.description || "",
        item.rendererType || "",
      ]
        .concat(legacyFor(item.id))
        .join(" ")
        .toLowerCase();
      return hay.includes(needle);
    });
  }

  window.EngineCatalog = Object.freeze({
    CATALOG,
    CATEGORIES,
    ALIASES,
    READY,
    EXPERIMENTAL,
    MIGRATION,
    resolve,
    get,
    status,
    compatibility,
    all,
    ready,
    visible,
    search,
  });
})();
