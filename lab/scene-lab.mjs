/* Scene-mode lab: drives the REAL app in headless Chrome over the DevTools
 * protocol, renders on demand (no animation loop — rAF is dead in a hidden
 * tab), and writes PNGs plus measurements to lab-out/.
 *
 *   npm run lab:scene                        the experiment (server on :8470)
 *   npm run lab:scene:baseline               OFF-mode hashes of three documents
 *   node lab/scene-lab.mjs diff-png a b      where two PNGs differ
 *
 * Env: LAB_APP (default http://localhost:8470/), LAB_CDP_PORT (9333),
 * LAB_TAG (suffix for baseline PNG names), LAB_HASHES (baseline json name).
 *
 * The experiment: one scene — a colourful patterned backdrop and three
 * overlapping glass objects of different thickness — rendered with scene
 * mode OFF and ON at identical framing, ON with the light at left / centre /
 * right, crops where two glass objects overlap, and the optics checks:
 * thickness and IOR change the refraction; the light moves the highlights
 * and the shadows on all three consistently; an object moved behind a glass
 * changes what that glass shows; and OFF renders what the same document
 * rendered before the branch. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import WebSocket from "ws";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.LAB_CDP_PORT || 9333);
const APP = process.env.LAB_APP || "http://localhost:8470/";
const OUT = path.resolve("lab-out");
const MODE = process.argv[2] || "run"; // run | off-hashes | diff-png
const TAG = process.env.LAB_TAG || "";

fs.mkdirSync(OUT, { recursive: true });

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    `--remote-debugging-port=${PORT}`,
    "--window-size=1400,900",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
    `--user-data-dir=${path.join(OUT, ".chrome-profile-" + PORT)}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);
process.on("exit", () => {
  try {
    chrome.kill();
  } catch {
    /* already gone */
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function json(url) {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(url);
      return await r.json();
    } catch {
      /* chrome is not up yet */
    }
    await sleep(200);
  }
  throw new Error("chrome did not answer on " + url);
}

const targets = await json(`http://127.0.0.1:${PORT}/json`);
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl, {
  perMessageDeflate: false,
  maxPayload: 256 * 1024 * 1024,
});
await new Promise((r) => ws.once("open", r));
let id = 0;
const pending = new Map();
ws.on("message", (m) => {
  const j = JSON.parse(m);
  if (j.id && pending.has(j.id)) {
    pending.get(j.id)(j);
    pending.delete(j.id);
  }
});
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, (j) =>
      j.error ? rej(new Error(method + ": " + JSON.stringify(j.error))) : res(j.result),
    );
    ws.send(JSON.stringify({ id: i, method, params }));
  });
