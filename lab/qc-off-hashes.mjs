/* QC: OFF-mode regression documents beyond the builder's three. Each document
 * is rendered twice (the second after a pause, so async image/font loads have
 * settled) through the app's renderFrameCanvas and the PNG data URL is
 * hashed. Run once against main and once against the branch on the SAME CDP
 * port (same Chrome profile) and compare the JSON.
 *
 *   LAB_APP=http://localhost:8471/ LAB_CDP_PORT=9337 LAB_TAG=-main node lab/qc-off-hashes.mjs
 *   LAB_CDP_PORT=9337 LAB_TAG=-branch node lab/qc-off-hashes.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { launch } from "./qc-cdp.mjs";

const APP = process.env.LAB_APP || "http://localhost:8470/";
const PORT = Number(process.env.LAB_CDP_PORT || 9337);
const TAG = process.env.LAB_TAG || "";
const OUT = path.resolve("lab-out/qc");
fs.mkdirSync(OUT, { recursive: true });
const HASHES = process.env.LAB_HASHES || "off-qc" + TAG + ".json";

const { ev, pageErrors, sleep, close } = await launch({ port: PORT, app: APP });

/* Every document is a page-side expression returning the doc; E is __editor. */
const TILES = `(function(){ const t=[]; const cols=['#ff5a5f','#ffb400','#2ec4b6','#3b6df0','#9b5de5','#f15bb5','#00bbf9','#fee440']; for(let r=0;r<6;r++) for(let c=0;c<9;c++) t.push({ type:(r+c)%3===0?'ellipse':'rect', name:'t'+r+c, x:c*100+8, y:r*100+8, w:84, h:84, radius:14, fill:{kind:'solid',color:cols[(r*3+c)%cols.length]} }); return t; })()`;
const SHADOW = `{on:true,x:8,y:12,blur:20,spread:2,alpha:0.45,color:'#000000'}`;
const DOCS = {
  rectShadowGlow: `return { frame:{ name:'q1', w:700, h:420, bg:'#e9eef5', children:[
    { type:'rect', name:'r', x:80, y:70, w:320, h:200, radius:22, fill:{kind:'solid',color:'#e0341c'}, effects:{ shadow:${SHADOW}, glow:{on:true,type:'outer',radius:26,spread:4,color:'#ffb400',alpha:0.8,falloff:1,blend:'normal'} } },
    { type:'ellipse', name:'e', x:440, y:120, w:200, h:200, fill:{kind:'linear',angle:45,stops:[{pos:0,color:'#2ec4b6'},{pos:1,color:'#3b6df0'}]}, effects:{ innerShadow:{on:true,x:4,y:6,blur:14,spread:0,color:'#000000',alpha:0.5,blend:'normal'}, glow:{on:true,type:'inner',radius:18,spread:0,color:'#ffffff',alpha:0.7,falloff:1,blend:'normal'} } } ] } };`,
  textShadow: `return { frame:{ name:'q2', w:800, h:400, bg:'#fafafa', children:[
    { type:'text', name:'T1', x:60, y:100, text:'Scene mode QC', size:72, weight:700, color:'#111111', align:'left', mode:'point', lineHeight:1.2, tracking:0, valign:'top', autosize:'fixed', caseTf:'none', opacity:1, effects:{ shadow:{on:true,x:6,y:8,blur:12,spread:0,alpha:0.6,color:'#000000'} } },
    { type:'text', name:'T2', x:80, y:240, text:'rotated, tinted shadow', size:40, weight:400, color:'#3b6df0', rot:12, align:'left', mode:'point', lineHeight:1.2, tracking:2, valign:'top', autosize:'fixed', caseTf:'none', opacity:0.9, effects:{ shadow:{on:true,x:-5,y:9,blur:6,spread:0,alpha:0.5,color:'#ff5a5f'} } } ] } };`,
  meshRotated: `const pts=[]; const cols=[[255,90,95],[255,180,0],[46,196,182],[59,109,240],[155,93,229],[241,91,181],[0,187,249],[254,228,64],[20,20,40]]; for(let r=0;r<3;r++) for(let c=0;c<3;c++) pts.push({x:c/2,y:r/2,color:cols[r*3+c]});
    return { frame:{ name:'q3', w:700, h:450, bg:'#ffffff', children:[
    { type:'rect', name:'bg', x:0, y:0, w:700, h:450, fill:{kind:'radial',stops:[{pos:0,color:'#ffffff'},{pos:1,color:'#cfd8e6'}]} },
    { type:'rect', name:'mesh', x:150, y:80, w:400, h:240, radius:30, rot:25, fill:{kind:'solid',color:'#3b6df0'}, effects:{ mesh:{on:true,cols:3,rows:3,points:pts,showNet:true}, shadow:${SHADOW} } } ] } };`,
  frostedEllipseShadow: `const G=E.DEFAULT_EFFECTS().glass; return { frame:{ name:'q4', w:900, h:600, bg:'#f4f4f6', children:${TILES}.concat([
    { type:'ellipse', name:'frost', x:200, y:120, w:420, h:320, fill:{kind:'solid',color:'#ffffff'}, fillOpacity:0, effects:{ glass:Object.assign({},G,{on:true,mode:'frosted',frost:50,depth:60,tint:'#cfe8ff',absorption:0.2,ior:1.52,refraction:60}), shadow:${SHADOW} } } ]) } };`,
  reedTile: `const R=E.DEFAULT_EFFECTS().reed; return { frame:{ name:'q5', w:700, h:400, bg:'#ffffff', children:[
    { type:'rect', name:'tiles', x:0, y:0, w:700, h:400, fill:{kind:'image',src:window.__qc.tileSrc,mode:'tile',tileScale:1.5,x:0.5,y:0.5,scale:1,rotation:0} },
    { type:'rect', name:'reed', x:60, y:50, w:380, h:300, fillOpacity:0, fill:{kind:'solid',color:'#ffffff'}, effects:{ reed:Object.assign({},R,{on:true}), shadow:{on:true,x:4,y:8,blur:12,spread:0,alpha:0.4,color:'#000000'} } },
    { type:'rect', name:'reed30', x:470, y:80, w:200, h:260, radius:24, fillOpacity:0, fill:{kind:'solid',color:'#ffffff'}, effects:{ reed:Object.assign({},R,{on:true,angle:30,thick:2}), shadow:{on:true,x:-6,y:10,blur:16,spread:0,alpha:0.5,color:'#102040'} } } ] } };`,
  glassForeignLight: `const G=E.DEFAULT_EFFECTS().glass; return { frame:{ name:'q6', w:900, h:600, bg:'#f4f4f6', children:${TILES}.concat([
    { type:'rect', name:'glassFL', x:150, y:120, w:500, h:340, radius:40, fill:{kind:'solid',color:'#ffffff'}, fillOpacity:0, effects:{ glass:Object.assign({},G,{on:true,mode:'backdrop',depth:90,tint:'#ffffff',absorption:0.1,ior:1.52,refraction:60,edgeIntensity:70,lightAngle:200,lightElevation:75}), shadow:${SHADOW} } } ]) } };`,
  glassRotatedOpacity: `const G=E.DEFAULT_EFFECTS().glass; return { frame:{ name:'q7', w:900, h:600, bg:'#f4f4f6', children:${TILES}.concat([
    { type:'ellipse', name:'glassRot', x:150, y:120, w:400, h:300, rot:30, opacity:0.3, fill:{kind:'solid',color:'#ffffff'}, fillOpacity:0, effects:{ glass:Object.assign({},G,{on:true,mode:'backdrop',depth:90,tint:'#b3d1ff',absorption:0.3,ior:1.52,refraction:60}), shadow:${SHADOW} } },
    { type:'rect', name:'glassRot2', x:500, y:200, w:300, h:260, radius:30, rot:-15, opacity:0.6, fill:{kind:'solid',color:'#ffffff'}, fillOpacity:0, effects:{ glass:Object.assign({},G,{on:true,mode:'backdrop',depth:40,tint:'#ffb3b3',absorption:0.1}), shadow:{on:true,x:0,y:0,blur:30,spread:0,alpha:0.6,color:'#000000'} } } ]) } };`,
  sceneKeyOff: `const G=E.DEFAULT_EFFECTS().glass; return { frame:{ name:'q8', w:900, h:600, bg:'#f4f4f6', scene:{on:false,light:{x:100,y:100}}, children:${TILES}.concat([
    { type:'rect', name:'A', x:120, y:120, w:340, h:300, radius:40, fill:{kind:'solid',color:'#ffffff'}, fillOpacity:0, effects:{ glass:Object.assign({},G,{on:true,mode:'backdrop',depth:40,tint:'#ffffff',absorption:0.08}), shadow:{on:true,x:6,y:10,blur:18,alpha:0.35,color:'#000000'} } },
    { type:'ellipse', name:'B', x:330, y:200, w:360, h:300, fill:{kind:'solid',color:'#ffffff'}, fillOpacity:0, effects:{ glass:Object.assign({},G,{on:true,mode:'backdrop',depth:90,tint:'#ffb3b3',absorption:0.25}), shadow:{on:true,x:6,y:10,blur:18,alpha:0.35,color:'#000000'} } } ]) } };`,
  everythingOff: `const G=E.DEFAULT_EFFECTS().glass, R=E.DEFAULT_EFFECTS().reed; return { frame:{ name:'q9', w:900, h:600, bg:'#eef2f7', children:${TILES}.concat([
    { type:'text', name:'T', x:40, y:20, text:'Everything, flag off', size:48, weight:700, color:'#111111', align:'left', mode:'point', lineHeight:1.2, tracking:0, valign:'top', autosize:'fixed', caseTf:'none', opacity:1, effects:{ shadow:{on:true,x:4,y:6,blur:8,spread:0,alpha:0.5,color:'#000000'} } },
    { type:'rect', name:'R', x:40, y:420, w:260, h:140, radius:16, fill:{kind:'solid',color:'#e0341c'}, effects:{ shadow:${SHADOW}, glow:{on:true,type:'outer',radius:20,spread:2,color:'#ffffff',alpha:0.9,falloff:1,blend:'normal'} } },
    { type:'rect', name:'glass', x:120, y:120, w:360, h:280, radius:36, fill:{kind:'solid',color:'#ffffff'}, fillOpacity:0, effects:{ glass:Object.assign({},G,{on:true,mode:'backdrop',depth:70,tint:'#d9ffe0',absorption:0.2}), shadow:${SHADOW} } },
    { type:'rect', name:'reed', x:520, y:100, w:320, h:300, fillOpacity:0, fill:{kind:'solid',color:'#ffffff'}, effects:{ reed:Object.assign({},R,{on:true}), shadow:${SHADOW} } } ]) } };`,
};

