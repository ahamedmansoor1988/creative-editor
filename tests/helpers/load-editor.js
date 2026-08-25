/**
 * Boots public/app.js inside jsdom so the real editor code can be
 * characterized without a browser.
 *
 * app.js is a browser-only IIFE that grabs DOM nodes and a 2D canvas context at
 * load time. jsdom supplies the DOM but has no canvas implementation, so we
 * install a recording stub for getContext(). The stub is intentionally dumb —
 * these tests characterize DOCUMENT and HISTORY behaviour, not pixels. Real
 * rendering is verified in the browser instead.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..");

/** A 2D context stub that swallows every draw call and records the calls. */
/** A gradient that remembers the stops added to it. */
function makeGradientStub(kind, args, ctx) {
  const g = {
    kind,
    args,
    stops: [],
    addColorStop(pos, color) {
      g.stops.push({ pos, color });
    },
  };
  ctx.gradients.push(g);
  ctx.lastGradient = g;
  return g;
}

/** The context properties app.js sets and therefore the ones save/restore
 *  must unwind. Anything outside this list is not modelled. */
const STATE_KEYS = [
  "fillStyle",
  "strokeStyle",
  "lineWidth",
  "font",
  "globalAlpha",
  "globalCompositeOperation",
  "shadowColor",
  "shadowBlur",
  "shadowOffsetX",
  "shadowOffsetY",
  "textBaseline",
  "textAlign",
];

export function makeCtxStub() {
  const calls = [];
  const stack = [];
  /** Every gradient built this session, newest last. */
  const gradients = [];
  const noop =
    (name) =>
    (...args) => {
      calls.push({ name, args });
    };
  const ctx = {
    calls,
    gradients,
    lastGradient: null,
    canvas: null,
    // state
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    shadowColor: "",
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    textBaseline: "",
    textAlign: "",
    // geometry / drawing
    /* save/restore were no-ops, so canvas state never unwound: whatever an
     * effect set stayed set for every later draw in the frame. That makes any
     * assertion of the form "what state was in force when this was painted?"
     * meaningless — a leftover shadow reads exactly like a configured one.
     * The effect QA pass depends on telling those apart, so the stub now
     * models the state stack for the properties app.js actually sets. */
    save: (...args) => {
      calls.push({ name: "save", args });
      stack.push(STATE_KEYS.map((k) => ctx[k]));
    },
    restore: (...args) => {
      calls.push({ name: "restore", args });
      const prev = stack.pop();
      if (prev) STATE_KEYS.forEach((k, i) => (ctx[k] = prev[i]));
    },
    beginPath: noop("beginPath"),
    closePath: noop("closePath"),
    moveTo: noop("moveTo"),
    lineTo: noop("lineTo"),
    rect: noop("rect"),
    roundRect: noop("roundRect"),
    arc: noop("arc"),
    arcTo: noop("arcTo"),
    ellipse: noop("ellipse"),
    quadraticCurveTo: noop("quadraticCurveTo"),
    bezierCurveTo: noop("bezierCurveTo"),
    fill: noop("fill"),
    stroke: noop("stroke"),
    clip: noop("clip"),
    fillRect: noop("fillRect"),
    strokeRect: noop("strokeRect"),
    clearRect: noop("clearRect"),
    fillText: noop("fillText"),
    setTransform: noop("setTransform"),
    translate: noop("translate"),
    scale: noop("scale"),
    rotate: noop("rotate"),
    drawImage: noop("drawImage"),
    putImageData: noop("putImageData"),
    // Dashed strokes: selection chrome, guides and snap lines all call these.
    // Missing setLineDash surfaced the first time a test rendered a real
    // multi-selection, as a TypeError from deep inside paint().
    setLineDash: noop("setLineDash"),
    getLineDash: () => [],
    // measuring / factories — must return plausible objects, not undefined
    measureText: (t) => ({ width: String(t).length * 8 }),
    /* Gradients used to be black holes: addColorStop discarded everything, so
     * nothing about a ramp could be asserted — which is how `space` sat in the
     * model unimplemented without a test noticing. They record their stops
     * now, and the most recent one is kept on ctx.lastGradient. */
    createLinearGradient: (...args) => makeGradientStub("linear", args, ctx),
    createRadialGradient: (...args) => makeGradientStub("radial", args, ctx),
    createPattern: () => ({}),
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    getImageData: (x, y, w, h) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
  };
  return ctx;
}