/** Evaluate in the page; `await` allowed; the JSON value comes back. */
async function ev(expr) {
  const r = await send("Runtime.evaluate", {
    expression: `(async()=>{ ${expr} })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails)
    throw new Error(
      r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails),
    );
  return r.result.value;
}

await send("Page.enable");
await send("Runtime.enable");
/* Anything the page throws or logs as an error during the run is a finding. */
const pageErrors = [];
ws.on("message", (m) => {
  const j = JSON.parse(m);
  if (j.method === "Runtime.exceptionThrown")
    pageErrors.push(
      j.params.exceptionDetails?.exception?.description ||
        j.params.exceptionDetails?.text ||
        "exception",
    );
  if (j.method === "Runtime.consoleAPICalled" && j.params.type === "error")
    pageErrors.push(j.params.args.map((a) => a.value || a.description).join(" "));
});

/* ---- the scene ---------------------------------------------------------- */
const SCENE = `
  const W = 900, H = 600;
  const tiles = [];
  const cols = ['#ff5a5f', '#ffb400', '#2ec4b6', '#3b6df0', '#9b5de5', '#f15bb5', '#00bbf9', '#fee440'];
  for (let r = 0; r < 6; r++) for (let c = 0; c < 9; c++) {
    tiles.push({ type: (r + c) % 3 === 0 ? 'ellipse' : 'rect', name: 't' + r + c, x: c * 100 + 8, y: r * 100 + 8, w: 84, h: 84, radius: 14, fill: { kind: 'solid', color: cols[(r * 3 + c) % cols.length] } });
  }
  const glass = (name, x, y, w, h, depth, tint, absorption, shape) => ({ type: shape || 'rect', name, x, y, w, h, radius: 40, fill: { kind: 'solid', color: '#ffffff' }, fillOpacity: 0,
    effects: { glass: Object.assign({}, E.DEFAULT_EFFECTS().glass, { on: true, mode: 'backdrop', depth, tint, absorption, ior: 1.52, refraction: 60, edgeIntensity: 70 }),
               shadow: { on: true, x: 6, y: 10, blur: 18, alpha: 0.35, color: '#000000' } } });
  const A = glass('glass thin', 120, 120, 340, 300, 40, '#ffffff', 0.08);
  const B = glass('glass mid', 330, 200, 360, 300, 90, '#ffb3b3', 0.25, 'ellipse');
  const C = glass('glass thick', 500, 90, 300, 360, 150, '#b3d1ff', 0.45);
  return { frame: { name: 'scene', w: W, h: H, bg: '#f4f4f6', children: tiles.concat([A, B, C]), scene: { on: ON, light: { x: LX, y: LY } } } };
`;
const setScene = (on, lx, ly, extra = "") =>
  ev(
    `const E = window.__editor; const ON = ${on}, LX = ${lx}, LY = ${ly}; const d = (function(){ ${SCENE} })(); ${extra} E.doc = d; return E.doc.frame.scene;`,
  );
const png = async (name, url) => {
  fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(url.split(",")[1], "base64"));
  return createHash("sha1").update(url).digest("hex").slice(0, 12);
};
const capture = async (name) =>
  png(
    name,
    await ev("const cv = window.__editor.renderFrameCanvas(); return cv.toDataURL('image/png');"),
  );
const crop = async (name, x, y, w, h, scale) =>
  png(
    name,
    await ev(
      `const cv = window.__editor.renderFrameCanvas(); const o = document.createElement('canvas'); o.width = ${w * scale}; o.height = ${h * scale}; const g = o.getContext('2d'); g.imageSmoothingEnabled = false; g.drawImage(cv, ${x}, ${y}, ${w}, ${h}, 0, 0, ${w * scale}, ${h * scale}); return o.toDataURL('image/png');`,
    ),
  );
/** Keep the current render's pixels under a name, for diffs. */
const keep = (name) =>
  ev(
    `const cv = window.__editor.renderFrameCanvas(); window.__lab_${name} = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height); return true;`,
  );
/** Mean absolute channel difference between two kept renders inside a box. */
const diff = (a, b, x, y, w, h) =>
  ev(
    `const A = window.__lab_${a}, B = window.__lab_${b}; let s = 0, n = 0; for (let j = ${y}; j < ${y + h}; j++) for (let i = ${x}; i < ${x + w}; i++) { const k = (j * A.width + i) * 4; s += Math.abs(A.data[k] - B.data[k]) + Math.abs(A.data[k + 1] - B.data[k + 1]) + Math.abs(A.data[k + 2] - B.data[k + 2]); n += 3; } return +(s / n).toFixed(2);`,
  );

if (MODE === "diff-png") {
  await send("Page.navigate", { url: "about:blank" });
  await sleep(300);
  const [a, b] = [process.argv[3], process.argv[4]].map(
    (f) => "data:image/png;base64," + fs.readFileSync(path.resolve(f)).toString("base64"),
  );
  const out = await ev(
    `const load = (u) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = u; }); const A = await load(${JSON.stringify(a)}), B = await load(${JSON.stringify(b)}); const w = A.width, h = A.height; const cv = (im) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0); return g.getImageData(0, 0, w, h).data; }; const da = cv(A), db = cv(B); let s = 0, n = 0, changed = 0, x0 = w, y0 = h, x1 = -1, y1 = -1, maxd = 0; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const k = (y * w + x) * 4; const d = Math.abs(da[k] - db[k]) + Math.abs(da[k + 1] - db[k + 1]) + Math.abs(da[k + 2] - db[k + 2]); s += d; n += 3; if (d > 0) { changed++; if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; if (d > maxd) maxd = d; } } return { size: [w, h], meanAbs: +(s / n).toFixed(3), changedPixels: changed, changedShare: +(changed / (w * h)).toFixed(4), box: changed ? [x0, y0, x1 - x0 + 1, y1 - y0 + 1] : null, maxChannelSum: maxd };`,
  );
  console.log(JSON.stringify(out));
  ws.close();
  chrome.kill();
  process.exit(0);
}

await send("Page.navigate", { url: APP });
for (let i = 0; i < 100; i++) {
  const ok = await ev(
    "return !!(window.__editor && window.__editor.renderFrameCanvas && window.GlassEngine && window.GlassEngine.available());",
  );
  if (ok) break;
  await sleep(200);
  if (i === 99) throw new Error("app did not come up, or WebGL2 is unavailable in this Chrome");
}
console.log(
  "engines:",
  JSON.stringify(
    await ev(
      "return { glass: window.GlassEngine.available(), reed: window.ReedGlassEngine && window.ReedGlassEngine.available() };",
    ),
  ),
);

const results = {};
if (MODE === "off-hashes") {
  /* The regression baseline: OFF renders of the scene and of two existing fixtures, hashed. */
  const hashes = {};
  await setScene(false, 450, 60);
  hashes.scene = await capture("baseline-scene-off" + TAG);
  await ev(
    `const E = window.__editor; E.doc = { frame: { name: 'mesh', w: 600, h: 400, bg: '#ffffff', children: [ { type: 'rect', name: 'Field', x: 0, y: 0, w: 600, h: 400, fill: { kind: 'solid', color: '#3b6df0' }, effects: { mesh: { on: true, cols: 2, rows: 2, points: [ { x: 0, y: 0, color: [40, 80, 220] }, { x: 1, y: 0, color: [120, 160, 255] }, { x: 0, y: 1, color: [200, 220, 255] }, { x: 1, y: 1, color: [60, 110, 240] } ] } } }, { type: 'rect', name: 'Box', x: 100, y: 80, w: 200, h: 120, fill: { kind: 'solid', color: '#e0341c' }, effects: { shadow: { on: true, x: 8, y: 12, blur: 16, alpha: 0.5, color: '#000000' } } } ] } }; return true;`,
  );
  hashes.meshShadow = await capture("baseline-mesh-shadow" + TAG);
  await ev(
    `const E = window.__editor; const R = E.DEFAULT_EFFECTS().reed; E.doc = { frame: { name: 'reed', w: 600, h: 300, bg: '#ffffff', children: [ { type: 'rect', name: 'bars', x: 0, y: 0, w: 600, h: 300, fill: { kind: 'linear', angle: 0, stops: [ { pos: 0, color: '#ff5a5f' }, { pos: 1, color: '#3b6df0' } ] } }, { type: 'rect', name: 'Reed glass', x: 60, y: 40, w: 480, h: 220, fillOpacity: 0, fill: { kind: 'solid', color: '#ffffff' }, effects: { reed: Object.assign({}, R, { on: true }), shadow: { on: true, x: 4, y: 8, blur: 12, alpha: 0.4, color: '#000000' } } } ] } }; return true;`,
  );
  hashes.reed = await capture("baseline-reed" + TAG);
  fs.writeFileSync(
    path.join(OUT, process.env.LAB_HASHES || "off-hashes.json"),
    JSON.stringify(hashes, null, 2),
  );
  console.log("off hashes:", JSON.stringify(hashes));
} else {
  /* 1. ON vs OFF, identical framing, light centre-top */
  await setScene(false, 450, 60);
  results.offHash = await capture("scene-off");
  await keep("off");
  await setScene(true, 450, 60);
  results.onHash = await capture("scene-on");
  await keep("on");
  results.onVsOff = {
    whole: await diff("off", "on", 0, 0, 900, 600),
    overlapBC: await diff("off", "on", 500, 200, 190, 160),
  };
  /* 2. the light at left / centre / right, ON. Then the test that matters:
   * between light-left and light-right, does each glass's lit third move
   * the same way, and does each shadow move to the other side? */
  const lights = { left: [80, 60], centre: [450, 60], right: [820, 60] };
  for (const [k, [lx, ly]] of Object.entries(lights)) {
    await setScene(true, lx, ly);
    await capture("scene-on-light-" + k);
    await keep("light_" + k);
  }
  const thirds = (a, b, x, y, w, h) =>
    ev(
      `const A = window.__lab_${a}, B = window.__lab_${b}; const t = Math.floor(${w} / 3); const m = (D, X) => { let s = 0, n = 0; for (let j = ${y}; j < ${y + h}; j++) for (let i = X; i < X + t; i++) { const k = (j * D.width + i) * 4; s += D.data[k] + D.data[k + 1] + D.data[k + 2]; n += 3; } return s / n; }; return { leftThird: +(m(B, ${x}) - m(A, ${x})).toFixed(2), rightThird: +(m(B, ${x} + 2 * t) - m(A, ${x} + 2 * t)).toFixed(2) };`,
    );
  const strips = (a, b, x, y, w, h) =>
    ev(
      `const A = window.__lab_${a}, B = window.__lab_${b}; const m = (D, X) => { let s = 0, n = 0; for (let j = ${y} + Math.floor(${h} * 0.3); j < ${y} + Math.floor(${h} * 0.7); j++) for (let i = X; i < X + 24; i++) { const k = (j * D.width + i) * 4; s += D.data[k] + D.data[k + 1] + D.data[k + 2]; n += 3; } return s / n; }; return { leftStrip: +(m(B, ${x} - 28) - m(A, ${x} - 28)).toFixed(2), rightStrip: +(m(B, ${x + w} + 4) - m(A, ${x + w} + 4)).toFixed(2) };`,
    );
  results.lightRightMinusLeft = {
    litThirds: {
      A: await thirds("light_left", "light_right", 120, 120, 340, 300),
      B: await thirds("light_left", "light_right", 330, 200, 360, 300),
      C: await thirds("light_left", "light_right", 500, 90, 300, 360),
    },
    shadowStrips: {
      A: await strips("light_left", "light_right", 120, 120, 340, 300),
      C: await strips("light_left", "light_right", 500, 90, 300, 360),
    },
    wholeFrame: await diff("light_left", "light_right", 0, 0, 900, 600),
  };
  /* 3. the overlap of B and C, close */
  await setScene(true, 450, 60);
  await crop("overlap-BC-on", 500, 200, 190, 160, 4);
  await setScene(false, 450, 60);
  await crop("overlap-BC-off", 500, 200, 190, 160, 4);
  /* 4. optics: thickness and IOR change the refraction — measured in B's interior, ON and OFF */
  await setScene(true, 450, 60);
  await keep("base");
  await setScene(
    true,
    450,
    60,
    "d.frame.children.find(c => c.name === 'glass mid').effects.glass.depth = 20;",
  );
  await keep("thin");
  await setScene(
    true,
    450,
    60,
    "d.frame.children.find(c => c.name === 'glass mid').effects.glass.ior = 2.0;",
  );
  await keep("ior2");
  await setScene(
    true,
    450,
    60,
    "d.frame.children.find(c => c.name === 'glass mid').effects.glass.ior = 1.0;",
  );
  await keep("ior1");
  const iorStored = await ev(
    "return window.__editor.doc.frame.children.find(c => c.name === 'glass mid').effects.glass.ior;",
  );
  await setScene(false, 450, 60);
  await keep("baseOff");
  await setScene(
    false,
    450,
    60,
    "d.frame.children.find(c => c.name === 'glass mid').effects.glass.depth = 20;",
  );
  await keep("thinOff");
  const edge = [330, 300, 70, 100]; // B's left bevel band: where this engine displaces
  results.optics = {
    interior: {
      depth90vs20: await diff("base", "thin", 420, 260, 180, 180),
      ior152vs200: await diff("base", "ior2", 420, 260, 180, 180),
      ior152vs100: await diff("base", "ior1", 420, 260, 180, 180),
    },
    edgeBand: {
      depth90vs20: await diff("base", "thin", ...edge),
      ior152vs200: await diff("base", "ior2", ...edge),
      ior152vs100: await diff("base", "ior1", ...edge),
    },
    iorStoredFor1: iorStored,
    depthLeavesTilesAlone: await diff("base", "thin", 0, 500, 900, 100),
    OFF: {
      interior_depth90vs20: await diff("baseOff", "thinOff", 420, 260, 180, 180),
      edgeBand_depth90vs20: await diff("baseOff", "thinOff", ...edge),
    },
  };
  /* 5. an object moved behind glass A changes what A shows — its footprint, the rest of A, and a far corner as control */
  const mover = (x, y) =>
    `d.frame.children.unshift({ type: 'rect', name: 'mover', x: ${x}, y: ${y}, w: 120, h: 60, fill: { kind: 'solid', color: '#000000' } });`;
  await setScene(true, 450, 60, mover(700, 480));
  await keep("moverOut");
  await setScene(true, 450, 60, mover(200, 220));
  await keep("moverIn");
  await setScene(false, 450, 60, mover(700, 480));
  await keep("moverOutOff");
  await setScene(false, 450, 60, mover(200, 220));
  await keep("moverInOff");
  results.behindGlass = {
    footprintUnderA: await diff("moverOut", "moverIn", 200, 220, 120, 60),
    restOfA: await diff("moverOut", "moverIn", 120, 300, 340, 120),
    farCorner: await diff("moverOut", "moverIn", 700, 480, 120, 60),
    footprintUnderA_OFF: await diff("moverOutOff", "moverInOff", 200, 220, 120, 60),
  };
  results.pageErrors = pageErrors;
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
}
ws.close();
chrome.kill();
process.exit(0);
