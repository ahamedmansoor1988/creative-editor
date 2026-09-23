/* QC: scene-mode behaviour on the branch app — toggle + undo, the light drag
 * through real PointerEvents on the canvas, serialisation, and the break-it
 * cases. Every step is recorded as {ok, detail | error}; nothing stops the run.
 *
 *   LAB_CDP_PORT=9337 node lab/qc-scene-behaviour.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { launch } from "./qc-cdp.mjs";

const APP = process.env.LAB_APP || "http://localhost:8470/";
const PORT = Number(process.env.LAB_CDP_PORT || 9337);
const OUT = path.resolve("lab-out/qc");
fs.mkdirSync(OUT, { recursive: true });
const { ev, pageErrors, close } = await launch({ port: PORT, app: APP });
const hashOf = (url) => createHash("sha1").update(url).digest("hex").slice(0, 12);
const capture = async (name) => {
  const url = await ev("return window.__qc.capture();");
  if (name)
    fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(url.split(",")[1], "base64"));
  return hashOf(url);
};
const R = {};
const step = async (name, fn) => {
  const errsBefore = pageErrors.length;
  try {
    const detail = await fn();
    R[name] = { ok: true, detail, newPageErrors: pageErrors.slice(errsBefore) };
  } catch (e) {
    R[name] = {
      ok: false,
      error: String(e.message || e),
      newPageErrors: pageErrors.slice(errsBefore),
    };
  }
  console.log(name, JSON.stringify(R[name]).slice(0, 600));
};

/* Page-side doc builders and pointer helpers. */
await ev(`
  const E = window.__editor;
  const TILES = () => { const t=[]; const cols=['#ff5a5f','#ffb400','#2ec4b6','#3b6df0','#9b5de5','#f15bb5','#00bbf9','#fee440']; for(let r=0;r<6;r++) for(let c=0;c<9;c++) t.push({ type:(r+c)%3===0?'ellipse':'rect', name:'t'+r+c, x:c*100+8, y:r*100+8, w:84, h:84, radius:14, fill:{kind:'solid',color:cols[(r*3+c)%cols.length]} }); return t; };
  const SH = () => ({on:true,x:8,y:12,blur:20,spread:2,alpha:0.45,color:'#000000'});
  const glass = (name, x, y, w, h, extra, shape) => Object.assign({ type: shape || 'rect', name, x, y, w, h, radius: 40, fill:{kind:'solid',color:'#ffffff'}, fillOpacity:0, effects:{ glass:Object.assign({}, E.DEFAULT_EFFECTS().glass, {on:true, mode:'backdrop', depth:90, tint:'#ffb3b3', absorption:0.25, ior:1.52, refraction:60}), shadow: SH() } }, extra || {});
  window.__qcDocs = {
    shadowRect(scene) { return { frame:{ name:'F', w:900, h:600, bg:'#ffffff', scene, children:[ { type:'rect', name:'a', x:600, y:300, w:100, h:100, fill:{kind:'solid',color:'#ff0000'}, effects:{ shadow: SH() } }, { type:'rect', name:'b', x:200, y:300, w:100, h:100, fill:{kind:'solid',color:'#00ff00'} } ] } }; },
    glassScene(scene, extraObj) { return { frame:{ name:'G', w:900, h:600, bg:'#f4f4f6', scene, children: TILES().concat([ glass('A', 150, 120, 400, 300, extraObj) ]) } }; },
    empty(scene) { return { frame:{ name:'E', w:600, h:400, bg:'#ffffff', scene, children:[] } }; },
    textOnly(scene) { return { frame:{ name:'T', w:800, h:400, bg:'#fafafa', scene, children:[ { type:'text', name:'T1', x:60, y:100, text:'Text only, scene on', size:64, weight:700, color:'#111111', align:'left', mode:'point', lineHeight:1.2, tracking:0, valign:'top', autosize:'fixed', caseTf:'none', opacity:1, effects:{ shadow: SH() } } ] } }; },
  };
  const cv = document.getElementById('out');
  const pe = (type, cx, cy, extra) => cv.dispatchEvent(new PointerEvent(type, Object.assign({ clientX: cx, clientY: cy, pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1 }, extra || {})));
  window.__qcPtr = {
    rect() { const r = cv.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height, bw: cv.width, bh: cv.height }; },
    /** screen (canvas-relative) position of a page point under the current view */
    screenOf(p) { const v = E.view; return { x: p.x * v.z + v.x, y: p.y * v.z + v.y }; },
    lightScreen() { return this.screenOf(E.sceneLight()); },
    lightClient() { const r = cv.getBoundingClientRect(), s = this.lightScreen(); return { x: r.left + s.x, y: r.top + s.y }; },
    down(cx, cy) { return pe('pointerdown', cx, cy); },
    move(cx, cy, buttons) { return pe('pointermove', cx, cy, { buttons: buttons === undefined ? 1 : buttons }); },
    up(cx, cy) { return pe('pointerup', cx, cy); },
    pixel(sx, sy) { const r = cv.getBoundingClientRect(); const kx = cv.width / r.width, ky = cv.height / r.height; const d = cv.getContext('2d').getImageData(Math.round(sx * kx), Math.round(sy * ky), 1, 1).data; return [d[0], d[1], d[2], d[3]]; },
    paint() { E.showRulers = E.showRulers; },
    setView(z, x, y) { const v = E.view; v.z = z; v.x = x; v.y = y; this.paint(); },
    hist() { return [...document.querySelectorAll('#historyList .histRow .hName')].map(e => e.textContent); },
    menuBtn(cmd) { const b = document.querySelector('.dropdown button[data-cmd="' + cmd + '"]'); return b ? { exists: true, dataCheck: b.dataset.check || null, checked: b.classList.contains('checked'), aria: b.getAttribute('aria-checked'), text: b.textContent.trim() } : { exists: false }; },
    undo() { const b = document.querySelector('.dropdown button[data-cmd="undo"]'); if (b) b.click(); },
    redo() { const b = document.querySelector('.dropdown button[data-cmd="redo"]'); if (b) b.click(); },
    key(k, extra) { document.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, extra || {}))); },
  };
  return true;
`);

