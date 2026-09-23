/* QC: does each kind of object's DROP SHADOW follow the scene light, or only
 * the transmission pool? Light left vs right, scene ON, with the object's
 * shadow on and (control) off. Same strip metric as lab/scene-lab.mjs.
 *   LAB_CDP_PORT=9338 node lab/qc-shadow-follow.mjs */
import fs from "node:fs";
import path from "node:path";
import { launch } from "./qc-cdp.mjs";

const APP = process.env.LAB_APP || "http://localhost:8470/";
const PORT = Number(process.env.LAB_CDP_PORT || 9338);
const OUT = path.resolve("lab-out/qc");
const { ev, pageErrors, close } = await launch({ port: PORT, app: APP });
await ev(`
  const E = window.__editor;
  const TILES = () => { const t=[]; const cols=['#ff5a5f','#ffb400','#2ec4b6','#3b6df0','#9b5de5','#f15bb5','#00bbf9','#fee440']; for(let r=0;r<6;r++) for(let c=0;c<9;c++) t.push({ type:(r+c)%3===0?'ellipse':'rect', name:'t'+r+c, x:c*100+8, y:r*100+8, w:84, h:84, radius:14, fill:{kind:'solid',color:cols[(r*3+c)%cols.length]} }); return t; };
  window.__qcS = {
    doc(kind, shadowOn, lx, on) {
      const box = { x: 300, y: 150, w: 300, h: 300 };
      const sh = { on: shadowOn, x: 6, y: 10, blur: 18, alpha: 0.35, color: '#000000' };
      let o;
      if (kind === 'rect') o = Object.assign({ type: 'rect', name: 'O', radius: 30, fill: { kind: 'solid', color: '#e0341c' }, effects: { shadow: sh } }, box);
      if (kind === 'glass') o = Object.assign({ type: 'rect', name: 'O', radius: 30, fill: { kind: 'solid', color: '#ffffff' }, fillOpacity: 0, effects: { glass: Object.assign({}, E.DEFAULT_EFFECTS().glass, { on: true, mode: 'backdrop', depth: 90, tint: '#ffb3b3', absorption: 0.25 }), shadow: sh } }, box);
      if (kind === 'reed') o = Object.assign({ type: 'rect', name: 'O', fill: { kind: 'solid', color: '#ffffff' }, fillOpacity: 0, effects: { reed: Object.assign({}, E.DEFAULT_EFFECTS().reed, { on: true }), shadow: sh } }, box);
      if (kind === 'text') o = { type: 'text', name: 'O', x: 300, y: 250, text: 'SHADOW', size: 90, weight: 800, color: '#111111', align: 'left', mode: 'point', lineHeight: 1.2, tracking: 0, valign: 'top', autosize: 'fixed', caseTf: 'none', opacity: 1, effects: { shadow: sh } };
      return { frame: { name: 'S', w: 900, h: 600, bg: '#f4f4f6', scene: { on: on === undefined ? true : on, light: { x: lx, y: 60 } }, children: TILES().concat([o]) } };
    },
    strips(a, b, x, y, w, h) { const A = window.__qc.kept[a], B = window.__qc.kept[b]; const m = (D, X) => { let s = 0, n = 0; for (let j = y + Math.floor(h * 0.3); j < y + Math.floor(h * 0.7); j++) for (let i = X; i < X + 24; i++) { const k = (j * D.width + i) * 4; s += D.data[k] + D.data[k + 1] + D.data[k + 2]; n += 3; } return s / n; }; return { leftStrip: +(m(B, x - 28) - m(A, x - 28)).toFixed(2), rightStrip: +(m(B, x + w + 4) - m(A, x + w + 4)).toFixed(2) }; },
  };
  return true;
`);
const R = {};
for (const kind of ["rect", "glass", "reed", "text"]) {
  R[kind] = {};
  for (const shadowOn of [true, false]) {
    await ev(
      `window.__editor.doc = window.__qcS.doc('${kind}', ${shadowOn}, 80); window.__qc.keep('L'); return true;`,
    );
    await ev(
      `window.__editor.doc = window.__qcS.doc('${kind}', ${shadowOn}, 820); window.__qc.keep('R'); return true;`,
    );
    const box = kind === "text" ? [300, 250, 330, 110] : [300, 150, 300, 300];
    R[kind]["shadow" + (shadowOn ? "On" : "Off")] = {
      strips: await ev(`return window.__qcS.strips('L','R',${box.join(",")});`),
      wholeFrame: await ev("return window.__qc.diff('L','R');"),
    };
  }
  /* and the same object, scene ON vs OFF at one light, shadow on */
  await ev(
    `window.__editor.doc = window.__qcS.doc('${kind}', true, 450, false); window.__qc.keep('OFF'); return true;`,
  );
  await ev(
    `window.__editor.doc = window.__qcS.doc('${kind}', true, 450, true); window.__qc.keep('ON'); return true;`,
  );
  R[kind].onVsOff = await ev("return window.__qc.diff('OFF','ON');");
  R[kind].shadowVec = await ev(
    "const E = window.__editor; return E.sceneShadowVec(E.doc.frame.children.find(c => c.name === 'O'));",
  );
  console.log(kind, JSON.stringify(R[kind]));
}
R.pageErrors = pageErrors;
fs.writeFileSync(path.join(OUT, "shadow-follow.json"), JSON.stringify(R, null, 2));
console.log("pageErrors:", pageErrors.length);
close();
process.exit(0);
