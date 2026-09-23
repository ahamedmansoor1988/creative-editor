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
  const PAINTABLE_SHAPES = SHAPES.concat("boolean");

  const CATALOG = [
    /* ---- fills ---------------------------------------------------------
     * A fill is what the layer IS, not something laid over it. Linear
     * gradient has no renderer type at all: applying it sets the layer's
     * fill. Mesh gradient is stored and rendered as a MATERIAL effect and
     * that is not being changed to suit a menu heading — it is shown here
     * because that is where someone would look for it. */
    {
      id: "imageFill",
      label: "Image fill",
      category: "fill",
      status: READY,
      kind: "fill",
      fillKind: "image",
      rendererType: null,
      icon: "image",
      page: "Fill",
      supportedInputs: PAINTABLE_SHAPES,
      description: "Place, crop, fit, stretch, or tile an image inside any shape.",
      tagline: "photo or texture",
    },
    {
      id: "linearGradient",
      label: "Gradient",
      category: "fill",
      status: READY,
      kind: "fill", // sets obj.fill, does not push a stack entry
      fillKind: "linear",
      rendererType: null,
      icon: "palette",
      page: "Fill",
      supportedInputs: SHAPES.concat("text"),
      description: "One editable gradient fill for every supported layer.",
      tagline: "linear, radial, angular",
    },
    {
      id: "mesh",
      label: "Mesh gradient",
      category: "fill",
      status: READY,
      kind: "effect",
      rendererType: "mesh",
      icon: "grid",
      page: "Mesh",
      opening: { on: true },
      supportedInputs: SHAPES,
      description: "A grid of colour points blended into one smooth surface.",
      tagline: "editable colour net",
    },
    {
      id: "iridescent",
      label: "Iridescence",
      category: "shader",
      status: READY,
      kind: "effect",
      rendererType: "iridescent",
      icon: "sparkles",
      page: "Iridescence",
      opening: { on: true },
      supportedInputs: SHAPES,
      description: "Thin-film colour that splits across the form, like oil on water.",
      tagline: "dispersive film",
    },
    /* ---- materials ------------------------------------------------------
     * All of these read or refract what is behind them, and all of them
     * currently assume a rectangular source. That is the migration. */
    {
      id: "glass",
      label: "Glass",
      category: "shader",
      status: READY,
      kind: "effect",
      rendererType: "glass",
      icon: "sparkles",
      page: "Glass",
      opening: { on: true, mode: "backdrop" },
      supportedInputs: ["rect", "ellipse"],
      description:
        "Refract a layer as backdrop, frosted, reeded, or 3D glass from one editable material.",
    },
    /* Its own row. The picker ("Add fill or effect") is built from the
     * catalog, so an effect that resolves onto another id has no row of its
     * own however ready it is — which is how the last fluted-glass engine came
     * to be promoted, allowed by FX_ONLY, wired to a menu row, and still
     * unreachable the way people actually add effects. */
    {
      id: "reed",
      label: "Reed glass",
      category: "shader",
      status: READY,
      kind: "effect",
      rendererType: "reed",
      icon: "line",
      page: "Reed glass",
      opening: { on: true },
      supportedInputs: ["rect", "ellipse"],
      description: "Fluted glass: each flute refracts the layers behind this one.",
    },
    {
      id: "fractal",
      label: "Fractal glass",
      category: "shader",
      status: READY,
      kind: "effect",
      rendererType: "fractal",
      icon: "sparkles",
      page: "Fractal glass",
      opening: { on: true },
      supportedInputs: ["rect", "ellipse"],
      description: "Fluted glass over a colour field of its own — no layers needed beneath it.",
    },
    {
      id: "divider",
      label: "Shape divider",
      category: "shader",
      status: READY,
      kind: "effect",
      rendererType: "divider",
      icon: "polygon",
      page: "Shape divider",
      opening: { on: true },
      supportedInputs: ["rect", "ellipse", "polygon", "path"],
      tagline: "cut the shape you drew",
      description:
        "Cuts the shape you drew into pieces with straight, curved, wave or radial dividers.",
    },
    {
      id: "beam",
      label: "Light beam",
      category: "shader",
      status: READY,
      kind: "effect",
      rendererType: "beam",
      icon: "sun",
      page: "Light beam",
      opening: { on: true },
      supportedInputs: ["rect", "ellipse", "polygon", "path"],
      tagline: "volumetric spectral light",
      description:
        "A spectral emitter that lights the layers beneath it. Drag the ring to move the source.",
    },
    {
      id: "innerLens",
      label: "Inner lens",
      category: "shader",
      status: MIGRATION,
      kind: "effect",
      rendererType: "glass2",
      supportedInputs: SHAPES,
      statusReason: "Requires universal layer input.",
      description: "Magnifies the layer's own contents from within.",
    },
    {
      id: "chromaticVolume",
      label: "Chromatic volume",
      category: "shader",
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
      category: "generator",
      status: EXPERIMENTAL,
      kind: "effect",
      rendererType: "liquid",
      supportedInputs: SHAPES,
      description: "Folded, flowing colour with no visible stops.",
    },
    {
      id: "stripField",
      label: "Gradient bands",
      category: "generator",
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
      category: "effect",
      status: READY,
      kind: "effect",
      rendererType: "shadow",
      icon: "layers",
      page: "Shadow",
      opening: { on: true },
      supportedInputs: ALL_LAYERS,
      description: "Offset, blurred silhouette behind the layer.",
    },
    {
      id: "innerShadow",
      label: "Inner shadow",
      category: "effect",
      status: READY,
      kind: "effect",
      rendererType: "innerShadow",
      icon: "circle-dashed",
      page: "Inner Shadow",
      opening: { on: true, blur: 12, alpha: 0.35 },
      supportedInputs: PAINTABLE_SHAPES,
      description: "Offset, blurred shading clipped inside the layer.",
    },
    {
      id: "glow",
      label: "Glow",
      category: "effect",
      status: READY,
      kind: "effect",
      rendererType: "glow",
      icon: "sparkles",
      page: "Glow",
      opening: { on: true, radius: 18, alpha: 0.7 },
      supportedInputs: ALL_LAYERS,
      description: "Light spreading inward or outward from the edge.",
    },
    {
      id: "bloom",
      label: "Bloom",
      category: "effect",
      status: READY,
      kind: "effect",
      rendererType: "bloom",
      icon: "sun",
      page: "Bloom",
      opening: { amount: 1, radius: 24, threshold: 0.65, knee: 0.25 },
      supportedInputs: ALL_LAYERS,
      description: "Soft light generated from the layer's brightest pixels.",
    },
    {
      id: "backgroundBlur",
      label: "Background blur",
      category: "effect",
      status: READY,
      kind: "effect",
      rendererType: "backgroundBlur",
      icon: "layers",
      page: "Background Blur",
      opening: { on: true, radius: 20, opacity: 1 },
      supportedInputs: SHAPES,
      description: "Softens layers behind the selected shape without blurring the shape itself.",
    },
    {
      id: "colorAdjust",
      label: "Color adjustments",
      category: "filter",
      status: READY,
      kind: "effect",
      rendererType: "colorAdjust",
      icon: "sliders",
      page: "Color Adjustments",
      opening: {
        exposure: 0,
        blackPoint: 0,
        whitePoint: 1,
        brightness: 0.1,
        contrast: 0,
        brilliance: 0,
        gamma: 1,
        saturation: 0,
        vibrance: 0,
        temperature: 0,
        tint: 0,
        highlights: 0,
        shadows: 0,
        filterAmount: 0,
        definition: 0,
      },
      supportedInputs: ALL_LAYERS,
      description:
        "Exposure, brightness, contrast, saturation, vibrance, highlights, and shadows in one reusable pass.",
    },
    {
      id: "colorMap",
      label: "Color mapping",
      category: "filter",
      status: READY,
      kind: "effect",
      rendererType: "colorMap",
      icon: "palette",
      page: "Color Mapping",
      opening: { mode: "gradientMap", shadow: "#1b103d", highlight: "#ffdc7a", amount: 1 },
      supportedInputs: ALL_LAYERS,
      description: "Gradient Map, Duotone, and Color Overlay in one reusable colour filter.",
    },
    {
      id: "channelFx",
      label: "Channel effects",
      category: "filter",
      status: READY,
      kind: "effect",
      rendererType: "channelFx",
      icon: "shuffle",
      page: "Channel Effects",
      opening: { mode: "rgbSplit", amount: 12, angle: 0, mix: 1 },
      supportedInputs: ALL_LAYERS,
      description:
        "RGB Split, Chromatic Aberration, and per-channel offsets in one reusable sampler.",
    },
    {
      id: "stylize",
      label: "Stylize",
      category: "filter",
      status: READY,
      kind: "effect",
      rendererType: "stylize",
      icon: "wand-sparkles",
      page: "Stylize",
      opening: { mode: "posterize", levels: 6, mix: 1 },
      supportedInputs: ALL_LAYERS,
      description: "Posterize, Threshold, Halftone, and Pixelate in one reusable stylize filter.",
    },
    {
      id: "blur",
      label: "Blur",
      category: "effect",
      status: READY,
      kind: "effect",
      rendererType: "blur",
      icon: "circle-dashed",
      page: "Blur",
      opening: { kind: "gaussian", radius: 10 },
      supportedInputs: ALL_LAYERS,
      description: "Gaussian, directional or zoom softening.",
    },
    {
      id: "grain",
      label: "Grain",
      category: "effect",
      status: READY,
      kind: "effect",
      rendererType: "grain",
      icon: "grid",
      page: "Grain",
      opening: { amount: 0.35 },
      supportedInputs: SHAPES.concat("image"),
      description: "Fine overlay texture, composited as light.",
    },
    {
      id: "noise",
      label: "Noise",
      category: "effect",
      status: READY,
      kind: "effect",
      rendererType: "noise",
      icon: "shuffle",
      page: "Noise",
      opening: { amount: 0.3 },
      supportedInputs: ALL_LAYERS,
      description: "Seeded per-pixel grain, monochrome or colour.",
    },
    {
      id: "distortion",
      label: "Distortion",
      category: "effect",
      status: READY,
      kind: "effect",
      rendererType: "distortion",
      icon: "waves",
      page: "Distortion",
      opening: { mode: "wave", amount: 24, wavelength: 0.2, phase: 0, axis: "x" },
      supportedInputs: ALL_LAYERS,
      description: "Wave, Twirl, Bulge/Pinch, and Ripple in one reusable distortion effect.",
    },
    {
      id: "warp",
      label: "Warp",
      category: "effect",
      status: READY,
      kind: "effect",
      rendererType: "warp",
      icon: "move",
      page: "Warp",
      opening: { envelope: "arc", strength: 24, axis: "horizontal" },
      supportedInputs: ALL_LAYERS,
      description: "Editable Arc, Arch, Bulge, Flag, Wave, and Fisheye envelope warps.",
    },
    {
      id: "displacement",
      label: "Displacement",
      category: "effect",
      status: READY,
      kind: "effect",
      rendererType: "displacement",
      icon: "scan",
      page: "Displacement",
      opening: { scaleX: 28, scaleY: 18, mapScale: 1, seed: 1 },
      supportedInputs: ALL_LAYERS,
      description: "Seeded procedural displacement with independent horizontal and vertical scale.",
    },
    {
      id: "chromaticDispersion",
      label: "Chromatic dispersion",
      category: "filter",
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
      category: "generator",
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
      category: "generator",
      status: READY,
      /* Not an effect: nothing is composited over the layer. Like the
       * repeater it changes how MANY of the layer there are, so it is set on
       * the layer itself and read by the one instancing seam. */
      kind: "structure",
      rendererType: null,
      icon: "shuffle",
      page: "Symmetry",
      supportedInputs: SHAPES.concat("image"),
      description: "Mirrors or turns the layer into a figure of live copies.",
      tagline: "mirror and radial repeat",
    },
    {
      id: "echo",
      label: "Echo",
      category: "generator",
      status: READY,
      /* Not an effect: nothing is composited over the layer. Like the repeater
       * and symmetry it changes how MANY of the layer there are, so it is set
       * on the layer and read by the one instancing seam. */
      kind: "structure",
      rendererType: null,
      icon: "duplicate",
      page: "Echo",
      supportedInputs: SHAPES.concat("image"),
      description: "A receding stack of copies, each narrower, flatter and turned a little more.",
      tagline: "copies going away",
    },
    {
      id: "mask",
      label: "Mask",
      category: "composition",
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
    { id: "effect", label: "Effects" },
    { id: "filter", label: "Filters" },
    { id: "shader", label: "Shaders" },
    { id: "generator", label: "Generators" },
    { id: "composition", label: "Composition" },
  ];

  /* Old names that must keep resolving. These were demo compositions or
   * earlier spellings; documents saved with them still load, and a search for
   * the old name still finds the capability it became. */
  const ALIASES = Object.freeze({
    capsule: "glass",
    glassobject: "glass",
    glassObject: "glass",
    strip: "glass",
    backdropGlass: "glass",
    reededGlass: "glass",
    glass3d: "glass",
    glass2: "innerLens",
    pattern: "repeater",
    echoes: "repeater",
    repeatTransform: "repeater",
    prism: "chromaticVolume",
    liquid: "liquidGradient",
    blob: "stripField",
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
    const legacyFor = (id) => Object.keys(ALIASES).filter((k) => ALIASES[k] === id);
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

  /* ---- what the catalog now also carries ------------------------------
   * Until 23 Sep 2026 an effect had to be declared on eight surfaces: the
   * stack registry, its order list, its READY gate, this catalog, the Effects
   * menu written by hand in index.html, and three maps in app.js — which icon,
   * which inspector page, which values it opens with. Every one of them was
   * edited by hand, and they drifted: iridescence was ordered and never
   * ready, glass was ready and never in the menu. The menu, the gate and the
   * three maps are now DERIVED from the entries above. Adding an effect is
   * its renderer, one stack-registry entry (slot, order), and one entry here. */

  /* The Effects menu, in the order the entries above are written: groups
   * that have something ready to offer, nothing hidden and nothing empty. */
  const MENU_GROUPS = [
    { label: "Fills", categories: ["fill", "shader"] },
    { label: "Effects", categories: ["effect"] },
    { label: "Structure", categories: ["generator"] },
    { label: "Filters", categories: ["filter"] },
  ];
  function menu() {
    return MENU_GROUPS.map((g) => ({
      label: g.label,
      items: CATALOG.filter(
        (e) => !e.hidden && g.categories.includes(e.category) && status(e.id) === READY,
      ),
    })).filter((g) => g.items.length);
  }

  /** The values an engine opens with when it is added, by renderer type. A
   *  copy, so a caller cannot edit the catalog through it. */
  function opening(type) {
    const e = CATALOG.find((x) => x.rendererType === type && x.opening);
    return e ? Object.assign({}, e.opening) : null;
  }

  /* THE GATE IS DERIVED. FxStack.READY starts empty; every entry here whose
   * status is ready and which names a renderer promotes that renderer, and
   * the stack's own FX_ONLY narrowing still applies inside promote(). One
   * record of "this one is finished", and it is the status field above. */
  const FS0 = typeof window !== "undefined" && window.FxStack;
  if (FS0 && typeof FS0.promote === "function")
    CATALOG.forEach((e) => {
      if (e.rendererType && e.status === READY) FS0.promote(e.rendererType);
    });

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
    MENU_GROUPS,
    menu,
    opening,
  });
})();