/* ---- 3. toggle / undo / View menu ---------------------------------------- */
await step("toggle", async () => {
  await ev("window.__editor.doc = window.__qcDocs.shadowRect(undefined); return true;");
  const before = await ev("return window.__editor.doc.frame.scene;");
  const hOff = await capture("t-off");
  const btnBefore = await ev("return window.__qcPtr.menuBtn('toggleScene');");
  await ev("window.__editor.toggleScene(); return true;");
  const afterOn = await ev("return window.__editor.doc.frame.scene;");
  const hOn = await capture("t-on");
  const btnOn = await ev("return window.__qcPtr.menuBtn('toggleScene');");
  const histOn = await ev("return window.__qcPtr.hist();");
  await ev("window.__qcPtr.undo(); return true;");
  let afterUndo = await ev("return window.__editor.doc.frame.scene;");
  let undoVia = "menu button";
  if (afterUndo.on) {
    await ev("window.__qcPtr.key('z', { metaKey: true }); return true;");
    afterUndo = await ev("return window.__editor.doc.frame.scene;");
    undoVia = "cmd+z keydown";
  }
  const hUndo = await capture("t-undo");
  const btnUndo = await ev("return window.__qcPtr.menuBtn('toggleScene');");
  await ev("window.__qcPtr.redo(); return true;");
  let afterRedo = await ev("return window.__editor.doc.frame.scene;");
  if (!afterRedo.on) {
    await ev("window.__qcPtr.key('z', { metaKey: true, shiftKey: true }); return true;");
    afterRedo = await ev("return window.__editor.doc.frame.scene;");
  }
  const hRedo = await capture(null);
  return {
    before,
    btnBefore,
    afterOn,
    btnOn,
    histOn,
    undoVia,
    afterUndo,
    btnUndo,
    afterRedo,
    hashes: { off: hOff, on: hOn, undo: hUndo, redo: hRedo },
    undoRestoresRender: hUndo === hOff,
    redoRestoresRender: hRedo === hOn,
    onDiffersFromOff: hOn !== hOff,
  };
});

