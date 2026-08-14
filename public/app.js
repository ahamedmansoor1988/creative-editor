/* Creative Editor — canvas, inspector, engines, agentic bar. */
(function(){
"use strict";

/* ================= helpers ================= */
const $=id=>document.getElementById(id);
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));

/* ================= document ================= */
let pages=[];            // array of {frame:{name,w,h,bg,children:[]}}
let pageIdx=-1;          // active page
let doc=null;            // ALIAS of pages[pageIdx] (null when no pages)
function setActivePage(i){
  pageIdx=(i>=0&&i<pages.length)?i:-1;
  doc=pageIdx>=0?pages[pageIdx]:null;
}
/** Replace the ACTIVE page's document (or append as a new page when none). */
function setActiveDoc(d){
  if(pageIdx<0){ pages.push(d); pageIdx=pages.length-1; }
  else pages[pageIdx]=d;
  doc=d;
}
let sel=-1;              // index into children
let selInstance=null;    // derived instance under inspection (never editable)
let tool='select';
let viewMode='fit';      // 'fit' | 'actual'
let fxPage=0;            // engines pager

const DEFAULT_EFFECTS=()=>({
  shadow:{on:false,x:0,y:6,blur:18,color:'#000000',alpha:0.25},
  grain:{amount:0},
  // Clear Glass defaults from the locked standalone glass app
  glass:{on:false,depth:40,refraction:35,frost:0,reflection:25,light:35,dispersion:0,tint:'#ffffff',opacity:100},
  // SDF metaball merge of the shape with its own pattern copies
  blob:{on:false,smoothness:40,mode:'union'},
  // the blob field driven through the glass optics
  glass2:{on:false,smoothness:40,mode:'union',depth:40,refraction:35,frost:0,reflection:25,light:35,dispersion:0,tint:'#ffffff',opacity:100},
});
const BLOB_MODES=['union','intersect','difference'];
/* ---- linked pattern (see docs/pattern-contract.md) ----
 * A parent owns a pattern definition. Instances are DERIVED at layout time,
 * never stored, so inherited appearance cannot drift and parent-reference
 * cycles are unrepresentable. */
const MAX_PATTERN_INSTANCES=400;
const MAX_GRID_AXIS=32, MAX_GAP=400, MAX_OFFSET=500, MAX_JITTER=500;
const MAX_HOLES=0.9, MIN_SIZE_FACTOR=0.1;
const MIRRORS=['none','horizontal','vertical','alt-horizontal','alt-vertical'];
const DEFAULT_PATTERN=()=>({
  columns:4, rows:1,
  hGap:16, vGap:16, rowOffsetX:0, colOffsetY:0,
  baseScale:1, lockProportions:true, widthVariation:0, heightVariation:0,
  baseRotation:0, rotationStep:0, rotationVariation:0, mirror:'none',
  jitterX:0, jitterY:0, holes:0,
  seed:Math.floor(Math.random()*99999999),
});

/* Deterministic value in [0,1) addressed by (seed, instance index, channel).
 * Deliberately a HASH, not a sequential stream: changing `holes` or adding a
 * row must not reshuffle the instances that were already there. */
function rand01(seed,i,salt){
  let a=(Math.imul(seed>>>0,0x9E3779B1) ^ Math.imul(i+1,0x85EBCA77) ^ Math.imul(salt+1,0xC2B2AE3D))>>>0;
  a=Math.imul(a^(a>>>16),0x7FEB352D)>>>0;
  a=Math.imul(a^(a>>>15),0x846CA68B)>>>0;
  return ((a^(a>>>16))>>>0)/4294967296;
}
const R_W=1,R_H=2,R_ROT=3,R_JX=4,R_JY=5,R_HOLE=6;
let uidN=0;
function newId(){ uidN+=1; return 'o'+Date.now().toString(36)+'-'+uidN.toString(36); }


/* Migrate + validate a pattern. Returns null when the object has no pattern.
 * Idempotent: the Stage 1.1 branch is keyed on the retired `mode` field, which
 * this function never writes back, so re-running is a no-op. */
function normalizePattern(raw){
  if(!raw||typeof raw!=='object') return null;
  let p=raw;
  if('mode' in p){
    // ---- Stage 1.1 -> 1.2 migration ----
    if(p.mode==='none') return null;                 // "Off" is now "no pattern"
    const count=clamp(Math.round(+p.count||4),1,MAX_GRID_AXIS);
    const vary=clamp(+p.vary||0,0,1);
    const mapped={
      columns: p.mode==='columns' ? 1 : (p.mode==='grid' ? clamp(Math.round(+p.cols||count),1,MAX_GRID_AXIS) : count),
      rows:    p.mode==='rows'    ? 1 : (p.mode==='grid' ? clamp(Math.round(+p.rows||count),1,MAX_GRID_AXIS) : count),
      hGap:+p.gap||0, vGap:+p.gap||0,
      widthVariation:vary, heightVariation:vary, lockProportions:true,
      holes:clamp(+p.empty||0,0,MAX_HOLES),
      seed:Math.floor(+p.seed)||DEFAULT_PATTERN().seed,
    };
    // `window` (Coverage) is intentionally dropped — see docs/pattern-contract.md §8.
    p=Object.assign(DEFAULT_PATTERN(),mapped);
  }
  const d=DEFAULT_PATTERN();
  const out=Object.assign(d,p);
  const num=(v,def,lo,hi)=>{ const n=+v; return Number.isFinite(n)?clamp(n,lo,hi):def; };
  out.columns=clamp(Math.round(num(out.columns,4,1,MAX_GRID_AXIS)),1,MAX_GRID_AXIS);
  out.rows=clamp(Math.round(num(out.rows,1,1,MAX_GRID_AXIS)),1,MAX_GRID_AXIS);
  // Predictable cap: shed ROWS until the grid fits, never a partial row.
  if(out.columns*out.rows>MAX_PATTERN_INSTANCES){
    out.rows=Math.max(1,Math.floor(MAX_PATTERN_INSTANCES/out.columns));
  }
  out.hGap=num(out.hGap,0,0,MAX_GAP);
  out.vGap=num(out.vGap,0,0,MAX_GAP);
  out.rowOffsetX=num(out.rowOffsetX,0,-MAX_OFFSET,MAX_OFFSET);
  out.colOffsetY=num(out.colOffsetY,0,-MAX_OFFSET,MAX_OFFSET);
  out.baseScale=num(out.baseScale,1,0.1,2);
  out.lockProportions=!!out.lockProportions;
  out.widthVariation=num(out.widthVariation,0,0,1);
  out.heightVariation=num(out.heightVariation,0,0,1);
  out.baseRotation=num(out.baseRotation,0,-180,180);
  out.rotationStep=num(out.rotationStep,0,-180,180);
  out.rotationVariation=num(out.rotationVariation,0,0,180);
  out.mirror=MIRRORS.includes(out.mirror)?out.mirror:'none';
  out.jitterX=num(out.jitterX,0,0,MAX_JITTER);
  out.jitterY=num(out.jitterY,0,0,MAX_JITTER);
  out.holes=num(out.holes,0,0,MAX_HOLES);
  const s=Math.floor(+out.seed);
  out.seed=Number.isFinite(s)&&s!==0?s:DEFAULT_PATTERN().seed;
  delete out.mode; delete out.count; delete out.cols; delete out.gap;
  delete out.vary; delete out.window; delete out.empty;
  return out;
}

