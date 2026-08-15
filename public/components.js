/* Components, symbols, constraints and stack layout (§6.7, §6.8, §6.11, §6.12).
 *
 * PATENT NOTE. §0 flags four live patents, none of which touch this file:
 * they cover snap-target lookup, tap-to-create guides, and raster-to-vector.
 * Reusable instances with overrides, edge pinning and flex-style stacks all
 * have prior art decades older than any current design tool — Interface
 * Builder springs and struts (1980s), Fireworks and Flash symbols (1990s),
 * the CSS Flexbox spec (2009). §0 additionally pre-approves Yoga for the
 * layout solver, which is an affirmative clearance for stack layout as a
 * feature. This implements the standard published semantics and nothing
 * reverse-engineered from a specific product.
 *
 * WHY NOT YOGA. §0 permits it, but it is a WASM/JS dependency and the subset
 * needed here — one-axis stacks with gap, padding, alignment and three sizing
 * modes — is about a hundred lines. The app has no runtime dependencies and
 * this did not seem worth the first one. If wrap/grid/baseline get built out,
 * revisit that.
 *
 * COMPONENTS vs SYMBOLS (§6.7 vs §6.8). One storage mechanism, two behaviours,
 * because the spec deliberately distinguishes them:
 *   component — per-instance overrides, variant sets, detach, reset
 *   symbol    — lightweight: instances carry a transform only, and every
 *               instance always shows exactly what the source shows
 * A symbol is not a crippled component; it is the thing you reach for when
 * you want NO divergence between instances.
 */