/* ---- 4. the light drag ---------------------------------------------------- */
await step("lightDrag", async () => {
  await ev(
    "window.__editor.doc = window.__qcDocs.glassScene({on:true, light:{x:300,y:200}}); window.__qcPtr.setView(1, 100, 80); return true;",
  );
  const L0 = await ev("return window.__editor.sceneLight();");
  const s = await ev("return window.__qcPtr.lightScreen();");
  const px = await ev(`return window.__qcPtr.pixel(${s.x}, ${s.y});`);
  const c = await ev("return window.__qcPtr.lightClient();");
  const histBefore = await ev("return window.__qcPtr.hist();");
  await ev(`window.__qcPtr.down(${c.x}, ${c.y}); return true;`);
  await ev(`window.__qcPtr.move(${c.x + 50}, ${c.y + 30}); return true;`);
  const during = await ev("return window.__editor.doc.frame.scene.light;");
  await ev(`window.__qcPtr.up(${c.x + 50}, ${c.y + 30}); return true;`);
  const after = await ev("return window.__editor.doc.frame.scene.light;");
  const histAfter = await ev("return window.__qcPtr.hist();");
  await ev(`window.__qcPtr.move(${c.x + 150}, ${c.y + 150}, 0); return true;`);
  const afterHover = await ev("return window.__editor.doc.frame.scene.light;");
  await ev("window.__qcPtr.undo(); return true;");
  const afterUndo = await ev("return window.__editor.doc.frame.scene.light;");
  return {
    L0,
    lightScreen: s,
    sunPixelAtLight: px,
    during,
    after,
    moved: after.x === L0.x + 50 && after.y === L0.y + 30,
    histBefore: histBefore.length,
    histAfter: histAfter.slice(-3),
    pushed: histAfter.includes("Move light") && histAfter.length === histBefore.length + 1,
    afterHover,
    dragEnded: afterHover.x === after.x && afterHover.y === after.y,
    afterUndo,
    undoRestores: afterUndo.x === L0.x && afterUndo.y === L0.y,
  };
});

/* ---- 5. serialisation ----------------------------------------------------- */
await step("serialise", async () => {
  await ev(
    "window.__editor.doc = window.__qcDocs.glassScene({on:true, light:{x:333,y:44}}); return true;",
  );
  const text = await ev("return window.__editor.serializeDocument();");
  const j = JSON.parse(text);
  const inText = (j.pages && j.pages[0] && j.pages[0].frame && j.pages[0].frame.scene) || null;
  await ev("window.__editor.doc = window.__qcDocs.shadowRect(undefined); return true;");
  const cleared = await ev("return window.__editor.doc.frame.scene;");
  await ev(
    `window.__editor.loadDocumentFromText(${JSON.stringify(text)}, 'qc', true); return true;`,
  );
  const reloaded = await ev("return window.__editor.doc.frame.scene;");
  const sceneOn = await ev("return window.__editor.sceneOn();");
  /* autosave round trip */
  await ev(
    "window.__editor.doc = window.__qcDocs.glassScene({on:true, light:{x:-77,y:512}}); window.__editor.autosaveNow(); window.__editor.doc = window.__qcDocs.shadowRect(undefined); return true;",
  );
  const restored = await ev("return window.__editor.restoreAutosave();");
  const afterRestore = await ev("return window.__editor.doc.frame.scene;");
  return {
    inText,
    cleared,
    reloaded,
    sceneOn,
    restored,
    afterRestore,
    fileRoundTrip:
      JSON.stringify(reloaded) === JSON.stringify({ on: true, light: { x: 333, y: 44 } }),
    autosaveRoundTrip:
      JSON.stringify(afterRestore) === JSON.stringify({ on: true, light: { x: -77, y: 512 } }),
  };
});