function normalizeDoc(d){
  const f=d.frame;
  f.w=clamp(+f.w||900,100,4000); f.h=clamp(+f.h||600,100,4000);
  if(!/^#/.test(f.bg||'')) f.bg='#ffffff';
  f.children=(f.children||[]).slice(0,24).map((c,i)=>{
    c.name=c.name||`${c.type} ${i+1}`;
    c.x=+c.x||0; c.y=+c.y||0;
    c.opacity=c.opacity===undefined?1:clamp(+c.opacity,0.05,1);
    if(c.type==='text'){
      c.size=clamp(+c.size||32,8,300); c.weight=+c.weight||600;
      c.color=c.color||'#111111'; c.align=c.align==='center'?'center':'left';
      c.text=String(c.text||'Text');
    }else{
      c.w=Math.max(4,+c.w||100); c.h=Math.max(4,+c.h||100);
      c.radius=clamp(+c.radius||0,0,300);
      if(!c.fill||!c.fill.kind) c.fill={kind:'solid',color:'#cccccc'};
      if(c.fill.kind!=='solid'){
        c.fill.stops=(c.fill.stops||[]).slice(0,4).map(s=>({pos:clamp(+s.pos||0,0,1),color:s.color||'#888888'}));
        while(c.fill.stops.length<2) c.fill.stops.push({pos:1,color:'#333333'});
        c.fill.angle=+c.fill.angle||0;
      }
    }
    {
      // deep-merge per effect: the model may send partial objects like
      // {"shadow":{"on":true}} and must not wipe the other fields
      const de=DEFAULT_EFFECTS(), ce=c.effects||{};
      const sh=Object.assign(de.shadow, ce.shadow||{});
      sh.on=!!sh.on; sh.x=clamp(+sh.x||0,-100,100); sh.y=clamp(+sh.y||0,-100,100);
      sh.blur=clamp(+sh.blur||0,0,150); sh.alpha=clamp(+sh.alpha||0,0,1);
      if(!/^#[0-9a-fA-F]{6}$/.test(sh.color||'')) sh.color='#000000';
      const gr=Object.assign(de.grain, ce.grain||{});
      gr.amount=clamp(+gr.amount||0,0,1);
      const gla=Object.assign(de.glass, ce.glass||{});
      gla.on=!!gla.on && c.type!=='text';
      gla.depth=clamp(+gla.depth||0,-200,200);
      gla.refraction=clamp(+gla.refraction||0,-200,200);
      gla.frost=clamp(+gla.frost||0,0,100);
      gla.reflection=clamp(+gla.reflection||0,0,100);
      gla.light=clamp(+gla.light||0,0,100);
      gla.dispersion=clamp(+gla.dispersion||0,0,200);
      gla.opacity=clamp(gla.opacity===undefined?100:+gla.opacity,0,100);
      if(!/^#[0-9a-fA-F]{6}$/.test(gla.tint||'')) gla.tint='#ffffff';
      const nb=(o,d)=>{
        o.on=!!o.on && c.type!=='text';
        o.smoothness=clamp(+o.smoothness||0,0,300);
        o.mode=BLOB_MODES.includes(o.mode)?o.mode:'union';
        return o;
      };
      const blo=nb(Object.assign(de.blob, ce.blob||{}));
      const gl2=nb(Object.assign(de.glass2, ce.glass2||{}));
      gl2.depth=clamp(+gl2.depth||0,-200,200);
      gl2.refraction=clamp(+gl2.refraction||0,-200,200);
      gl2.frost=clamp(+gl2.frost||0,0,100);
      gl2.reflection=clamp(+gl2.reflection||0,0,100);
      gl2.light=clamp(+gl2.light||0,0,100);
      gl2.dispersion=clamp(+gl2.dispersion||0,0,200);
      gl2.opacity=clamp(gl2.opacity===undefined?100:+gl2.opacity,0,100);
      if(!/^#[0-9a-fA-F]{6}$/.test(gl2.tint||'')) gl2.tint='#ffffff';
      c.effects={shadow:sh, grain:gr, glass:gla, blob:blo, glass2:gl2};
    }
    // Stable identity. Required so instances can carry an explicit parentId.
    if(typeof c.id!=='string'||!c.id) c.id=newId();
    if(c.type!=='text'){
      // Migrate the legacy bounding-box `engine` field. Deliberate semantic
      // change: same knobs, but they now place linked duplicates outside the
      // parent instead of gradient segments inside it. See the contract doc.
      const legacy=c.engine;
      if(legacy&&!c.pattern){
        c.pattern={
          mode:legacy.mode==='mixed'?'rows':legacy.mode,
          count:legacy.bands, rows:legacy.bands, cols:legacy.bands,
          gap:legacy.gap, vary:legacy.vary, window:legacy.window,
          empty:legacy.empty, seed:legacy.seed,
        };
      }
      delete c.engine;
      c.pattern=normalizePattern(c.pattern);
      if(!c.pattern) delete c.pattern;
    } else {
      delete c.engine; delete c.pattern;
    }
    return c;
  });
  return d;
}
function newDoc(){
  return normalizeDoc({frame:{name:'Frame 1',w:900,h:600,bg:'#ffffff',children:[]}});
}

/* ================= history ================= */
const hist={stack:[],i:-1};
function pushHistory(){
  hist.stack=hist.stack.slice(0,hist.i+1);
  hist.stack.push(JSON.stringify({pages,pageIdx}));
  if(hist.stack.length>60) hist.stack.shift();
  hist.i=hist.stack.length-1;
}
function restoreSnapshot(json){
  const s=JSON.parse(json);
  pages=s.pages||[]; setActivePage(s.pageIdx);
  sel=-1; selInstance=null; refresh();
}
function undo(){ if(hist.i>0){ hist.i--; restoreSnapshot(hist.stack[hist.i]); } }
function redo(){ if(hist.i<hist.stack.length-1){ hist.i++; restoreSnapshot(hist.stack[hist.i]); } }

/* ================= render ================= */
const canvas=$('out'), ctx=canvas.getContext('2d');
const frameBuf=document.createElement('canvas');
let grainTile=null;
function makeGrain(){
  const c=document.createElement('canvas'); c.width=96; c.height=96;
  const g=c.getContext('2d'), img=g.createImageData(96,96);
  for(let i=0;i<img.data.length;i+=4){
    const v=Math.random()*255|0;
    img.data[i]=img.data[i+1]=img.data[i+2]=v; img.data[i+3]=255;
  }
  g.putImageData(img,0,0);
  return c;
}
function fillStyleFor(c,obj,b){
  const f=obj.fill;
  if(!f||f.kind==='solid') return (f&&f.color)||'#cccccc';
  if(f.kind==='radial'){
    const g=c.createRadialGradient(b.x+b.w/2,b.y+b.h/2,0,b.x+b.w/2,b.y+b.h/2,Math.max(b.w,b.h)/2);
    f.stops.forEach(s=>g.addColorStop(s.pos,s.color));
    return g;
  }
  const a=(f.angle||0)*Math.PI/180, dx=Math.cos(a), dy=Math.sin(a);
  const cx=b.x+b.w/2, cy=b.y+b.h/2, ext=Math.abs(dx)*b.w/2+Math.abs(dy)*b.h/2;
  const g=c.createLinearGradient(cx-dx*ext,cy-dy*ext,cx+dx*ext,cy+dy*ext);
  f.stops.forEach(s=>g.addColorStop(s.pos,s.color));
  return g;
}
function pathFor(c,obj){
  c.beginPath();
  if(obj.type==='ellipse') c.ellipse(obj.x+obj.w/2,obj.y+obj.h/2,obj.w/2,obj.h/2,0,0,Math.PI*2);
  else{
    const r=Math.min(obj.radius||0,obj.w/2,obj.h/2);
    if(r>0.5){
      c.moveTo(obj.x+r,obj.y);
      c.arcTo(obj.x+obj.w,obj.y,obj.x+obj.w,obj.y+obj.h,r);
      c.arcTo(obj.x+obj.w,obj.y+obj.h,obj.x,obj.y+obj.h,r);
      c.arcTo(obj.x,obj.y+obj.h,obj.x,obj.y,r);
      c.arcTo(obj.x,obj.y,obj.x+obj.w,obj.y,r);
      c.closePath();
    } else c.rect(obj.x,obj.y,obj.w,obj.h);
  }
}
function hexAlpha(hex,a){
  const n=parseInt(hex.slice(1),16);
  return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${a})`;
}

/* ---- linked pattern layout ----
 * Pure function of (parent, parent.pattern). Returns COMPLETE derived
 * instances positioned OUTSIDE the parent. Each instance is a shallow view of
 * the parent with only geometry substituted, so every appearance property
 * (type, radius, fill, opacity, shadow, grain) is inherited live — there is no
 * copied state that could drift. Deterministic: seeded, never Math.random. */
function patternInstances(parent){
  const P=parent&&parent.pattern;
  const out=[];
  if(!P) return out;
  if(parent.type==='text') return out;          // text parents unsupported
  if(parent.parentId) return out;               // instances never recurse
  const pw=parent.w, ph=parent.h;
  if(!isFinite(pw)||!isFinite(ph)||pw<=0||ph<=0) return out;
  if(!isFinite(parent.x)||!isFinite(parent.y)) return out;

  const cols=P.columns, rows=P.rows;
  const total=cols*rows;
  if(total>MAX_PATTERN_INSTANCES) return out;   // normalizePattern prevents this
  const baseW=pw*P.baseScale, baseH=ph*P.baseScale;
  const RAD=Math.PI/180;

  // Pass 1 — intrinsic size + rotation + the AXIS-ALIGNED BOUNDS those imply.
  // Spacing is driven by these actual bounds, never by the parent's size: that
  // substitution was the Stage 1.1 gap bug (see contract §1.2).
  // Ellipses use their EXACT rotated bounding box — the rectangle formula
  // (w|cos|+h|sin|) overestimates it, which padded rotated ellipses apart
  // even at gap 0.
  const aabb=(w,h,a)=>{
    const ca=Math.cos(a), sa=Math.sin(a);
    if(parent.type==='ellipse'){
      return [Math.sqrt(w*w*ca*ca+h*h*sa*sa), Math.sqrt(w*w*sa*sa+h*h*ca*ca)];
    }
    return [w*Math.abs(ca)+h*Math.abs(sa), w*Math.abs(sa)+h*Math.abs(ca)];
  };
  // Cell (0,0) is the PARENT itself: the grid grows right of and below it,
  // so the slot directly under the parent is a real instance, not a void.
  const cell=new Array(total);
  const [paw,pah]=aabb(pw,ph,0);
  cell[0]={w:pw,h:ph,rot:0,aw:paw,ah:pah,isParent:true};
  for(let r=0;r<rows;r++) for(let c=0;c<cols;c++){
    const i=r*cols+c;
    if(i===0) continue;
    const rw=rand01(P.seed,i,R_W);
    const rh=P.lockProportions?rw:rand01(P.seed,i,R_H);
    const w=baseW*(1-(1-MIN_SIZE_FACTOR)*P.widthVariation*rw);
    const h=baseH*(1-(1-MIN_SIZE_FACTOR)*P.heightVariation*rh);
    const rot=P.baseRotation+P.rotationStep*i+
      (P.rotationVariation?(rand01(P.seed,i,R_ROT)*2-1)*P.rotationVariation:0);
    const [aw,ah]=aabb(w,h,rot*RAD);
    cell[i]={w,h,rot,aw,ah};
  }

  // Pass 2 — row heights are the tallest actual bounds in each row, so rows
  // cannot overlap when heights vary.
  const rowH=new Array(rows).fill(0);
  for(let r=0;r<rows;r++) for(let c=0;c<cols;c++) rowH[r]=Math.max(rowH[r],cell[r*cols+c].ah);

  // Pass 3 — centres. Horizontal advance is sequential over ACTUAL bounds, so
  // hGap is the exact clear space for every adjacent pair, including at 0.
  // Row 0 chains off the parent (cell 0); later rows left-align to the
  // parent's left edge so the column beneath it is populated.
  const pCx=parent.x+pw/2, pCy=parent.y+ph/2;
  let rowCy=0;
  for(let r=0;r<rows;r++){
    rowCy = r===0 ? pCy : rowCy+rowH[r-1]/2+P.vGap+rowH[r]/2;
    let cx=0;
    for(let c=0;c<cols;c++){
      const i=r*cols+c, k=cell[i];
      if(i===0){ k.cx=pCx; k.cy=pCy; cx=pCx; continue; }
      cx = c===0 ? parent.x+k.aw/2 : cx+cell[i-1].aw/2+P.hGap+k.aw/2;
      k.cx=cx+r*P.rowOffsetX;
      k.cy=rowCy+c*P.colOffsetY;
      if(P.jitterX) k.cx+=(rand01(P.seed,i,R_JX)*2-1)*P.jitterX;
      if(P.jitterY) k.cy+=(rand01(P.seed,i,R_JY)*2-1)*P.jitterY;
    }
  }

  // Pass 4 — emit. Holes are applied LAST so omitting an instance never moves
  // the survivors; the slot grid above is already fixed. Cell 0 is the parent
  // and is never emitted as an instance.
  for(let r=0;r<rows;r++) for(let c=0;c<cols;c++){
    const i=r*cols+c, k=cell[i];
    if(i===0) continue;
    if(P.holes>0 && rand01(P.seed,i,R_HOLE)<P.holes) continue;
    const x=k.cx-k.w/2, y=k.cy-k.h/2;
    if(!isFinite(x)||!isFinite(y)||!(k.w>0)||!(k.h>0)) continue;
    const m=P.mirror;
    out.push({
      ...parent,
      id:parent.id+'#'+i, parentId:parent.id, instanceIndex:i,
      x, y, w:k.w, h:k.h,
      rot:k.rot,
      mirrorX: m==='horizontal' || (m==='alt-horizontal' && c%2===1),
      mirrorY: m==='vertical'   || (m==='alt-vertical'   && r%2===1),
      pattern:undefined,                        // never recurse
    });
  }
  return out;
}
/** Axis-aligned visual bounds of an instance's rotated geometry. */
function instanceBounds(o){
  // Must mirror the layout's aabb(): ellipses get their exact tangent box,
  // rectangles the rectangle AABB.
  const a=(o.rot||0)*Math.PI/180, ca=Math.cos(a), sa=Math.sin(a);
  let aw,ah;
  if(o.type==='ellipse'){
    aw=Math.sqrt(o.w*o.w*ca*ca+o.h*o.h*sa*sa);
    ah=Math.sqrt(o.w*o.w*sa*sa+o.h*o.h*ca*ca);
  }else{
    aw=o.w*Math.abs(ca)+o.h*Math.abs(sa);
    ah=o.w*Math.abs(sa)+o.h*Math.abs(ca);
  }
  const cx=o.x+o.w/2, cy=o.y+o.h/2;
  return {x:cx-aw/2,y:cy-ah/2,w:aw,h:ah};
}
/** Every derived instance in the document, in paint order. */
function allInstances(){
  if(!doc) return [];
  const out=[];
  doc.frame.children.forEach(c=>{ patternInstances(c).forEach(i=>out.push(i)); });
  return out;
}

/* Members of a blob/glass2 group: every shape on the page with that effect
 * enabled, plus each one's linked pattern copies. A lone shape still merges
 * with its own copies, so the original behaviour is a strict subset. */
function blobGroup(key){
  if(!doc) return [];
  const out=[];
  doc.frame.children.forEach(o=>{
    if(o.type==='text') return;
    const e=o.effects&&o.effects[key];
    if(!e||!e.on) return;
    out.push(o,...patternInstances(o));
  });
  return out;
}
/* Group members are one body, so they must agree on the group's settings.
 * Writing an edit to every member means it does not matter which member
 * happens to render the group — previously the first member's values won and
 * edits made on any other member were silently ignored. */
function applyToGroup(key,fn){
  if(!doc) return;
  doc.frame.children.forEach(o=>{
    const e=o.effects&&o.effects[key];
    if(e&&e.on) fn(e);
  });
}
function groupShapes(list){
  return list.slice(0,window.BlobEngine?window.BlobEngine.MAX:64).map(o=>({
    cx:o.x+o.w/2, cy:o.y+o.h/2, w:o.w, h:o.h,
    ellipse:o.type==='ellipse',
    radius:o.type==='ellipse'?0:clamp(o.radius||0,0,Math.min(o.w,o.h)/2),
  }));
}
function isFirstOfGroup(obj,key){
  const first=doc.frame.children.find(o=>o.type!=='text'&&o.effects&&o.effects[key]&&o.effects[key].on);
  return first===obj;
}

function drawDoc(c,W,H){
  const f=doc.frame;
  c.fillStyle=f.bg; c.fillRect(0,0,W,H);
  // Parent first, then its complete linked instances, through the SAME draw
  // path — which is what guarantees an ellipse parent yields ellipses.
  f.children.forEach(obj=>{
    const fx=obj.effects||{};
    const blobReady=obj.type!=='text'&&window.BlobEngine&&window.BlobEngine.available();
    // Blob / Glass 2 merge the parent WITH its pattern copies into one field,
    // so they must replace the whole parent+instances draw, not sit beside it.
    if(blobReady&&(fx.glass2&&fx.glass2.on||fx.blob&&fx.blob.on)){
      const key=(fx.glass2&&fx.glass2.on)?'glass2':'blob';
      // The whole group is drawn once, by its bottom-most member; the others
      // skip so the field is never rendered twice.
      if(!isFirstOfGroup(obj,key)) return;
      const objs=blobGroup(key).slice(0,window.BlobEngine.MAX);
      const members=groupShapes(objs);
      if(key==='glass2'){
        window.BlobEngine.liquid(c.canvas,W,H,members,fx.glass2,fx.glass2);
      }else{
        // Mask the object's REAL fill, so every fill type works unchanged.
        // Each member is painted through its OWN share of the blend, and the
        // shares sum to 1, so additive compositing reproduces the weighted
        // colour mix exactly. Colour therefore crosses the neck as a smooth
        // gradient — the defining look of a metaball merge — while every fill
        // type (gradients included) is preserved, because each layer is just
        // that shape's normal fill behind a soft mask.
        const tmp=document.createElement('canvas'); tmp.width=W; tmp.height=H;
        const t2=tmp.getContext('2d');
        const layer=document.createElement('canvas'); layer.width=W; layer.height=H;
        const l2=layer.getContext('2d');
        t2.globalCompositeOperation='lighter';
        let painted=false;
        objs.forEach((o,i)=>{
          const wm=window.BlobEngine.mask(W,H,members,fx.blob,i);
          if(!wm) return;
          l2.setTransform(1,0,0,1,0,0);
          l2.globalCompositeOperation='source-over';
          l2.clearRect(0,0,W,H);
          drawObject(l2,o,'flood');       // full fill, gradients intact
          // destination-in: keep the FILL's colour, take the mask's alpha.
          // source-in would keep the mask's own white pixels instead, which
          // paints the entire blob white.
          l2.globalCompositeOperation='destination-in';
          l2.drawImage(wm,0,0,W,H);       // keep only this shape's share
          t2.drawImage(layer,0,0);
          painted=true;
        });
        if(painted){
          c.save(); c.setTransform(1,0,0,1,0,0);
          c.globalAlpha=obj.opacity;
          const sh2=fx.shadow;
          if(sh2&&sh2.on){ c.shadowColor=hexAlpha(sh2.color,sh2.alpha); c.shadowBlur=sh2.blur;
                           c.shadowOffsetX=sh2.x; c.shadowOffsetY=sh2.y; }
          c.drawImage(tmp,0,0);
          c.restore();
        }
      }
      return;
    }
    const gla=fx.glass;
    if(gla&&gla.on&&obj.type!=='text'&&window.GlassEngine&&window.GlassEngine.available()){
      // Glass replaces the fill entirely: the shader refracts everything
      // painted so far (page bg + layers below), so the object's own
      // fill/shadow/grain are deliberately NOT painted first.
      // NOTE: requires c to be an untransformed frame-resolution canvas —
      // render() and exportPNG both satisfy this.
      const geoms=[obj,...patternInstances(obj)].map(o=>({
        cx:o.x+o.w/2, cy:o.y+o.h/2, w:o.w, h:o.h,
        // shader shapes: 0 rect, 1 circle, 2 pill. An elongated ellipse maps
        // to the pill (closest smooth footprint); rotation is not supported
        // by the shader and is ignored for the glass pass.
        shape: o.type==='ellipse' ? (Math.abs(o.w-o.h)<2?1:2) : 0,
        radius01: o.type==='ellipse'?0.5:clamp((o.radius||0)/Math.max(1,Math.min(o.w,o.h)),0,0.5),
      }));
      window.GlassEngine.render(c.canvas,W,H,geoms,gla);
      return;
    }
    drawObject(c,obj);
    patternInstances(obj).forEach(inst=>drawObject(c,inst));
  });
}
function drawObject(c,obj,plain){
  {
    c.save();
    // Rotation/mirror are applied about the instance centre BEFORE anything is
    // drawn, so geometry, gradient and effects all transform together.
    if(obj.rot||obj.mirrorX||obj.mirrorY){
      const cx=obj.x+obj.w/2, cy=obj.y+obj.h/2;
      c.translate(cx,cy);
      if(obj.rot) c.rotate(obj.rot*Math.PI/180);
      if(obj.mirrorX||obj.mirrorY) c.scale(obj.mirrorX?-1:1, obj.mirrorY?-1:1);
      c.translate(-cx,-cy);
    }
    c.globalAlpha=plain?1:obj.opacity;
    const sh=obj.effects.shadow;
    if(sh.on&&!plain){ c.shadowColor=hexAlpha(sh.color,sh.alpha); c.shadowBlur=sh.blur; c.shadowOffsetX=sh.x; c.shadowOffsetY=sh.y; }
    if(obj.type==='text'){
      c.font=`${obj.weight} ${obj.size}px Inter,-apple-system,sans-serif`;
      c.fillStyle=obj.color; c.textBaseline='top';
      c.textAlign=obj.align==='center'?'center':'left';
      c.fillText(obj.text,obj.x,obj.y);
      c.restore(); return;
    }
    const b={x:obj.x,y:obj.y,w:obj.w,h:obj.h};
    // A patterned parent still draws its OWN complete fill. Instances are
    // separate complete objects drawn by the caller; nothing is segmented.
    c.fillStyle=fillStyleFor(c,obj,b);
    if(plain==='flood'){
      // Blob layer: this shape's colour has to exist wherever the blend gives
      // it weight, including the neck outside its own outline.
      c.fillRect(0,0,c.canvas.width,c.canvas.height);
    } else {
      pathFor(c,obj); c.fill();
    }
    c.shadowColor='transparent';
    const gr=obj.effects.grain;
    if(gr.amount>0){
      if(!grainTile) grainTile=makeGrain();
      c.save();
      pathFor(c,obj); c.clip();
      c.globalAlpha=obj.opacity*gr.amount*0.35;
      c.globalCompositeOperation='overlay';
      c.fillStyle=c.createPattern(grainTile,'repeat');
      c.fillRect(b.x,b.y,b.w,b.h);
      c.restore();
    }
    c.restore();
  }
}
function textBox(obj){
  ctx.font=`${obj.weight} ${obj.size}px Inter,-apple-system,sans-serif`;
  const w=ctx.measureText(obj.text).width;
  const x=obj.align==='center'?obj.x-w/2:obj.x;
  return {x, y:obj.y, w, h:obj.size*1.2};
}
function boxOf(obj){ return obj.type==='text'?textBox(obj):{x:obj.x,y:obj.y,w:obj.w,h:obj.h}; }

function render(){
  const has=!!doc && doc.frame.children!==undefined;
  canvas.style.display=has?'':'none';   // nothing on the stage until a page exists
  if(!has){ canvas.width=1; canvas.height=1; return; }
  const f=doc.frame;
  const stage=$('stage'), pad=40;
  stage.classList.toggle('actual', viewMode==='actual');
  const availW=stage.clientWidth-pad, availH=stage.clientHeight-pad;
  const scale=viewMode==='actual' ? 1 : Math.min(1.5, availW/f.w, availH/f.h);
  canvas.width=Math.round(f.w*scale); canvas.height=Math.round(f.h*scale);
  // Paint at full frame resolution into an offscreen buffer first: the glass
  // engine samples real pixels, so it must never see a scaled transform.
  frameBuf.width=f.w; frameBuf.height=f.h;
  drawDoc(frameBuf.getContext('2d'),f.w,f.h);
  ctx.setTransform(scale,0,0,scale,0,0);
  ctx.drawImage(frameBuf,0,0);
  // selection overlay (screen-only)
  if(selInstance){
    // Instances get a dashed outline matching their own complete bounds, so a
    // derived object never looks like an editable source.
    const b=boxOf(selInstance);
    ctx.save();
    ctx.strokeStyle='#8b5cf6'; ctx.lineWidth=1.6/scale;
    ctx.setLineDash([6/scale,4/scale]);
    ctx.strokeRect(b.x,b.y,b.w,b.h);
    ctx.restore();
  }
  const obj=doc.frame.children[sel];
  if(obj){
    const b=boxOf(obj);
    ctx.strokeStyle='#3b82f6'; ctx.lineWidth=1.6/scale;
    ctx.strokeRect(b.x,b.y,b.w,b.h);
    if(obj.type!=='text'){
      const hs=7/scale;
      ctx.fillStyle='#fff'; ctx.strokeStyle='#3b82f6';
      ctx.fillRect(b.x+b.w-hs/2,b.y+b.h-hs/2,hs,hs);
      ctx.strokeRect(b.x+b.w-hs/2,b.y+b.h-hs/2,hs,hs);
    }
  }
  ctx.setTransform(1,0,0,1,0,0);
}

/* ================= UI sync ================= */
function refresh(){ render(); syncLayers(); syncInspector(); syncPageRow(); }

function syncLayers(){
  const list=$('layerList'); list.innerHTML='';
  if(!doc) return;
  const glyph={rect:'▭',ellipse:'◯',text:'T'};
  [...doc.frame.children].reverse().forEach((c,ri)=>{
    const i=doc.frame.children.length-1-ri;
    const row=document.createElement('div');
    row.className=(i===sel?'sel':'')+(c.pattern&&c.pattern.mode!=='none'?' isParent':'');
    row.innerHTML=`<span class="glyph">${glyph[c.type]||'▭'}</span>`;
    row.appendChild(document.createTextNode(c.type==='text'?c.text.slice(0,18):c.name));
    // Parents are labelled with their linked-instance count so the layer panel
    // distinguishes a pattern source from an ordinary object.
    const n=patternInstances(c).length;
    if(n){
      const badge=document.createElement('span');
      badge.className='linkBadge';
      badge.textContent=`⇢ ${n}`;
      badge.title=`${n} linked instance${n===1?'':'s'}`;
      row.appendChild(badge);
    }
    row.addEventListener('click',()=>{ sel=i; selInstance=null; fxPage=0; refresh(); });
    list.appendChild(row);
  });
}

const FX_PAGES=obj=>obj.type==='text' ? ['Text','Shadow'] : ['Pattern','Fill','Blob','Glass','Glass 2','Shadow','Grain'];

function syncInspector(){
  const obj=doc&&doc.frame.children[sel];
  // A derived instance is inspectable but never editable: showing the parent's
  // controls here would let a user change fields that are immediately
  // overwritten on the next layout.
  if(!obj && selInstance){
    const pi=doc.frame.children.findIndex(c=>c.id===selInstance.parentId);
    const parent=pi>=0?doc.frame.children[pi]:null;
    $('posSection').classList.add('disabled');
    $('engineSection').classList.add('disabled');
    $('engineSection').style.display='none';
    const hint=$('noSel');
    hint.style.display='';
    hint.innerHTML='';
    const box=document.createElement('div');
    box.className='instHint';
    box.textContent=`Linked instance #${selInstance.instanceIndex} of “${parent?parent.name:'unknown'}”. Its appearance and position are controlled by its parent.`;
    if(parent){
      const b=document.createElement('button');
      b.type='button'; b.textContent='Select parent';
      b.addEventListener('click',()=>{ sel=pi; selInstance=null; fxPage=0; refresh(); });
      box.appendChild(document.createElement('br'));
      box.appendChild(b);
    }
    hint.appendChild(box);
    return;
  }
  if($('noSel').firstChild&&$('noSel').querySelector('.instHint')) $('noSel').textContent='Select an element to edit it.';
  $('posSection').classList.toggle('disabled',!obj);
  $('engineSection').classList.toggle('disabled',!obj);
  $('engineSection').style.display=obj?'':'none';
  $('noSel').style.display=obj?'none':'';
  if(!obj) return;
  const b=boxOf(obj);
  $('pX').value=Math.round(obj.x); $('pY').value=Math.round(obj.y);
  $('pW').value=Math.round(b.w); $('pH').value=Math.round(b.h);
  const tx=obj.type==='text';
  $('pW').disabled=tx; $('pH').disabled=tx;
  $('pOpacity').value=Math.round(obj.opacity*100);
  $('pOpacityV').textContent=Math.round(obj.opacity*100)+'%';
  buildFx(obj);
}

/* ---- engines panel ---- */
function buildFx(obj){
  const pages=FX_PAGES(obj);
  fxPage=clamp(fxPage,0,pages.length-1);
  $('fxTitle').textContent=pages[fxPage];
  $('fxPager').style.display=pages.length>1?'':'none';
  const body=$('fxBody'); body.innerHTML='';
  const add=h=>{ body.insertAdjacentHTML('beforeend',h); };
  const page=pages[fxPage];

  if(page==='Pattern'){
    const E=obj.pattern;
    if(!E){
      add(`<div class="fxHint">No pattern on this object.</div>`);
      add(`<button class="rollBtn" id="pAdd">+ Add pattern</button>`);
      $('pAdd').addEventListener('click',()=>{ obj.pattern=normalizePattern({}); pushHistory(); refresh(); });
      return;
    }
    // Paired slider + number box. The number input is the keyboard path; both
    // stay in sync, and every control carries an explicit <label for>.
    const row=(id,label,min,max,step,val,unit,hint)=>{
      add(`<div class="pRow">
        <label for="${id}n">${label}${hint?` <span class="pQ" title="${hint}">?</span>`:''}</label>
        <div class="pCtl">
          <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}" aria-labelledby="${id}n" tabindex="-1">
          <input type="number" id="${id}n" min="${min}" max="${max}" step="${step}" value="${val}" aria-label="${label}${unit?' in '+unit:''}">
          <span class="pUnit">${unit||''}</span>
        </div></div>`);
    };
    const wire=(id,set)=>{
      const r=$(id), n=$(id+'n');
      const apply=(v,commit)=>{ r.value=v; n.value=v; set(+v); commit?(pushHistory(),refresh()):render(); };
      r.addEventListener('input',e=>apply(e.target.value,false));
      r.addEventListener('change',e=>apply(e.target.value,true));
      n.addEventListener('input',e=>{ if(e.target.value!=='') apply(e.target.value,false); });
      n.addEventListener('change',e=>apply(e.target.value===''?r.value:e.target.value,true));
    };
    const sect=t=>add(`<div class="pSect">${t}</div>`);

    sect('Layout');
    row('pCols','Columns',1,MAX_GRID_AXIS,1,E.columns,'','Generated instances across. The parent is not counted.');
    row('pRows','Rows',1,MAX_GRID_AXIS,1,E.rows,'','Generated instances down. The parent is not counted.');
    wire('pCols',v=>{ E.columns=v; });
    wire('pRows',v=>{ E.rows=v; });
    const totalNow=E.columns*E.rows;
    add(`<div class="fxHint">${totalNow} instance${totalNow===1?'':'s'} · max ${MAX_PATTERN_INSTANCES}. Rows are reduced if the grid would exceed it.</div>`);

    sect('Spacing');
    row('pHG','Horizontal gap',0,MAX_GAP,1,E.hGap,'px','Exact clear space between adjacent instance bounds. 0 = touching.');
    row('pVG','Vertical gap',0,MAX_GAP,1,E.vGap,'px','Exact clear space between rows. 0 = touching.');
    row('pROX','Row offset X',-MAX_OFFSET,MAX_OFFSET,1,E.rowOffsetX,'px','Shifts each successive row sideways (brick/stagger).');
    row('pCOY','Column offset Y',-MAX_OFFSET,MAX_OFFSET,1,E.colOffsetY,'px','Shifts each successive column down.');
    wire('pHG',v=>E.hGap=v); wire('pVG',v=>E.vGap=v);
    wire('pROX',v=>E.rowOffsetX=v); wire('pCOY',v=>E.colOffsetY=v);

    sect('Size');
    row('pBS','Base scale',10,200,1,Math.round(E.baseScale*100),'%','Instance size relative to the parent. Does not resize the parent.');
    $('pBS').addEventListener('input',e=>{ E.baseScale=+e.target.value/100; $('pBSn').value=e.target.value; render(); });
    $('pBS').addEventListener('change',()=>{ pushHistory(); refresh(); });
    $('pBSn').addEventListener('change',e=>{ const v=clamp(+e.target.value||100,10,200); E.baseScale=v/100; $('pBS').value=v; e.target.value=v; pushHistory(); refresh(); });
    add(`<label class="pCheck"><input type="checkbox" id="pLock" ${E.lockProportions?'checked':''}> Lock proportions</label>`);
    $('pLock').addEventListener('change',e=>{ E.lockProportions=e.target.checked; if(e.target.checked) E.heightVariation=E.widthVariation; pushHistory(); refresh(); });
    row('pWV','Width variation',0,100,1,Math.round(E.widthVariation*100),'%','Shrinks instances by up to this much. 0% = all identical.');
    row('pHV','Height variation',0,100,1,Math.round(E.heightVariation*100),'%','Shrinks instance height. Driven by width when proportions are locked.');
    wire('pWV',v=>{ E.widthVariation=v/100; if(E.lockProportions){ E.heightVariation=v/100; const hv=$('pHV'),hn=$('pHVn'); if(hv){hv.value=v;hn.value=v;} } });
    wire('pHV',v=>{ E.heightVariation=v/100; if(E.lockProportions){ E.widthVariation=v/100; const wv=$('pWV'),wn=$('pWVn'); if(wv){wv.value=v;wn.value=v;} } });
    if(E.lockProportions) add(`<div class="fxHint">Proportions locked — width and height vary together.</div>`);

    sect('Transform');
    row('pBR','Base rotation',-180,180,1,E.baseRotation,'°','Applied to every instance.');
    row('pRS','Rotation progression',-180,180,1,E.rotationStep,'°','Added per instance in sequence order.');
    row('pRV','Rotation variation',0,180,1,E.rotationVariation,'°','Deterministic random rotation, ± this amount.');
    wire('pBR',v=>E.baseRotation=v); wire('pRS',v=>E.rotationStep=v); wire('pRV',v=>E.rotationVariation=v);
    add(`<div class="pRow"><label for="pMir">Mirror</label><div class="pCtl">
      <select id="pMir" aria-label="Mirror mode">${MIRRORS.map(m=>`<option value="${m}"${m===E.mirror?' selected':''}>${m}</option>`).join('')}</select>
      </div></div>`);
    $('pMir').addEventListener('change',e=>{ E.mirror=e.target.value; pushHistory(); refresh(); });

    add(`<details class="pAdv"><summary>Advanced</summary><div id="pAdvBody"></div></details>`);
    const advBody=$('pAdvBody');
    const addA=h=>advBody.insertAdjacentHTML('beforeend',h);
    const rowA=(id,label,min,max,step,val,unit,hint)=>{
      addA(`<div class="pRow">
        <label for="${id}n">${label}${hint?` <span class="pQ" title="${hint}">?</span>`:''}</label>
        <div class="pCtl">
          <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}" aria-labelledby="${id}n" tabindex="-1">
          <input type="number" id="${id}n" min="${min}" max="${max}" step="${step}" value="${val}" aria-label="${label}${unit?' in '+unit:''}">
          <span class="pUnit">${unit||''}</span>
        </div></div>`);
    };
    rowA('pJX','Position jitter X',0,MAX_JITTER,1,E.jitterX,'px','Deterministic random horizontal displacement.');
    rowA('pJY','Position jitter Y',0,MAX_JITTER,1,E.jitterY,'px','Deterministic random vertical displacement.');
    rowA('pHoles','Pattern holes',0,90,1,Math.round(E.holes*100),'%','Omits whole instances. Slots stay put; the parent is never removed.');
    wire('pJX',v=>E.jitterX=v); wire('pJY',v=>E.jitterY=v);
    wire('pHoles',v=>E.holes=v/100);
    addA(`<button class="rollBtn" id="pRoll">↻ Reroll pattern</button>`);
    // Math.random is confined to this user action; layout stays pure.
    $('pRoll').addEventListener('click',()=>{ E.seed=Math.floor(Math.random()*99999999)||1; pushHistory(); refresh(); });

    add(`<button class="rollBtn danger" id="pRemove">Remove pattern</button>`);
    $('pRemove').addEventListener('click',()=>{ delete obj.pattern; pushHistory(); refresh(); });
  }

  if(page==='Fill'){
    add(`<label class="slider">Type
      <select id="fKind">
        <option value="solid">Solid</option>
        <option value="linear">Linear gradient</option>
        <option value="radial">Radial gradient</option>
      </select></label>`);
    $('fKind').value=obj.fill.kind;
    $('fKind').addEventListener('change',e=>{
      const k=e.target.value;
      if(k==='solid') obj.fill={kind:'solid',color:firstColor(obj.fill)};
      else obj.fill={kind:k,angle:obj.fill.angle||90,
        stops:obj.fill.stops||[{pos:0,color:firstColor(obj.fill)},{pos:1,color:'#333333'}]};
      pushHistory(); refresh();
    });
    if(obj.fill.kind==='solid'){
      add(`<label class="slider">Color <input type="color" id="fColor" value="${obj.fill.color}"></label>`);
      $('fColor').addEventListener('input',e=>{ obj.fill.color=e.target.value; render(); });
      $('fColor').addEventListener('change',()=>{ pushHistory(); });
    } else {
      if(obj.fill.kind==='linear'){
        add(`<label class="slider">Angle <span id="fAngV">${obj.fill.angle}°</span>
          <input type="range" id="fAng" min="0" max="359" value="${obj.fill.angle}"></label>`);
        $('fAng').addEventListener('input',e=>{ obj.fill.angle=+e.target.value; $('fAngV').textContent=e.target.value+'°'; render(); });
        $('fAng').addEventListener('change',()=>pushHistory());
      }
      obj.fill.stops.forEach((s,i)=>{
        add(`<div class="stopRow"><input type="color" data-si="${i}" class="stopC" value="${s.color}">
             <input type="range" data-si="${i}" class="stopP" min="0" max="100" value="${Math.round(s.pos*100)}"></div>`);
      });
      body.querySelectorAll('.stopC').forEach(el=>{
        el.addEventListener('input',e=>{ obj.fill.stops[+e.target.dataset.si].color=e.target.value; render(); });
        el.addEventListener('change',()=>pushHistory());
      });
      body.querySelectorAll('.stopP').forEach(el=>{
        el.addEventListener('input',e=>{ obj.fill.stops[+e.target.dataset.si].pos=+e.target.value/100; render(); });
        el.addEventListener('change',()=>pushHistory());
      });
    }
    if(obj.type==='rect'){
      add(`<label class="slider">Corner radius <span id="fRadV">${obj.radius}</span>
        <input type="range" id="fRad" min="0" max="200" value="${obj.radius}"></label>`);
      $('fRad').addEventListener('input',e=>{ obj.radius=+e.target.value; $('fRadV').textContent=e.target.value; render(); });
      $('fRad').addEventListener('change',()=>pushHistory());
    }
  }

  if(page==='Text'){
    add(`<label class="slider">Content <input type="text" id="tText" value=""></label>`);
    $('tText').value=obj.text;
    $('tText').addEventListener('input',e=>{ obj.text=e.target.value; render(); syncLayers(); });
    $('tText').addEventListener('change',()=>pushHistory());
    add(`<label class="slider">Size <span id="tSizeV">${obj.size}</span>
      <input type="range" id="tSize" min="8" max="200" value="${obj.size}"></label>`);
    $('tSize').addEventListener('input',e=>{ obj.size=+e.target.value; $('tSizeV').textContent=e.target.value; render(); });
    $('tSize').addEventListener('change',()=>pushHistory());
    add(`<div class="row2">
      <label class="slider">Weight
        <select id="tWeight"><option>400</option><option>600</option><option>800</option></select></label>
      <label class="slider">Color <input type="color" id="tColor" value="${obj.color}"></label>
    </div>`);
    $('tWeight').value=String(obj.weight);
    $('tWeight').addEventListener('change',e=>{ obj.weight=+e.target.value; pushHistory(); render(); });
    $('tColor').addEventListener('input',e=>{ obj.color=e.target.value; render(); });
    $('tColor').addEventListener('change',()=>pushHistory());
  }

  if(page==='Blob'||page==='Glass 2'){
    const isG2=page==='Glass 2';
    const B=isG2?obj.effects.glass2:obj.effects.blob;
    if(!(window.BlobEngine&&window.BlobEngine.available())){
      add(`<div class="fxHint">Needs WebGL2, which this browser doesn't provide.</div>`);
    } else {
      add(`<label class="slider"><input type="checkbox" id="bbOn" ${B.on?'checked':''}> Enable ${isG2?'liquid glass':'blob'}</label>`);
      $('bbOn').addEventListener('change',e=>{ B.on=e.target.checked; pushHistory(); refresh(); });
      if(B.on){
        const key=isG2?'glass2':'blob';
        const n=blobGroup(key).length;
        add(n<2
          ? `<div class="fxHint" style="color:#b45309">Merging <b>1</b> shape — nothing to blend with yet, so Smoothness has no effect. Give this shape a <b>Pattern</b> with a negative gap, or enable ${isG2?'Glass 2':'Blob'} on another shape so the two merge.</div>`
          : `<div class="fxHint">Merging <b>${n}</b> shapes — every shape on this page with ${isG2?'Glass 2':'Blob'} on, plus their pattern copies.</div>`);
        add(`<label class="slider">Smoothness <span id="bbSmV">${B.smoothness}px</span>
          <input type="range" id="bbSm" min="0" max="300" value="${B.smoothness}"></label>`);
        $('bbSm').addEventListener('input',e=>{
          applyToGroup(key,p=>p.smoothness=+e.target.value);
          $('bbSmV').textContent=e.target.value+'px'; render();
        });
        $('bbSm').addEventListener('change',()=>pushHistory());
        add(`<label class="slider">Combine
          <select id="bbMode">
            <option value="union">Union — merge</option>
            <option value="intersect">Intersection — overlap only</option>
            <option value="difference">Difference — subtract</option>
          </select></label>`);
        $('bbMode').value=B.mode;
        $('bbMode').addEventListener('change',e=>{
          applyToGroup(key,p=>p.mode=e.target.value); pushHistory(); refresh();
        });
        if(isG2){
          const sl=(id,label,min,max,val,fmt)=>{
            add(`<label class="slider">${label} <span id="${id}V">${fmt(val)}</span>
              <input type="range" id="${id}" min="${min}" max="${max}" value="${val}"></label>`);
          };
          sl('g2Depth','Depth',-200,200,B.depth,v=>v);
          sl('g2Refr','Refraction',-200,200,B.refraction,v=>v);
          sl('g2Frost','Frost',0,100,B.frost,v=>v);
          sl('g2Refl','Reflection',0,100,B.reflection,v=>v);
          sl('g2Light','Light',0,100,B.light,v=>v);
          sl('g2Disp','Dispersion',0,200,B.dispersion,v=>v);
          sl('g2Op','Opacity',0,100,B.opacity,v=>v+'%');
          const wire=(id,f,fmt)=>{
            $(id).addEventListener('input',e=>{ f(+e.target.value); $(id+'V').textContent=fmt(+e.target.value); render(); });
            $(id).addEventListener('change',()=>pushHistory());
          };
          const G=(f)=>(v)=>applyToGroup('glass2',p=>f(p,v));
          wire('g2Depth',G((p,v)=>p.depth=v),v=>v); wire('g2Refr',G((p,v)=>p.refraction=v),v=>v);
          wire('g2Frost',G((p,v)=>p.frost=v),v=>v); wire('g2Refl',G((p,v)=>p.reflection=v),v=>v);
          wire('g2Light',G((p,v)=>p.light=v),v=>v); wire('g2Disp',G((p,v)=>p.dispersion=v),v=>v);
          wire('g2Op',G((p,v)=>p.opacity=v),v=>v+'%');
          add(`<label class="slider">Tint <input type="color" id="g2Tint" value="${B.tint}"></label>`);
          $('g2Tint').addEventListener('input',e=>{ applyToGroup('glass2',p=>p.tint=e.target.value); render(); });
          $('g2Tint').addEventListener('change',()=>pushHistory());
          add(`<div class="fxHint">The merged blob field driven through the glass optics — the shapes fuse, then refract as one body.</div>`);
        } else {
          add(`<div class="fxHint">Shapes fuse organically as they approach (SDF smooth-union). Uses this shape's Fill.</div>`);
        }
      }
    }
  }

  if(page==='Glass'){
    const G=obj.effects.glass;
    if(!(window.GlassEngine&&window.GlassEngine.available())){
      add(`<div class="fxHint">Glass needs WebGL2, which this browser doesn't provide.</div>`);
    } else {
      add(`<label class="slider"><input type="checkbox" id="glOn" ${G.on?'checked':''}> Enable glass</label>`);
      $('glOn').addEventListener('change',e=>{ G.on=e.target.checked; pushHistory(); refresh(); });
      if(G.on){
        const sl=(id,label,min,max,val,fmt)=>{
          add(`<label class="slider">${label} <span id="${id}V">${fmt(val)}</span>
            <input type="range" id="${id}" min="${min}" max="${max}" value="${val}"></label>`);
        };
        sl('glDepth','Depth',-200,200,G.depth,v=>v);
        sl('glRefr','Refraction',-200,200,G.refraction,v=>v);
        sl('glFrost','Frost',0,100,G.frost,v=>v);
        sl('glRefl','Reflection',0,100,G.reflection,v=>v);
        sl('glLight','Light',0,100,G.light,v=>v);
        sl('glDisp','Dispersion',0,200,G.dispersion,v=>v);
        sl('glOp','Opacity',0,100,G.opacity,v=>v+'%');
        const wire=(id,f,fmt)=>{
          $(id).addEventListener('input',e=>{ f(+e.target.value); $(id+'V').textContent=fmt(+e.target.value); render(); });
          $(id).addEventListener('change',()=>pushHistory());
        };
        wire('glDepth',v=>G.depth=v,v=>v);
        wire('glRefr',v=>G.refraction=v,v=>v);
        wire('glFrost',v=>G.frost=v,v=>v);
        wire('glRefl',v=>G.reflection=v,v=>v);
        wire('glLight',v=>G.light=v,v=>v);
        wire('glDisp',v=>G.dispersion=v,v=>v);
        wire('glOp',v=>G.opacity=v,v=>v+'%');
        add(`<label class="slider">Tint <input type="color" id="glTint" value="${G.tint}"></label>`);
        $('glTint').addEventListener('input',e=>{ G.tint=e.target.value; render(); });
        $('glTint').addEventListener('change',()=>pushHistory());
        add(`<div class="fxHint">Physically-based glass: refracts the layers behind this shape (IOR 1.52). Replaces the Fill while enabled; pattern copies become glass too.</div>`);
      }
    }
  }

  if(page==='Shadow'){
    const sh=obj.effects.shadow;
    add(`<label class="slider"><input type="checkbox" id="shOn" ${sh.on?'checked':''}> Enable shadow</label>`);
    $('shOn').addEventListener('change',e=>{ sh.on=e.target.checked; pushHistory(); refresh(); });
    if(sh.on){
      const sl=(id,label,min,max,val)=>{
        add(`<label class="slider">${label} <span id="${id}V">${val}</span>
          <input type="range" id="${id}" min="${min}" max="${max}" value="${val}"></label>`);
      };
      sl('shX','Offset X',-60,60,sh.x); sl('shY','Offset Y',-60,60,sh.y);
      sl('shBlur','Blur',0,120,sh.blur); sl('shA','Opacity %',0,100,Math.round(sh.alpha*100));
      const wire=(id,f)=>{
        $(id).addEventListener('input',e=>{ f(+e.target.value); $(id+'V').textContent=e.target.value; render(); });
        $(id).addEventListener('change',()=>pushHistory());
      };
      wire('shX',v=>sh.x=v); wire('shY',v=>sh.y=v); wire('shBlur',v=>sh.blur=v); wire('shA',v=>sh.alpha=v/100);
      add(`<label class="slider">Color <input type="color" id="shC" value="${sh.color}"></label>`);
      $('shC').addEventListener('input',e=>{ sh.color=e.target.value; render(); });
      $('shC').addEventListener('change',()=>pushHistory());
    }
  }

  if(page==='Grain'){
    const gr=obj.effects.grain;
    add(`<label class="slider">Amount <span id="grAV">${Math.round(gr.amount*100)}%</span>
      <input type="range" id="grA" min="0" max="100" value="${Math.round(gr.amount*100)}"></label>`);
    $('grA').addEventListener('input',e=>{ gr.amount=+e.target.value/100; $('grAV').textContent=e.target.value+'%'; render(); });
    $('grA').addEventListener('change',()=>pushHistory());
  }
}
function firstColor(fill){
  if(fill.kind==='solid') return fill.color;
  return (fill.stops&&fill.stops[0]&&fill.stops[0].color)||'#cccccc';
}
$('fxPrev').addEventListener('click',()=>{ fxPage--; syncInspector(); });
$('fxNext').addEventListener('click',()=>{ fxPage++; syncInspector(); });

/* engine search: type to find an engine by name, click result to open it */
$('engineSearch').addEventListener('input',()=>{
  const obj=doc&&doc.frame.children[sel];
  const box=$('engineResults');
  box.innerHTML='';
  const q=$('engineSearch').value.trim().toLowerCase();
  if(!obj||!q) return;
  FX_PAGES(obj).forEach((name,i)=>{
    if(!name.toLowerCase().includes(q)) return;
    const b=document.createElement('button');
    b.type='button'; b.textContent=name;
    b.addEventListener('click',()=>{
      fxPage=i;
      $('engineSearch').value=''; box.innerHTML='';
      syncInspector();
    });
    box.appendChild(b);
  });
  if(!box.children.length){
    const d=document.createElement('div');
    d.className='noHit'; d.textContent='No engine matches';
    box.appendChild(d);
  }
});
$('engineSearch').addEventListener('keydown',e=>{
  if(e.key==='Enter'){
    const first=$('engineResults').querySelector('button');
    if(first) first.click();
  }
  e.stopPropagation();
});

/* ---- position inputs ---- */
[['pX','x'],['pY','y'],['pW','w'],['pH','h']].forEach(([id,k])=>{
  $(id).addEventListener('input',e=>{
    const obj=doc&&doc.frame.children[sel]; if(!obj)return;
    const v=parseFloat(e.target.value); if(isNaN(v))return;
    if(obj.type==='text'&&(k==='w'||k==='h'))return;
    obj[k]=v; render();
  });
  $(id).addEventListener('change',()=>pushHistory());
});
$('pOpacity').addEventListener('input',e=>{
  const obj=doc&&doc.frame.children[sel]; if(!obj)return;
  obj.opacity=+e.target.value/100; $('pOpacityV').textContent=e.target.value+'%'; render();
});
$('pOpacity').addEventListener('change',()=>pushHistory());
document.querySelectorAll('#alignRow button').forEach(btn=>{
  btn.addEventListener('click',()=>{
    const obj=doc&&doc.frame.children[sel]; if(!obj)return;
    const f=doc.frame, b=boxOf(obj);
    switch(btn.dataset.align){
      case 'left': obj.x=0+(obj.x-b.x); break;
      case 'hcenter': obj.x=(f.w-b.w)/2+(obj.x-b.x); break;
      case 'right': obj.x=f.w-b.w+(obj.x-b.x); break;
      case 'top': obj.y=0; break;
      case 'vcenter': obj.y=(f.h-b.h)/2; break;
      case 'bottom': obj.y=f.h-b.h; break;
    }
    pushHistory(); refresh();
  });
});

/* ================= canvas interaction ================= */
function evtFrame(e){
  const r=canvas.getBoundingClientRect();
  const f=doc.frame;
  return {x:(e.clientX-r.left)/r.width*f.w, y:(e.clientY-r.top)/r.height*f.h};
}
function hit(px,py){
  const ch=doc.frame.children;
  for(let i=ch.length-1;i>=0;i--){
    const b=boxOf(ch[i]);
    if(px>=b.x&&px<=b.x+b.w&&py>=b.y&&py<=b.y+b.h) return i;
  }
  return -1;
}
/** Topmost derived instance under the point, or null. Parents win over
 *  instances, so clicking the source never selects a copy. */
function hitInstance(px,py){
  const list=allInstances();
  for(let i=list.length-1;i>=0;i--){
    const o=list[i], b=boxOf(o);
    if(px>=b.x&&px<=b.x+b.w&&py>=b.y&&py<=b.y+b.h) return o;
  }
  return null;
}
let drag=null;
canvas.addEventListener('pointerdown',e=>{
  if(!doc){
    // no page yet: a shape tool means the user wants to start — open the
    // New Page flow rather than silently inventing a canvas
    if(tool!=='select') openPageModal();
    return;
  }
  const p=evtFrame(e);
  if(tool!=='select'){ addShapeAt(tool,p); setTool('select'); return; }
  const i=hit(p.x,p.y);
  // Instances are inspectable but never draggable: they are derived, and
  // layout is owned by the parent's pattern settings.
  selInstance = i>=0 ? null : hitInstance(p.x,p.y);
  sel=i; fxPage=0;
  if(i>=0){
    const obj=doc.frame.children[i], b=boxOf(obj);
    const nearHandle=obj.type!=='text' &&
      Math.abs(p.x-(b.x+b.w))<12 && Math.abs(p.y-(b.y+b.h))<12;
    drag=nearHandle?{mode:'resize'}:{mode:'move',dx:obj.x-p.x,dy:obj.y-p.y};
    try{canvas.setPointerCapture(e.pointerId);}catch(_){}
  }
  refresh();
});
canvas.addEventListener('pointermove',e=>{
  const obj=doc&&doc.frame.children[sel];
  if(!drag||!obj) return;
  const p=evtFrame(e);
  if(drag.mode==='move'){ obj.x=Math.round(p.x+drag.dx); obj.y=Math.round(p.y+drag.dy); }
  else{ obj.w=Math.max(8,Math.round(p.x-obj.x)); obj.h=Math.max(8,Math.round(p.y-obj.y)); }
  render(); syncInspector();
});
const endDrag=e=>{
  if(!drag) return;
  drag=null; pushHistory();
  try{canvas.releasePointerCapture(e.pointerId);}catch(_){}
};
canvas.addEventListener('pointerup',endDrag);
canvas.addEventListener('pointercancel',endDrag);

/* ================= tools ================= */
function setTool(t){
  tool=t;
  document.querySelectorAll('.tool').forEach(b=>b.classList.toggle('active',b.dataset.tool===t));
  canvas.style.cursor=t==='select'?'default':'crosshair';
}
document.querySelectorAll('.tool').forEach(b=>b.addEventListener('click',()=>setTool(b.dataset.tool)));
function addShapeAt(kind,p){
  if(!doc){ openPageModal(); return; }   // no silent premade page
  const f=doc.frame;
  let obj;
  if(kind==='text') obj={type:'text',name:'Text',x:p.x,y:p.y,text:'Text',size:36,weight:600,color:'#111111',align:'left',opacity:1};
  else obj={type:kind,name:kind==='rect'?'Rectangle':'Ellipse',
    x:p.x-80,y:p.y-60,w:160,h:120,radius:kind==='rect'?8:0,opacity:1,
    fill:{kind:'solid',color:'#d9d9d9'}};
  obj.effects=DEFAULT_EFFECTS();
  if(obj.type!=='text') obj.pattern=DEFAULT_PATTERN();
  obj.id=newId();
  f.children.push(obj);
  sel=f.children.length-1; fxPage=0;
  pushHistory(); refresh();
}

/* ================= menus / commands ================= */
document.querySelectorAll('.menu').forEach(m=>{
  m.addEventListener('click',e=>{
    document.querySelectorAll('.menu').forEach(o=>{ if(o!==m)o.classList.remove('open'); });
    m.classList.toggle('open');
    e.stopPropagation();
  });
});
document.addEventListener('click',()=>document.querySelectorAll('.menu').forEach(m=>m.classList.remove('open')));

function exportPNG(){
  if(!doc) return;
  const f=doc.frame;
  const c=document.createElement('canvas'); c.width=f.w; c.height=f.h;
  drawDoc(c.getContext('2d'),f.w,f.h);
  c.toBlob(b=>{
    const u=URL.createObjectURL(b), a=document.createElement('a');
    a.href=u; a.download=(f.name||'creative')+'.png'; a.click();
    setTimeout(()=>URL.revokeObjectURL(u),2000);
  },'image/png');
}
function duplicateSel(){
  const obj=doc&&doc.frame.children[sel]; if(!obj)return;
  const c=JSON.parse(JSON.stringify(obj));
  // A fresh id makes the copy an INDEPENDENT parent: its instances derive from
  // it, not from the original, so the two compositions never stay linked.
  c.id=newId();
  c.x+=16; c.y+=16; c.name=obj.name+' copy';
  doc.frame.children.push(c);
  sel=doc.frame.children.length-1;
  pushHistory(); refresh();
}
function deleteSel(){
  if(!doc||sel<0)return;
  doc.frame.children.splice(sel,1); sel=-1;
  pushHistory(); refresh();
}
/* ---------------- New Page flow ---------------- */
function openPageModal(){
  $('npName').value='Page '+(pages.length+1);
  $('pageModal').style.display='flex';
}
function closePageModal(){ $('pageModal').style.display='none'; }
function syncPageRow(){
  const list=$('pageList'); list.innerHTML='';
  pages.forEach((pg,i)=>{
    const row=document.createElement('div');
    row.className='pageRow'+(i===pageIdx?' sel':'');
    row.textContent=pg.frame.name;
    row.title=`${pg.frame.w}×${pg.frame.h}`;
    row.addEventListener('click',()=>{
      setActivePage(i); sel=-1; selInstance=null; refresh();
    });
    list.appendChild(row);
  });
}
function createPage(){
  const w=clamp(Math.round(+$('npW').value)||900,100,4000);
  const h=clamp(Math.round(+$('npH').value)||600,100,4000);
  const gradient=document.querySelector('input[name="bgMode"]:checked').value==='gradient';
  const bg=$('npBg').value;
  const children=[];
  if(gradient){
    // Background as a real layer so the full Fill engine can refine it later
    // ("color engine"): it is an ordinary rect with a linear-gradient fill.
    children.push({type:'rect',name:'Background',x:0,y:0,w,h,radius:0,opacity:1,
      fill:{kind:'linear',angle:+$('npAng').value,
            stops:[{pos:0,color:$('npG1').value},{pos:1,color:$('npG2').value}]}});
  }
  const name=($('npName').value||'').trim()||('Page '+(pages.length+1));
  pages.push(normalizeDoc({frame:{name,w,h,bg:gradient?$('npG1').value:bg,children}}));
  setActivePage(pages.length-1);
  sel=-1; selInstance=null;
  closePageModal();
  pushHistory(); refresh();
}
document.querySelectorAll('#sizeChips button').forEach(b=>{
  b.addEventListener('click',()=>{
    document.querySelectorAll('#sizeChips button').forEach(o=>o.classList.remove('on'));
    b.classList.add('on');
    $('npW').value=b.dataset.w; $('npH').value=b.dataset.h;
  });
});
['npW','npH'].forEach(id=>$(id).addEventListener('input',()=>{
  document.querySelectorAll('#sizeChips button').forEach(o=>o.classList.remove('on'));
}));
document.querySelectorAll('input[name="bgMode"]').forEach(r=>{
  r.addEventListener('change',()=>{
    const grad=document.querySelector('input[name="bgMode"]:checked').value==='gradient';
    $('bgSolid').style.display=grad?'none':'';
    $('bgGrad').style.display=grad?'':'none';
  });
});
document.querySelectorAll('#swatches button').forEach(b=>{
  b.addEventListener('click',()=>{ $('npBg').value=b.dataset.c; });
});
$('npAng').addEventListener('input',e=>{ $('npAngV').textContent=e.target.value+'°'; });
$('npCreate').addEventListener('click',createPage);
$('npCancel').addEventListener('click',closePageModal);
$('pageModal').addEventListener('click',e=>{ if(e.target.id==='pageModal') closePageModal(); });
$('btnNewPage').addEventListener('click',openPageModal);

const CMDS={
  new:openPageModal,
  exportPng:exportPNG, undo, redo, duplicate:duplicateSel, delete:deleteSel,
  zoomFit(){ viewMode='fit'; render(); },
  zoomActual(){ viewMode='actual'; render(); },
};
/* Effects menu: jump the inspector to that engine for the selected object. */
document.querySelectorAll('.dropdown button[data-fx]').forEach(b=>{
  b.addEventListener('click',e=>{
    e.stopPropagation();
    document.querySelectorAll('.menu').forEach(m=>m.classList.remove('open'));
    const obj=doc&&doc.frame.children[sel];
    if(!obj) return;
    const i=FX_PAGES(obj).indexOf(b.dataset.fx);
    if(i>=0){ fxPage=i; syncInspector(); }
  });
});
document.querySelectorAll('.dropdown button').forEach(b=>{
  b.addEventListener('click',e=>{ e.stopPropagation();
    document.querySelectorAll('.menu').forEach(m=>m.classList.remove('open'));
    CMDS[b.dataset.cmd]&&CMDS[b.dataset.cmd]();
  });
});
document.addEventListener('keydown',e=>{
  if(/input|select|textarea/i.test(e.target.tagName||''))return;
  const meta=e.metaKey||e.ctrlKey;
  if(meta&&e.key==='z'&&!e.shiftKey){ e.preventDefault(); undo(); }
  else if(meta&&((e.key==='z'&&e.shiftKey)||e.key==='y')){ e.preventDefault(); redo(); }
  else if(meta&&e.key==='d'){ e.preventDefault(); duplicateSel(); }
  else if(e.key==='Escape'&&$('pageModal').style.display!=='none'){ closePageModal(); }
  else if(e.key==='Delete'||e.key==='Backspace'){ e.preventDefault(); deleteSel(); }
  else if(e.key==='v'||e.key==='V') setTool('select');
  else if(e.key==='r'||e.key==='R') setTool('rect');
  else if(e.key==='o'||e.key==='O') setTool('ellipse');
  else if(e.key==='t'||e.key==='T') setTool('text');
});

/* ================= agent bar ================= */
let attachedImage=null;
function setAttachment(dataUrl){
  attachedImage=dataUrl;
  $('attachChip').style.display=dataUrl?'':'none';
  $('attachBtn').style.display=dataUrl?'none':'';
  if(dataUrl) $('attachThumb').src=dataUrl;
}
$('attachBtn').addEventListener('click',()=>$('fileInput').click());
$('attachX').addEventListener('click',()=>setAttachment(null));
$('fileInput').addEventListener('change',e=>{
  const f=e.target.files[0]; if(!f)return;
  const rd=new FileReader();
  rd.onload=()=>setAttachment(rd.result);
  rd.readAsDataURL(f);
  e.target.value='';
});
document.addEventListener('paste',e=>{
  const items=[...(e.clipboardData?.items||[])];
  const img=items.find(i=>i.type.startsWith('image/'));
  if(!img) return;
  const rd=new FileReader();
  rd.onload=()=>setAttachment(rd.result);
  rd.readAsDataURL(img.getAsFile());
});

function status(msg,isErr){
  const el=$('agentStatus');
  el.textContent=msg||'';
  el.title=msg||'';
  el.className=isErr?'err':'';
}
async function callGenerate(){
  const r=await fetch('/api/generate',{
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      prompt:$('prompt').value.trim(),
      imageDataUrl:attachedImage||undefined,
      currentDoc: doc&&doc.frame.children.length ? doc : undefined,
    })
  });
  const data=await r.json();
  if(!r.ok){
    const e=new Error(data.error||('HTTP '+r.status));
    e.status=r.status; e.retryAfter=data.retryAfter;
    throw e;
  }
  return data;
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function generate(){
  if(!aiAvailable){ status('AI not configured — see README setup',true); return; }
  const prompt=$('prompt').value.trim();
  if(!prompt&&!attachedImage) return;
  $('generateBtn').disabled=true;
  status('Generating…');
  try{
    let data;
    try{
      data=await callGenerate();
    }catch(e){
      // Free-tier rate limit: Groq tells us when the window resets, so
      // wait it out visibly and retry once instead of just failing.
      if(e.status!==429 || !e.retryAfter || e.retryAfter>120) throw e;
      for(let t=e.retryAfter;t>0;t--){
        status(`Rate limit (free tier) — retrying in ${t}s…`,true);
        await sleep(1000);
      }
      status('Generating…');
      data=await callGenerate();
    }
    setActiveDoc(normalizeDoc(data.doc));
    sel=-1; fxPage=0;
    pushHistory(); refresh();
    const u=data.usage;
    status(u?`done · ${u.total_tokens} tokens (${data.model.split('/').pop()})`:'done');
  }catch(e){
    status(e.status===429?'Rate limit (free tier) — give it a minute, then Generate again':e.message,true);
  }finally{
    $('generateBtn').disabled=false;
  }
}
$('generateBtn').addEventListener('click',generate);
$('prompt').addEventListener('keydown',e=>{ if(e.key==='Enter') generate(); });

/* Provider capability probe. The UI must know AI is unavailable BEFORE the
 * user submits, so Generate is disabled up front with a setup hint rather than
 * failing after a round trip. The endpoint never returns the key itself. */
let aiAvailable=true;
async function probeProvider(){
  try{
    const r=await fetch('/api/config');
    if(!r.ok) return;
    const cfg=await r.json();
    aiAvailable=!!cfg.aiAvailable;
    const btn=$('generateBtn'), box=$('prompt');
    btn.disabled=!aiAvailable;
    btn.setAttribute('aria-disabled',String(!aiAvailable));
    if(!aiAvailable){
      btn.title=cfg.reason||'AI is not configured on this server.';
      box.placeholder='AI unavailable — set GROQ_API_KEY in .env, or run npm run dev:mock';
      box.disabled=true;
      status('AI not configured — see README setup',true);
    } else if(cfg.mode==='mock'){
      status('mock provider');
    }
  }catch(_){ /* leave enabled; generate() still reports failures safely */ }
}
probeProvider();

/* ================= init ================= */
window.addEventListener('resize',render);
setActivePage(-1); pushHistory(); refresh();   // start with NO pages — user creates one

/* test hook */
window.__editor={ get doc(){return doc;}, set doc(d){setActiveDoc(normalizeDoc(d)); sel=-1; selInstance=null; pushHistory(); refresh();},
  get pages(){return pages;}, get pageIdx(){return pageIdx;}, setActivePage,
  get sel(){return sel;}, set sel(i){sel=i; fxPage=0; refresh();},
  get selInstance(){return selInstance;},
  render, refresh, normalizeDoc,
  patternInstances, allInstances, instanceBounds, normalizePattern,
  duplicateSel, deleteSel,
  limits:{MAX_PATTERN_INSTANCES,MAX_GRID_AXIS,MAX_GAP,MAX_OFFSET,MAX_JITTER,MAX_HOLES,MIN_SIZE_FACTOR} };
})();
