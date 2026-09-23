/* QC: after a real light drag, is the render identical to a fresh document with the light at the dragged position (no stale cached paint)?  LAB_CDP_PORT=9338 node lab/qc-drag-cache.mjs */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { launch } from "./qc-cdp.mjs";
const { ev, pageErrors, close } = await launch({
  port: Number(process.env.LAB_CDP_PORT || 9338),
  app: process.env.LAB_APP || "http://localhost:8470/",
});
const h = async () =>
  createHash("sha1")
    .update(await ev("return window.__qc.capture();"))
    .digest("hex")
    .slice(0, 12);
await ev(`
  const E = window.__editor, cv = document.getElementById('out');
  window.__qcD = {
    doc(lx, ly) { const t = []; const cols = ['#ff5a5f','#ffb400','#2ec4b6','#3b6df0']; for (let r = 0; r < 6; r++) for (let c = 0; c < 9; c++) t.push({ type: 'rect', name: 't' + r + c, x: c * 100 + 8, y: r * 100 + 8, w: 84, h: 84, radius: 14, fill: { kind: 'solid', color: cols[(r + c) % 4] }, effects: { shadow: { on: true, x: 4, y: 6, blur: 10, alpha: 0.4, color: '#000000' } } });
      t.push({ type: 'rect', name: 'A', x: 150, y: 120, w: 400, h: 300, radius: 40, fill: { kind: 'solid', color: '#ffffff' }, fillOpacity: 0, effects: { glass: Object.assign({}, E.DEFAULT_EFFECTS().glass, { on: true, mode: 'backdrop', depth: 90, tint: '#ffb3b3' }), shadow: { on: true, x: 8, y: 12, blur: 20, alpha: 0.45, color: '#000000' } } });
      t.push({ type: 'rect', name: 'R', x: 600, y: 350, w: 200, h: 150, radius: 20, fill: { kind: 'solid', color: '#e0341c' }, effects: { shadow: { on: true, x: 8, y: 12, blur: 20, alpha: 0.45, color: '#000000' } } });
      return { frame: { name: 'D', w: 900, h: 600, bg: '#f4f4f6', scene: { on: true, light: { x: lx, y: ly } }, children: t } }; },
    pe(type, cx, cy) { cv.dispatchEvent(new PointerEvent(type, { clientX: cx, clientY: cy, pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1 })); },
    lightClient() { const v = E.view, L = E.sceneLight(), r = cv.getBoundingClientRect(); return { x: r.left + L.x * v.z + v.x, y: r.top + L.y * v.z + v.y }; },
    setView() { const v = E.view; v.mode = 'free'; v.z = 1; v.x = 100; v.y = 80; E.showRulers = E.showRulers; },
  };
  return true;
`);
await ev("window.__editor.doc = window.__qcD.doc(300, 200); window.__qcD.setView(); return true;");
const before = await h();
const cacheBefore = await ev("return window.__editor.paintCacheSize;");
const c = await ev("return window.__qcD.lightClient();");
await ev(
  `window.__qcD.pe('pointerdown', ${c.x}, ${c.y}); window.__qcD.pe('pointermove', ${c.x + 200}, ${c.y + 120}); window.__qcD.pe('pointerup', ${c.x + 200}, ${c.y + 120}); return true;`,
);
const light = await ev("return window.__editor.doc.frame.scene.light;");
const afterDrag = await h();
const cacheAfter = await ev("return window.__editor.paintCacheSize;");
await ev(`window.__editor.doc = window.__qcD.doc(${light.x}, ${light.y}); return true;`);
const fresh = await h();
const R = {
  before,
  light,
  afterDrag,
  fresh,
  dragMatchesFresh: afterDrag === fresh,
  dragChangedRender: afterDrag !== before,
  cacheBefore,
  cacheAfter,
  pageErrors,
};
console.log(JSON.stringify(R));
fs.writeFileSync(
  path.join(path.resolve("lab-out/qc"), "drag-cache.json"),
  JSON.stringify(R, null, 2),
);
close();
process.exit(0);