const hashOf = (url) => createHash("sha1").update(url).digest("hex").slice(0, 12);
const out = { app: APP, port: PORT, docs: {} };
for (const [name, src] of Object.entries(DOCS)) {
  await ev(
    `const E = window.__editor; const d = (function(){ ${src} })(); E.doc = d; return true;`,
  );
  const h1 = hashOf(await ev("return window.__qc.capture();"));
  await sleep(500);
  const url2 = await ev("return window.__qc.capture();");
  const h2 = hashOf(url2);
  await sleep(300);
  const h3 = hashOf(await ev("return window.__qc.capture();"));
  fs.writeFileSync(path.join(OUT, name + TAG + ".png"), Buffer.from(url2.split(",")[1], "base64"));
  const stats = await ev("return window.__qc.stats();");
  const sceneKey = await ev(
    "return JSON.stringify(window.__editor.doc.frame.scene===undefined?null:window.__editor.doc.frame.scene);",
  );
  out.docs[name] = {
    hash: h3,
    first: h1,
    second: h2,
    stable: h1 === h2 && h2 === h3,
    stats,
    sceneKey,
  };
  console.log(name, JSON.stringify(out.docs[name]));
}
out.pageErrors = pageErrors;
fs.writeFileSync(path.join(OUT, HASHES), JSON.stringify(out, null, 2));
console.log("wrote", path.join(OUT, HASHES), "pageErrors:", pageErrors.length);
close();
process.exit(0);
