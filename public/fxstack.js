/* Non-destructive effect stack (§5.15, §6.13).
 *
 * The governing patent — Microsoft US 7,554,550, "Non-destructive editing of
 * digital images" — EXPIRED 29 Nov 2025, which is why §5.15 says to build the
 * full effect graph rather than a limited approximation.
 *
 * WHAT CHANGED. Effects used to be a fixed dictionary on each object, applied
 * in an order hard-coded in the renderer. They are now an ORDERED ARRAY:
 *
 *     obj.fx = [{ id, type, on, params }, ...]        // bottom of stack first
 *
 * The old `obj.effects` dictionary is kept as a LIVE ALIAS of the first entry
 * of each type, so all twelve engines, their panels and the AI capability
 * registry keep working untouched. That also means a document written before
 * this session loads unchanged: normalizeDoc builds the array from the
 * dictionary in exactly the order the renderer used to apply them, so nothing
 * moves on screen.
 *
 * SLOTS. An effect declares where it composites, and the stack order is
 * honoured WITHIN each slot:
 *   behind   — painted under the object (drop shadow, outer glow)
 *   material — replaces the object's own fill (glass, prism, light, …)
 *   over     — painted on top (inner shadow, inner glow, grain, stripes)
 * Only one material can win; the TOPMOST enabled one does, and the panel says
 * so rather than silently ignoring the others.
 *
 * Stacking the same type more than once now works, which is where §4.9's
 * "multiple stacked shadows" comes from for free.
 *
 * CACHING. Each stack index records the signature of everything up to and
 * including it. Editing entry i reuses the cached layer from i-1 and re-runs
 * only i onward — "invalidating only downstream of a change", per the spec.
 * Backdrop-reading materials (glass, prism, capsule, strip) are excluded from
 * the cache because their input is the page beneath them, not the object.
 */
(function () {
  "use strict";

  /* type -> how it behaves. `defaults` is only used when adding from the UI;
   * existing objects carry their own params. */
  const REG = {
    shadow: { slot: "behind", label: "Drop shadow", multi: true },
    glow: { slot: "behind", label: "Glow", multi: true, dual: "type" },
    gradient: { slot: "over", label: "Gradient stripe", multi: false },
    innerShadow: { slot: "over", label: "Inner shadow", multi: true },
    grain: { slot: "over", label: "Grain", multi: false },
    light: { slot: "material", label: "Light", multi: false },
    liquid: { slot: "material", label: "Liquid gradient", multi: false },
    flare: { slot: "material", label: "Prism flare", multi: false },
    glass3d: { slot: "material", label: "Glass 3D", multi: false },
    prism: { slot: "material", label: "Prism", multi: false, backdrop: true },
    capsule: { slot: "material", label: "Capsule", multi: false, backdrop: true },
    strip: { slot: "material", label: "Strip", multi: false, backdrop: true },
    blob: { slot: "material", label: "Blob", multi: false },
    glass2: { slot: "material", label: "Glass 2", multi: false },
    glass: { slot: "material", label: "Glass", multi: false, backdrop: true },
    /* §4.8/§4.12/§5.5/§5.6/§5.10–5.12 — the PIXEL slot. These read the object's
     * rendered pixels, so they run last, over the composited result of the
     * material and the over-slot filters. Order among them matters a great deal
     * (blur-then-warp is not warp-then-blur), which is exactly what the stack
     * is for. */
    blur: { slot: "pixel", label: "Blur", multi: true },
    distortion: { slot: "pixel", label: "Distortion", multi: true },
    warp: { slot: "pixel", label: "Warp", multi: true },
    displacement: { slot: "pixel", label: "Displacement", multi: true },
    haze: { slot: "pixel", label: "Fractal haze", multi: false },
    slice: { slot: "pixel", label: "Slice", multi: false },
    noise: { slot: "pixel", label: "Noise", multi: false },
  };

  /* The order the renderer used BEFORE the stack existed. Migration lays the
   * array out in exactly this order so no existing document shifts. */
  const LEGACY_ORDER = [
    "shadow",
    "glow",
    "blob",
    "glass2",
    "light",
    "liquid",
    "flare",
    "glass3d",
    "prism",
    "capsule",
    "strip",
    "glass",
    "gradient",
    "innerShadow",
    "grain",
    "blur",
    "distortion",
    "warp",
    "displacement",
    "haze",
    "slice",
    "noise",
  ];

  function meta(type) {
    return REG[type] || null;
  }
  function slotOf(type) {
    const m = REG[type];
    return m ? m.slot : "over";
  }
  function isBackdrop(type) {
    const m = REG[type];
    return !!(m && m.backdrop);
  }
  function label(type) {
    const m = REG[type];
    return m ? m.label : type;
  }
  function types() {
    return Object.keys(REG);
  }

  /** Is this entry actually doing something? Used for the active dot and to
   *  decide whether it participates in the signature. */
  function entryOn(e) {
    if (!e || e.on === false) return false; // stack entry switched off
    const p = e.params || {};
    if (e.type === "grain" || e.type === "noise") return (p.amount || 0) > 0;
    if (e.type === "blur") return (p.radius || 0) > 0 || p.kind === "zoom";
    if (e.type === "distortion") return (p.amount || 0) !== 0;
    if (e.type === "warp") return (p.strength || 0) !== 0;
    if (e.type === "displacement") return (p.scaleX || 0) !== 0 || (p.scaleY || 0) !== 0;
    if (e.type === "haze") return (p.density || 0) > 0;
    if (e.type === "slice") return (p.count || 0) > 1 && (p.offset || 0) !== 0;
    // An explicit boolean wins; anything without one is on by default.
    // (Writing this as a chained ternary inverts on `p.on === false` — it
    // falls to the default branch and reports the effect as ENABLED.)
    if (typeof p.on === "boolean") return p.on;
    return true;
  }

  /** Ordered entries for one slot, bottom of stack first. */
  function inSlot(fx, slot) {
    return (fx || []).filter((e) => slotOf(e.type) === slot && entryOn(e));
  }
  /** The material that wins: the TOPMOST enabled one. */
  function activeMaterial(fx) {
    const m = inSlot(fx, "material");
    return m.length ? m[m.length - 1] : null;
  }
  /** Every enabled material beyond the winner — the panel warns about these. */
  function shadowedMaterials(fx) {
    const m = inSlot(fx, "material");
    return m.slice(0, -1);
  }

  /* ---- signatures / caching ------------------------------------------- */
  function entrySig(e) {
    return e.type + ":" + (e.on === false ? 0 : 1) + ":" + JSON.stringify(e.params || {});
  }
  /** Cumulative signature up to and including index i. */
  function prefixSig(fx, i, base) {
    let s = base || "";
    for (let k = 0; k <= i; k++) s += "|" + entrySig(fx[k]);
    return s;
  }
  /** Longest cached prefix still valid for this stack. Returns the index of the
   *  last VALID cached step, or -1 if everything downstream must re-run. */
  function validPrefix(cache, fx, base) {
    if (!cache || !cache.length) return -1;
    let s = base || "";
    let last = -1;
    for (let i = 0; i < fx.length && i < cache.length; i++) {
      s += "|" + entrySig(fx[i]);
      if (cache[i] && cache[i].sig === s) last = i;
      else break;
    }
    return last;
  }

  window.FxStack = {
    REG,
    LEGACY_ORDER,
    meta,
    slotOf,
    isBackdrop,
    label,
    types,
    entryOn,
    inSlot,
    activeMaterial,
    shadowedMaterials,
    entrySig,
    prefixSig,
    validPrefix,
  };
})();
