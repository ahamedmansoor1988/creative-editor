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
export function makeCtxStub() {
  const calls = [];
  const noop =
    (name) =>
    (...args) => {
      calls.push({ name, args });
    };
  const ctx = {
    calls,
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
    save: noop("save"),
    restore: noop("restore"),
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
    // measuring / factories — must return plausible objects, not undefined
    measureText: (t) => ({ width: String(t).length * 8 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
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

  // render() sizes the canvas from #stage's client box, which is 0 in jsdom.
  // Give it a realistic viewport so the scale maths exercises a real path.
  const stage = document.getElementById("stage");
  Object.defineProperty(stage, "clientWidth", { value: 1200, configurable: true });
  Object.defineProperty(stage, "clientHeight", { value: 800, configurable: true });

  const src = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  // Evaluate in the jsdom global scope so `document`/`window` resolve there.
  window.eval(src);

  if (!window.__editor) throw new Error("app.js did not expose window.__editor");
  return { editor: window.__editor, ctx };
}
