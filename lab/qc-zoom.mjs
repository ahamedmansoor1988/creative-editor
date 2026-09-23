/* QC: the sun and its hit test at zoom 0.25 and 4, scene ON. The view is put
 * in 'free' mode so paint() does not refit it. LAB_CDP_PORT=9338 node lab/qc-zoom.mjs */
import fs from "node:fs";
import path from "node:path";
import { launch } from "./qc-cdp.mjs";

const APP = process.env.LAB_APP || "http://localhost:8470/";
const PORT = Number(process.env.LAB_CDP_PORT || 9338);
const OUT = path.resolve("lab-out/qc");
const { ev, pageErrors, close } = await launch({ port: PORT, app: APP });
await ev(`
  const E = window.__editor, cv = document.getElementById('out');
  const TILES = () => { const t=[]; const cols=['#ff5a5f','#ffb400','#2ec4b6','#3b6df0']; for(let r=0;r<6;r++) for(let c=0;c<9;c++) t.push({ type:'rect', name:'t'+r+c, x:c*100+8, y:r*100+8, w:84, h:84, radius:14, fill:{kind:'solid',color:cols[(r+c)%4]} }); return t; };
  window.__qcZ = {
    doc() { return { frame:{ name:'Z', w:900, h:600, bg:'#f4f4f6', scene:{on:true,light:{x:300,y:200}}, children: TILES().concat([{ type:'rect', name:'A', x:150, y:120, w:400, h:300, radius:40, fill:{kind:'solid',color:'#ffffff'}, fillOpacity:0, effects:{ glass:Object.assign({}, E.DEFAULT_EFFECTS().glass, {on:true, mode:'backdrop', depth:90}), shadow:{on:true,x:8,y:12,blur:20,alpha:0.45,color:'#000000'} } }]) } }; },
    setView(z, x, y) { const v = E.view; v.mode = 'free'; v.z = z; v.x = x; v.y = y; E.showRulers = E.showRulers; return { z: v.z, x: v.x, y: v.y, mode: v.mode }; },
    view() { const v = E.view; return { z: v.z, x: v.x, y: v.y, mode: v.mode }; },
    screen(p) { const v = E.view; return { x: p.x * v.z + v.x, y: p.y * v.z + v.y }; },
    client(p) { const r = cv.getBoundingClientRect(), s = this.screen(p); return { x: r.left + s.x, y: r.top + s.y }; },
    pixel(sx, sy) { const r = cv.getBoundingClientRect(); const kx = cv.width / r.width, ky = cv.height / r.height; const d = cv.getContext('2d').getImageData(Math.round(sx * kx), Math.round(sy * ky), 1, 1).data; return [d[0], d[1], d[2]]; },
    pe(type, cx, cy) { cv.dispatchEvent(new PointerEvent(type, { clientX: cx, clientY: cy, pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1 })); },
    drag(cx, cy, dx, dy) { this.pe('pointerdown', cx, cy); this.pe('pointermove', cx + dx, cy + dy); this.pe('pointerup', cx + dx, cy + dy); },
    hist() { return [...document.querySelectorAll('#historyList .histRow .hName')].map(e => e.textContent); },
  };
  return true;
`);
const R = { steps: {} };
for (const z of [0.25, 1, 4]) {
  try {
    await ev("window.__editor.doc = window.__qcZ.doc(); return true;");
    const view = await ev(
      `const L = window.__editor.sceneLight(); return window.__qcZ.setView(${z}, 300 - L.x * ${z}, 300 - L.y * ${z});`,
    );
    const L0 = await ev("return window.__editor.sceneLight();");
    const s = await ev("return window.__qcZ.screen(window.__editor.sceneLight());");
    const viewAfterPaint = await ev("return window.__qcZ.view();");
    const px = await ev(`return window.__qcZ.pixel(${s.x}, ${s.y});`);
    const ring = await ev(`return window.__qcZ.pixel(${s.x + 9}, ${s.y});`);
    const away = await ev(`return window.__qcZ.pixel(${s.x + 40}, ${s.y + 40});`);
    const c = await ev("return window.__qcZ.client(window.__editor.sceneLight());");
    const histBefore = (await ev("return window.__qcZ.hist();")).length;
    await ev(`window.__qcZ.drag(${c.x + 8}, ${c.y}, 40, 0); return true;`);
    const L1 = await ev("return window.__editor.sceneLight();");
    const c2 = await ev("return window.__qcZ.client(window.__editor.sceneLight());");
    await ev(`window.__qcZ.drag(${c2.x + 20}, ${c2.y}, 40, 0); return true;`);
    const L2 = await ev("return window.__editor.sceneLight();");
    const hist = await ev("return window.__qcZ.hist();");
    R.steps["zoom" + z] = {
      view,
      viewAfterPaint,
      viewHeld: Math.abs(viewAfterPaint.z - z) < 1e-9,
      lightScreen: s,
      sunPixel: px,
      ringPixel: ring,
      awayPixel: away,
      sunDrawn: px[0] === 255 && px[1] === 247 && px[2] === 214,
      ringDrawn: ring[0] === 37 && ring[1] === 99 && ring[2] === 235,
      L0,
      L1,
      movedBy: +(L1.x - L0.x).toFixed(3),
      expectedMove: 40 / z,
      grabbedInsideRadius: Math.abs(L1.x - L0.x - 40 / z) <= 1,
      L2,
      missedOutsideRadius: L2.x === L1.x && L2.y === L1.y,
      historyPushed: hist.length - histBefore,
      histTail: hist.slice(-2),
    };
  } catch (e) {
    R.steps["zoom" + z] = { error: String(e.message || e) };
  }
  console.log("zoom" + z, JSON.stringify(R.steps["zoom" + z]));
}
R.pageErrors = pageErrors;
fs.writeFileSync(path.join(OUT, "zoom.json"), JSON.stringify(R, null, 2));
console.log("pageErrors:", pageErrors.length);
close();
process.exit(0);