(function(){
"use strict";

const clamp=(v,a,b)=>v<a?a:v>b?b:v;
const clone=v=>JSON.parse(JSON.stringify(v));

/* ---- definitions ----------------------------------------------------- */
function normDef(d,i,newId){
  return {
    id:typeof d.id==='string'&&d.id?d.id:newId(),
    name:String(d.name||('Component '+(i+1))).slice(0,80),
    kind:d.kind==='symbol'?'symbol':'component',
    root:d.root&&typeof d.root==='object'?d.root:null,
    /* §6.7 variant sets: named property -> alternate root. The default
     * variant is the root itself, so a component with no variants behaves
     * exactly as before variants existed. */
    variantKey:String(d.variantKey||'Variant').slice(0,40),
    variants:(Array.isArray(d.variants)?d.variants:[]).slice(0,24).map(v=>({
      name:String(v.name||'Variant').slice(0,40),
      root:v.root&&typeof v.root==='object'?v.root:null,
    })).filter(v=>v.root),
  };
}
function findDef(defs,id){ return (defs||[]).find(d=>d.id===id)||null; }

/* ---- instances -------------------------------------------------------- */
/* An override is addressed by the child's NAME PATH inside the definition
 * ("Card/Title"), not by index. Index paths break the moment the source gains
 * a child; names survive reordering, which is the whole point of overrides
 * outliving edits to the source. */
function pathOf(node,root){
  const stack=[];
  (function walk(list,trail){
    (list||[]).forEach(o=>{
      const t=trail.concat(o.name||o.type);
      if(o===node){ stack.push(t); return; }
      if(o.children) walk(o.children,t);
    });
  })([root],[]);
  return stack.length?stack[0].join('/'):null;
}
function applyOverrides(root,ov){
  if(!ov) return root;
  (function walk(list,trail){
    (list||[]).forEach(o=>{
      const t=trail.concat(o.name||o.type);
      const key=t.join('/');
      const set=ov[key];
      if(set){
        // §6.7 the overridable set: text, colour, visibility. Geometry stays
        // with the source deliberately — an instance that could move its own
        // children is a group, not an instance.
        if(set.text!==undefined&&o.type==='text') o.text=set.text;
        if(set.hidden!==undefined) o.hidden=!!set.hidden;
        if(set.color!==undefined){
          if(o.type==='text') o.color=set.color;
          else if(o.fills&&o.fills[0]){ o.fills[0].kind='solid'; o.fills[0].color=set.color; }
          else if(o.strokes&&o.strokes[0]){ o.strokes[0].kind='solid'; o.strokes[0].color=set.color; }
        }
      }
      if(o.children) walk(o.children,t);
    });
  })([root],[]);
  return root;
}

/** Resolve an instance into a drawable subtree, positioned at the instance.
 *  Returns null when the definition is missing (a dangling instance renders
 *  as nothing rather than throwing). */
function resolve(inst,defs,helpers){
  const def=findDef(defs,inst.compId);
  if(!def||!def.root) return null;
  let src=def.root;
  if(def.kind==='component'&&inst.variant){
    const v=def.variants.find(x=>x.name===inst.variant);
    if(v) src=v.root;
  }
  const root=clone(src);
  if(def.kind==='component') applyOverrides(root,inst.overrides);
  // move the resolved tree so the definition's own origin lands on the
  // instance's position
  const b=helpers.boxOf(root);
  helpers.translate(root,(inst.x||0)-b.x,(inst.y||0)-b.y);
  root.__instanceOf=inst.id;
  root.rot=inst.rot||root.rot||0;
  root.opacity=inst.opacity===undefined?1:inst.opacity;
  return root;
}

/* ---- §6.11 constraints ------------------------------------------------
 * Resolved when a FRAME resizes. Each child pins independently on each axis.
 * `scale` keeps the child's proportional position and size; the others hold a
 * fixed distance to one or both edges. */
const CONSTRAINTS=['left','right','both','center','scale'];
function applyConstraints(frame,prev,helpers){
  const dw=frame.w-prev.w, dh=frame.h-prev.h;
  if(!dw&&!dh) return;
  (frame.children||[]).forEach(o=>{
    const c=o.constraints||{};
    const b=helpers.boxOf(o);
    const relX=b.x-prev.x, relY=b.y-prev.y;
    let nx=relX, ny=relY, nw=b.w, nh=b.h;
    switch(c.h||'left'){
      case 'right':  nx=relX+dw; break;
      case 'both':   nw=Math.max(1,b.w+dw); break;
      case 'center': nx=relX+dw/2; break;
      case 'scale':  { const k=prev.w?frame.w/prev.w:1; nx=relX*k; nw=Math.max(1,b.w*k); break; }
    }
    switch(c.v||'top'){
      case 'bottom': ny=relY+dh; break;
      case 'both':   nh=Math.max(1,b.h+dh); break;
      case 'center': ny=relY+dh/2; break;
      case 'scale':  { const k=prev.h?frame.h/prev.h:1; ny=relY*k; nh=Math.max(1,b.h*k); break; }
    }
    helpers.place(o,frame.x+nx,frame.y+ny,nw,nh);
  });
}

/* ---- §6.12 stack layout ----------------------------------------------
 * Flexbox semantics for one axis: gap, per-side padding, alignment on the
 * cross axis, and three child sizing modes. `absolute` children opt out
 * entirely, which is the escape hatch the spec asks for. */
function layoutStack(frame,helpers){
  const L=frame.layout;
  if(!L||L.mode==='none') return;
  const horiz=L.mode==='horizontal';
  const pad=L.padding||{t:0,r:0,b:0,l:0};
  const kids=(frame.children||[]).filter(o=>!o.hidden&&!o.absolute);
  if(!kids.length) return;
  const innerW=Math.max(0,frame.w-pad.l-pad.r);
  const innerH=Math.max(0,frame.h-pad.t-pad.b);
  const gap=Math.max(0,L.gap||0);

  // measure, honouring each child's sizing mode on the MAIN axis
  const boxes=kids.map(o=>helpers.boxOf(o));
  const fills=kids.filter(o=>(o.sizing||'fixed')==='fill').length;
  const fixedMain=kids.reduce((sum,o,i)=>
    sum+((o.sizing||'fixed')==='fill'?0:(horiz?boxes[i].w:boxes[i].h)),0);
  const totalGap=gap*(kids.length-1);
  const free=Math.max(0,(horiz?innerW:innerH)-fixedMain-totalGap);
  const perFill=fills?free/fills:0;

  // §6.12 justification along the main axis
  const used=fixedMain+totalGap+perFill*fills;
  const slack=Math.max(0,(horiz?innerW:innerH)-used);
  let cursor=(horiz?frame.x+pad.l:frame.y+pad.t);
  let between=gap;
  switch(L.justify||'start'){
    case 'center': cursor+=slack/2; break;
    case 'end':    cursor+=slack; break;
    case 'between': if(kids.length>1) between=gap+slack/(kids.length-1); break;
  }

  kids.forEach((o,i)=>{
    const b=boxes[i];
    const mode=o.sizing||'fixed';
    let mw=horiz?b.w:b.h;
    if(mode==='fill') mw=perFill;
    // cross axis: hug keeps the child's size, fill stretches it
    let cw=horiz?b.h:b.w;
    const crossInner=horiz?innerH:innerW;
    if((L.align||'start')==='stretch') cw=crossInner;
    let cross=(horiz?frame.y+pad.t:frame.x+pad.l);
    if((L.align||'start')==='center') cross+=(crossInner-cw)/2;
    else if((L.align||'start')==='end') cross+=crossInner-cw;
    const x=horiz?cursor:cross, y=horiz?cross:cursor;
    const w=horiz?mw:cw, h=horiz?cw:mw;
    helpers.place(o,x,y,Math.max(1,w),Math.max(1,h));
    cursor+=mw+between;
  });
}

/** §6.12 "hug contents": the frame shrinks to fit its stack. */
function hugFrame(frame,helpers){
  const L=frame.layout;
  if(!L||L.mode==='none'||!L.hug) return;
  const pad=L.padding||{t:0,r:0,b:0,l:0};
  const kids=(frame.children||[]).filter(o=>!o.hidden&&!o.absolute);
  if(!kids.length) return;
  const boxes=kids.map(o=>helpers.boxOf(o));
  const gap=Math.max(0,L.gap||0);
  if(L.mode==='horizontal'){
    frame.w=Math.round(pad.l+pad.r+boxes.reduce((s,b)=>s+b.w,0)+gap*(kids.length-1));
    frame.h=Math.round(pad.t+pad.b+Math.max(...boxes.map(b=>b.h)));
  }else{
    frame.h=Math.round(pad.t+pad.b+boxes.reduce((s,b)=>s+b.h,0)+gap*(kids.length-1));
    frame.w=Math.round(pad.l+pad.r+Math.max(...boxes.map(b=>b.w)));
  }
}

window.Components={normDef,findDef,resolve,applyOverrides,pathOf,
  applyConstraints,layoutStack,hugFrame,CONSTRAINTS};
})();