/* ---- 8. break it ---------------------------------------------------------- */
await step("emptyDocOn", async () => {
  await ev(
    "window.__editor.doc = window.__qcDocs.empty({on:true, light:{x:100,y:50}}); window.__qcPtr.setView(1, 100, 80); return true;",
  );
  const h = await capture("b-empty-on");
  const st = await ev("return window.__qc.stats();");
  const s = await ev("return window.__qcPtr.lightScreen();");
  const px = await ev(`return window.__qcPtr.pixel(${s.x}, ${s.y});`);
  await ev("window.__editor.toggleScene(); window.__editor.toggleScene(); return true;");
  return {
    hash: h,
    stats: st,
    sunPixel: px,
    sceneAfterDoubleToggle: await ev("return window.__editor.doc.frame.scene.on;"),
  };
});
await step("textOnlyOn", async () => {
  await ev(
    "window.__editor.doc = window.__qcDocs.textOnly({on:false, light:{x:700,y:40}}); return true;",
  );
  await ev("window.__qc.keep('toff'); return true;");
  const hOff = await capture(null);
  await ev(
    "window.__editor.doc = window.__qcDocs.textOnly({on:true, light:{x:700,y:40}}); return true;",
  );
  await ev("window.__qc.keep('ton'); return true;");
  const hOn = await capture("b-text-on");
  const st = await ev("return window.__qc.stats();");
  const vec = await ev(
    "return window.__editor.sceneShadowVec(window.__editor.doc.frame.children[0]);",
  );
  return {
    hOff,
    hOn,
    differs: hOff !== hOn,
    diff: await ev("return window.__qc.diff('toff','ton');"),
    stats: st,
    textShadowVec: vec,
  };
});
await step("lightFarOff", async () => {
  await ev(
    "window.__editor.doc = window.__qcDocs.glassScene({on:true, light:{x:-5000,y:-5000}}); return true;",
  );
  const h = await capture("b-light-far");
  const st = await ev("return window.__qc.stats();");
  const geo = await ev(
    "const E=window.__editor, o=E.doc.frame.children.find(c=>c.name==='A'); const s=E.sceneLightAt(o); return { light: E.sceneLight(), at: s, vec: E.sceneShadowVec(o), glassAngle: E.sceneGlassAngle(s), reedAngle: E.sceneReedAngle(o, 0) };",
  );
  /* now drag the light far off the page and see whether the stored value is clamped anywhere */
  await ev(
    "window.__editor.doc = window.__qcDocs.glassScene({on:true, light:{x:300,y:200}}); window.__qcPtr.setView(1, 100, 80); return true;",
  );
  const c = await ev("return window.__qcPtr.lightClient();");
  await ev(
    `window.__qcPtr.down(${c.x}, ${c.y}); window.__qcPtr.move(${c.x - 30000}, ${c.y - 30000}); window.__qcPtr.up(${c.x - 30000}, ${c.y - 30000}); return true;`,
  );
  const dragged = await ev("return window.__editor.doc.frame.scene.light;");
  const h2 = await capture(null);
  const text = await ev("return window.__editor.serializeDocument();");
  await ev(
    `window.__editor.loadDocumentFromText(${JSON.stringify(text)}, 'qc', true); return true;`,
  );
  const reloaded = await ev("return window.__editor.doc.frame.scene.light;");
  const h3 = await capture(null);
  return {
    hash: h,
    stats: st,
    geo,
    draggedTo: dragged,
    reloadedAs: reloaded,
    storedEqualsReloaded: dragged.x === reloaded.x && dragged.y === reloaded.y,
    renderSameAfterReload: h2 === h3,
  };
});
await step("toggleDuringDrag", async () => {
  await ev(
    "window.__editor.doc = window.__qcDocs.glassScene({on:true, light:{x:300,y:200}}); window.__qcPtr.setView(1, 100, 80); return true;",
  );
  const c = await ev("return window.__qcPtr.lightClient();");
  const histBefore = await ev("return window.__qcPtr.hist();");
  await ev(
    `window.__qcPtr.down(${c.x}, ${c.y}); window.__qcPtr.move(${c.x + 30}, ${c.y + 30}); return true;`,
  );
  const mid = await ev(
    "return { on: window.__editor.doc.frame.scene.on, light: window.__editor.doc.frame.scene.light };",
  );
  await ev("window.__editor.toggleScene(); return true;");
  await ev(`window.__qcPtr.move(${c.x + 60}, ${c.y + 60}); return true;`);
  const afterToggleMove = await ev(
    "return { on: window.__editor.doc.frame.scene.on, light: window.__editor.doc.frame.scene.light };",
  );
  await ev(`window.__qcPtr.up(${c.x + 60}, ${c.y + 60}); return true;`);
  const end = await ev(
    "return { on: window.__editor.doc.frame.scene.on, light: window.__editor.doc.frame.scene.light };",
  );
  await ev(`window.__qcPtr.move(${c.x + 200}, ${c.y + 200}, 0); return true;`);
  const hover = await ev("return window.__editor.doc.frame.scene.light;");
  const hist = await ev("return window.__qcPtr.hist();");
  const h = await capture("b-toggle-during-drag");
  const st = await ev("return window.__qc.stats();");
  /* can the light still be grabbed once scene is back on? */
  await ev("window.__editor.toggleScene(); return true;");
  const c2 = await ev("return window.__qcPtr.lightClient();");
  await ev(
    `window.__qcPtr.down(${c2.x}, ${c2.y}); window.__qcPtr.move(${c2.x + 10}, ${c2.y}); window.__qcPtr.up(${c2.x + 10}, ${c2.y}); return true;`,
  );
  const regrab = await ev("return window.__editor.doc.frame.scene.light;");
  return {
    histBefore: histBefore.length,
    mid,
    afterToggleMove,
    end,
    hover,
    dragEnded: hover.x === end.light.x,
    histTail: hist.slice(-4),
    hash: h,
    stats: st,
    regrabbed: regrab.x === end.light.x + 10,
  };
});
await step("glassOpacity03On", async () => {
  await ev(
    "window.__editor.doc = window.__qcDocs.glassScene({on:false, light:{x:450,y:60}}, {opacity:0.3}); window.__qc.keep('o3off'); return true;",
  );
  const hOff = await capture(null);
  await ev(
    "window.__editor.doc = window.__qcDocs.glassScene({on:true, light:{x:450,y:60}}, {opacity:0.3}); window.__qc.keep('o3on'); return true;",
  );
  const hOn = await capture("b-glass-op03-on");
  return {
    hOff,
    hOn,
    differs: hOff !== hOn,
    diff: await ev("return window.__qc.diff('o3off','o3on');"),
    stats: await ev("return window.__qc.stats();"),
  };
});
await step("rotatedGlassOn", async () => {
  await ev(
    "window.__editor.doc = window.__qcDocs.glassScene({on:false, light:{x:450,y:60}}, {rot:35}); window.__qc.keep('rotoff'); return true;",
  );
  const hOff = await capture(null);
  await ev(
    "window.__editor.doc = window.__qcDocs.glassScene({on:true, light:{x:450,y:60}}, {rot:35}); window.__qc.keep('roton'); return true;",
  );
  const hOn = await capture("b-glass-rot35-on");
  const box = await ev(
    "const E=window.__editor, o=E.doc.frame.children.find(c=>c.name==='A'); return { box: E.boxOf(o), at: E.sceneLightAt(o) };",
  );
  return {
    hOff,
    hOn,
    differs: hOff !== hOn,
    diff: await ev("return window.__qc.diff('rotoff','roton');"),
    stats: await ev("return window.__qc.stats();"),
    box,
  };
});
for (const z of [0.25, 4]) {
  await step("zoom" + z, async () => {
    await ev(
      `window.__editor.doc = window.__qcDocs.glassScene({on:true, light:{x:300,y:200}}); const L = window.__editor.sceneLight(); window.__qcPtr.setView(${z}, 300 - L.x * ${z}, 300 - L.y * ${z}); return true;`,
    );
    const s = await ev("return window.__qcPtr.lightScreen();");
    const px = await ev(`return window.__qcPtr.pixel(${s.x}, ${s.y});`);
    const pxRing = await ev(`return window.__qcPtr.pixel(${s.x + 9}, ${s.y});`);
    const pxAway = await ev(`return window.__qcPtr.pixel(${s.x + 40}, ${s.y + 40});`);
    const c = await ev("return window.__qcPtr.lightClient();");
    const L0 = await ev("return window.__editor.sceneLight();");
    /* grab 8 screen px off centre (inside the 12px hit radius) and drag 40 screen px */
    await ev(
      `window.__qcPtr.down(${c.x + 8}, ${c.y}); window.__qcPtr.move(${c.x + 48}, ${c.y}); window.__qcPtr.up(${c.x + 48}, ${c.y}); return true;`,
    );
    const L1 = await ev("return window.__editor.sceneLight();");
    /* grab 20 screen px off centre (outside the hit radius): must NOT move the light */
    const c2 = await ev("return window.__qcPtr.lightClient();");
    await ev(
      `window.__qcPtr.down(${c2.x + 20}, ${c2.y}); window.__qcPtr.move(${c2.x + 60}, ${c2.y}); window.__qcPtr.up(${c2.x + 60}, ${c2.y}); return true;`,
    );
    const L2 = await ev("return window.__editor.sceneLight();");
    const view = await ev("const v = window.__editor.view; return { z: v.z, x: v.x, y: v.y };");
    return {
      view,
      lightScreen: s,
      sunPixel: px,
      ringPixel: pxRing,
      awayPixel: pxAway,
      L0,
      L1,
      movedBy: L1.x - L0.x,
      expectedMove: 40 / z,
      grabbedInsideRadius: Math.abs(L1.x - L0.x - 40 / z) < 1e-6,
      L2,
      missedOutsideRadius: L2.x === L1.x && L2.y === L1.y,
    };
  });
}
await ev("window.__qcPtr.setView(1, 0, 0); return true;");

R.pageErrors = pageErrors;
fs.writeFileSync(path.join(OUT, "behaviour.json"), JSON.stringify(R, null, 2));
console.log("wrote lab-out/qc/behaviour.json; pageErrors:", pageErrors.length);
close();
process.exit(0);