/**
 * Load index.html's body + app.js into the current jsdom global.
 * Returns { editor, ctx } where `editor` is app.js's window.__editor hook.
 */
export function loadEditor() {
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (!bodyMatch) throw new Error("could not find <body> in public/index.html");
  // Drop the <script src="app.js"> tag; we evaluate the file ourselves.
  document.body.innerHTML = bodyMatch[1].replace(/<script[\s\S]*?<\/script>/gi, "");

  const ctx = makeCtxStub();

  // jsdom's canvas has no 2D context; hand back the stub instead. Cast is
  // deliberate: the stub implements only the surface app.js actually calls,
  // not the full CanvasRenderingContext2D interface.
  window.HTMLCanvasElement.prototype.getContext = /** @type {any} */ (
    function () {
      ctx.canvas = this;
      return ctx;
    }
  );
  window.HTMLCanvasElement.prototype.toBlob = function (cb) {
    cb(new window.Blob([""], { type: "image/png" }));
  };
  if (!window.URL.createObjectURL) window.URL.createObjectURL = () => "blob:stub";
  if (!window.URL.revokeObjectURL) window.URL.revokeObjectURL = () => {};

  // jsdom implements neither of these, and app.js constructs both at load time.
  // Without them the whole file throws on evaluation and every editor test is
  // reported as a load failure rather than an assertion failure — which is how
  // these two suites sat silently unrun. Dumb on purpose: the tests drive
  // render() directly and never rely on a resize or an animation frame firing.
  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (!window.requestAnimationFrame) {
    window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(Date.now()), 0);
    window.cancelAnimationFrame = (id) => window.clearTimeout(id);
  }

  // render() sizes the canvas from #stage's client box, which is 0 in jsdom.
  // Give it a realistic viewport so the scale maths exercises a real path.
  const stage = document.getElementById("stage");
  Object.defineProperty(stage, "clientWidth", { value: 1200, configurable: true });
  Object.defineProperty(stage, "clientHeight", { value: 800, configurable: true });

  /* app.js is not self-contained: it reads window.FxStack for the effect
   * stack, window.EditHistory for undo, window.Components for instances and
   * layout, window.SnapEngine for snapping, window.Filters for the pixel slot
   * and window.Icons for panel markup. Loading app.js alone exercised every
   * "if the module is missing" fallback instead of the real code paths.
   *
   * The WebGL engines and clipper2.mjs are deliberately NOT loaded: the first
   * need a GPU context jsdom cannot provide, the second is an ES module that
   * window.eval cannot take. Both are already guarded by available() checks,
   * so their absence is a supported state rather than a broken one.
   *
   * gradient.js is the exception among the engines: it is a plain 2D canvas
   * renderer, not WebGL, so it loads here like any other sibling. Its panel
   * reads MAX_STOPS and PRESETS off the engine rather than repeating them, so
   * without it that panel builds its "engine did not load" branch and none of
   * it can be tested. */
  for (const dep of [
    "fxstack.js",
    "history.js",
    "snap.js",
    "components.js",
    "filters.js",
    "icons.js",
    "gradient.js",
    /* meshgradient.js for the same reason as gradient.js, though it IS a WebGL
     * engine: its init() is lazy, so loading the file touches no GPU. What
     * app.js needs from it at normalise time — defaultPoints, the grid limits
     * — is plain JS, and without it every mesh in a document normalises to an
     * empty net. available() still reports false here, which is the branch a
     * machine without WebGL2 takes, so that path gets exercised too. */
    "meshgradient.js",
  ]) {
    window.eval(fs.readFileSync(path.join(ROOT, "public", dep), "utf8"));
  }

  const src = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  // Evaluate in the jsdom global scope so `document`/`window` resolve there.
  window.eval(src);

  if (!window.__editor) throw new Error("app.js did not expose window.__editor");
  return { editor: window.__editor, ctx };
}
