/* Creative Editor — canvas, inspector, engines, agentic bar. */
(function(){
"use strict";

/* ================= helpers ================= */
const $=id=>document.getElementById(id);
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
/* Layer, component and text names are user-supplied and some panels build
 * their rows with innerHTML, so anything interpolated has to go through this. */
const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,ch=>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

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
  // cached bitmaps are keyed by object id; a replaced document leaves every
  // one of them unreachable, so drop them rather than leak
  if(typeof paintCacheClear==='function') paintCacheClear();
}
let sel=-1;              // index into children
let selInstance=null;    // derived instance under inspection (never editable)
let tool='select';
/* Viewport: page->screen is s = p*z + (x,y). 'fit' auto-frames the page until
 * the user pans or zooms, which flips it to 'free'. */
let view={z:1,x:0,y:0,mode:'fit'};
let fxPage=0;            // engines pager
/* Multi-select: selIds is the source of truth; `sel` stays the PRIMARY
 * selected index so every single-object code path (inspector, engines,
 * duplicate) keeps working unchanged. Invariant: sel>=0 implies
 * children[sel].id is in selIds. */
let selIds=new Set();
/* §6.9 isolation: the container we have "entered" by double-click. Clicks
 * select its children directly; everything outside it dims and is inert. */
let enteredId=null;
/* §2.10 snapping preferences. Radius is in SCREEN pixels so it feels the
 * same at every zoom. Per-target-type toggles are the spec's requirement. */
let snapCfg={on:true, radius:7,
  edges:true, centers:true, anchors:true, guides:true, grid:true, artboard:true};
let showRulers=true;
let alignTo='selection';   // 'selection' | 'artboard' | 'key'  (§2.8)
let selArtboard=null;      // §6.5 the artboard whose panel is open
let snapLines=[];        // live indicators, screen chrome only
let gapHints=[];         // §2.11 equal-spacing indicators
let guideDrag=null;      // dragging a guide out of a ruler, or moving one
let lastPointer=null;    // screen coords, for the ruler markers
const RULER=22;          // px
/* Prism and Capsule accumulate samples synchronously, so a full-quality pass
 * is far too slow to run on every pointer move. Slider `input` renders a
 * draft; the `change` that ends the drag renders properly. */
let fxDraft=false;

const DEFAULT_EFFECTS=()=>({
  shadow:{on:false,x:0,y:6,blur:18,spread:0,color:'#000000',alpha:0.25,blend:'normal'},
  // §4.10 inner shadow — same parameter set, cast inward from the edges
  innerShadow:{on:false,x:0,y:4,blur:12,spread:0,color:'#000000',alpha:0.35,blend:'normal'},
  // §4.11 glow — outer or inner, with a falloff curve
  glow:{on:false,type:'outer',radius:18,spread:0,color:'#ffffff',alpha:0.7,falloff:1,blend:'normal'},
  grain:{amount:0},
  // Clear Glass defaults from the locked standalone glass app
  glass:{on:false,depth:40,refraction:35,frost:0,reflection:25,light:35,dispersion:0,tint:'#ffffff',opacity:100},
  // Funnel light cone, ported from the Funnel Light Figma plugin
  light:{on:false,mode:0,throat:0.39,mouth:0.95,curve:2.07,intensity:0.62,density:2.0,
         bloom:0,innerGlow:2.5,falloff:2.33,leftFade:0.45,meshMix:1.62,bandFlow:0,
         beamLength:1.17,beamGlow:0.65,transparent:true,
         deep:'#000000',core:'#00aaff',inner:'#eaeaea',mesh:'#7744ff',bg:'#000000'},
  // banded two-gradient stripe fill, ported from the Gradient Stripe plugin
  gradient:{on:false,bandHeight:60,split:30,drift:2,g1shift:10,g2shift:-10,
            phase:0.1,bounce:false,angle:0,mirrorX:false,mirrorY:false,
            g1:[{color:'#0000ff',pos:0},{color:'#ffaa00',pos:0.5},{color:'#6666aa',pos:1}],
            g2:[{color:'#ffaa00',pos:0},{color:'#0000ff',pos:0.5},{color:'#999999',pos:1}]},
  // beam traced forward through a glass solid, dispersed per wavelength
  prism:{on:false,shape:0,thickness:0.25,corner:0.12,wedge:0,yaw:0,pitch:0,roll:0,
         ior:1.52,dispersion:0.145,body:1,blend:'add',
         azimuth:126,elevation:30,intensity:1.9,width:0.15,softness:2,distance:14,
         aimX:0,aimY:0,falloff:0.03,inGain:1,outGain:2.9,
         bend:0,fan:26,bands:0,fanRoll:0,spectrum:0,
         colorA:'#ff9a2e',colorB:'#e040c0',beamColor:'#ffffff',
         airScatter:0.085,glassScatter:2.4,saturation:1.3,rim:0.42,
         camZ:4.6,fov:30,reach:1.5,exposure:1.3,shoulder:0.24,grain:0.018,
         // measured on this machine: ~90ms for a 1020x680 page at these
         // settings, and the draft path is ~10ms, so a drag stays responsive
         steps:56,quality:96,scale:0.6},
  // path-traced glass pill with an inner lens, from the Glass Capsule app
  capsule:{on:false,lensSize:0.67,lensSquash:1.15,lensShift:0.02,roughness:0.13,
           ior:1.47,dispersion:0.013,absorb:0.45,tint:'#dce8f5',
           lensIor:1.58,lensAbsorb:3.2,lensTint:'#6f9dcd',
           reflection:60,depth:12,quality:32,scale:0.6},
  // fluted/reeded glass panel: ribs smear the page behind into bands
  strip:{on:false,bulge:0.34,ribWidth:0.12,angle:0,thickness:0.08,
         ior:1.55,dispersion:0.048,slopeLimit:6,smear:1.6},
  // §4.8 blur — gaussian / directional / zoom
  blur:{kind:'gaussian',radius:0,angle:0,distance:20,amount:0.2,cx:0,cy:0},
  // §5.10 distortion — wave / twirl / bulge / pinch / ripple
  distortion:{mode:'wave',amount:0,wavelength:0.2,phase:0,axis:'both',
              radius:0.5,cx:0,cy:0,edge:'clamp'},
  // §5.12 warp — envelope presets
  warp:{envelope:'arc',strength:0,axis:'horizontal',edge:'clamp'},
  // §5.11 displacement — procedural when no source map is chosen
  displacement:{scaleX:0,scaleY:0,channel:'luminance',mapScale:1,seed:1,edge:'clamp'},
  // §5.5 fractal glass haze
  haze:{density:0,octaves:4,lacunarity:2,gain:0.5,scale:0.25,falloff:1,
        color:'#ffffff',seed:1},
  // §5.6 slice
  slice:{count:8,axis:'horizontal',offset:0,gap:0,mode:'ramp',seed:1,edge:'clamp'},
  // §4.12 noise
  noise:{amount:0,mono:true,scale:1,seed:1},
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

const CAPS=['butt','round','square'], JOINS=['miter','round','bevel'];
const STROKE_ALIGN=['center','inside','outside'];
/** One fill entry: solid / linear / radial, with its own opacity + blend. */
function normPaint(f,dflt){
  f=f&&typeof f==='object'?f:{};
  const kind=['solid','linear','radial'].includes(f.kind)?f.kind:'solid';
  const out={kind, on:f.on!==false,
    opacity:clamp(f.opacity===undefined?1:+f.opacity,0,1),
    blend:BLEND_MODES.includes(f.blend)?f.blend:'normal'};
  if(kind==='solid'){
    out.color=/^#[0-9a-fA-F]{6}$/.test(f.color||'')?f.color:(dflt||'#cccccc');
  }else{
    out.stops=(Array.isArray(f.stops)?f.stops:[]).slice(0,8).map(st=>({
      pos:clamp(+st.pos||0,0,1),
      color:/^#[0-9a-fA-F]{6}$/.test(st.color||'')?st.color:'#888888',
      opacity:clamp(st.opacity===undefined?1:+st.opacity,0,1),
      mid:clamp(st.mid===undefined?0.5:+st.mid,0.05,0.95),
    }));
    while(out.stops.length<2) out.stops.push({pos:out.stops.length?1:0,
      color:out.stops.length?'#333333':(dflt||'#cccccc'),opacity:1,mid:0.5});
    out.angle=((+f.angle||0)%360+360)%360;
    out.space=['srgb','linear','oklab'].includes(f.space)?f.space:'srgb';
    if(kind==='radial'){
      out.fx=clamp(+f.fx||0,-1,1); out.fy=clamp(+f.fy||0,-1,1);
      out.aspect=clamp(+f.aspect||1,0.2,5);
    }
  }
  return out;
}
/** One stroke entry: a paint plus geometry (§4.2). */
function normStroke(k,dfltColor){
  k=k&&typeof k==='object'?k:{};
  const out=normPaint(k,dfltColor||'#111111');
  out.width=clamp(+k.width===0?0:(+k.width||1),0,200);
  out.align=STROKE_ALIGN.includes(k.align)?k.align:'center';
  out.cap=CAPS.includes(k.cap)?k.cap:'butt';
  out.join=JOINS.includes(k.join)?k.join:'miter';
  out.miter=clamp(+k.miter||10,1,50);
  out.dash=(Array.isArray(k.dash)?k.dash:[]).slice(0,8)
    .map(v=>clamp(+v||0,0,500)).filter((v,i,a)=>true);
  out.dashOffset=clamp(+k.dashOffset||0,-1000,1000);
  out.scaleWith=k.scaleWith!==false;
  return out;
}
/* Migrate the legacy single `fill` / `stroke` into the stacked arrays, and
 * keep the old field as a LIVE ALIAS of entry 0 so every existing reader
 * (engines, eyedropper, blob flood) keeps working unchanged. */
function normAppearance(c){
  const dflt=(c.fill&&c.fill.color)||'#d9d9d9';
  let fills=Array.isArray(c.fills)?c.fills:(c.fill?[c.fill]:null);
  if(c.type==='text'||c.type==='line') fills=null;
  if(fills){
    c.fills=fills.slice(0,8).map(f=>normPaint(f,dflt));
    if(!c.fills.length) c.fills=[normPaint({},dflt)];
    c.fill=c.fills[0];
  }else{ delete c.fills; }
  const needsStroke=['rect','ellipse','polygon','path','line'].includes(c.type);
  if(needsStroke){
    let st=Array.isArray(c.strokes)?c.strokes:(c.stroke?[c.stroke]:[]);
    c.strokes=st.slice(0,8).map(k=>normStroke(k,(c.stroke&&c.stroke.color)||'#111111'));
    // paths and lines are stroke-defined: they always keep one
    if(!c.strokes.length&&(c.type==='path'||c.type==='line'))
      c.strokes=[normStroke({width:c.type==='line'?4:3},'#111111')];
    c.stroke=c.strokes[0];
  }else{ delete c.strokes; delete c.stroke; }
  // §4.3 / §4.4 object-level
  c.fillOpacity=clamp(c.fillOpacity===undefined?1:+c.fillOpacity,0,1);
  c.strokeOpacity=clamp(c.strokeOpacity===undefined?1:+c.strokeOpacity,0,1);
  c.blend=BLEND_MODES.includes(c.blend)?c.blend:'normal';
  c.isolate=!!c.isolate;
  c.knockout=!!c.knockout;
}

function normalizeDoc(d){
  const f=d.frame;
  f.w=clamp(+f.w||900,100,4000); f.h=clamp(+f.h||600,100,4000);
  if(!/^#/.test(f.bg||'')) f.bg='#ffffff';
  /* §2.11 guides live with the page, so they save and undo with it.
   * §0 constraint 2: guides are created by DRAGGING FROM A RULER or by
   * numeric entry — never by tapping a ruler on a touchscreen. */
  f.guides=(Array.isArray(f.guides)?f.guides:[]).slice(0,200).map(g=>({
    axis:g.axis==='v'?'v':'h',
    pos:clamp(+g.pos||0,-10000,10000),
    locked:!!g.locked,
  }));
  /* §6.5 artboards. `frame` stays the PAGE canvas — every existing reader of
   * frame.w/h/children keeps working — and artboards are named regions on it.
   * Membership is GEOMETRIC (a child belongs to the artboard containing its
   * centre), so nothing extra has to be stored on the objects and moving a
   * shape between artboards is just moving it. A document with no artboards
   * gets one covering the whole page, so old files are unchanged. */
  f.artboards=(Array.isArray(f.artboards)?f.artboards:[]).slice(0,32).map((a,i)=>({
    id:typeof a.id==='string'&&a.id?a.id:newId(),
    name:String(a.name||('Artboard '+(i+1))).slice(0,60),
    x:Math.round(+a.x||0), y:Math.round(+a.y||0),
    w:clamp(Math.round(+a.w)||400,20,8000), h:clamp(Math.round(+a.h)||300,20,8000),
    bg:/^#[0-9a-fA-F]{6}$/.test(a.bg||'')?a.bg:'#ffffff',
    clip:a.clip!==false, show:a.show!==false,
  }));
  if(!f.artboards.length)
    f.artboards=[{id:newId(),name:'Artboard 1',x:0,y:0,w:f.w,h:f.h,bg:f.bg,clip:false,show:true}];
  /* §6.7/§6.8 definitions live with the page. An instance stores only which
   * definition it points at plus its own transform and overrides. */
  const C=window.Components;
  f.components=(Array.isArray(f.components)?f.components:[]).slice(0,200)
    .map((d,i)=>C?C.normDef(d,i,newId):d)
    .filter(d=>d&&d.root);
  (f.components||[]).forEach(d=>{
    d.root=normChildren([d.root],1)[0];
    (d.variants||[]).forEach(v=>{ v.root=normChildren([v.root],1)[0]; });
  });
  // §6.4 grid
  const gr=f.grid||{};
  f.grid={size:clamp(+gr.size||20,1,500),
          subdivisions:clamp(Math.round(+gr.subdivisions)||1,1,10),
          show:!!gr.show, snap:gr.snap!==false,
          color:/^#[0-9a-fA-F]{6}$/.test(gr.color||'')?gr.color:'#c9ced6'};
  f.children=normChildren(f.children||[],0);
  return d;
}
/* Recursive child normalizer — containers normalize their own children. The
 * depth cap stops a malformed or hostile document from recursing forever.
 *
 * THE CHILD CAP WAS 64 AND IT SILENTLY DELETED WORK. normalizeDoc runs on
 * every load, paste, undo and structural edit, so pasting 100 objects kept 64
 * and dropped 36 with no error — the same document normalised twice lost more
 * each time. The cap exists to bound a malformed or hostile document, which is
 * a real concern, but 64 is far below any honest document. It is now high
 * enough never to touch real work, and truncation SAYS SO instead of happening
 * quietly. */
const MAX_CHILDREN=20000;
let truncWarned=false;
function normChildren(list,depth){
  if(depth>8) return [];
  const src=list||[];
  if(src.length>MAX_CHILDREN&&!truncWarned){
    truncWarned=true;
    console.warn('Document exceeds '+MAX_CHILDREN+' children in one container; '+
      (src.length-MAX_CHILDREN)+' dropped.');
    if(window.__editor) try{ status('Too many objects in one container — '+
      (src.length-MAX_CHILDREN)+' were dropped.',true); }catch(e){}
  }
  return src.slice(0,MAX_CHILDREN).map((c,i)=>{
    c.name=c.name||`${c.type} ${i+1}`;
    c.x=+c.x||0; c.y=+c.y||0;
    c.opacity=c.opacity===undefined?1:clamp(+c.opacity,0.05,1);
    if(!['rect','ellipse','text','polygon','line','path','group','frame','boolean','image','instance'].includes(c.type)) c.type='rect';
    if(c.type==='text'){
      c.size=clamp(+c.size||32,8,300); c.weight=+c.weight||600;
      c.color=c.color||'#111111';
      c.align=['left','center','right'].includes(c.align)?c.align:'left';
      c.text=String(c.text||'Text');
      // §1.9: area text with wrap, leading, tracking, vertical alignment
      c.mode=c.mode==='area'?'area':'point';
      if(c.mode==='area'){ c.w=Math.max(20,+c.w||240); c.h=Math.max(16,+c.h||120); }
      c.lineHeight=clamp(+c.lineHeight||1.2,0.7,3);
      c.tracking=clamp(+c.tracking||0,-10,60);
      c.valign=['top','middle','bottom'].includes(c.valign)?c.valign:'top';
      c.autosize=['fixed','height'].includes(c.autosize)?c.autosize:'fixed';
      c.caseTf=['none','upper','lower','title'].includes(c.caseTf)?c.caseTf:'none';
    }else if(CONTAINER(c)){
      c.children=normChildren(c.children||[],depth+1);
      if(c.type==='boolean'){
        c.boolOp=['union','subtract','intersect','exclude'].includes(c.boolOp)?c.boolOp:'union';
        c.fillRule=c.fillRule==='evenodd'?'evenodd':'nonzero';
        c.fillOn=c.fillOn!==false;
        delete c.__sig; delete c.__res;      // never persist the cache
      }
      if(c.type==='frame'){
        c.w=Math.max(4,+c.w||200); c.h=Math.max(4,+c.h||200);
        c.radius=clamp(+c.radius||0,0,300);
        c.clip=c.clip!==false;
        // §6.12 stack layout on the frame
        const L=c.layout||{};
        const pd=L.padding||{};
        c.layout={
          mode:['none','horizontal','vertical'].includes(L.mode)?L.mode:'none',
          gap:clamp(+L.gap||0,0,400),
          padding:{t:clamp(+pd.t||0,0,400),r:clamp(+pd.r||0,0,400),
                   b:clamp(+pd.b||0,0,400),l:clamp(+pd.l||0,0,400)},
          align:['start','center','end','stretch'].includes(L.align)?L.align:'start',
          justify:['start','center','end','between'].includes(L.justify)?L.justify:'start',
          hug:!!L.hug,
        };
      }
      // §6.9: a group's box is derived from its children, never stored
      delete c.pattern;
    }else if(c.type==='instance'){
      // §6.7/§6.8 instance: a pointer plus a transform plus overrides
      c.compId=String(c.compId||'');
      c.variant=c.variant?String(c.variant).slice(0,40):'';
      c.overrides=(c.overrides&&typeof c.overrides==='object')?c.overrides:{};
      delete c.pattern; delete c.children;
    }else if(c.type==='image'){
      // §5.15 flatten target: a plain pixel layer. `src` is a data URL so the
      // document stays self-contained and round-trips through save/undo.
      c.w=Math.max(1,+c.w||100); c.h=Math.max(1,+c.h||100);
      c.src=typeof c.src==='string'?c.src:'';
      delete c.pattern;
    }else if(c.type==='path'){
      /* §3.7 compound path: one object, many subpaths. `points` and `closed`
       * stay as LIVE ALIASES of subpath 0 so the pen, node editor and every
       * existing reader keep working on single-contour paths unchanged. */
      const normPts=arr=>(Array.isArray(arr)?arr:[]).slice(0,2000).map(p=>({
        x:+p.x||0, y:+p.y||0,
        ox:+p.ox||0, oy:+p.oy||0, ix:+p.ix||0, iy:+p.iy||0,
        m:['corner','smooth','asym','free'].includes(p.m)?p.m:'corner',
      }));
      let sps=Array.isArray(c.subpaths)?c.subpaths:null;
      if(!sps) sps=[{points:c.points,closed:c.closed}];
      c.subpaths=sps.slice(0,64)
        .map(sp=>({points:normPts(sp&&sp.points),closed:!!(sp&&sp.closed)}))
        .filter(sp=>sp.points.length);
      if(!c.subpaths.length) c.subpaths=[{points:[],closed:false}];
      c.points=c.subpaths[0].points;
      c.closed=c.subpaths[0].closed;
      c.fillRule=c.fillRule==='evenodd'?'evenodd':'nonzero';
      c.fillOn=!!c.fillOn;
      c.x=+c.x||0; c.y=+c.y||0;
      delete c.pattern;
    }else if(c.type==='line'){
      c.x2=Number.isFinite(+c.x2)?+c.x2:c.x+160;
      c.y2=Number.isFinite(+c.y2)?+c.y2:c.y;
      const HEADS=['none','triangle','open','circle','bar'];
      c.arrowStart=HEADS.includes(c.arrowStart)?c.arrowStart:'none';
      c.arrowEnd=HEADS.includes(c.arrowEnd)?c.arrowEnd:'none';
      c.arrowSize=clamp(+c.arrowSize||12,4,60);
      delete c.pattern;
    }else{
      c.w=Math.max(4,+c.w||100); c.h=Math.max(4,+c.h||100);
      c.radius=clamp(+c.radius||0,0,300);
      if(c.type==='rect'){
        if(Array.isArray(c.radii)) c.radii=c.radii.slice(0,4).map(v=>clamp(+v||0,0,300));
        c.cornerStyle=['round','bevel','scoop'].includes(c.cornerStyle)?c.cornerStyle:'round';
      }
      if(c.type==='ellipse'){
        c.startAngle=clamp(+c.startAngle||0,0,360);
        c.endAngle=c.endAngle===undefined?360:clamp(+c.endAngle,0,360);
        c.innerRatio=clamp(+c.innerRatio||0,0,0.95);
      }
      if(c.type==='polygon'){
        c.sides=clamp(Math.round(+c.sides)||5,3,24);
        c.innerRatio=c.innerRatio===undefined?1:clamp(+c.innerRatio,0.1,1);
      }
    }
    normAppearance(c);
    {
      // deep-merge per effect: the model may send partial objects like
      // {"shadow":{"on":true}} and must not wipe the other fields
      const de=DEFAULT_EFFECTS(), ce=c.effects||{};
      const sh=Object.assign(de.shadow, ce.shadow||{});
      sh.on=!!sh.on; sh.x=clamp(+sh.x||0,-100,100); sh.y=clamp(+sh.y||0,-100,100);
      sh.blur=clamp(+sh.blur||0,0,150); sh.alpha=clamp(+sh.alpha||0,0,1);
      sh.spread=clamp(+sh.spread||0,0,100);
      sh.blend=BLEND_MODES.includes(sh.blend)?sh.blend:'normal';
      if(!/^#[0-9a-fA-F]{6}$/.test(sh.color||'')) sh.color='#000000';
      const ish=Object.assign(de.innerShadow, ce.innerShadow||{});
      ish.on=!!ish.on&&c.type!=='text'; ish.x=clamp(+ish.x||0,-100,100); ish.y=clamp(+ish.y||0,-100,100);
      ish.blur=clamp(+ish.blur||0,0,150); ish.alpha=clamp(+ish.alpha||0,0,1);
      ish.spread=clamp(+ish.spread||0,0,100);
      ish.blend=BLEND_MODES.includes(ish.blend)?ish.blend:'normal';
      if(!/^#[0-9a-fA-F]{6}$/.test(ish.color||'')) ish.color='#000000';
      const glw=Object.assign(de.glow, ce.glow||{});
      glw.on=!!glw.on&&c.type!=='text';
      glw.type=glw.type==='inner'?'inner':'outer';
      glw.radius=clamp(+glw.radius||0,0,200); glw.spread=clamp(+glw.spread||0,0,100);
      glw.alpha=clamp(+glw.alpha||0,0,1); glw.falloff=clamp(+glw.falloff||1,0.2,4);
      glw.blend=BLEND_MODES.includes(glw.blend)?glw.blend:'normal';
      if(!/^#[0-9a-fA-F]{6}$/.test(glw.color||'')) glw.color='#ffffff';
      const gr=Object.assign(de.grain, ce.grain||{});
      gr.amount=clamp(+gr.amount||0,0,1);
      const grd=Object.assign(de.gradient, ce.gradient||{});
      grd.on=!!grd.on && ['rect','ellipse','polygon','path'].includes(c.type);
      grd.bandHeight=clamp(Math.round(+grd.bandHeight)||60,2,400);
      grd.split=clamp(+grd.split||0,5,95);
      grd.drift=clamp(+grd.drift||0,-20,20);
      grd.g1shift=clamp(+grd.g1shift||0,-50,50);
      grd.g2shift=clamp(+grd.g2shift||0,-50,50);
      grd.phase=clamp(Number.isFinite(+grd.phase)?+grd.phase:0.1,-0.5,0.5);
      grd.angle=clamp(+grd.angle||0,0,359);
      grd.bounce=!!grd.bounce; grd.mirrorX=!!grd.mirrorX; grd.mirrorY=!!grd.mirrorY;
      grd.seeded=!!grd.seeded;
      // Stops arrive from the model as well as the panel, so both ramps are
      // repaired here rather than trusted: at least two, at most MAX_STOPS.
      const maxSt=(window.GradientEngine&&window.GradientEngine.MAX_STOPS)||6;
      ['g1','g2'].forEach(k=>{
        let a=Array.isArray(grd[k])?grd[k]:[];
        a=a.slice(0,maxSt).map(s=>({
          pos:clamp(+(s&&s.pos)||0,0,1),
          color:/^#[0-9a-fA-F]{6}$/.test((s&&s.color)||'')?s.color:'#888888'}));
        while(a.length<2) a.push({pos:1,color:'#333333'});
        grd[k]=a;
      });
      const gla=Object.assign(de.glass, ce.glass||{});
      gla.on=!!gla.on && (c.type==='rect'||c.type==='ellipse');
      gla.depth=clamp(+gla.depth||0,-200,200);
      gla.refraction=clamp(+gla.refraction||0,-200,200);
      gla.frost=clamp(+gla.frost||0,0,100);
      gla.reflection=clamp(+gla.reflection||0,0,100);
      gla.light=clamp(+gla.light||0,0,100);
      gla.dispersion=clamp(+gla.dispersion||0,0,200);
      gla.opacity=clamp(gla.opacity===undefined?100:+gla.opacity,0,100);
      if(!/^#[0-9a-fA-F]{6}$/.test(gla.tint||'')) gla.tint='#ffffff';
      const nb=(o,d)=>{
        o.on=!!o.on && (c.type==='rect'||c.type==='ellipse');
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
      const pr=Object.assign(de.prism, ce.prism||{});
      pr.on=!!pr.on && (c.type==='rect'||c.type==='ellipse');
      pr.shape=clamp(Math.round(+pr.shape)||0,0,8);
      pr.blend=pr.blend==='normal'?'normal':'add';
      pr.seeded=!!pr.seeded;
      pr.spectrum=(+pr.spectrum)?1:0;
      {
        const n=(k,lo,hi)=>{ const v=+pr[k], d=de.prism[k];
          pr[k]=Number.isFinite(v)?clamp(v,lo,hi):d; };
        n('thickness',0.01,3); n('corner',0,0.5); n('wedge',0,60);
        n('yaw',-180,180); n('pitch',-180,180); n('roll',-180,180);
        n('ior',1,2.4); n('dispersion',0,0.6); n('body',0,1);
        n('azimuth',-180,180); n('elevation',-89,89); n('intensity',0,8);
        n('width',0.005,2); n('softness',0.5,6); n('distance',1,60);
        n('aimX',-4,4); n('aimY',-4,4); n('falloff',0,1); n('inGain',0,3); n('outGain',0,4);
        n('bend',-180,180); n('fan',0,60); n('bands',0,24); n('fanRoll',-180,180);
        n('airScatter',0,1); n('glassScatter',0,8); n('saturation',0,1.6); n('rim',0,2);
        n('camZ',1.5,20); n('fov',5,70); n('reach',0.3,4);
        n('exposure',0.1,4); n('shoulder',0,1); n('grain',0,0.1);
        n('steps',8,192); n('quality',1,256); n('scale',0.15,1);
        ['colorA','colorB','beamColor'].forEach(k=>{
          if(!/^#[0-9a-fA-F]{6}$/.test(pr[k]||'')) pr[k]=de.prism[k];
        });
      }
      const cap=Object.assign(de.capsule, ce.capsule||{});
      cap.on=!!cap.on && (c.type==='rect'||c.type==='ellipse');
      {
        const n=(k,lo,hi)=>{ const v=+cap[k]; cap[k]=Number.isFinite(v)?clamp(v,lo,hi):de.capsule[k]; };
        n('lensSize',0.1,1.2); n('lensSquash',0.5,1.6); n('lensShift',-0.5,0.5);
        n('roughness',0,0.6); n('ior',1,2); n('dispersion',0,0.06); n('absorb',0,3);
        n('lensIor',1,2.2); n('lensAbsorb',0,8); n('reflection',0,100);
        n('depth',1.1,30); n('quality',1,128); n('scale',0.15,1);
        ['tint','lensTint'].forEach(k=>{
          if(!/^#[0-9a-fA-F]{6}$/.test(cap[k]||'')) cap[k]=de.capsule[k];
        });
      }
      const st=Object.assign(de.strip, ce.strip||{});
      st.on=!!st.on && (c.type==='rect'||c.type==='ellipse');
      {
        const n=(k,lo,hi)=>{ const v=+st[k]; st[k]=Number.isFinite(v)?clamp(v,lo,hi):de.strip[k]; };
        n('bulge',0,1); n('ribWidth',0.02,0.5); n('angle',-90,90); n('thickness',0.01,0.4);
        n('ior',1,2.2); n('dispersion',0,0.15); n('slopeLimit',0.2,20); n('smear',0.1,6);
      }
      const fnum=(o,k,lo,hi,d)=>{ const v=+o[k]; o[k]=Number.isFinite(v)?clamp(v,lo,hi):d; };
      const blur=Object.assign(de.blur, ce.blur||{});
      blur.kind=['gaussian','directional','zoom'].includes(blur.kind)?blur.kind:'gaussian';
      fnum(blur,'radius',0,200,0); fnum(blur,'angle',-180,180,0);
      fnum(blur,'distance',0,400,20); fnum(blur,'amount',0,1,0.2);
      fnum(blur,'cx',-0.5,0.5,0); fnum(blur,'cy',-0.5,0.5,0);
      const dis=Object.assign(de.distortion, ce.distortion||{});
      dis.mode=['wave','twirl','bulge','ripple'].includes(dis.mode)?dis.mode:'wave';
      dis.axis=['x','y','both'].includes(dis.axis)?dis.axis:'both';
      dis.edge=['clamp','wrap','mirror'].includes(dis.edge)?dis.edge:'clamp';
      fnum(dis,'amount',-200,200,0); fnum(dis,'wavelength',0.01,2,0.2);
      fnum(dis,'phase',-360,360,0); fnum(dis,'radius',0.05,2,0.5);
      fnum(dis,'cx',-0.5,0.5,0); fnum(dis,'cy',-0.5,0.5,0);
      const wrp=Object.assign(de.warp, ce.warp||{});
      wrp.envelope=(window.Filters?Filters.ENVELOPES:['arc']).includes(wrp.envelope)?wrp.envelope:'arc';
      wrp.axis=wrp.axis==='vertical'?'vertical':'horizontal';
      wrp.edge=['clamp','wrap','mirror'].includes(wrp.edge)?wrp.edge:'clamp';
      fnum(wrp,'strength',-100,100,0);
      const dsp=Object.assign(de.displacement, ce.displacement||{});
      dsp.channel=['red','green','blue','alpha','luminance'].includes(dsp.channel)?dsp.channel:'luminance';
      dsp.edge=['clamp','wrap','mirror'].includes(dsp.edge)?dsp.edge:'clamp';
      fnum(dsp,'scaleX',-300,300,0); fnum(dsp,'scaleY',-300,300,0);
      fnum(dsp,'mapScale',0.05,10,1); fnum(dsp,'seed',1,99999,1);
      const hz=Object.assign(de.haze, ce.haze||{});
      fnum(hz,'density',0,1,0); fnum(hz,'octaves',1,8,4); fnum(hz,'lacunarity',1.1,4,2);
      fnum(hz,'gain',0.1,0.9,0.5); fnum(hz,'scale',0.02,2,0.25);
      fnum(hz,'falloff',0.1,4,1); fnum(hz,'seed',1,99999,1);
      if(!/^#[0-9a-fA-F]{6}$/.test(hz.color||'')) hz.color='#ffffff';
      const slc=Object.assign(de.slice, ce.slice||{});
      slc.axis=slc.axis==='vertical'?'vertical':'horizontal';
      slc.mode=slc.mode==='random'?'random':'ramp';
      slc.edge=['clamp','wrap','mirror'].includes(slc.edge)?slc.edge:'clamp';
      fnum(slc,'count',2,200,8); fnum(slc,'offset',-400,400,0);
      fnum(slc,'gap',0,200,0); fnum(slc,'seed',1,99999,1);
      const nz=Object.assign(de.noise, ce.noise||{});
      fnum(nz,'amount',0,1,0); fnum(nz,'scale',1,32,1); fnum(nz,'seed',1,99999,1);
      nz.mono=nz.mono!==false;
      const li=Object.assign(de.light, ce.light||{});
      li.on=!!li.on && ['rect','ellipse','polygon','path'].includes(c.type);
      const num=(k,lo,hi,dv)=>{ const v=+li[k]; li[k]=Number.isFinite(v)?clamp(v,lo,hi):dv; };
      num('mode',0,34,0); num('throat',-0.2,0.55,0.39); num('mouth',0.35,1.4,0.95);
      num('curve',1,3.2,2.07); num('intensity',0,2.8,0.62); num('density',2,36,2);
      num('bloom',0,2.5,0); num('innerGlow',0,2.5,2.5); num('falloff',0,2.5,2.33);
      num('leftFade',0,1,0.45); num('meshMix',0,2.5,1.62); num('bandFlow',0,2,0);
      num('beamLength',0.1,2,1.17); num('beamGlow',0,2.5,0.65);
      li.transparent=li.transparent!==false;
      ['deep','core','inner','mesh','bg'].forEach(k=>{
        if(!/^#[0-9a-fA-F]{6}$/.test(li[k]||'')) li[k]='#000000';
      });
      const EFF=c.effects={shadow:sh, innerShadow:ish, glow:glw, grain:gr, gradient:grd,
        glass:gla, blob:blo, glass2:gl2, light:li, prism:pr, capsule:cap, strip:st,
        blur, distortion:dis, warp:wrp, displacement:dsp, haze:hz, slice:slc, noise:nz};
      /* §5.15: build the ORDERED stack. An existing document has only the
       * dictionary, so the array is laid out in the exact order the renderer
       * used to apply them — nothing moves on screen on first load. Entries
       * hold the SAME param objects the dictionary points at, so the twelve
       * engine panels keep editing through `obj.effects.<type>` unchanged. */
      const FS=window.FxStack;
      const known=FS?FS.types():Object.keys(EFF);
      let stack=Array.isArray(c.fx)?c.fx:null;
      if(stack){
        stack=stack.slice(0,32).filter(e=>e&&known.includes(e.type)).map(e=>({
          id:typeof e.id==='string'&&e.id?e.id:newId(),
          type:e.type, on:e.on!==false,
          params:(e.params&&typeof e.params==='object')?e.params:{},
        }));
        // a saved stack carries the params; fold them back into the
        // normalised dictionary objects so both views agree
        stack.forEach(e=>{ if(EFF[e.type]) Object.assign(EFF[e.type],e.params); });
      }else{
        stack=(FS?FS.LEGACY_ORDER:known).filter(t=>EFF[t]).map(t=>({
          id:newId(), type:t, on:true, params:EFF[t],
        }));
      }
      // re-link: entry params ARE the dictionary objects (first of each type)
      const seen={};
      stack.forEach(e=>{
        if(!seen[e.type]&&EFF[e.type]){ e.params=EFF[e.type]; seen[e.type]=1; }
      });
      // any known type missing from a saved stack is appended, off
      (FS?FS.LEGACY_ORDER:known).forEach(t=>{
        if(!seen[t]&&EFF[t]){ stack.push({id:newId(),type:t,on:true,params:EFF[t]}); seen[t]=1; }
      });
      c.fx=stack;
      delete c.__fxCache;
    }
    if(c.type!=='line'){
      // §2.2/§2.4/§2.5 transform state. Lines have no rot — their endpoints
      // ARE the orientation, and flip/rotate rewrite the endpoints directly.
      c.rot=((+c.rot||0)%360+360)%360;
      c.skewX=clamp(+c.skewX||0,-75,75);
      c.skewY=clamp(+c.skewY||0,-75,75);
      c.mirrorX=!!c.mirrorX; c.mirrorY=!!c.mirrorY;
    }
    // Stable identity. Required so instances can carry an explicit parentId.
    if(typeof c.id!=='string'||!c.id) c.id=newId();
    // §6.11 constraints — how this child reacts when its frame resizes
    const CN=(window.Components&&Components.CONSTRAINTS)||['left'];
    c.constraints={
      h:CN.includes((c.constraints||{}).h)?c.constraints.h:'left',
      v:['top','bottom','both','center','scale'].includes((c.constraints||{}).v)?c.constraints.v:'top',
    };
    // §6.12 per-child sizing inside a stack, plus the absolute escape hatch
    c.sizing=['fixed','hug','fill'].includes(c.sizing)?c.sizing:'fixed';
    c.absolute=!!c.absolute;
    // §3.8/§3.9 masking. `maskMode` on a container makes its TOP child the
    // mask for the rest; on any object it marks how it is used as one.
    c.maskMode=['none','alpha','luminance','clip'].includes(c.maskMode)?c.maskMode:'none';
    c.maskInvert=!!c.maskInvert;
    c.maskOn=c.maskOn!==false;
    // §1.1: lock suppresses canvas selectability, hide suppresses render too.
    // Document state, so they round-trip through save/load and history.
    c.locked=!!c.locked; c.hidden=!!c.hidden;
    if(c.type!=='text'&&c.type!=='line'&&c.type!=='path'&&!CONTAINER(c)){
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
    if(CONTAINER(c)){ delete c.pattern; delete c.engine; }
    return c;
  });
}
function newDoc(){
  return normalizeDoc({frame:{name:'Frame 1',w:900,h:600,bg:'#ffffff',children:[]}});
}

/* ================= history ================= */
/* §6.14 command-pattern history over structural diffs — see history.js for
 * why snapshots had to go. The call sites are unchanged: every committed edit
 * still calls pushHistory(), and a drag still pushes once on release, so
 * coalescing behaviour is identical. */
/* ---- compact serialization -------------------------------------------
 * MEASURED: a bare normalised rectangle was 7,565 bytes, of which 204 were the
 * fields that matter — a 37x multiple. normalizeDoc materialises all nineteen
 * effect types on every object so the twelve engine panels can read
 * `obj.effects.<type>` without null checks, and that is worth keeping IN
 * MEMORY. It is not worth writing to disk, to the clipboard, or into the undo
 * baseline, which is deep-cloned on every single edit.
 *
 * So the split is: fully materialised in memory, compact on the wire. An
 * effect survives compaction only if it DIFFERS from its default — which also
 * means a shadow you tuned and then switched off keeps your settings, because
 * the params still differ even though `on` is false.
 *
 * normalizeDoc() is the exact inverse: it re-materialises whatever is missing.
 * compact -> normalize is a round trip, which is what makes it safe to store
 * the compact form and rebuild from it.
 */
/* Key-order-INDEPENDENT deep equality. JSON.stringify comparison looks right
 * and is not: the normaliser rebuilds gradient stops as {pos,color} while the
 * default literal writes {color,pos}, so identical stops stringify differently
 * and every plain rectangle kept a 408-byte gradient it had never touched. */
function deepEq(a,b){
  if(a===b) return true;
  if(typeof a!==typeof b||a===null||b===null||typeof a!=='object') return a===b;
  if(Array.isArray(a)!==Array.isArray(b)) return false;
  if(Array.isArray(a)){
    if(a.length!==b.length) return false;
    for(let i=0;i<a.length;i++) if(!deepEq(a[i],b[i])) return false;
    return true;
  }
  const ka=Object.keys(a), kb=Object.keys(b);
  if(ka.length!==kb.length) return false;
  return ka.every(k=>Object.prototype.hasOwnProperty.call(b,k)&&deepEq(a[k],b[k]));
}
function sameAsDefault(type,params,defs){
  const d=defs[type];
  if(!d||!params) return false;
  // compare only the DEFAULT's own keys — the normaliser may add derived ones
  return Object.keys(d).every(k=>deepEq(d[k],params[k]));
}
function compactObj(c,defs){
  const out={};
  for(const k in c){
    if(k.startsWith('__')||k==='effects'||k==='fx') continue;
    out[k]=c[k];
  }
  // keep only effect entries the user actually moved away from the default
  if(Array.isArray(c.fx)){
    const keep=c.fx.filter(e=>!sameAsDefault(e.type,e.params,defs))
      .map(e=>({id:e.id,type:e.type,on:e.on!==false,params:e.params}));
    if(keep.length) out.fx=keep;
  }
  if(Array.isArray(c.children)) out.children=c.children.map(k=>compactObj(k,defs));
  return out;
}
function compactDoc(d){
  if(!d) return d;
  const defs=DEFAULT_EFFECTS();
  const out=JSON.parse(JSON.stringify(d,(k,v)=>k.startsWith('__')?undefined:v));
  const walk=f=>{
    if(!f) return;
    if(Array.isArray(f.children)) f.children=f.children.map(c=>compactObj(c,defs));
  };
  if(out.frame) walk(out.frame);
  if(Array.isArray(out.pages)) out.pages.forEach(p=>walk(p.frame||p));
  return out;
}
function compactPages(list){
  return (list||[]).map(p=>{
    const q={};
    for(const k in p){ if(!k.startsWith('__')) q[k]=p[k]; }
    if(q.frame) q.frame=compactDoc({frame:q.frame}).frame;
    return q;
  });
}

let HIST=null;
function initHistory(){
  if(!window.History) return;
  HIST=new window.History(
    /* The baseline is deep-cloned on every push and diffed on every edit, so
     * it stores the COMPACT form — the 37x effect bloat never enters it. */
    ()=>({pages:compactPages(pages),pageIdx}),
    st=>{
      pages=(st.pages||[]).map(p=>{
        // re-materialise: the compact form omits default effects
        if(p&&p.frame) return Object.assign({},p,{frame:normalizeDoc({frame:p.frame}).frame});
        return p;
      });
      setActivePage(st.pageIdx);
      // ids can vanish under us on undo; drop any selection that no longer exists
      setSelIds(new Set([...selIds]));
      selInstance=null;
      if(enteredId&&!findById(enteredId)) enteredId=null;
      refresh();
    });
}
function pushHistory(label){
  if(!HIST){ initHistory(); if(!HIST) return; }
  HIST.push(label);
  syncHistoryPanel();
}
function undo(){ if(HIST&&HIST.undo()) syncHistoryPanel(); }
function redo(){ if(HIST&&HIST.redo()) syncHistoryPanel(); }
function historyJump(i){ if(HIST&&HIST.jump(i)) syncHistoryPanel(); }

/* ---- §6.7/§6.8 instances --------------------------------------------- */
const CHELP={
  boxOf:o=>boxOf(o),
  translate:(o,dx,dy)=>translateObj(o,dx,dy),
  place:(o,x,y,w,h)=>placeObject(o,x,y,w,h),
};
/** Move AND resize an object to an exact box — the operation constraints and
 *  stack layout both need, and the one place that knows how each type resizes. */
function placeObject(o,x,y,w,h){
  const b=boxOf(o);
  translateObj(o,x-b.x,y-b.y);
  if(w===undefined||h===undefined) return;
  const sx=b.w?w/b.w:1, sy=b.h?h/b.h:1;
  if(Math.abs(sx-1)<1e-6&&Math.abs(sy-1)<1e-6) return;
  const nb=boxOf(o);
  if(o.type==='text'&&o.mode!=='area'){ o.size=clamp(Math.round(o.size*sy),8,300); return; }
  if(o.type==='line'){
    o.x2=nb.x+(o.x2-nb.x)*sx; o.y2=nb.y+(o.y2-nb.y)*sy;
    o.x=nb.x+(o.x-nb.x)*sx;  o.y=nb.y+(o.y-nb.y)*sy;
    return;
  }
  if(o.type==='path'){
    (o.subpaths||[]).forEach(sp=>sp.points.forEach(q=>{
      q.x=nb.x+(q.x-nb.x)*sx; q.y=nb.y+(q.y-nb.y)*sy;
      q.ox*=sx; q.oy*=sy; q.ix*=sx; q.iy*=sy;
    }));
    return;
  }
  if(CONTAINER(o)){
    (o.children||[]).forEach(k=>{
      const kb=boxOf(k);
      placeObject(k,nb.x+(kb.x-nb.x)*sx,nb.y+(kb.y-nb.y)*sy,kb.w*sx,kb.h*sy);
    });
    if(o.type==='frame'){ o.w=w; o.h=h; }
    return;
  }
  o.w=Math.max(1,w); o.h=Math.max(1,h);
}
/** The drawable tree for an instance, cached against its inputs. */
function instanceTree(inst){
  const C=window.Components;
  if(!C||!doc) return null;
  const defs=doc.frame.components||[];
  const sig=inst.compId+'|'+(inst.variant||'')+'|'+inst.x+','+inst.y+'|'+
    (inst.rot||0)+'|'+(inst.opacity===undefined?1:inst.opacity)+'|'+
    JSON.stringify(inst.overrides||{})+'|'+(doc.__defRev||0);
  if(inst.__sig===sig&&inst.__tree) return inst.__tree;
  const tree=C.resolve(inst,defs,CHELP);
  inst.__sig=sig; inst.__tree=tree;
  return tree;
}
/** Bump when a definition changes, so every instance re-resolves (§6.7
 *  "instances update when the source changes"). */
function defsChanged(){ if(doc) doc.__defRev=(doc.__defRev||0)+1; }

/* ---- §6.5 artboards -------------------------------------------------- */
/** The artboard an object sits in — the one containing its centre. Topmost
 *  (last in the list) wins where artboards overlap. */
function artboardOf(o){
  if(!doc||!doc.frame.artboards) return null;
  const b=aabbOf(o), cx=b.x+b.w/2, cy=b.y+b.h/2;
  const A=doc.frame.artboards;
  for(let i=A.length-1;i>=0;i--){
    const a=A[i];
    if(cx>=a.x&&cx<=a.x+a.w&&cy>=a.y&&cy<=a.y+a.h) return a;
  }
  return null;
}
function objectsInArtboard(a){
  return allObjects().filter(o=>artboardOf(o)===a);
}

/* ================= document tree (§6.9/§6.10) =================
 * Groups and frames hold their own `children`. Child coordinates stay
 * ABSOLUTE (page space) rather than parent-relative: it keeps every existing
 * geometry path — hit tests, handles, snapping, engines — working unchanged,
 * and a group transform is applied around the children at draw time.
 * A frame is a group that CLIPS to its box. */
const CONTAINER=o=>o&&(o.type==='group'||o.type==='frame'||o.type==='boolean');
/* §3.3–3.6 non-destructive booleans: a `boolean` is a container whose children
 * are the OPERANDS and whose rendered geometry is computed from them. Editing
 * an operand updates the result; "Flatten" turns it into a plain path. The
 * result is cached against a signature of the inputs so a redraw is free. */
function boolSignature(o){
  return o.boolOp+'|'+o.fillRule+'|'+(o.children||[]).map(k=>{
    const b=boxOf(k);
    return k.type+':'+Math.round(b.x)+','+Math.round(b.y)+','+Math.round(b.w)+','+Math.round(b.h)
      +':'+(k.rot||0)+':'+(k.mirrorX?1:0)+(k.mirrorY?1:0)+':'+(k.hidden?'h':'')
      +(k.type==='path'?':'+(k.subpaths||[]).map(sp=>sp.points.length).join('.'):'')
      +(k.type==='polygon'?':'+k.sides+'.'+k.innerRatio:'')
      +(k.type==='ellipse'?':'+k.startAngle+'.'+k.endAngle+'.'+k.innerRatio:'')
      +(k.type==='rect'?':'+(k.radii||[k.radius]).join('.')+'.'+k.cornerStyle:'');
  }).join('|');
}
/** Geometric outline sampling per primitive type (page space, pre-rotation). */
function samplePolyline(o,tol){
  const b=boxOf(o), out=[];
  const push=(x,y)=>out.push([x,y]);
  const N=n=>Math.max(16,Math.min(360,Math.ceil(n)));
  if(o.type==='ellipse'){
    const cx=b.x+b.w/2, cy=b.y+b.h/2, rx=b.w/2, ry=b.h/2;
    const s=+o.startAngle||0, e=o.endAngle===undefined?360:+o.endAngle;
    const inner=clamp(+o.innerRatio||0,0,0.95);
    const full=Math.abs(e-s)>=360;
    const n=N((b.w+b.h)/2/Math.max(tol,0.3));
    const a0=(s-90)*Math.PI/180, a1=(e-90)*Math.PI/180;
    for(let i=0;i<=n;i++){ const a=a0+(a1-a0)*(i/n); push(cx+Math.cos(a)*rx,cy+Math.sin(a)*ry); }
    if(inner>0){ for(let i=n;i>=0;i--){ const a=a0+(a1-a0)*(i/n);
      push(cx+Math.cos(a)*rx*inner,cy+Math.sin(a)*ry*inner); } }
    else if(!full) push(cx,cy);
    return [out];
  }
  if(o.type==='polygon'){
    const cx=b.x+b.w/2, cy=b.y+b.h/2, rx=b.w/2, ry=b.h/2;
    const sides=clamp(Math.round(o.sides||5),3,24);
    const inner=clamp(o.innerRatio===undefined?1:+o.innerRatio,0.1,1);
    const star=inner<0.999, steps=star?sides*2:sides;
    for(let i=0;i<steps;i++){
      const rr=star&&(i%2===1)?inner:1;
      const a=-Math.PI/2+i*(Math.PI*2/steps);
      push(cx+Math.cos(a)*rx*rr, cy+Math.sin(a)*ry*rr);
    }
    return [out];
  }
  if(o.type==='rect'){
    const mx=Math.min(b.w,b.h)/2;
    const u=clamp(o.radius||0,0,mx);
    const R=(Array.isArray(o.radii)?o.radii:[u,u,u,u]).map(v=>clamp(+v||0,0,mx));
    const [tl,tr,br,bl]=R;
    const arc=(cx,cy,r,a0,a1)=>{ const n=N(r/Math.max(tol,0.3)*2);
      for(let i=0;i<=n;i++){ const a=a0+(a1-a0)*(i/n); push(cx+Math.cos(a)*r,cy+Math.sin(a)*r); } };
    const H=Math.PI/2;
    push(b.x+tl,b.y); push(b.x+b.w-tr,b.y);
    if(tr>0.5) arc(b.x+b.w-tr,b.y+tr,tr,-H,0);
    push(b.x+b.w,b.y+b.h-br);
    if(br>0.5) arc(b.x+b.w-br,b.y+b.h-br,br,0,H);
    push(b.x+bl,b.y+b.h);
    if(bl>0.5) arc(b.x+bl,b.y+b.h-bl,bl,H,Math.PI);
    push(b.x,b.y+tl);
    if(tl>0.5) arc(b.x+tl,b.y+tl,tl,Math.PI,Math.PI*1.5);
    return [out];
  }
  return [];
}
/** The computed subpaths for a boolean container, cached on the object. */
function boolResult(o){
  if(!window.BooleanEngine||!BooleanEngine.available()) return null;
  const sig=boolSignature(o);
  if(o.__sig===sig&&o.__res!==undefined) return o.__res;
  const kids=(o.children||[]).filter(k=>!k.hidden&&k.type!=='text'&&k.type!=='line');
  const res=kids.length>=2
    ? BooleanEngine.compute(o.boolOp,kids,{boxOf,addPathTo:(k,tol)=>samplePolyline(k,tol)[0]},o.fillRule)
    : null;
  o.__sig=sig; o.__res=res;
  return res;
}
/** Depth-first walk over every object, containers included. */
function walkAll(list,fn,parent){
  (list||[]).forEach((o,i)=>{ fn(o,list,i,parent); if(CONTAINER(o)) walkAll(o.children,fn,o); });
}
function allObjects(){ const out=[]; if(doc) walkAll(doc.frame.children,o=>out.push(o)); return out; }
/** {obj,list,index,parent} for an id anywhere in the tree, or null. */
function findById(id){
  let hit=null;
  if(doc) walkAll(doc.frame.children,(o,list,i,parent)=>{ if(!hit&&o.id===id) hit={obj:o,list,index:i,parent}; });
  return hit;
}
/** The list an object lives in (its parent's children, or the page's). */
function listOf(o){ const f=findById(o.id); return f?f.list:doc.frame.children; }
/** Objects at the level currently being edited — the page, or an entered group. */
function activeList(){
  if(enteredId){ const f=findById(enteredId); if(f&&CONTAINER(f.obj)) return f.obj.children; }
  return doc?doc.frame.children:[];
}
/** True if `o` is inside the container we have entered (or we are at top level). */
function atActiveLevel(o){ return activeList().includes(o); }

/* ================= selection model ================= */
/** Single-select: collapses the id-set to one object (or none). */
function setSel(i){
  sel=i;
  selIds.clear();
  const o=i>=0&&activeList()[i];
  if(o) selIds.add(o.id);
}
/** Multi-select from ids. `primaryId` (default: last id) becomes `sel`. */
function setSelIds(ids,primaryId){
  selIds=new Set(ids);
  if(!doc||!selIds.size){ sel=-1; return; }
  // drop ids that no longer exist ANYWHERE in the tree
  selIds.forEach(id=>{ if(!findById(id)) selIds.delete(id); });
  const pid=primaryId&&selIds.has(primaryId)?primaryId:[...selIds][selIds.size-1];
  const L=activeList();
  sel=L.findIndex(c=>c.id===pid);
  if(sel<0){ const f=findById(pid); if(f) sel=f.list.indexOf(f.obj); }
}
function selObjs(){ return doc?allObjects().filter(c=>selIds.has(c.id)):[]; }
/** The primary selected object, wherever it lives. */
function primary(){
  if(!doc) return null;
  const L=activeList();
  if(sel>=0&&L[sel]&&selIds.has(L[sel].id)) return L[sel];
  const first=[...selIds][0];
  return first?(findById(first)||{}).obj||null:null;
}
/** Union bounds of the selection, or null. */
function selBounds(){
  const os=selObjs(); if(!os.length) return null;
  let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
  os.forEach(o=>{ const b=aabbOf(o);
    x0=Math.min(x0,b.x); y0=Math.min(y0,b.y);
    x1=Math.max(x1,b.x+b.w); y1=Math.max(y1,b.y+b.h); });
  return {x:x0,y:y0,w:x1-x0,h:y1-y0};
}
function selectable(o){ return !o.locked&&!o.hidden; }


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
/* §4.4 blend modes: the exact separable + non-separable set from
 * W3C Compositing and Blending Level 1
 * (https://www.w3.org/TR/compositing-1/) — that spec carries a royalty-free
 * patent commitment, and deviating from its list forfeits that protection.
 * Canvas globalCompositeOperation implements these names directly. */
const BLEND_MODES=['normal','multiply','screen','overlay','darken','lighten',
  'color-dodge','color-burn','hard-light','soft-light','difference','exclusion',
  'hue','saturation','color','luminosity'];
const blendOp=m=>(m&&m!=='normal'&&BLEND_MODES.includes(m))?m:'source-over';

/* §4.5/§4.6: a paint spec -> a canvas style. Per-stop opacity is baked into
 * the stop colour (canvas gradients take colour strings), and the
 * interpolation midpoint is emitted as an extra sampled stop, since canvas
 * gradients are always linear between stops. */
function stopColor(s){
  const a=s.opacity===undefined?1:clamp(+s.opacity,0,1);
  if(a>=1) return s.color;
  const n=parseInt(String(s.color).slice(1),16);
  return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${a})`;
}
function mixHex(c1,c2,t){
  const a=parseInt(String(c1).slice(1),16), b2=parseInt(String(c2).slice(1),16);
  const ch=(sh)=>Math.round((((a>>sh)&255)+((((b2>>sh)&255)-((a>>sh)&255))*t)));
  return '#'+[16,8,0].map(sh=>ch(sh).toString(16).padStart(2,'0')).join('');
}
function addStops(g,stops){
  const S=[...stops].sort((x,y)=>x.pos-y.pos);
  S.forEach((s,i)=>{
    g.addColorStop(clamp(s.pos,0,1),stopColor(s));
    const nx=S[i+1];
    // midpoint: where the 50% blend between this stop and the next lands
    const m=s.mid===undefined?0.5:clamp(+s.mid,0.05,0.95);
    if(nx&&Math.abs(m-0.5)>0.01){
      const p=clamp(s.pos+(nx.pos-s.pos)*m,0,1);
      g.addColorStop(p,stopColor({color:mixHex(s.color,nx.color,0.5),
        opacity:((s.opacity===undefined?1:s.opacity)+(nx.opacity===undefined?1:nx.opacity))/2}));
    }
  });
}
function paintStyle(c,f,b){
  if(!f||f.kind==='solid') return (f&&f.color)||'#cccccc';
  if(f.kind==='radial'){
    // §4.6: focal point offset + elliptical aspect
    const cx=b.x+b.w/2, cy=b.y+b.h/2;
    const asp=clamp(+f.aspect||1,0.2,5);
    const r=Math.max(b.w,b.h)/2;
    const fx=cx+(+f.fx||0)*b.w/2, fy=cy+(+f.fy||0)*b.h/2;
    let g;
    if(Math.abs(asp-1)<0.01){
      g=c.createRadialGradient(fx,fy,0,cx,cy,r);
      addStops(g,f.stops); return g;
    }
    // elliptical: scale the space about the centre, build a circular gradient
    c.save();
    c.translate(cx,cy); c.scale(1,1/asp); c.translate(-cx,-cy);
    g=c.createRadialGradient(fx,(fy-cy)*asp+cy,0,cx,cy,r);
    addStops(g,f.stops);
    c.__ellipticalGrad=true;              // caller restores after painting
    return g;
  }
  const a=(f.angle||0)*Math.PI/180, dx=Math.cos(a), dy=Math.sin(a);
  const cx=b.x+b.w/2, cy=b.y+b.h/2, ext=Math.abs(dx)*b.w/2+Math.abs(dy)*b.h/2;
  const g=c.createLinearGradient(cx-dx*ext,cy-dy*ext,cx+dx*ext,cy+dy*ext);
  addStops(g,f.stops);
  return g;
}
/* Back-compat shim: older code paths (blob flood, engines) still ask for a
 * single fill style. Returns the bottom-most visible fill. */
function fillStyleFor(c,obj,b){
  const F=(obj.fills||[]).filter(f=>f.on!==false);
  return paintStyle(c,F.length?F[0]:obj.fill,b);
}
/* One corner of a rectangle. The path is already at the corner's approach
 * point; this emits the treatment and leaves the path at the exit point.
 *   round — convex arc (arcTo through the corner)
 *   bevel — straight chamfer
 *   scoop — concave quarter-arc centred ON the corner point */
function rectCorner(c,style,cx,cy,toX,toY,r){
  if(r<=0.5){ c.lineTo(cx,cy); return; }
  if(style==='bevel'){ c.lineTo(toX,toY); return; }
  if(style==='scoop'){
    const a1=Math.atan2(toY-cy,toX-cx);
    // current point is the approach point; sweep the short way to the exit
    const cur=c.__last||[cx,cy];
    const a0=Math.atan2(cur[1]-cy,cur[0]-cx);
    const ccw=((a1-a0+Math.PI*2)%(Math.PI*2))>Math.PI;
    c.arc(cx,cy,r,a0,a1,ccw);
    return;
  }
  c.arcTo(cx,cy,toX,toY,r);
}
function rectPath(c,o){
  const x=o.x,y=o.y,w=o.w,h=o.h,mx=Math.min(w,h)/2;
  const u=clamp(o.radius||0,0,mx);
  // §1.5: independent per-corner radii [tl,tr,br,bl]; uniform radius otherwise.
  // Clamped against the CURRENT box, so non-uniform scaling stays valid.
  const R=(Array.isArray(o.radii)?o.radii:[u,u,u,u]).map(v=>clamp(+v||0,0,mx));
  const st=o.cornerStyle||'round';
  if(!R.some(v=>v>0.5)){ c.rect(x,y,w,h); return; }
  const [tl,tr,br,bl]=R;
  const at=(px,py)=>{ c.__last=[px,py]; };
  c.moveTo(x+tl,y);
  c.lineTo(x+w-tr,y); at(x+w-tr,y);
  rectCorner(c,st,x+w,y,   x+w,y+tr,  tr);
  c.lineTo(x+w,y+h-br); at(x+w,y+h-br);
  rectCorner(c,st,x+w,y+h, x+w-br,y+h, br);
  c.lineTo(x+bl,y+h); at(x+bl,y+h);
  rectCorner(c,st,x,y+h,   x,y+h-bl,  bl);
  c.lineTo(x,y+tl); at(x,y+tl);
  rectCorner(c,st,x,y,     x+tl,y,    tl);
  c.closePath();
  delete c.__last;
}
/* §1.6: full disc, ring, pie sector, or annular (donut) sector. Angles are
 * degrees clockwise from 12 o'clock. */
function ellipsePath(c,o){
  const cx=o.x+o.w/2, cy=o.y+o.h/2, rx=Math.max(0.5,o.w/2), ry=Math.max(0.5,o.h/2);
  const s=+o.startAngle||0, e=o.endAngle===undefined?360:+o.endAngle;
  const inner=clamp(+o.innerRatio||0,0,0.95);
  const full=Math.abs(e-s)>=360;
  const a0=(s-90)*Math.PI/180, a1=(e-90)*Math.PI/180;
  if(full){
    c.ellipse(cx,cy,rx,ry,0,0,Math.PI*2);
    // reversed inner sweep + nonzero winding = ring
    if(inner>0) c.ellipse(cx,cy,rx*inner,ry*inner,0,Math.PI*2,0,true);
    return;
  }
  c.ellipse(cx,cy,rx,ry,0,a0,a1);
  if(inner>0) c.ellipse(cx,cy,rx*inner,ry*inner,0,a1,a0,true);
  else c.lineTo(cx,cy);           // pie: close through the centre
  c.closePath();
}
/* §1.7: regular polygon; star when innerRatio<1 (alternating radii). Corner
 * radius rounds every vertex via arcTo. Rotation comes from obj.rot, applied
 * by drawObject about the centre like every other shape. */
function polygonPath(c,o){
  const cx=o.x+o.w/2, cy=o.y+o.h/2, rx=o.w/2, ry=o.h/2;
  const n=clamp(Math.round(o.sides||5),3,24);
  const inner=clamp(o.innerRatio===undefined?1:+o.innerRatio,0.1,1);
  const star=inner<0.999;
  const steps=star?n*2:n;
  const pts=[];
  for(let i=0;i<steps;i++){
    const rr=star&&(i%2===1)?inner:1;
    const a=-Math.PI/2+i*(Math.PI*2/steps);
    pts.push([cx+Math.cos(a)*rx*rr, cy+Math.sin(a)*ry*rr]);
  }
  const r=clamp(o.radius||0,0,Math.min(rx,ry)*0.6);
  if(r>0.5){
    const mid=(a,b)=>[(a[0]+b[0])/2,(a[1]+b[1])/2];
    const m0=mid(pts[steps-1],pts[0]);
    c.moveTo(m0[0],m0[1]);
    for(let i=0;i<steps;i++){
      const cur=pts[i], nxt=pts[(i+1)%steps], m=mid(cur,nxt);
      c.arcTo(cur[0],cur[1],m[0],m[1],r);
    }
    c.closePath();
  }else{
    pts.forEach((p,i)=>i?c.lineTo(p[0],p[1]):c.moveTo(p[0],p[1]));
    c.closePath();
  }
}
/* §1.2–1.4 path object: cubic bézier chain. Handles are stored RELATIVE to
 * their anchor (ox,oy = out, ix,iy = in), so translating a path only touches
 * anchor coords. Anchor mode m: 'corner' (no handles), 'smooth' (mirrored),
 * 'asym' (same angle, free lengths), 'free' (disconnected). */
function subPath(c,sp){
  const P=sp.points; if(!P||P.length<2) return;
  c.moveTo(P[0].x,P[0].y);
  for(let i=1;i<P.length;i++){
    const a=P[i-1], b=P[i];
    c.bezierCurveTo(a.x+a.ox,a.y+a.oy, b.x+b.ix,b.y+b.iy, b.x,b.y);
  }
  if(sp.closed&&P.length>2){
    const a=P[P.length-1], b=P[0];
    c.bezierCurveTo(a.x+a.ox,a.y+a.oy, b.x+b.ix,b.y+b.iy, b.x,b.y);
    c.closePath();
  }
}
function pathPath(c,o){ (o.subpaths||[{points:o.points,closed:o.closed}]).forEach(sp=>subPath(c,sp)); }
/* §4.1–§4.4 appearance painter. `mk` builds the object's path into ctx.
 * Fills paint bottom-to-top, then strokes, each with its own opacity and
 * blend mode. Stroke alignment is done with clipping, since Canvas2D only
 * strokes centred: inside = clip to the shape and stroke double width;
 * outside = stroke double width, then knock the interior back out. */
/* Reusable scratch layer for stroke alignment and any other pass that needs
 * to composite a shape against itself without touching what is beneath. */
let _strokeLayer=null;
function strokeLayer(w,h){
  if(!_strokeLayer) _strokeLayer=document.createElement('canvas');
  if(_strokeLayer.width!==w||_strokeLayer.height!==h){ _strokeLayer.width=w; _strokeLayer.height=h; }
  return _strokeLayer;
}
function paintAppearance(c,obj,mk,b,objBlend){
  // An entry set to 'normal' inherits the object's blend mode; an entry with
  // its own mode overrides it (§4.4 applies at both levels).
  const bl=m=>blendOp(m&&m!=='normal'?m:(objBlend||'normal'));
  const fo=obj.fillOpacity===undefined?1:obj.fillOpacity;
  const so=obj.strokeOpacity===undefined?1:obj.strokeOpacity;
  const base=c.globalAlpha;
  const fills=obj.fills||[];
  // A path is fillable when it has at least one CLOSED subpath — checking
  // obj.closed alone missed compound paths and boolean results, which carry
  // their contours in subpaths and never set the single-contour alias.
  const closedish=obj.type!=='path'||
    (obj.fillOn&&(obj.subpaths||[{closed:obj.closed}]).some(sp=>sp.closed));
  const fr=(obj.type==='path'&&obj.fillRule==='evenodd')?'evenodd':'nonzero';
  if(closedish) fills.forEach(f=>{
    if(f.on===false||f.opacity<=0) return;
    c.save();
    c.globalAlpha=base*fo*f.opacity;
    c.globalCompositeOperation=bl(f.blend);
    const st=paintStyle(c,f,b);
    c.beginPath(); mk(c);
    c.fillStyle=st; c.fill(fr);
    if(c.__ellipticalGrad){ delete c.__ellipticalGrad; c.restore(); c.restore(); return; }
    c.restore();
  });
  (obj.strokes||[]).forEach(k=>{
    if(k.on===false||k.width<=0||k.opacity<=0) return;
    c.save();
    c.globalAlpha=base*so*k.opacity;
    c.globalCompositeOperation=bl(k.blend);
    c.strokeStyle=paintStyle(c,k,b);
    c.lineCap=k.cap; c.lineJoin=k.join; c.miterLimit=k.miter;
    if(k.dash&&k.dash.length){ c.setLineDash(k.dash); c.lineDashOffset=k.dashOffset||0; }
    const inner=k.align==='inside', outer=k.align==='outside';
    c.lineWidth=(inner||outer)?k.width*2:k.width;
    if(outer){
      // Outside alignment needs its OWN layer: knocking the inner half out
      // with destination-out directly on the target would erase the fill and
      // the page underneath it, not just the unwanted half of the stroke.
      const tmp=strokeLayer(c.canvas.width,c.canvas.height);
      const tc=tmp.getContext('2d');
      tc.setTransform(1,0,0,1,0,0);
      // The scratch canvas is REUSED, so its context carries state between
      // objects. destination-out left over from the previous outside stroke
      // would composite this one into an empty layer and it would vanish.
      tc.globalCompositeOperation='source-over';
      tc.globalAlpha=1;
      tc.setLineDash([]);
      tc.clearRect(0,0,tmp.width,tmp.height);
      tc.setTransform(c.getTransform());
      tc.strokeStyle=paintStyle(tc,k,b);
      tc.lineWidth=k.width*2; tc.lineCap=k.cap; tc.lineJoin=k.join; tc.miterLimit=k.miter;
      if(k.dash&&k.dash.length){ tc.setLineDash(k.dash); tc.lineDashOffset=k.dashOffset||0; }
      tc.beginPath(); mk(tc); tc.stroke();
      tc.globalCompositeOperation='destination-out';
      tc.beginPath(); mk(tc); tc.fillStyle='#000'; tc.fill();
      if(tc.__ellipticalGrad) delete tc.__ellipticalGrad;
      c.save();
      c.setTransform(1,0,0,1,0,0);
      c.globalAlpha=base*so*k.opacity;
      c.globalCompositeOperation=bl(k.blend);
      c.drawImage(tmp,0,0);
      c.restore();
    }else{
      if(inner){ c.beginPath(); mk(c); c.clip(); }
      c.beginPath(); mk(c); c.stroke();
    }
    if(c.__ellipticalGrad) delete c.__ellipticalGrad;
    c.restore();
  });
  c.globalAlpha=base;
}
/* Append-only path builder. Callers begin the path themselves, which is what
 * lets a shape be combined with another subpath (the inverse-region fill that
 * casts an inner shadow) instead of replacing it. */
function addPath(c,obj){
  if(obj.type==='path'){ pathPath(c,obj); return; }
  if(obj.type==='ellipse') ellipsePath(c,obj);
  else if(obj.type==='polygon') polygonPath(c,obj);
  else if(obj.type==='line'){
    c.moveTo(obj.x,obj.y); c.lineTo(obj.x2,obj.y2);
  }
  else rectPath(c,obj);
}
function pathFor(c,obj){ c.beginPath(); addPath(c,obj); }
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
  /* nested-aware */
  if(!doc) return [];
  const out=[];
  allObjects().forEach(c=>{ patternInstances(c).forEach(i=>out.push(i)); });
  return out;
}

/* Members of a blob/glass2 group: every shape on the page with that effect
 * enabled, plus each one's linked pattern copies. A lone shape still merges
 * with its own copies, so the original behaviour is a strict subset. */
/* Blob and Glass 2 are ONE merged body with two possible materials, not two
 * separate groups. Splitting them meant a Blob shape and a Glass 2 shape could
 * never merge — each sat alone in its own group. Membership is therefore
 * "either effect is on"; the material is glass when ANY member asks for it. */
function inBlobGroup(o){
  const e=o&&o.effects;
  if(!o||o.hidden||o.type==='text'||!e) return false;
  // a disabled stack entry must switch the merge off too, not just the param
  return fxOn(o,'blob')||fxOn(o,'glass2');
}
function blobGroup(){
  /* nested-aware: blob members can live inside groups */
  if(!doc) return [];
  const out=[];
  allObjects().forEach(o=>{ if(inBlobGroup(o)) out.push(o,...patternInstances(o)); });
  return out;
}
function groupGlassParams(){
  if(!doc) return null;
  const o=doc.frame.children.find(x=>x.type!=='text'&&x.effects&&x.effects.glass2&&x.effects.glass2.on);
  return o?o.effects.glass2:null;
}
function groupBlobParams(){
  if(!doc) return null;
  const o=allObjects().find(inBlobGroup);
  if(!o) return null;
  const e=o.effects;
  return (e.glass2&&e.glass2.on)?e.glass2:e.blob;
}
/* Group members are one body, so they must agree on the group's settings.
 * Writing an edit to every member means it does not matter which member
 * happens to render the group — previously the first member's values won and
 * edits made on any other member were silently ignored. */
function applyToGroup(key,fn){
  if(!doc) return;
  doc.frame.children.forEach(o=>{
    if(!inBlobGroup(o)) return;
    // Shared geometry settings are written to BOTH effect records so the body
    // keeps one shape whichever material it ends up rendering with.
    if(key==='shared'){ fn(o.effects.blob); fn(o.effects.glass2); return; }
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
function isFirstOfGroup(obj){
  return allObjects().find(inBlobGroup)===obj;
}

function drawDoc(c,W,H){
  const f=doc.frame;
  c.clearRect(0,0,Math.max(W,f.w)+8000,Math.max(H,f.h)+8000);
  c.fillStyle=f.bg; c.fillRect(0,0,f.w,f.h);
  // §6.5: each artboard paints its own background before any content
  (f.artboards||[]).forEach(a=>{
    if(!a.show) return;
    c.fillStyle=a.bg;
    c.fillRect(a.x,a.y,a.w,a.h);
  });
  /* Artboards that CLIP need their members drawn inside a clip region, so the
   * children are bucketed by artboard first. Anything outside every artboard,
   * or inside a non-clipping one, draws normally in document order. */
  const clippers=(f.artboards||[]).filter(a=>a.show&&a.clip);
  if(!clippers.length){ drawList(c,W,H,f.children); return; }
  f.children.forEach(o=>{
    if(o.hidden) return;
    const a=artboardOf(o);
    if(a&&a.clip){
      c.save();
      c.beginPath(); c.rect(a.x,a.y,a.w,a.h); c.clip();
      drawList(c,W,H,[o]);
      c.restore();
    }else drawList(c,W,H,[o]);
  });
}
/* §3.8/§3.9: a container whose maskMode is not 'none' uses its TOP child as
 * the mask for everything beneath it inside that container.
 *   clip      — vector mask: keep where the mask's shape covers
 *   alpha     — keep by the mask's alpha
 *   luminance — keep by the mask's brightness
 * The masked content and the mask are each rendered to their own layer, so
 * masking never reaches outside the container. */
let _maskPool=[];
function maskLayer(i,w,h){
  if(!_maskPool[i]) _maskPool[i]=document.createElement('canvas');
  const cv2=_maskPool[i];
  if(cv2.width!==w||cv2.height!==h){ cv2.width=w; cv2.height=h; }
  const cx=cv2.getContext('2d');
  cx.setTransform(1,0,0,1,0,0);
  cx.globalCompositeOperation='source-over'; cx.globalAlpha=1;
  cx.clearRect(0,0,w,h);
  return cv2;
}
function drawMasked(c,W,H,cont,depth){
  const kids=(cont.children||[]).filter(o=>!o.hidden);
  if(kids.length<2){ drawList(c,W,H,cont.children,depth); return; }
  const mask=kids[kids.length-1];
  const rest=kids.slice(0,-1);
  const base=depth*2;
  const contentCv=maskLayer(base,W,H), maskCv=maskLayer(base+1,W,H);
  drawList(contentCv.getContext('2d'),W,H,rest,depth+1);
  drawList(maskCv.getContext('2d'),W,H,[mask],depth+1);
  const mc=maskCv.getContext('2d');
  if(cont.maskMode==='luminance'){
    // brightness -> alpha, per Rec.709
    const img=mc.getImageData(0,0,W,H), d2=img.data;
    for(let i=0;i<d2.length;i+=4){
      const lum=(0.2126*d2[i]+0.7152*d2[i+1]+0.0722*d2[i+2])/255;
      d2[i+3]=Math.round(d2[i+3]*lum);
    }
    mc.putImageData(img,0,0);
  }
  if(cont.maskInvert){
    // keep the complement: paint opaque everywhere, subtract the mask
    const inv=maskLayer(base+1===base?base+2:base+2,W,H);
    const ic=inv.getContext('2d');
    ic.fillStyle='#000'; ic.fillRect(0,0,W,H);
    ic.globalCompositeOperation='destination-out';
    ic.drawImage(maskCv,0,0);
    mc.setTransform(1,0,0,1,0,0);
    mc.globalCompositeOperation='copy';
    mc.drawImage(inv,0,0);
    mc.globalCompositeOperation='source-over';
  }
  const cc=contentCv.getContext('2d');
  cc.setTransform(1,0,0,1,0,0);
  cc.globalCompositeOperation='destination-in';
  cc.drawImage(maskCv,0,0);
  cc.globalCompositeOperation='source-over';
  c.save(); c.setTransform(1,0,0,1,0,0);
  c.globalAlpha=cont.opacity===undefined?1:cont.opacity;
  c.drawImage(contentCv,0,0);
  c.restore();
}
function drawList(c,W,H,list,depth){
  depth=depth||0;
  if(depth>8) return;
  (list||[]).forEach(obj=>{
    if(obj.hidden) return;
    if(CONTAINER(obj)){
      const b=boxOf(obj);
      c.save();
      // §6.9 group-level transform, opacity and blend apply to the composite
      if(obj.rot||obj.skewX||obj.skewY||obj.mirrorX||obj.mirrorY){
        const cx=b.x+b.w/2, cy=b.y+b.h/2;
        c.translate(cx,cy);
        if(obj.rot) c.rotate(obj.rot*Math.PI/180);
        if(obj.skewX||obj.skewY)
          c.transform(1,Math.tan((obj.skewY||0)*Math.PI/180),Math.tan((obj.skewX||0)*Math.PI/180),1,0,0);
        if(obj.mirrorX||obj.mirrorY) c.scale(obj.mirrorX?-1:1,obj.mirrorY?-1:1);
        c.translate(-cx,-cy);
      }
      if(obj.blend&&obj.blend!=='normal') c.globalCompositeOperation=blendOp(obj.blend);
      if(obj.type==='boolean'){
        // §3.3–3.6: the operands are not drawn — the computed result is.
        const res=boolResult(obj);
        if(res&&res.length){
          const proxy={type:'path',subpaths:res,fillRule:obj.fillRule,fillOn:obj.fillOn,
            fills:obj.fills,strokes:obj.strokes,
            fillOpacity:obj.fillOpacity,strokeOpacity:obj.strokeOpacity};
          const pb=(function(){let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
            res.forEach(sp=>sp.points.forEach(p=>{x0=Math.min(x0,p.x);y0=Math.min(y0,p.y);
              x1=Math.max(x1,p.x);y1=Math.max(y1,p.y);}));
            return {x:x0,y:y0,w:x1-x0,h:y1-y0};})();
          const a=c.globalAlpha;
          c.globalAlpha=a*(obj.opacity===undefined?1:obj.opacity);
          paintAppearance(c,proxy,cc=>pathPath(cc,proxy),pb,obj.blend);
          c.globalAlpha=a;
        }else{
          // not enough operands yet: show them so the user can see what they have
          drawList(c,W,H,obj.children,depth+1);
        }
        c.restore();
        return;
      }
      if(obj.type==='frame'&&obj.layout&&obj.layout.mode!=='none'&&window.Components){
        // §6.12 layout resolves at draw time from the frame's own rules, so a
        // child added by any route lands in the stack without extra plumbing
        Components.hugFrame(obj,CHELP);
        Components.layoutStack(obj,CHELP);
      }
      if(obj.type==='frame'){
        if(obj.fills&&obj.fills.length) paintAppearance(c,obj,cc=>addPath(cc,obj),b,obj.blend);
        if(obj.clip!==false){ c.beginPath(); addPath(c,obj); c.clip(); }   // §6.10
      }
      const gop=obj.opacity===undefined?1:obj.opacity;
      if(obj.maskMode&&obj.maskMode!=='none'&&obj.maskOn!==false){
        drawMasked(c,W,H,obj,depth+1);
      }else if(gop<1||(obj.blend&&obj.blend!=='normal')){
        // §4.3/§6.9: group opacity and blend apply to the COMPOSITED group,
        // not to each child — otherwise overlapping children show through
        // each other. That requires its own layer.
        const lay=maskLayer(depth*2+16,W,H);
        const lc=lay.getContext('2d');
        lc.setTransform(c.getTransform());     // carry the group transform in
        drawList(lc,W,H,obj.children,depth+1);
        c.save(); c.setTransform(1,0,0,1,0,0);
        c.globalAlpha=gop;
        if(obj.blend&&obj.blend!=='normal') c.globalCompositeOperation=blendOp(obj.blend);
        c.drawImage(lay,0,0);
        c.restore();
      }else{
        drawList(c,W,H,obj.children,depth+1);
      }
      c.restore();
      return;
    }
    drawOne(c,W,H,obj);
  });
}
/* §5.15: the stack decides WHICH material renders and in WHAT ORDER the
 * behind/over filters run. `fxOn(obj,type)` replaces the old
 * `obj.effects.<type>.on` checks so a disabled STACK ENTRY also switches the
 * effect off, not just the param flag. */
function fxEntries(obj,slot){
  const FS=window.FxStack;
  if(!FS||!obj.fx) return [];
  return FS.inSlot(obj.fx,slot);
}
function fxMaterial(obj){
  const FS=window.FxStack;
  if(!FS||!obj.fx) return null;
  return FS.activeMaterial(obj.fx);
}
/** True when `type` is BOTH parameter-enabled and its stack entry is on,
 *  and it is the material that actually wins. */
function fxOn(obj,type){
  const FS=window.FxStack;
  if(!FS||!obj.fx) return !!(obj.effects&&obj.effects[type]&&obj.effects[type].on);
  if(FS.slotOf(type)==='material'){
    const m=FS.activeMaterial(obj.fx);
    return !!(m&&m.type===type);
  }
  return obj.fx.some(e=>e.type===type&&FS.entryOn(e));
}
/* Decoded-image cache. A newly decoded bitmap triggers one re-render, so a
 * flattened layer appears as soon as its data URL is ready. */
const _imgs=new Map();
function imageFor(src){
  if(!src) return null;
  let im=_imgs.get(src);
  if(!im){
    im=new Image();
    /* A cached bitmap painted BEFORE the bitmap decoded holds a blank space,
     * and nothing about the object changes when the decode lands — its
     * signature is identical — so the cache would serve that blank forever.
     * The decode is the invalidation event. */
    im.onload=()=>{ paintCacheClear(); if(doc) render(); };
    im.src=src;
    _imgs.set(src,im);
  }
  return im;
}
/* §4.8/§5.x pixel pipeline. When an object carries any enabled pixel-slot
 * effect it cannot be painted straight into the page — its rendered pixels
 * have to exist somewhere first. So it is drawn to a PADDED offscreen layer
 * (padding matters: a warp or blur pushes ink outside the object's own box),
 * the filters run in stack order, and the result is composited back. */
let _fxLayerA=null;
function fxLayer(w,h){
  if(!_fxLayerA) _fxLayerA=document.createElement('canvas');
  if(_fxLayerA.width!==w||_fxLayerA.height!==h){ _fxLayerA.width=w; _fxLayerA.height=h; }
  else _fxLayerA.getContext('2d').clearRect(0,0,w,h);
  return _fxLayerA;
}
function pixelPad(entries){
  let pad=8;
  entries.forEach(e=>{
    const p=e.params||{};
    if(e.type==='blur') pad=Math.max(pad,(+p.radius||0)*3+(+p.distance||0));
    if(e.type==='distortion') pad=Math.max(pad,Math.abs(+p.amount||0)+12);
    if(e.type==='warp') pad=Math.max(pad,Math.abs(+p.strength||0)*2);
    if(e.type==='displacement') pad=Math.max(pad,Math.abs(+p.scaleX||0)+Math.abs(+p.scaleY||0));
    if(e.type==='slice') pad=Math.max(pad,Math.abs(+p.offset||0));
  });
  return Math.min(400,Math.ceil(pad));
}
/* ---- per-object paint cache -------------------------------------------
 * MEASURED, before this existed: re-rendering an UNCHANGED 64-object document
 * with drop shadows cost the same ~40ms as re-rendering it after an edit, and
 * zero objects held a cached layer. Canvas `shadowBlur` is expensive per
 * object, so dragging one rectangle re-blurred all 63 others every frame —
 * about 25fps.
 *
 * An object is now painted into its own bitmap and blitted. The bitmap is kept
 * until the object's APPEARANCE signature changes, so moving one object leaves
 * the rest as pure blits.
 *
 * WHAT IS DELIBERATELY NOT CACHED, and why:
 *   - blend modes other than `normal` — a cached bitmap is composited from a
 *     TRANSPARENT layer, so `multiply` and friends would blend against nothing
 *     instead of against the page. Opacity is safe because baking it into the
 *     bitmap and blitting at alpha 1 is the same result; it is in the
 *     signature, so changing it invalidates.
 *   - backdrop materials (glass, prism, capsule, strip) — their input IS the
 *     page beneath them, which changes when anything else moves.
 *   - containers and instances — they composite children, and a child can be
 *     any of the above.
 *   - blob-group members — they merge into one shared field.
 *   - objects with nothing expensive on them: caching a plain rectangle costs
 *     more than drawing it.
 */
const _paintCache=new Map();
let _paintCacheOff=false;    // test hook: forces the uncached path for comparison
/* Same reasoning as the image decode: text cached while the webfont was still
 * loading holds fallback glyphs, and the object's signature never changes. */
if(document.fonts&&document.fonts.ready) document.fonts.ready.then(()=>{
  if(typeof paintCacheClear==='function'){ paintCacheClear(); if(window.__editor&&__editor.doc) render(); }
});
let _paintCachePx=0;
const PAINT_CACHE_MAX_PX=16e6;          // ~64MB of RGBA at most
function paintCacheClear(){ _paintCache.clear(); _paintCachePx=0; }
/** Everything drawOneInner reads that can change what the object LOOKS like.
 *  Built from enabled effects only, so it stays a few hundred bytes rather
 *  than the ~7.5KB a fully materialised object stringifies to. */
function paintSig(obj){
  const FS=window.FxStack;
  let s=obj.type+'|'+obj.x+','+obj.y+','+obj.w+','+obj.h+'|'+
    (obj.rot||0)+','+(obj.skewX||0)+','+(obj.skewY||0)+','+
    (obj.mirrorX?1:0)+(obj.mirrorY?1:0)+'|'+
    (obj.radius||0)+'|'+(obj.opacity===undefined?1:obj.opacity)+'|'+
    (obj.hidden?1:0)+'|'+JSON.stringify(obj.fills||null)+'|'+
    JSON.stringify(obj.strokes||null);
  if(obj.type==='text') s+='|'+obj.text+','+obj.size+','+obj.weight+','+obj.color+','+
    obj.align+','+obj.lineHeight+','+obj.tracking+','+obj.font;
  if(obj.subpaths) s+='|'+JSON.stringify(obj.subpaths);
  if(obj.type==='line') s+='|'+obj.x2+','+obj.y2+','+JSON.stringify(obj.stroke);
  if(obj.type==='polygon') s+='|'+obj.sides+','+obj.star+','+obj.inset;
  if(obj.type==='image') s+='|'+(obj.src||'').length;
  if(FS&&obj.fx) obj.fx.forEach(e=>{
    if(FS.entryOn(e)) s+='|'+e.type+JSON.stringify(e.params);
  });
  return s;
}
/** How far this object's ink can spill outside its own box. */
function spillPad(obj){
  const FS=window.FxStack;
  let pad=2;
  (obj.strokes||[]).forEach(st=>{ if(st.on!==false) pad=Math.max(pad,(+st.width||0)+2); });
  if(FS&&obj.fx) obj.fx.forEach(e=>{
    if(!FS.entryOn(e)) return;
    const p=e.params||{};
    if(e.type==='shadow') pad=Math.max(pad,Math.abs(+p.x||0)+Math.abs(+p.y||0)+(+p.blur||0)+(+p.spread||0)+4);
    if(e.type==='glow') pad=Math.max(pad,(+p.radius||0)+(+p.spread||0)+4);
  });
  if(FS&&obj.fx){
    const pix=FS.inSlot(obj.fx,'pixel');
    if(pix.length) pad=Math.max(pad,pixelPad(pix));
  }
  return Math.ceil(pad);
}
function paintCacheable(obj){
  const FS=window.FxStack;
  if(_paintCacheOff) return false;
  if(!FS||!obj.fx||obj.__inPixelPass) return false;
  if(CONTAINER(obj)||obj.type==='instance') return false;
  if(obj.blend&&obj.blend!=='normal') return false;
  const m=FS.activeMaterial(obj.fx);
  if(m&&FS.isBackdrop(m.type)) return false;
  if(window.BlobEngine&&window.BlobEngine.available()&&inBlobGroup(obj)) return false;
  /* PATTERNED OBJECTS. drawOneUncached paints the parent AND its linked copies,
   * but the cache bitmap is sized to aabbOf(parent) — the copies land outside
   * it and are clipped away, so a patterned object with a drop shadow rendered
   * as a single shape. The signature does not track `pattern` either. Sizing
   * the bitmap to cover every instance would work and is not worth it: the
   * pattern path already redraws N copies, which is the expensive part. */
  if(obj.pattern) return false;
  // only worth it when something expensive is on
  const worth=obj.fx.some(e=>FS.entryOn(e)&&
    (FS.slotOf(e.type)==='behind'||FS.slotOf(e.type)==='pixel'||FS.slotOf(e.type)==='material'));
  return worth;
}
function drawOne(c,W,H,obj){
  if(paintCacheable(obj)){
    const sig=paintSig(obj);
    let ent=_paintCache.get(obj.id);
    if(!ent||ent.sig!==sig){
      const b=aabbOf(obj), pad=spillPad(obj);
      const lx=Math.floor(b.x-pad), ly=Math.floor(b.y-pad);
      const lw=Math.ceil(b.w+pad*2), lh=Math.ceil(b.h+pad*2);
      if(lw>0&&lh>0&&lw<6000&&lh<6000){
        if(ent){ _paintCachePx-=ent.px; _paintCache.delete(obj.id); }
        if(_paintCachePx>PAINT_CACHE_MAX_PX) paintCacheClear();
        const cv=document.createElement('canvas');
        cv.width=lw; cv.height=lh;
        const cc=cv.getContext('2d');
        cc.setTransform(1,0,0,1,-lx,-ly);
        drawOneUncached(cc,W,H,obj);
        ent={sig,cv,lx,ly,px:lw*lh};
        _paintCache.set(obj.id,ent);
        _paintCachePx+=ent.px;
      }
    }
    if(ent){ c.drawImage(ent.cv,ent.lx,ent.ly); return; }
  }
  drawOneUncached(c,W,H,obj);
}
function drawOneUncached(c,W,H,obj){
  const FS=window.FxStack;
  const pix=(FS&&obj.fx)?FS.inSlot(obj.fx,'pixel'):[];
  if(pix.length&&window.Filters&&!obj.__inPixelPass){
    const b=aabbOf(obj);
    const pad=pixelPad(pix);
    const lx=Math.floor(b.x-pad), ly=Math.floor(b.y-pad);
    const lw=Math.ceil(b.w+pad*2), lh=Math.ceil(b.h+pad*2);
    if(lw>0&&lh>0&&lw<6000&&lh<6000){
      let lay=fxLayer(lw,lh);
      const lc=lay.getContext('2d');
      lc.setTransform(1,0,0,1,-lx,-ly);
      obj.__inPixelPass=true;                 // re-entry guard
      try{ drawOneUncached(lc,W,H,obj); } finally{ delete obj.__inPixelPass; }
      lc.setTransform(1,0,0,1,0,0);
      // filters run in STACK ORDER — blur-then-warp differs from warp-then-blur
      pix.forEach(e=>{ lay=Filters.apply(e.type,lay,e.params); });
      c.save();
      c.globalAlpha=obj.opacity===undefined?1:obj.opacity;
      if(obj.blend&&obj.blend!=='normal') c.globalCompositeOperation=blendOp(obj.blend);
      c.drawImage(lay,lx,ly);
      c.restore();
      return;
    }
  }
  drawOneInner(c,W,H,obj);
}
function drawOneInner(c,W,H,obj){
    const f=doc.frame;
    const fx=obj.effects||{};
    const blobReady=obj.type!=='text'&&window.BlobEngine&&window.BlobEngine.available();
    // Blob / Glass 2 merge the parent WITH its pattern copies into one field,
    // so they must replace the whole parent+instances draw, not sit beside it.
    if(blobReady&&inBlobGroup(obj)){
      // The whole group is drawn once, by its bottom-most member; the others
      // skip so the field is never rendered twice.
      if(!isFirstOfGroup(obj)) return;
      const objs=blobGroup().slice(0,window.BlobEngine.MAX);
      const members=groupShapes(objs);
      const geom=groupBlobParams()||fx.blob;
      const glassP=groupGlassParams();
      if(glassP){
        window.BlobEngine.liquid(c.canvas,W,H,members,glassP,geom);
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
          const wm=window.BlobEngine.mask(W,H,members,geom,i);
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
    const li=fx.light;
    if(li&&fxOn(obj,'light')&&obj.type!=='text'&&window.LightEngine&&window.LightEngine.available()){
      // Generative graphic: rendered at the shape's box size, then clipped to
      // the shape so a cone can live inside a rounded rect or ellipse.
      const draw=(o)=>{
        const img=window.LightEngine.render(o.w,o.h,li);
        if(!img) return;
        c.save();
        if(o.rot||o.mirrorX||o.mirrorY){
          const cx=o.x+o.w/2, cy=o.y+o.h/2;
          c.translate(cx,cy);
          if(o.rot) c.rotate(o.rot*Math.PI/180);
          if(o.mirrorX||o.mirrorY) c.scale(o.mirrorX?-1:1,o.mirrorY?-1:1);
          c.translate(-cx,-cy);
        }
        c.globalAlpha=o.opacity;
        pathFor(c,o); c.clip();
        c.drawImage(img,o.x,o.y,o.w,o.h);
        c.restore();
      };
      draw(obj);
      patternInstances(obj).forEach(draw);
      return;
    }
    const pr=fx.prism;
    if(pr&&fxOn(obj,'prism')&&obj.type!=='text'&&window.PrismEngine&&window.PrismEngine.available()){
      // FULL CANVAS, deliberately not clipped to the shape: a prism's whole
      // point is that the light leaves it, and clipping to the outline would
      // delete the exit fan and leave a lit rectangle. The shape supplies the
      // solid's position and size; the beam and fan cross the page freely.
      // Pattern copies are skipped — each would need its own beam and its own
      // accumulation pass.
      const img=window.PrismEngine.render(W,H,{x:obj.x,y:obj.y,w:obj.w,h:obj.h},
        Object.assign({},pr,{fill:firstColor(obj.fill)}),fxDraft);
      if(img){
        c.save();
        c.globalAlpha=obj.opacity;
        if(pr.blend==='add') c.globalCompositeOperation='lighter';
        c.drawImage(img,0,0,W,H);
        c.restore();
        return;
      }
    }
    const cap=fx.capsule;
    if(cap&&fxOn(obj,'capsule')&&obj.type!=='text'&&window.CapsuleEngine&&window.CapsuleEngine.available()){
      // Like Glass: the capsule IS the material, refracting everything painted
      // so far, so the object's own fill is deliberately not painted first.
      // Pattern copies are skipped — each would need its own trace.
      window.CapsuleEngine.capsule(c.canvas,W,H,{x:obj.x,y:obj.y,w:obj.w,h:obj.h},cap,fxDraft);
      return;
    }
    const st=fx.strip;
    if(st&&fxOn(obj,'strip')&&obj.type!=='text'&&window.CapsuleEngine&&window.CapsuleEngine.available()){
      // Reeded panel: reads the page behind the box, smears it into ribs,
      // clipped to the shape's outline. Replaces the fill.
      const img=window.CapsuleEngine.strip(c.canvas,W,H,{x:obj.x,y:obj.y,w:obj.w,h:obj.h},st);
      if(img){
        c.save();
        c.globalAlpha=obj.opacity;
        pathFor(c,obj); c.clip();
        c.drawImage(img,obj.x,obj.y,obj.w,obj.h);
        c.restore();
        return;
      }
    }
    const gla=fx.glass;
    if(gla&&fxOn(obj,'glass')&&obj.type!=='text'&&window.GlassEngine&&window.GlassEngine.available()){
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
}

function drawObject(c,obj,plain){
  {
    c.save();
    // Rotation/mirror are applied about the instance centre BEFORE anything is
    // drawn, so geometry, gradient and effects all transform together.
    if(obj.rot||obj.mirrorX||obj.mirrorY||obj.skewX||obj.skewY){
      const bb=boxOf(obj), cx=bb.x+bb.w/2, cy=bb.y+bb.h/2;
      c.translate(cx,cy);
      if(obj.rot) c.rotate(obj.rot*Math.PI/180);
      if(obj.skewX||obj.skewY)
        c.transform(1,Math.tan((obj.skewY||0)*Math.PI/180),Math.tan((obj.skewX||0)*Math.PI/180),1,0,0);
      if(obj.mirrorX||obj.mirrorY) c.scale(obj.mirrorX?-1:1, obj.mirrorY?-1:1);
      c.translate(-cx,-cy);
    }
    c.globalAlpha=(plain||obj.__inPixelPass)?1:obj.opacity;
    // §4.4 object-level blend. Shapes and paths apply it per fill/stroke
    // inside paintAppearance (so an entry can override it); text and lines
    // paint in one pass, so it is set here for them.
    if(!plain&&obj.blend&&obj.blend!=='normal'&&(obj.type==='text'||obj.type==='line'))
      c.globalCompositeOperation=blendOp(obj.blend);
    // Defensive: an object that reached the renderer without passing through
    // normalizeDoc has no effects dictionary, and an uncaught TypeError here
    // takes the whole frame down rather than dropping one object's shadow.
    const sh=(obj.effects&&obj.effects.shadow)||{on:false};
    const mkPath=cc=>addPath(cc,obj);
    // §5.15 behind slot, walked in STACK ORDER — stacking two shadows or a
    // shadow plus a glow now works, and their order is the user's choice.
    if(!plain&&obj.type!=='text') fxEntries(obj,'behind').forEach(entry=>{
      const gl=entry.type==='glow'?entry.params:null;
      if(gl&&gl.type==='outer'&&gl.radius>0){
        // §4.11 outer glow: a zero-offset shadow laid under the object.
        // Falloff is applied by repeating the pass — each repeat concentrates
        // the core, which is what a falloff curve does to the profile.
        c.save();
        c.globalCompositeOperation=blendOp(gl.blend);
        const reps=Math.max(1,Math.round(gl.falloff*2));
        for(let i=0;i<reps;i++){
          c.shadowColor=hexAlpha(gl.color,gl.alpha/reps*1.4);
          c.shadowBlur=gl.radius; c.shadowOffsetX=0; c.shadowOffsetY=0;
          c.beginPath(); mkPath(c);
          c.fillStyle='#000';
          if(gl.spread>0){ c.lineWidth=gl.spread*2; c.strokeStyle='#000'; c.stroke(); }
          c.fill();
        }
        c.restore();
      }
      const sd=entry.type==='shadow'?entry.params:null;
      if(sd&&sd.on){
        c.save();
        c.shadowColor=hexAlpha(sd.color,sd.alpha); c.shadowBlur=sd.blur;
        c.shadowOffsetX=sd.x; c.shadowOffsetY=sd.y;
        c.globalCompositeOperation=blendOp(sd.blend);
        c.beginPath(); mkPath(c);
        if(sd.spread>0){ c.lineWidth=sd.spread*2; c.strokeStyle='#000'; c.stroke(); }
        c.fillStyle='#000'; c.fill();
        c.restore();
      }
    });
    // the legacy single-shadow path stays for text, which has no stack slot
    if(sh.on&&!plain&&obj.type==='text'){
      c.shadowColor=hexAlpha(sh.color,sh.alpha); c.shadowBlur=sh.blur;
      c.shadowOffsetX=sh.x; c.shadowOffsetY=sh.y;
      if(sh.spread>0&&obj.type!=='text'){
        // §4.9 spread: thicken the caster so the shadow grows without blurring
        c.save();
        c.globalCompositeOperation=blendOp(sh.blend);
        c.beginPath(); mkPath(c);
        c.lineWidth=sh.spread*2; c.strokeStyle='#000'; c.fillStyle='#000';
        c.stroke(); c.fill();
        c.restore();
        c.shadowColor='transparent';
      }
    }
    if(obj.type==='text'){
      const L=textLayout(obj);
      c.font=`${obj.weight} ${obj.size}px Inter,-apple-system,sans-serif`;
      c.letterSpacing=(obj.tracking||0)+'px';
      c.fillStyle=obj.color; c.textBaseline='top';
      c.textAlign=obj.align;
      const area=obj.mode==='area';
      let ty=obj.y;
      if(area&&obj.autosize==='fixed'){
        if(obj.valign==='middle') ty+=Math.max(0,(obj.h-L.contentH)/2);
        else if(obj.valign==='bottom') ty+=Math.max(0,obj.h-L.contentH);
      }
      const tx=!area?obj.x
        : obj.align==='center'?obj.x+obj.w/2
        : obj.align==='right'?obj.x+obj.w
        : obj.x;
      if(area&&obj.autosize==='fixed'){ c.save(); c.beginPath(); c.rect(obj.x,obj.y,obj.w,obj.h); c.clip(); }
      L.lines.forEach((ln,li)=>c.fillText(ln,tx,ty+li*L.lh));
      if(area&&obj.autosize==='fixed') c.restore();
      c.letterSpacing='0px';
      c.restore(); return;
    }
    if(obj.type==='instance'){
      // drawObject has no W/H in scope; mask layers size off the buffer, and
      // the buffer IS the page raster, so its own dimensions are correct here
      const tree=instanceTree(obj);
      if(tree) drawList(c,frameBuf.width,frameBuf.height,[tree],1);
      c.restore(); return;
    }
    if(obj.type==='image'){
      const im=imageFor(obj.src);
      if(im&&im.complete&&im.naturalWidth) c.drawImage(im,obj.x,obj.y,obj.w,obj.h);
      c.restore(); return;
    }
    if(obj.type==='path'){
      paintAppearance(c,obj,cc=>pathPath(cc,obj),boxOf(obj),obj.blend);
      c.restore(); return;
    }
    if(obj.type==='line'){
      const s=obj.stroke||{width:4,color:'#111111'};
      const ang=Math.atan2(obj.y2-obj.y,obj.x2-obj.x);
      const sz=Math.max(4,+obj.arrowSize||12);
      // Pull the stroke back so it never pokes through a triangle/open tip.
      const inset=k=>(k==='triangle'?sz*0.8:0);
      const i1=inset(obj.arrowStart), i2=inset(obj.arrowEnd);
      c.strokeStyle=s.color; c.lineWidth=s.width; c.lineCap='butt'; c.lineJoin='round';
      c.beginPath();
      c.moveTo(obj.x+Math.cos(ang)*i1, obj.y+Math.sin(ang)*i1);
      c.lineTo(obj.x2-Math.cos(ang)*i2, obj.y2-Math.sin(ang)*i2);
      c.stroke();
      // §1.8 arrowheads: tip sits exactly on the endpoint
      const head=(x,y,a,kind)=>{
        if(!kind||kind==='none') return;
        c.save(); c.translate(x,y); c.rotate(a);
        c.fillStyle=s.color; c.strokeStyle=s.color; c.lineWidth=s.width;
        if(kind==='triangle'){
          c.beginPath(); c.moveTo(0,0); c.lineTo(-sz,-sz*0.55); c.lineTo(-sz,sz*0.55);
          c.closePath(); c.fill();
        }else if(kind==='open'){
          c.beginPath(); c.moveTo(-sz,-sz*0.6); c.lineTo(0,0); c.lineTo(-sz,sz*0.6); c.stroke();
        }else if(kind==='circle'){
          c.beginPath(); c.arc(0,0,sz*0.45,0,Math.PI*2); c.fill();
        }else if(kind==='bar'){
          c.beginPath(); c.moveTo(0,-sz*0.6); c.lineTo(0,sz*0.6); c.stroke();
        }
        c.restore();
      };
      head(obj.x2,obj.y2,ang,obj.arrowEnd);
      head(obj.x,obj.y,ang+Math.PI,obj.arrowStart);
      c.restore(); return;
    }
    const b={x:obj.x,y:obj.y,w:obj.w,h:obj.h};
    // A patterned parent still draws its OWN complete fill. Instances are
    // separate complete objects drawn by the caller; nothing is segmented.
    if(plain==='flood'){
      // Blob layer: this shape's colour has to exist wherever the blend gives
      // it weight, including the neck outside its own outline.
      c.fillStyle=fillStyleFor(c,obj,b);
      c.fillRect(0,0,c.canvas.width,c.canvas.height);
    } else {
      paintAppearance(c,obj,cc=>addPath(cc,obj),b,obj.blend);
    }
    c.shadowColor='transparent';
    // §4.10 inner shadow / §4.11 inner glow, walked in STACK ORDER.
    if(!plain&&obj.type!=='text'){
      const inners=[];
      fxEntries(obj,'behind').concat(fxEntries(obj,'over')).forEach(entry=>{
        const p=entry.params;
        if(entry.type==='innerShadow'&&p.on&&(p.blur>0||p.spread>0))
          inners.push({x:p.x,y:p.y,blur:p.blur,spread:p.spread,
            color:p.color,alpha:p.alpha,blend:p.blend,reps:1});
        if(entry.type==='glow'&&p.on&&p.type==='inner'&&p.radius>0)
          inners.push({x:0,y:0,blur:p.radius,spread:p.spread,
            color:p.color,alpha:p.alpha,blend:p.blend,reps:Math.max(1,Math.round(p.falloff*2))});
      });
      inners.forEach(S=>{
        c.save();
        c.beginPath(); mkPath(c); c.clip();
        c.globalCompositeOperation=blendOp(S.blend);
        const R=1e4;
        for(let i=0;i<S.reps;i++){
          c.shadowColor=hexAlpha(S.color,S.alpha/S.reps*(S.reps>1?1.4:1));
          c.shadowBlur=S.blur; c.shadowOffsetX=S.x; c.shadowOffsetY=S.y;
          c.beginPath();
          c.rect(-R,-R,R*2,R*2);      // everything...
          mkPath(c);                   // ...minus the shape (even-odd)
          c.fillStyle='#000'; c.fill('evenodd');
          if(S.spread>0){
            c.shadowOffsetX=S.x; c.shadowOffsetY=S.y;
            c.beginPath(); mkPath(c);
            c.lineWidth=S.spread*2; c.strokeStyle='#000'; c.stroke();
          }
        }
        c.restore();
      });
      c.shadowColor='transparent';
    }
    // Stripe fill paints OVER the flat fill rather than replacing it: the flat
    // fill above is what casts the drop shadow, and a clipped drawImage cannot.
    const grd=obj.effects.gradient;
    if(grd&&fxOn(obj,'gradient')&&window.GradientEngine&&b.w>=1&&b.h>=1){
      const tile=window.GradientEngine.get(b.w,b.h,grd);
      if(tile){
        if(plain==='flood'){
          c.drawImage(tile,0,0,c.canvas.width,c.canvas.height);
        }else{
          c.save(); pathFor(c,obj); c.clip();
          c.drawImage(tile,b.x,b.y,b.w,b.h);
          c.restore();
        }
      }
    }
    const gr=obj.effects.grain;
    if(gr.amount>0&&fxOn(obj,'grain')){
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
function caseText(t,tf){
  if(tf==='upper') return t.toUpperCase();
  if(tf==='lower') return t.toLowerCase();
  if(tf==='title') return t.replace(/\b\w/g,ch=>ch.toUpperCase());
  return t;
}
/* Shared layout for draw + bounds. Point text: one line, natural width.
 * Area text: word wrap into obj.w; autosize 'height' grows the box to fit;
 * 'fixed' keeps it and reports overflow (§1.9 overflow indicator). */
function textLayout(obj){
  ctx.font=`${obj.weight} ${obj.size}px Inter,-apple-system,sans-serif`;
  ctx.letterSpacing=(obj.tracking||0)+'px';
  const text=caseText(String(obj.text),obj.caseTf);
  const lh=obj.size*(obj.lineHeight||1.2);
  let lines, width;
  if(obj.mode!=='area'){
    lines=text.split('\n');
    width=Math.max(1,...lines.map(l=>ctx.measureText(l).width));
  }else{
    lines=[]; width=obj.w;
    text.split('\n').forEach(para=>{
      const words=para.split(/\s+/).filter(Boolean);
      if(!words.length){ lines.push(''); return; }
      let cur=words[0];
      for(let i=1;i<words.length;i++){
        const t2=cur+' '+words[i];
        if(ctx.measureText(t2).width<=obj.w) cur=t2;
        else{ lines.push(cur); cur=words[i]; }
      }
      lines.push(cur);
    });
  }
  const contentH=lines.length*lh;
  const boxH=obj.mode==='area' ? (obj.autosize==='height'?contentH:obj.h) : contentH;
  const overflow=obj.mode==='area'&&obj.autosize==='fixed'&&contentH>obj.h+0.5;
  ctx.letterSpacing='0px';
  return {lines,lh,width,contentH,boxH,overflow};
}
function textBox(obj){
  const L=textLayout(obj);
  if(obj.mode==='area') return {x:obj.x,y:obj.y,w:obj.w,h:L.boxH};
  const x=obj.align==='center'?obj.x-L.width/2:obj.align==='right'?obj.x-L.width:obj.x;
  return {x, y:obj.y, w:L.width, h:L.boxH};
}
function boxOf(obj){
  if(obj.type==='instance'){
    const t=instanceTree(obj);
    return t?boxOf(t):{x:obj.x||0,y:obj.y||0,w:1,h:1};
  }
  if(obj.type==='frame') return {x:obj.x,y:obj.y,w:obj.w,h:obj.h};
  if(obj.type==='boolean'){
    const res=boolResult(obj);
    if(res&&res.length){
      let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
      res.forEach(sp=>sp.points.forEach(p=>{x0=Math.min(x0,p.x);y0=Math.min(y0,p.y);
        x1=Math.max(x1,p.x);y1=Math.max(y1,p.y);}));
      const sw=(obj.strokes&&obj.strokes[0]?obj.strokes[0].width:0)/2;
      return {x:x0-sw,y:y0-sw,w:Math.max(1,x1-x0)+sw*2,h:Math.max(1,y1-y0)+sw*2};
    }
  }
  if(obj.type==='group'||obj.type==='boolean'){
    // §6.9: a group's box is the union of its children, always derived
    const ch=(obj.children||[]).filter(o=>!o.hidden);
    if(!ch.length) return {x:obj.x||0,y:obj.y||0,w:1,h:1};
    let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
    ch.forEach(o=>{ const b=aabbOf(o);
      x0=Math.min(x0,b.x); y0=Math.min(y0,b.y);
      x1=Math.max(x1,b.x+b.w); y1=Math.max(y1,b.y+b.h); });
    return {x:x0,y:y0,w:Math.max(1,x1-x0),h:Math.max(1,y1-y0)};
  }
  if(obj.type==='text') return textBox(obj);
  if(obj.type==='path'){
    let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
    // an object built by makeShape has not been through normalizeDoc yet, so
    // fall back to the single-contour alias rather than reporting no bounds
    (obj.subpaths||[{points:obj.points||[]}]).flatMap(sp=>sp.points).forEach(p=>{
      [[p.x,p.y],[p.x+p.ox,p.y+p.oy],[p.x+p.ix,p.y+p.iy]].forEach(([X,Y])=>{
        x0=Math.min(x0,X); y0=Math.min(y0,Y); x1=Math.max(x1,X); y1=Math.max(y1,Y);
      });
    });
    if(x0>x1) return {x:obj.x||0,y:obj.y||0,w:1,h:1};
    const s=(obj.stroke?obj.stroke.width:3)/2;
    return {x:x0-s,y:y0-s,w:(x1-x0)+s*2,h:(y1-y0)+s*2};
  }
  if(obj.type==='line'){
    const x=Math.min(obj.x,obj.x2), y=Math.min(obj.y,obj.y2);
    return {x, y, w:Math.max(1,Math.abs(obj.x2-obj.x)), h:Math.max(1,Math.abs(obj.y2-obj.y))};
  }
  return {x:obj.x,y:obj.y,w:obj.w,h:obj.h};
}
/** Translate an object. Lines carry BOTH endpoints, so every mover (drag,
 *  nudge, align, numeric X/Y) must go through here rather than setting x/y. */
function translateObj(o,dx,dy){
  o.x+=dx; o.y+=dy;
  // children carry absolute coordinates, so a container moves them with it
  if(CONTAINER(o)) (o.children||[]).forEach(k=>translateObj(k,dx,dy));
  if(o.type==='line'){ o.x2+=dx; o.y2+=dy; }
  if(o.type==='path') (o.subpaths||[]).forEach(sp=>sp.points.forEach(p=>{ p.x+=dx; p.y+=dy; }));
}
/* Scratch context for exact fill/stroke hit-testing of bézier paths. */
const hitCtx=document.createElement('canvas').getContext('2d');
function pathHit(o,px,py,tol){
  hitCtx.setTransform(1,0,0,1,0,0);
  hitCtx.beginPath(); pathPath(hitCtx,o);
  hitCtx.lineWidth=Math.max(tol*2,(o.stroke?o.stroke.width:3)+tol);
  const anyClosed=(o.subpaths||[]).some(sp=>sp.closed);
  if(o.fillOn&&anyClosed&&
     hitCtx.isPointInPath(px,py,o.fillRule==='evenodd'?'evenodd':'nonzero')) return true;
  return hitCtx.isPointInStroke(px,py);
}
/* §2.7: visual AABB of a possibly-rotated object. boxOf stays the unrotated
 * geometric box; this wraps it for marquee, align, and union bounds. */
function aabbOf(o){
  const b=boxOf(o);
  if(!o.rot) return b;
  const cx=b.x+b.w/2, cy=b.y+b.h/2, r=o.rot*Math.PI/180;
  const cs=Math.cos(r), sn=Math.sin(r);
  let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
  [[b.x,b.y],[b.x+b.w,b.y],[b.x+b.w,b.y+b.h],[b.x,b.y+b.h]].forEach(([X,Y])=>{
    const dx=X-cx, dy=Y-cy;
    const rx=cx+dx*cs-dy*sn, ry=cy+dx*sn+dy*cs;
    x0=Math.min(x0,rx); y0=Math.min(y0,ry); x1=Math.max(x1,rx); y1=Math.max(y1,ry);
  });
  return {x:x0,y:y0,w:x1-x0,h:y1-y0};
}
/* Inverse-rotate a page point into an object's unrotated frame, so hit tests
 * and handle grabs work on rotated objects. */
function toLocal(o,px,py){
  if(!o.rot) return {x:px,y:py};
  const b=boxOf(o), cx=b.x+b.w/2, cy=b.y+b.h/2, r=-o.rot*Math.PI/180;
  const cs=Math.cos(r), sn=Math.sin(r), dx=px-cx, dy=py-cy;
  return {x:cx+dx*cs-dy*sn, y:cy+dx*sn+dy*cs};
}
function distToSegment(px,py,x1,y1,x2,y2){
  const dx=x2-x1, dy=y2-y1, L2=dx*dx+dy*dy;
  const t=L2?clamp(((px-x1)*dx+(py-y1)*dy)/L2,0,1):0;
  return Math.hypot(px-(x1+t*dx), py-(y1+t*dy));
}

/* Render is split in two so navigation is cheap:
 *   renderDoc() — the expensive pass. Draws the document (engines included)
 *                 into frameBuf at page resolution. Only runs when the DOC
 *                 changes.
 *   paint()     — blits frameBuf through the view transform and draws all
 *                 screen-space chrome. Runs on every pan/zoom/marquee frame,
 *                 never re-running the shader engines.
 * render() = both, and is what every doc-mutating path already calls. */
let marquee=null;   // {x0,y0,x1,y1} in page coords while dragging
function fitView(){
  if(!doc) return;
  const f=doc.frame, stage=$('stage');
  // keep the page clear of the floating panels in fit mode
  const inL=250,inR=250,inT=80,inB=100;
  const availW=Math.max(50,stage.clientWidth-inL-inR);
  const availH=Math.max(50,stage.clientHeight-inT-inB);
  view.z=Math.min(1.5, availW/f.w, availH/f.h);
  view.x=inL+(availW-f.w*view.z)/2;
  view.y=inT+(availH-f.h*view.z)/2;
}
function renderDoc(){
  if(!doc||doc.frame.children===undefined) return;
  const f=doc.frame;
  /* The buffer used to be exactly the page, which meant anything overflowing
   * the page edge was cut by the BUFFER rather than by an artboard's clip
   * setting. Now that artboards sit on an open canvas that is wrong, so the
   * buffer grows to cover the artboards and the content. The origin stays at
   * (0,0) so buffer coordinates remain page coordinates — the glass-family
   * engines sample this buffer directly and must not be shifted. */
  let bw=f.w, bh=f.h;
  (f.artboards||[]).forEach(a=>{ bw=Math.max(bw,a.x+a.w); bh=Math.max(bh,a.y+a.h); });
  allObjects().forEach(o=>{
    if(o.hidden) return;
    const b=aabbOf(o);
    bw=Math.max(bw,b.x+b.w); bh=Math.max(bh,b.y+b.h);
  });
  frameBuf.width=Math.min(8000,Math.ceil(bw));
  frameBuf.height=Math.min(8000,Math.ceil(bh));
  // Full frame resolution, no transform: the glass engines sample real pixels.
  drawDoc(frameBuf.getContext('2d'),f.w,f.h);
}
function paint(){
  const has=!!doc && doc.frame.children!==undefined;
  canvas.style.display=has?'':'none';
  $('zoomChip').style.display=has?'':'none';
  if(!has){ canvas.width=1; canvas.height=1; return; }
  const stage=$('stage'), dpr=Math.min(devicePixelRatio||1,2);
  const W=stage.clientWidth, H=stage.clientHeight;
  if(canvas.width!==Math.round(W*dpr)||canvas.height!==Math.round(H*dpr)){
    canvas.width=Math.round(W*dpr); canvas.height=Math.round(H*dpr);
  }
  if(view.mode==='fit') fitView();
  const z=view.z;
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,W,H);
  ctx.setTransform(z*dpr,0,0,z*dpr,view.x*dpr,view.y*dpr);
  const f=doc.frame;
  // page shadow + white surface behind transparent content
  ctx.save();
  ctx.shadowColor='rgba(0,0,0,.13)'; ctx.shadowBlur=18/z; ctx.shadowOffsetY=3/z;
  ctx.fillStyle='#ffffff'; ctx.fillRect(0,0,f.w,f.h);
  ctx.restore();
  // §1.13 pixel preview: at high magnification show the actual pixels
  ctx.imageSmoothingEnabled=z<4;
  ctx.drawImage(frameBuf,0,0);
  ctx.imageSmoothingEnabled=true;
  // §6.4 grid, drawn OVER the page but under the chrome; skipped when the
  // lines would be denser than a couple of screen pixels
  const G=f.grid;
  if(G&&G.show&&G.size>0){
    const sub=Math.max(1,G.subdivisions||1);
    const step=G.size/sub;
    if(step*z>=3){
      ctx.save();
      ctx.beginPath(); ctx.rect(0,0,f.w,f.h); ctx.clip();
      for(let pass=0;pass<2;pass++){
        const st=pass?G.size:step;
        if(pass===0&&sub===1) continue;
        ctx.strokeStyle=G.color;
        ctx.globalAlpha=pass?0.55:0.28;
        ctx.lineWidth=1/z;
        ctx.beginPath();
        for(let x=0;x<=f.w+0.5;x+=st){ ctx.moveTo(x,0); ctx.lineTo(x,f.h); }
        for(let y=0;y<=f.h+0.5;y+=st){ ctx.moveTo(0,y); ctx.lineTo(f.w,y); }
        ctx.stroke();
      }
      ctx.restore();
    }
  }
  // ---- screen-space chrome (line widths divided by z stay constant) ----
  if(selInstance){
    // Instances: dashed, so a derived object never looks editable.
    const b=boxOf(selInstance);
    ctx.save();
    ctx.strokeStyle='#8b5cf6'; ctx.lineWidth=1.6/z;
    ctx.setLineDash([6/z,4/z]);
    ctx.strokeRect(b.x,b.y,b.w,b.h);
    ctx.restore();
  }
  const os=selObjs();
  os.forEach(o=>{
    const b=boxOf(o);
    ctx.save();
    if(o.rot){ const cx=b.x+b.w/2, cy=b.y+b.h/2;
      ctx.translate(cx,cy); ctx.rotate(o.rot*Math.PI/180); ctx.translate(-cx,-cy); }
    ctx.strokeStyle='#3b82f6'; ctx.lineWidth=1.6/z;
    ctx.strokeRect(b.x,b.y,b.w,b.h);
    ctx.restore();
  });
  // §2.6: eight handles on the primary object, drawn in its rotated frame,
  // constant screen size. Lines keep their endpoint grips instead.
  const obj=primary();
  if(obj&&obj.type!=='line'&&!obj.locked&&selIds.size===1&&tool==='select'){
    handlePts(obj).forEach(h=>{
      const hs=7/z;
      ctx.fillStyle='#fff'; ctx.strokeStyle='#3b82f6'; ctx.lineWidth=1.6/z;
      ctx.fillRect(h.x-hs/2,h.y-hs/2,hs,hs);
      ctx.strokeRect(h.x-hs/2,h.y-hs/2,hs,hs);
    });
  }
  // live numeric readout during a transform drag (§2.6)
  if(drag&&drag.readout){
    const m=drag.readout;
    ctx.save();
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.font='11px Inter,-apple-system,sans-serif';
    const tw=ctx.measureText(m.text).width+12;
    ctx.fillStyle='rgba(17,24,39,.85)';
    ctx.beginPath();
    ctx.roundRect?ctx.roundRect(m.sx+12,m.sy+12,tw,20,5):ctx.rect(m.sx+12,m.sy+12,tw,20);
    ctx.fill();
    ctx.fillStyle='#fff'; ctx.textBaseline='middle';
    ctx.fillText(m.text,m.sx+18,m.sy+22);
    ctx.restore();
  }
  if(obj&&obj.type==='line'&&!obj.locked&&selIds.size===1){
    const hs=7/z;
    ctx.fillStyle='#fff'; ctx.strokeStyle='#3b82f6'; ctx.lineWidth=1.6/z;
    [[obj.x,obj.y],[obj.x2,obj.y2]].forEach(([px,py])=>{
      ctx.fillRect(px-hs/2,py-hs/2,hs,hs);
      ctx.strokeRect(px-hs/2,py-hs/2,hs,hs);
    });
  }
  // union bounds when more than one object is selected
  if(os.length>1){
    const b=selBounds();
    ctx.save();
    ctx.strokeStyle='#3b82f6'; ctx.lineWidth=1/z; ctx.setLineDash([4/z,3/z]);
    ctx.strokeRect(b.x,b.y,b.w,b.h);
    ctx.restore();
  }
  // §1.2 node editing overlay
  const no=nodeObj&&nodeObj();
  if(tool==='node'&&no){
    const hs=6/z;
    ctx.lineWidth=1.2/z;
    no.points.forEach((a,pi)=>{
      const on=nodeSel.pts.has(pi);
      if(on){
        // handles of selected anchors
        ctx.strokeStyle='#8b5cf6';
        [[a.ox,a.oy],[a.ix,a.iy]].forEach(([hx,hy])=>{
          if(!hx&&!hy) return;
          ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(a.x+hx,a.y+hy); ctx.stroke();
          ctx.beginPath(); ctx.arc(a.x+hx,a.y+hy,3.4/z,0,Math.PI*2);
          ctx.fillStyle='#fff'; ctx.fill(); ctx.stroke();
        });
      }
      ctx.fillStyle=on?'#3b82f6':'#fff';
      ctx.strokeStyle='#3b82f6';
      ctx.fillRect(a.x-hs/2,a.y-hs/2,hs,hs);
      ctx.strokeRect(a.x-hs/2,a.y-hs/2,hs,hs);
    });
  }
  // §1.3 pen: anchors + rubber-band preview of the pending segment
  const po=penDraft&&doc.frame.children[penDraft.oi];
  if(po){
    const hs=6/z;
    ctx.fillStyle='#fff'; ctx.strokeStyle='#3b82f6'; ctx.lineWidth=1.2/z;
    po.points.forEach(a=>{
      ctx.fillRect(a.x-hs/2,a.y-hs/2,hs,hs);
      ctx.strokeRect(a.x-hs/2,a.y-hs/2,hs,hs);
    });
    if(penHover&&po.points.length){
      const a=po.points[po.points.length-1];
      ctx.strokeStyle='#8b5cf6'; ctx.setLineDash([4/z,3/z]);
      ctx.beginPath(); ctx.moveTo(a.x,a.y);
      ctx.bezierCurveTo(a.x+a.ox,a.y+a.oy, penHover.x,penHover.y, penHover.x,penHover.y);
      ctx.stroke(); ctx.setLineDash([]);
    }
  }
  // §1.9 overflow indicator on fixed-size area text
  allObjects().forEach(o=>{
    if(o.type!=='text'||o.mode!=='area'||o.hidden) return;
    if(textLayout(o).overflow){
      const b={x:o.x,y:o.y,w:o.w,h:o.h}, r=5/z;
      ctx.fillStyle='#dc2626';
      ctx.beginPath(); ctx.arc(b.x+b.w-r,b.y+b.h-r,r,0,Math.PI*2); ctx.fill();
      ctx.fillStyle='#fff';
      ctx.font=`${9/z}px Inter,sans-serif`; ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText('+',b.x+b.w-r,b.y+b.h-r);
    }
  });
  // §6.5 artboard outlines and name labels — screen chrome, not content
  (f.artboards||[]).forEach(a=>{
    if(!a.show) return;
    ctx.save();
    const isSel=selArtboard===a.id;
    ctx.strokeStyle=isSel?'#3b82f6':'#d6d9de';
    ctx.lineWidth=(isSel?1.6:1)/z;
    ctx.strokeRect(a.x,a.y,a.w,a.h);
    ctx.font=`${11/z}px ${getComputedStyle(document.body).fontFamily}`;
    ctx.fillStyle=isSel?'#3b82f6':'#8a8d93';
    ctx.textBaseline='bottom';
    ctx.fillText(a.name,a.x,a.y-4/z);
    ctx.restore();
  });
  // §2.11 guides — full-viewport lines so they read outside the page too
  const vx0=-view.x/z, vy0=-view.y/z, vx1=(W-view.x)/z, vy1=(H-view.y)/z;
  if(!guidesHidden) (f.guides||[]).forEach((g,gi)=>{
    ctx.save();
    ctx.strokeStyle=(guideDrag&&guideDrag.index===gi)?'#f43f5e':'#22c1c3';
    ctx.lineWidth=1/z;
    ctx.beginPath();
    if(g.axis==='v'){ ctx.moveTo(g.pos,vy0); ctx.lineTo(g.pos,vy1); }
    else { ctx.moveTo(vx0,g.pos); ctx.lineTo(vx1,g.pos); }
    ctx.stroke();
    ctx.restore();
  });
  // §2.11 live alignment guides, drawn only while a snap is active
  if(snapLines.length){
    ctx.save();
    ctx.strokeStyle='#f43f5e'; ctx.lineWidth=1/z;
    ctx.setLineDash([5/z,3/z]);
    snapLines.forEach(L=>{
      ctx.beginPath();
      if(L.axis==='v'){ ctx.moveTo(L.pos,vy0); ctx.lineTo(L.pos,vy1); }
      else { ctx.moveTo(vx0,L.pos); ctx.lineTo(vx1,L.pos); }
      ctx.stroke();
    });
    ctx.restore();
  }
  // §2.11 equal-spacing indicators
  if(gapHints.length&&!drag){
    ctx.save();
    ctx.strokeStyle='#f43f5e'; ctx.fillStyle='#f43f5e'; ctx.lineWidth=1/z;
    gapHints.forEach(g=>{
      const H2=g.axis==='h';
      const y=H2?(Math.max(g.a.y,g.b.y)+Math.min(g.a.y+g.a.h,g.b.y+g.b.h))/2
               :(Math.max(g.a.x,g.b.x)+Math.min(g.a.x+g.a.w,g.b.x+g.b.w))/2;
      const s0=H2?g.a.x+g.a.w:g.a.y+g.a.h, s1=H2?g.b.x:g.b.y;
      ctx.beginPath();
      if(H2){ ctx.moveTo(s0,y); ctx.lineTo(s1,y);
        ctx.moveTo(s0,y-4/z); ctx.lineTo(s0,y+4/z);
        ctx.moveTo(s1,y-4/z); ctx.lineTo(s1,y+4/z); }
      else { ctx.moveTo(y,s0); ctx.lineTo(y,s1);
        ctx.moveTo(y-4/z,s0); ctx.lineTo(y+4/z,s0);
        ctx.moveTo(y-4/z,s1); ctx.lineTo(y+4/z,s1); }
      ctx.stroke();
    });
    ctx.restore();
  }
  if(marquee){
    const x=Math.min(marquee.x0,marquee.x1), y=Math.min(marquee.y0,marquee.y1);
    const w=Math.abs(marquee.x1-marquee.x0), h=Math.abs(marquee.y1-marquee.y0);
    ctx.fillStyle='rgba(59,130,246,.08)';
    ctx.strokeStyle='#3b82f6'; ctx.lineWidth=1/z;
    ctx.fillRect(x,y,w,h); ctx.strokeRect(x,y,w,h);
  }
  ctx.setTransform(dpr,0,0,dpr,0,0);
  // §6.4 rulers — screen chrome, so they stay pinned while the page moves
  if(showRulers){
    const nice=[1,2,5,10,20,25,50,100,200,250,500,1000,2000];
    let step=nice.find(n=>n*z>=54)||2000;
    ctx.fillStyle='#f7f8f9';
    ctx.fillRect(0,0,W,RULER); ctx.fillRect(0,0,RULER,H);
    ctx.strokeStyle='#e4e4e6'; ctx.lineWidth=1;
    ctx.beginPath();
    ctx.moveTo(0,RULER+.5); ctx.lineTo(W,RULER+.5);
    ctx.moveTo(RULER+.5,0); ctx.lineTo(RULER+.5,H);
    ctx.stroke();
    ctx.font='9px '+getComputedStyle(document.body).fontFamily;
    ctx.textBaseline='top';
    ctx.fillStyle='#8a8d93'; ctx.strokeStyle='#c9ced6';
    const from=v=>Math.floor(v/step)*step;
    ctx.beginPath();
    for(let u=from(-view.x/z); u<=(W-view.x)/z; u+=step){
      const sx=Math.round(u*z+view.x)+.5;
      if(sx<RULER) continue;
      ctx.moveTo(sx,RULER-5); ctx.lineTo(sx,RULER);
      ctx.fillText(String(Math.round(u)),sx+2,3);
    }
    for(let u=from(-view.y/z); u<=(H-view.y)/z; u+=step){
      const sy=Math.round(u*z+view.y)+.5;
      if(sy<RULER) continue;
      ctx.moveTo(RULER-5,sy); ctx.lineTo(RULER,sy);
      ctx.save(); ctx.translate(3,sy-2); ctx.rotate(-Math.PI/2);
      ctx.textBaseline='top'; ctx.fillText(String(Math.round(u)),-18,0);
      ctx.restore();
    }
    ctx.stroke();
    // page extent highlighted on both rulers
    ctx.fillStyle='rgba(59,130,246,.14)';
    ctx.fillRect(Math.max(RULER,view.x),0,Math.max(0,f.w*z),RULER);
    ctx.fillRect(0,Math.max(RULER,view.y),RULER,Math.max(0,f.h*z));
    // cursor position marker
    if(lastPointer){
      ctx.fillStyle='#3b82f6';
      ctx.fillRect(lastPointer.x,0,1,RULER);
      ctx.fillRect(0,lastPointer.y,RULER,1);
    }
  }
  ctx.setTransform(1,0,0,1,0,0);
  const zi=$('zoomInput');
  if(document.activeElement!==zi) zi.value=Math.round(z*100)+'%';
}
function render(){ renderDoc(); paint(); }

/* ================= UI sync ================= */
function refresh(){ computeGapHints(); render(); syncLayers(); syncInspector(); syncPageRow(); }
/* Depth is configurable per §6.14; kept modest by default because entries are
 * now diffs, so 200 costs far less than the old 60 snapshots did. */
function setHistoryLimit(n){
  if(!HIST) return;
  HIST.limit=clamp(Math.round(n)||200,10,2000);
  while(HIST.entries.length>HIST.limit){ HIST.entries.shift(); HIST.i--; }
  if(HIST.i<-1) HIST.i=-1;
  syncHistoryPanel();
}
// Text measured before the webfont finishes loading renders with fallback
// metrics; re-render once fonts settle so text is never left stale.
if(document.fonts&&document.fonts.ready) document.fonts.ready.then(()=>{ if(doc) render(); });

let dragLayerId=null;
/** §6.1 inline rename, committed on Enter or blur. */
function startRename(span,obj){
  const old=obj.type==='text'?obj.text:obj.name;
  const inp=document.createElement('input');
  inp.className='lrename'; inp.value=old;
  span.replaceWith(inp);
  inp.focus(); inp.select();
  const done=commit=>{
    if(commit&&inp.value.trim()){
      if(obj.type==='text') obj.text=inp.value; else obj.name=inp.value.trim();
      pushHistory('Rename');
    }
    refresh();
  };
  inp.addEventListener('keydown',e=>{
    e.stopPropagation();
    if(e.key==='Enter'){ e.preventDefault(); done(true); }
    if(e.key==='Escape'){ e.preventDefault(); done(false); }
  });
  inp.addEventListener('blur',()=>done(true));
}
/** §6.1 reorder / reparent by drag. `where` is above | below | into. */
function moveLayer(srcId,dstId,where){
  if(!srcId||srcId===dstId) return;
  const S=findById(srcId), D=findById(dstId);
  if(!S||!D) return;
  // refuse to drop a container into its own subtree — that detaches the branch
  let p=D.obj, guard=0;
  while(p&&guard++<32){ if(p.id===srcId) return; const f=findById(p.id); p=f&&f.parent; }
  S.list.splice(S.list.indexOf(S.obj),1);
  if(where==='into'&&CONTAINER(D.obj)){ D.obj.children.push(S.obj); }
  else{
    const L=D.list, at=L.indexOf(D.obj);
    // the panel lists top-of-stack first, so "above" in the UI is a HIGHER index
    L.splice(where==='above'?at+1:at,0,S.obj);
  }
  setActiveDoc(normalizeDoc(doc));
  setSelIds(new Set([srcId]));
  pushHistory('Reorder layers'); refresh();
}
function syncLayers(){
  const list=$('layerList'); list.innerHTML='';
  if(!doc) return;
  const ICO={rect:'rect',ellipse:'ellipse',text:'text',polygon:'polygon',
             line:'line',path:'path',group:'group',frame:'frame'};
  const gly=t=>`<span class="glyph">${window.Icons?Icons.svg(ICO[t]||'rect',{size:14}):''}</span>`;
  if(enteredId){
    const f=findById(enteredId);
    const bar=document.createElement('div');
    bar.className='isoBar';
    bar.innerHTML=(window.Icons?Icons.svg('chevronLeft',{size:12}):'')
      +'<span>'+(f?f.obj.name:'container')+'</span>';
    bar.title='Leave this container (Esc)';
    bar.addEventListener('click',()=>{ exitContainer(); });
    list.appendChild(bar);
  }
  // §6.1: the panel is a tree — deepest last so it reads top-of-stack first
  const row=(c,depth)=>{
    const r=document.createElement('div');
    r.className=(selIds.has(c.id)?'sel':'')
      +(c.pattern&&c.pattern.mode!=='none'?' isParent':'')
      +(c.hidden?' isHidden':'')
      +(enteredId&&c.id===enteredId?' isEntered':'');
    r.style.paddingLeft=(12+depth*13)+'px';   // matches the row inset in style.css
    if(CONTAINER(c)){
      const tw=document.createElement('span');
      tw.className='twisty';
      tw.innerHTML=window.Icons?Icons.svg(c.collapsed?'chevronRight':'chevronDown',{size:12}):'';
      tw.addEventListener('click',ev=>{ ev.stopPropagation(); c.collapsed=!c.collapsed; syncLayers(); });
      r.appendChild(tw);
    }
    r.insertAdjacentHTML('beforeend',gly(c.type));
    const nm=document.createElement('span');
    nm.className='lname';
    nm.textContent=c.type==='text'?c.text:c.name;
    r.appendChild(nm);
    const n=patternInstances(c).length;
    if(n){
      const badge=document.createElement('span');
      badge.className='linkBadge'; badge.textContent=`⇢ ${n}`;
      r.appendChild(badge);
    }
    if(CONTAINER(c)&&c.maskMode&&c.maskMode!=='none'){
      const m=document.createElement('span');
      m.className='linkBadge'; m.textContent=c.maskMode==='clip'?'clip':'mask';
      m.title=`${c.maskMode} mask — the top child masks the rest`;
      r.appendChild(m);
    }
    const tgl=(kind,on,title,fn)=>{
      const b=document.createElement('button');
      b.type='button'; b.className='layerTgl'+(on?' on':'');
      const nm=kind==='eye'?(on?'eyeOff':'eye'):(on?'lock':'unlock');
      b.innerHTML=window.Icons?Icons.svg(nm,{size:14}):'';
      b.title=title; b.setAttribute('aria-label',title);
      b.addEventListener('click',ev=>{ ev.stopPropagation(); fn(); pushHistory(); refresh(); });
      r.appendChild(b);
    };
    tgl('lock',c.locked,c.locked?'Unlock':'Lock',()=>{ c.locked=!c.locked; });
    tgl('eye',c.hidden,c.hidden?'Show':'Hide',()=>{
      c.hidden=!c.hidden;
      if(c.hidden&&selIds.has(c.id)){ selIds.delete(c.id); setSelIds(selIds); }
    });
    // §6.1 colour label
    if(c.label){ const dot=document.createElement('span');
      dot.className='labelDot'; dot.style.background=c.label; r.appendChild(dot); }
    r.addEventListener('click',ev=>{
      selInstance=null; fxPage=0;
      if(ev.shiftKey){
        if(selIds.has(c.id)&&selIds.size>1) selIds.delete(c.id); else selIds.add(c.id);
        setSelIds(selIds,c.id);
      }else setSelIds(new Set([c.id]),c.id);
      refresh();
    });
    r.addEventListener('dblclick',ev=>{
      ev.stopPropagation();
      // §6.1 inline rename; containers still enter on double-click via
      // their glyph, so renaming a group stays possible
      if(CONTAINER(c)&&ev.target.closest('.glyph')){ enterContainer(c.id); return; }
      startRename(nm,c);
    });
    // §6.1 colour label via right-click
    r.addEventListener('contextmenu',ev=>{
      ev.preventDefault();
      const COLS=['','#ef4444','#f59e0b','#eab308','#22c55e','#3b82f6','#8b5cf6','#ec4899'];
      const cur=COLS.indexOf(c.label||'');
      c.label=COLS[(cur+1)%COLS.length]||undefined;
      pushHistory('Colour label'); refresh();
    });
    // §6.1 drag to reorder / reparent
    r.draggable=true;
    r.addEventListener('dragstart',ev=>{
      dragLayerId=c.id;
      ev.dataTransfer.effectAllowed='move';
      try{ev.dataTransfer.setData('text/plain',c.id);}catch(_){}
    });
    r.addEventListener('dragover',ev=>{
      if(!dragLayerId||dragLayerId===c.id) return;
      ev.preventDefault();
      const bb=r.getBoundingClientRect();
      const frac=(ev.clientY-bb.top)/bb.height;
      r.dataset.drop=CONTAINER(c)&&frac>0.3&&frac<0.7?'into':(frac<0.5?'above':'below');
      r.classList.add('dropTarget');
    });
    r.addEventListener('dragleave',()=>{ r.classList.remove('dropTarget'); delete r.dataset.drop; });
    r.addEventListener('drop',ev=>{
      ev.preventDefault();
      r.classList.remove('dropTarget');
      const where=r.dataset.drop||'above';
      delete r.dataset.drop;
      moveLayer(dragLayerId,c.id,where);
      dragLayerId=null;
    });
    list.appendChild(r);
    if(CONTAINER(c)&&!c.collapsed) [...(c.children||[])].reverse().forEach(k=>row(k,depth+1));
  };
  const q=(($('layerSearch')||{}).value||'').trim().toLowerCase();
  if(q){
    // §6.1 search: a flat list of matches by name or type, hierarchy set aside
    const hits=allObjects().filter(c=>
      (c.name||'').toLowerCase().includes(q)||c.type.toLowerCase().includes(q)||
      (c.type==='text'&&(c.text||'').toLowerCase().includes(q)));
    if(!hits.length){
      const d=document.createElement('div');
      d.className='hint'; d.textContent='No layers match';
      list.appendChild(d);
    }else hits.reverse().forEach(c=>row(c,0));
    return;
  }
  [...doc.frame.children].reverse().forEach(c=>row(c,0));
}

const FX_PAGES=obj=>{
  if(obj.type==='boolean') return ['Boolean','Fill','Stroke','Effects','Shadow','Glow'];
  if(obj.type==='group') return ['Group','Mask','Shadow'];
  if(obj.type==='frame') return ['Frame','Layout','Fill','Stroke','Mask','Shadow'];
  if(obj.type==='instance') return ['Instance','Effects','Shadow','Glow','Blur'];
  if(obj.type==='image') return ['Image','Effects','Shadow','Glow','Blur','Distortion','Warp','Displacement','Haze','Slice','Noise'];
  if(obj.type==='text') return ['Text','Shadow'];
  if(obj.type==='line') return ['Line','Stroke','Shadow','Glow'];
  if(obj.type==='path') return ['Path','Fill','Stroke','Effects','Gradient','Light','Shadow','Inner Shadow','Glow','Grain','Blur','Distortion','Warp','Displacement','Haze','Slice','Noise'];
  // polygons clip fine through pathFor, but the glass-family engines fit a
  // 3D solid to the box and would render a misleading rect footprint
  if(obj.type==='polygon') return ['Shape','Pattern','Fill','Stroke','Effects','Gradient','Light','Shadow','Inner Shadow','Glow','Grain','Blur','Distortion','Warp','Displacement','Haze','Slice','Noise'];
  return ['Shape','Pattern','Fill','Stroke','Effects','Gradient','Light','Prism','Capsule','Strip','Blob','Glass','Glass 2','Shadow','Inner Shadow','Glow','Grain','Blur','Distortion','Warp','Displacement','Haze','Slice','Noise'];
};

function syncInspector(){
  const obj=primary();
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
      b.addEventListener('click',()=>{ setSel(pi); selInstance=null; fxPage=0; refresh(); });
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
  const tx=(obj.type==='text'&&obj.mode!=='area')||obj.type==='line'||obj.type==='path';
  $('pW').disabled=tx; $('pH').disabled=tx;
  $('pOpacity').value=Math.round(obj.opacity*100);
  $('pOpacityV').textContent=Math.round(obj.opacity*100)+'%';
  // §6.11/§6.12 — only meaningful for a child of a frame
  const par=(findById(obj.id)||{}).parent;
  const inFrame=par&&par.type==='frame';
  const cw=$('constraintRow');
  if(cw){
    cw.style.display=inFrame?'':'none';
    if(inFrame){
      $('cH').value=obj.constraints.h; $('cV').value=obj.constraints.v;
      $('cSize').value=obj.sizing;
      $('cAbs').checked=!!obj.absolute;
      $('cSize').disabled=!(par.layout&&par.layout.mode!=='none');
    }
  }
  const noRot=obj.type==='line';
  $('trRot').disabled=noRot; $('trSkX').disabled=noRot; $('trSkY').disabled=noRot;
  $('trRot').value=noRot?'':Math.round(obj.rot||0);
  $('trSkX').value=noRot?'':Math.round(obj.skewX||0);
  $('trSkY').value=noRot?'':Math.round(obj.skewY||0);
  $('trScale').value='';
  $('objBlend').value=obj.blend||'normal';
  syncInstancePanel(obj);
  syncLayoutPanel(obj);
  buildFx(obj);
}

/* §6.7/§6.8 — the instance panel. Overrides are listed from the DEFINITION's
 * tree rather than from whatever the instance happens to have overridden, so
 * every overridable child is offered even before it has been touched, and a
 * child added to the source shows up here without the instance being edited. */
function syncInstancePanel(obj){
  const p=$('instPanel');
  if(!p) return;
  const isInst=obj&&obj.type==='instance';
  p.style.display=isInst?'':'none';
  if(!isInst) return;
  const defs=(doc.frame.components||[]);
  const def=defs.find(d=>d.id===obj.compId);
  $('instOf').textContent=def?(def.kind==='symbol'?'Symbol: ':'Component: ')+def.name
                              :'Source definition is missing';
  // variants (components only — a symbol has none by definition)
  const vr=$('instVariantRow'), vs=$('instVariant');
  const hasVars=!!(def&&def.kind==='component'&&def.variants.length);
  vr.style.display=hasVars?'':'none';
  if(hasVars){
    vs.innerHTML='<option value="">Default</option>'+
      def.variants.map(v=>'<option value="'+esc(v.name)+'">'+esc(v.name)+'</option>').join('');
    vs.value=obj.variant||'';
  }
  // overrides
  const box=$('instOverrides');
  box.innerHTML='';
  if(!def||def.kind!=='component'){
    box.innerHTML='<div class="hint">'+(def&&def.kind==='symbol'
      ? 'Symbols do not take overrides — every instance follows the source.'
      : '')+'</div>';
    return;
  }
  let src=def.root;
  if(obj.variant){ const v=def.variants.find(x=>x.name===obj.variant); if(v) src=v.root; }
  const rows=[];
  (function walk(list,trail){
    (list||[]).forEach(o=>{
      const t=trail.concat(o.name||o.type);
      const key=t.join('/');
      if(o.type==='text') rows.push({key,label:t[t.length-1],kind:'text',
        val:(o.text===undefined?'':o.text)});
      else if(o.fills&&o.fills[0]) rows.push({key,label:t[t.length-1],kind:'color',
        val:o.fills[0].color||'#000000'});
      if(o.children) walk(o.children,t);
    });
  })([src],[]);
  if(!rows.length){ box.innerHTML='<div class="hint">Nothing overridable in this component.</div>'; return; }
  const ov=obj.overrides||{};
  rows.slice(0,24).forEach(r=>{
    const set=ov[r.key]||{};
    const dirty=set.text!==undefined||set.color!==undefined||set.hidden!==undefined;
    const row=document.createElement('div');
    row.className='ovRow';
    const cur=r.kind==='text'?(set.text!==undefined?set.text:r.val)
                             :(set.color!==undefined?set.color:r.val);
    row.innerHTML='<span class="'+(dirty?'ovDirty':'')+'" title="'+esc(r.key)+'">'+esc(r.label)+'</span>'+
      (r.kind==='text'
        ? '<input type="text" value="'+esc(cur)+'">'
        : '<input type="color" value="'+esc(cur)+'">')+
      '<label class="chk" style="margin:0" title="Hide this child in this instance only">'+
      '<input type="checkbox"'+(set.hidden?' checked':'')+'></label>';
    const field=row.querySelector('input[type=text],input[type=color]');
    const hide=row.querySelector('input[type=checkbox]');
    const write=(patch)=>{
      const inst=primary();
      if(!inst||inst.type!=='instance') return;
      inst.overrides=inst.overrides||{};
      const e=Object.assign({},inst.overrides[r.key]||{},patch);
      Object.keys(e).forEach(k=>{ if(e[k]===undefined) delete e[k]; });
      if(Object.keys(e).length) inst.overrides[r.key]=e; else delete inst.overrides[r.key];
      delete inst.__sig;
      render(); pushHistory('Override instance'); syncInspector();
    };
    field.addEventListener('input',()=>{
      write(r.kind==='text'?{text:field.value}:{color:field.value});
    });
    hide.addEventListener('change',()=>write({hidden:hide.checked||undefined}));
    box.appendChild(row);
  });
}

/* §6.12 — the layout panel, shown for any frame. */
function syncLayoutPanel(obj){
  const p=$('layoutPanel');
  if(!p) return;
  const isFrame=obj&&obj.type==='frame';
  p.style.display=isFrame?'':'none';
  if(!isFrame) return;
  const L=obj.layout||{mode:'none'};
  $('lyMode').value=L.mode||'none';
  const on=(L.mode||'none')!=='none';
  $('lyBody').style.display=on?'':'none';
  if(!on) return;
  const pad=L.padding||{t:0,r:0,b:0,l:0};
  $('lyGap').value=L.gap||0;
  $('lyHug').checked=!!L.hug;
  $('lyPT').value=pad.t||0; $('lyPR').value=pad.r||0;
  $('lyPB').value=pad.b||0; $('lyPL').value=pad.l||0;
  $('lyAlign').value=L.align||'start';
  $('lyJustify').value=L.justify||'start';
}

/* Is this engine doing anything on this object? Drives the dot in the engine
 * menu, so "which effects are on this shape" is answerable at a glance rather
 * than by paging through all ten. */
function fxActive(obj,name){
  const e=obj.effects||{};
  switch(name){
    case 'Shape':
      if(obj.type==='rect') return !!(obj.radii&&obj.radii.some((v,i,a)=>v!==a[0]))||obj.cornerStyle!=='round';
      if(obj.type==='ellipse') return obj.innerRatio>0||obj.startAngle>0||(obj.endAngle!==undefined&&obj.endAngle<360);
      if(obj.type==='polygon') return true;
      return false;
    case 'Line':     return obj.arrowStart!=='none'||obj.arrowEnd!=='none';
    case 'Mask':     return !!(obj.maskMode&&obj.maskMode!=='none'&&obj.maskOn!==false);
    case 'Group':    return (obj.children||[]).length>0;
    case 'Boolean':  return true;
    case 'Effects':  return !!(window.FxStack&&obj.fx&&obj.fx.some(x=>FxStack.entryOn(x)));
    case 'Frame':    return obj.clip!==false;
    case 'Layout':   return !!(obj.layout&&obj.layout.mode!=='none');
    case 'Instance': return true;
    case 'Constraints': return true;
    case 'Path':     return !!(obj.closed||obj.fillOn);
    case 'Pattern':  return !!obj.pattern;
    case 'Fill':     return (obj.fills||[]).length>1||(obj.fill&&obj.fill.kind!=='solid');
    case 'Stroke':   return (obj.strokes||[]).some(k=>k.on!==false&&k.width>0);
    case 'Inner Shadow': return !!(e.innerShadow&&e.innerShadow.on);
    case 'Glow':     return !!(e.glow&&e.glow.on);
    case 'Blur': case 'Distortion': case 'Warp': case 'Displacement':
    case 'Haze': case 'Slice': case 'Noise': {
      const K={Blur:'blur',Distortion:'distortion',Warp:'warp',
        Displacement:'displacement',Haze:'haze',Slice:'slice',Noise:'noise'}[name];
      return !!(window.FxStack&&obj.fx&&obj.fx.some(x=>x.type===K&&FxStack.entryOn(x)));
    }
    case 'Gradient': return !!(e.gradient&&e.gradient.on);
    case 'Light':    return !!(e.light&&e.light.on);
    case 'Prism':    return !!(e.prism&&e.prism.on);
    case 'Capsule':  return !!(e.capsule&&e.capsule.on);
    case 'Strip':    return !!(e.strip&&e.strip.on);
    case 'Blob':     return !!(e.blob&&e.blob.on);
    case 'Glass':    return !!(e.glass&&e.glass.on);
    case 'Glass 2':  return !!(e.glass2&&e.glass2.on);
    case 'Shadow':   return !!(e.shadow&&e.shadow.on);
    case 'Grain':    return !!(e.grain&&e.grain.amount>0);
    default:         return false;
  }
}
/* The engine name doubles as the picker. The ‹ › pager still works, but it is
 * the only affordance that scrolls off the bottom of a long panel, so it
 * cannot be the only way to reach an engine. */
function buildFxMenu(obj,pages){
  const menu=$('fxMenu');
  menu.innerHTML='';
  pages.forEach((name,i)=>{
    const b=document.createElement('button');
    b.type='button'; b.setAttribute('role','menuitem');
    if(i===fxPage) b.classList.add('cur');
    if(fxActive(obj,name)) b.classList.add('on');
    const dot=document.createElement('span'); dot.className='dot';
    b.appendChild(dot);
    b.appendChild(document.createTextNode(name));
    b.addEventListener('click',ev=>{
      ev.stopPropagation();
      fxPage=i; closeFxMenu(); syncInspector();
    });
    menu.appendChild(b);
  });
}
function closeFxMenu(){
  $('fxTitleWrap').classList.remove('open');
  $('fxTitle').setAttribute('aria-expanded','false');
}
$('fxTitle').addEventListener('click',e=>{
  e.stopPropagation();
  const w=$('fxTitleWrap'), open=!w.classList.contains('open');
  w.classList.toggle('open',open);
  $('fxTitle').setAttribute('aria-expanded',String(open));
});
document.addEventListener('click',closeFxMenu);
document.addEventListener('keydown',e=>{ if(e.key==='Escape') closeFxMenu(); });

/* Inline icon markup for panel templates; empty if icons.js is unavailable. */
const IC=(n,sz)=>window.Icons?Icons.svg(n,{size:sz||14}):'';

/* ---- engines panel ---- */
function buildFx(obj){
  const pages=FX_PAGES(obj);
  fxPage=clamp(fxPage,0,pages.length-1);
  $('fxTitle').textContent=pages[fxPage];
  buildFxMenu(obj,pages);
  $('fxPager').style.display=pages.length>1?'':'none';
  const body=$('fxBody'); body.innerHTML='';
  const add=h=>{ body.insertAdjacentHTML('beforeend',h); };
  const page=pages[fxPage];

  if(page==='Shape'){
    const sl=(id,label,min,max,step,key,fmt)=>{
      add(`<label class="slider">${label} <span id="${id}V">${fmt(obj[key])}</span>
        <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${obj[key]}"></label>`);
      $(id).addEventListener('input',e=>{ obj[key]=+e.target.value; $(id+'V').textContent=fmt(+e.target.value); render(); });
      $(id).addEventListener('change',()=>pushHistory());
    };
    const int=v=>String(Math.round(v)), deg=v=>Math.round(v)+'°', f2=v=>(+v).toFixed(2);
    if(obj.type==='rect'){
      add(`<label class="slider">Corner style<select id="shSt">
        <option value="round">Round</option><option value="bevel">Bevel</option>
        <option value="scoop">Scoop (inverted)</option></select></label>`);
      $('shSt').value=obj.cornerStyle||'round';
      $('shSt').addEventListener('change',e=>{ obj.cornerStyle=e.target.value; pushHistory(); render(); });
      const per=Array.isArray(obj.radii);
      add(`<label class="chk"><input type="checkbox" id="shPer" ${per?'checked':''}> Independent corners</label>`);
      $('shPer').addEventListener('change',e=>{
        if(e.target.checked){ const u=obj.radius||0; obj.radii=[u,u,u,u]; }
        else delete obj.radii;
        pushHistory(); refresh();
      });
      if(per){
        ['Top left','Top right','Bottom right','Bottom left'].forEach((lab,ci)=>{
          add(`<label class="slider">${lab} <span id="shR${ci}V">${Math.round(obj.radii[ci])}</span>
            <input type="range" id="shR${ci}" min="0" max="200" value="${obj.radii[ci]}"></label>`);
          $('shR'+ci).addEventListener('input',e=>{ obj.radii[ci]=+e.target.value; $(`shR${ci}V`).textContent=e.target.value; render(); });
          $('shR'+ci).addEventListener('change',()=>pushHistory());
        });
      }else{
        sl('shRad','Corner radius',0,200,1,'radius',int);
      }
      add(`<div class="fxHint">Radii clamp to the box automatically, so non-uniform scaling never breaks a corner.</div>`);
    }
    if(obj.type==='ellipse'){
      sl('shA0','Start angle',0,360,1,'startAngle',deg);
      sl('shA1','End angle',0,360,1,'endAngle',deg);
      sl('shIn','Inner radius (ring)',0,0.95,0.01,'innerRatio',f2);
      add(`<div class="fxHint">A partial sweep makes a pie; inner radius makes a ring or donut segment. Open arcs need strokes (§4.2, not built yet).</div>`);
    }
    if(obj.type==='polygon'){
      sl('shN','Sides',3,24,1,'sides',int);
      sl('shStar','Star inner ratio',0.1,1,0.01,'innerRatio',f2);
      sl('shRad','Corner radius',0,120,1,'radius',int);
      add(`<div class="fxHint">Inner ratio 1 is a regular polygon; below 1 the vertices alternate and it becomes a star.</div>`);
    }
  }

  if(page==='Path'){
    const P=obj;
    add(`<div class="fxHint">${(P.subpaths||[]).reduce((a,sp)=>a+sp.points.length,0)} anchors in
      ${(P.subpaths||[]).length} subpath${(P.subpaths||[]).length===1?'':'s'} · ${P.closed?'closed':'open'}.
      Double-click the path with the Select tool (or press A) to edit nodes:
      drag anchors and handles, double-click an anchor to convert corner/smooth,
      double-click a segment to add an anchor, Delete removes selected anchors.</div>`);
    if((P.subpaths||[]).length>1){
      add(`<label class="slider">Fill rule<select id="paRule">
        <option value="nonzero">Non-zero</option><option value="evenodd">Even-odd (holes)</option>
      </select></label>`);
      $('paRule').value=P.fillRule||'nonzero';
      $('paRule').addEventListener('change',e=>{ P.fillRule=e.target.value; pushHistory(); render(); });
      add(`<button class="rollBtn" id="paRelease">Release compound path (${P.subpaths.length} subpaths)</button>`);
      $('paRelease').addEventListener('click',()=>{ setSelIds(new Set([P.id])); releaseCompound(); });
    }
    add(`<label class="chk"><input type="checkbox" id="paClosed" ${P.closed?'checked':''}> Closed path</label>`);
    $('paClosed').addEventListener('change',e=>{ P.closed=e.target.checked; pushHistory(); refresh(); });
    add(`<label class="chk"><input type="checkbox" id="paFill" ${P.fillOn?'checked':''}> Fill (when closed)</label>`);
    $('paFill').addEventListener('change',e=>{ P.fillOn=e.target.checked; pushHistory(); refresh(); });
    add(`<label class="slider">Stroke width <span id="paWV">${P.stroke.width}</span>
      <input type="range" id="paW" min="0" max="60" step="1" value="${P.stroke.width}"></label>`);
    $('paW').addEventListener('input',e=>{ P.stroke.width=+e.target.value; $('paWV').textContent=e.target.value; render(); });
    $('paW').addEventListener('change',()=>pushHistory());
    add(`<label class="slider">Stroke color <input type="color" id="paC" value="${P.stroke.color}"></label>`);
    $('paC').addEventListener('input',e=>{ P.stroke.color=e.target.value; render(); });
    $('paC').addEventListener('change',()=>pushHistory());
    add(`<div class="gsBtns">
      <button class="rollBtn" id="paSmooth">Smooth all</button>
      <button class="rollBtn" id="paCorner">Corner all</button></div>`);
    $('paSmooth').addEventListener('click',()=>{
      P.points.forEach((a,i)=>{
        const prev=P.points[(i-1+P.points.length)%P.points.length];
        const next=P.points[(i+1)%P.points.length];
        a.ox=Math.round((next.x-prev.x)/6); a.oy=Math.round((next.y-prev.y)/6);
        a.ix=-a.ox; a.iy=-a.oy; a.m='smooth';
      });
      pushHistory(); refresh();
    });
    $('paCorner').addEventListener('click',()=>{
      P.points.forEach(a=>{ a.ox=a.oy=a.ix=a.iy=0; a.m='corner'; });
      pushHistory(); refresh();
    });
  }

  if(page==='Line'){
    const L=obj;
    const sl=(id,label,min,max,step,get,set,fmt)=>{
      add(`<label class="slider">${label} <span id="${id}V">${fmt(get())}</span>
        <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${get()}"></label>`);
      $(id).addEventListener('input',e=>{ set(+e.target.value); $(id+'V').textContent=fmt(+e.target.value); render(); });
      $(id).addEventListener('change',()=>pushHistory());
    };
    const int=v=>String(Math.round(v));
    sl('lnW','Stroke width',1,60,1,()=>L.stroke.width,v=>L.stroke.width=v,int);
    add(`<label class="slider">Color <input type="color" id="lnC" value="${L.stroke.color}"></label>`);
    $('lnC').addEventListener('input',e=>{ L.stroke.color=e.target.value; render(); });
    $('lnC').addEventListener('change',()=>pushHistory());
    // §1.8 numeric length + angle, editing about the start point
    const len=()=>Math.hypot(L.x2-L.x,L.y2-L.y);
    const ang=()=>Math.atan2(L.y2-L.y,L.x2-L.x)*180/Math.PI;
    const apply=(nl,na)=>{
      const r=na*Math.PI/180;
      L.x2=Math.round(L.x+Math.cos(r)*nl); L.y2=Math.round(L.y+Math.sin(r)*nl);
    };
    add(`<div class="pSect">Geometry</div>
      <div class="row2">
        <label class="slider">Length <input type="number" id="lnLen" value="${Math.round(len())}" min="1" step="1"></label>
        <label class="slider">Angle° <input type="number" id="lnAng" value="${Math.round(ang())}" step="1"></label>
      </div>`);
    $('lnLen').addEventListener('change',e=>{ apply(Math.max(1,+e.target.value||1),ang()); pushHistory(); refresh(); });
    $('lnAng').addEventListener('change',e=>{ apply(len(),+e.target.value||0); pushHistory(); refresh(); });
    add(`<div class="pSect">Arrowheads</div>`);
    const HEADS=[['none','None'],['triangle','Triangle'],['open','Open'],['circle','Circle'],['bar','Bar']];
    [['arrowStart','Start'],['arrowEnd','End']].forEach(([key,lab])=>{
      add(`<label class="slider">${lab}<select id="ln_${key}">`+
        HEADS.map(([v,n])=>`<option value="${v}">${n}</option>`).join('')+`</select></label>`);
      $('ln_'+key).value=L[key];
      $('ln_'+key).addEventListener('change',e=>{ L[key]=e.target.value; pushHistory(); render(); });
    });
    sl('lnAS','Arrow size',4,60,1,()=>L.arrowSize,v=>L.arrowSize=v,int);
    add(`<div class="fxHint">Drag either endpoint on canvas; shift snaps to 45°. Heads align their tip to the endpoint.</div>`);
  }

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
    addA(`<button class="rollBtn" id="pRoll">${IC('reset',13)} Reroll pattern</button>`);
    // Math.random is confined to this user action; layout stays pure.
    $('pRoll').addEventListener('click',()=>{ E.seed=Math.floor(Math.random()*99999999)||1; pushHistory(); refresh(); });

    add(`<button class="rollBtn danger" id="pRemove">Remove pattern</button>`);
    $('pRemove').addEventListener('click',()=>{ delete obj.pattern; pushHistory(); refresh(); });
  }

  if(page==='Fill'||page==='Stroke'){
    const isFill=page==='Fill';
    const list=isFill?(obj.fills||[]):(obj.strokes||[]);
    const key=isFill?'fills':'strokes';
    if(!list){ add(`<div class="fxHint">This object type has no ${page.toLowerCase()}s.</div>`); }
    else{
      // §4.3 object-level fill/stroke opacity, independent of layer opacity
      const opKey=isFill?'fillOpacity':'strokeOpacity';
      add(`<label class="slider">${page} opacity <span id="apOpV">${Math.round((obj[opKey]??1)*100)}%</span>
        <input type="range" id="apOp" min="0" max="100" value="${Math.round((obj[opKey]??1)*100)}"></label>`);
      $('apOp').addEventListener('input',e=>{ obj[opKey]=+e.target.value/100; $('apOpV').textContent=e.target.value+'%'; render(); });
      $('apOp').addEventListener('change',()=>pushHistory());

      list.forEach((f,fi)=>{
        add(`<div class="pSect">${page} ${fi+1}${fi===0?' (bottom)':''}</div>`);
        add(`<div class="apRow">
          <label class="chk" style="flex:1"><input type="checkbox" class="apOn" data-i="${fi}" ${f.on!==false?'checked':''}> Visible</label>
          <button class="apUp" data-i="${fi}" title="Move up" aria-label="Move up" ${fi===list.length-1?'disabled':''}>${IC('chevronUp',13)}</button>
          <button class="apDn" data-i="${fi}" title="Move down" aria-label="Move down" ${fi===0?'disabled':''}>${IC('chevronDown',13)}</button>
          <button class="apDel" data-i="${fi}" title="Remove" aria-label="Remove" ${list.length<=1&&(!isFill?obj.type==='path'||obj.type==='line':true)?'disabled':''}>${IC('trash',13)}</button>
        </div>`);
        add(`<label class="slider">Type<select class="apKind" data-i="${fi}">
          <option value="solid">Solid</option><option value="linear">Linear gradient</option>
          <option value="radial">Radial gradient</option></select></label>`);
        body.querySelectorAll('.apKind')[fi].value=f.kind;
        if(f.kind==='solid'){
          add(`<label class="slider">Color <input type="color" class="apColor" data-i="${fi}" value="${f.color}"></label>`);
        }else{
          if(f.kind==='linear'){
            add(`<label class="slider">Angle <span id="apAng${fi}">${Math.round(f.angle)}°</span>
              <input type="range" class="apAngle" data-i="${fi}" min="0" max="359" value="${Math.round(f.angle)}"></label>`);
          }else{
            add(`<div class="row2">
              <label class="slider">Focal X <input type="range" class="apFx" data-i="${fi}" min="-100" max="100" value="${Math.round(f.fx*100)}"></label>
              <label class="slider">Focal Y <input type="range" class="apFy" data-i="${fi}" min="-100" max="100" value="${Math.round(f.fy*100)}"></label>
            </div>`);
            add(`<label class="slider">Aspect <span id="apAsp${fi}">${(+f.aspect).toFixed(2)}</span>
              <input type="range" class="apAspect" data-i="${fi}" min="0.2" max="5" step="0.05" value="${f.aspect}"></label>`);
          }
          f.stops.forEach((st,si)=>{
            add(`<div class="stopRow">
              <input type="color" class="apSC" data-i="${fi}" data-s="${si}" value="${st.color}">
              <input type="range" class="apSP" data-i="${fi}" data-s="${si}" min="0" max="100" value="${Math.round(st.pos*100)}">
              <button class="stopDel apSD" data-i="${fi}" data-s="${si}" title="Remove stop" aria-label="Remove stop" ${f.stops.length<=2?'disabled':''}>${IC('x',12)}</button>
            </div>
            <div class="row2" style="margin:-4px 0 6px">
              <label class="slider" style="font-size:10px">Stop opacity
                <input type="range" class="apSO" data-i="${fi}" data-s="${si}" min="0" max="100" value="${Math.round((st.opacity??1)*100)}"></label>
              <label class="slider" style="font-size:10px">Midpoint
                <input type="range" class="apSM" data-i="${fi}" data-s="${si}" min="5" max="95" value="${Math.round((st.mid??0.5)*100)}"></label>
            </div>`);
          });
          add(`<div class="gsBtns">
            <button class="rollBtn apAddStop" data-i="${fi}">+ Stop</button>
            <button class="rollBtn apRev" data-i="${fi}">Reverse</button></div>`);
        }
        if(!isFill){
          add(`<div class="row2">
            <label class="slider">Width <input type="number" class="apW" data-i="${fi}" min="0" max="200" step="0.5" value="${f.width}"></label>
            <label class="slider">Align<select class="apAlign" data-i="${fi}">
              <option value="center">Center</option><option value="inside">Inside</option>
              <option value="outside">Outside</option></select></label>
          </div>`);
          body.querySelectorAll('.apAlign')[fi].value=f.align;
          add(`<div class="row2">
            <label class="slider">Cap<select class="apCap" data-i="${fi}">
              <option value="butt">Butt</option><option value="round">Round</option>
              <option value="square">Square</option></select></label>
            <label class="slider">Join<select class="apJoin" data-i="${fi}">
              <option value="miter">Miter</option><option value="round">Round</option>
              <option value="bevel">Bevel</option></select></label>
          </div>`);
          body.querySelectorAll('.apCap')[fi].value=f.cap;
          body.querySelectorAll('.apJoin')[fi].value=f.join;
          add(`<label class="slider">Dash (px, comma separated)
            <input type="text" class="apDash" data-i="${fi}" value="${(f.dash||[]).join(', ')}" placeholder="e.g. 12, 6"></label>`);
          add(`<label class="slider">Dash offset <span id="apDO${fi}">${Math.round(f.dashOffset)}</span>
            <input type="range" class="apDashOff" data-i="${fi}" min="-100" max="100" value="${Math.round(f.dashOffset)}"></label>`);
        }
        add(`<div class="row2">
          <label class="slider">Opacity <input type="range" class="apEOp" data-i="${fi}" min="0" max="100" value="${Math.round(f.opacity*100)}"></label>
          <label class="slider">Blend<select class="apBlend" data-i="${fi}">`+
          BLEND_MODES.map(m=>`<option value="${m}">${m}</option>`).join('')+`</select></label>
        </div>`);
        body.querySelectorAll('.apBlend')[fi].value=f.blend;
      });
      add(`<button class="rollBtn" id="apAdd">+ Add ${page.toLowerCase()}</button>`);
      $('apAdd').addEventListener('click',()=>{
        const base=list.length?JSON.parse(JSON.stringify(list[list.length-1])):null;
        obj[key]=[...list, isFill?(base||{kind:'solid',color:'#888888'})
                              :(base||{kind:'solid',color:'#111111',width:2})];
        setActiveDoc(normalizeDoc(doc)); pushHistory(); refresh();
      });

      const I=el=>+el.dataset.i, SI=el=>+el.dataset.s;
      const live=()=>render(), commit=()=>{ pushHistory(); };
      const each=(cls,ev,fn,rebuild)=>body.querySelectorAll('.'+cls).forEach(el=>{
        el.addEventListener(ev,e=>{ fn(list[I(el)],e,el);
          if(rebuild){ setActiveDoc(normalizeDoc(doc)); pushHistory(); refresh(); } else live(); });
        if(ev==='input') el.addEventListener('change',commit);
      });
      each('apOn','change',(f,e)=>f.on=e.target.checked);
      each('apKind','change',(f,e)=>{ f.kind=e.target.value; },true);
      each('apColor','input',(f,e)=>f.color=e.target.value);
      each('apAngle','input',(f,e,el)=>{ f.angle=+e.target.value; const sp=$('apAng'+I(el)); if(sp) sp.textContent=e.target.value+'°'; });
      each('apFx','input',(f,e)=>f.fx=+e.target.value/100);
      each('apFy','input',(f,e)=>f.fy=+e.target.value/100);
      each('apAspect','input',(f,e,el)=>{ f.aspect=+e.target.value; const sp=$('apAsp'+I(el)); if(sp) sp.textContent=(+e.target.value).toFixed(2); });
      each('apSC','input',(f,e,el)=>f.stops[SI(el)].color=e.target.value);
      each('apSP','input',(f,e,el)=>f.stops[SI(el)].pos=+e.target.value/100);
      each('apSO','input',(f,e,el)=>f.stops[SI(el)].opacity=+e.target.value/100);
      each('apSM','input',(f,e,el)=>f.stops[SI(el)].mid=+e.target.value/100);
      each('apSD','click',(f,e,el)=>{ if(f.stops.length>2) f.stops.splice(SI(el),1); },true);
      each('apAddStop','click',f=>{
        const last=f.stops[f.stops.length-1];
        f.stops.push({pos:1,color:last.color,opacity:1,mid:0.5});
        f.stops.forEach((st,i2)=>st.pos=i2/(f.stops.length-1));
      },true);
      each('apRev','click',f=>{
        const cols=f.stops.map(st=>st.color).reverse();
        const ops=f.stops.map(st=>st.opacity).reverse();
        f.stops.forEach((st,i2)=>{ st.color=cols[i2]; st.opacity=ops[i2]; });
      },true);
      each('apW','input',(f,e)=>f.width=clamp(+e.target.value||0,0,200));
      each('apAlign','change',(f,e)=>f.align=e.target.value);
      each('apCap','change',(f,e)=>f.cap=e.target.value);
      each('apJoin','change',(f,e)=>f.join=e.target.value);
      each('apDash','input',(f,e)=>{
        f.dash=e.target.value.split(/[,\s]+/).map(v=>parseFloat(v)).filter(v=>Number.isFinite(v)&&v>=0);
      });
      each('apDashOff','input',(f,e,el)=>{ f.dashOffset=+e.target.value; const sp=$('apDO'+I(el)); if(sp) sp.textContent=e.target.value; });
      each('apEOp','input',(f,e)=>f.opacity=+e.target.value/100);
      each('apBlend','change',(f,e)=>f.blend=e.target.value);
      each('apUp','click',(f,e,el)=>{ const i2=I(el); [obj[key][i2],obj[key][i2+1]]=[obj[key][i2+1],obj[key][i2]]; },true);
      each('apDn','click',(f,e,el)=>{ const i2=I(el); [obj[key][i2],obj[key][i2-1]]=[obj[key][i2-1],obj[key][i2]]; },true);
      each('apDel','click',(f,e,el)=>{ obj[key].splice(I(el),1); },true);

      if(isFill&&obj.type==='rect'){
        add(`<label class="slider">Corner radius <span id="fRadV">${obj.radius}</span>
          <input type="range" id="fRad" min="0" max="200" value="${obj.radius}"></label>`);
        $('fRad').addEventListener('input',e=>{ obj.radius=+e.target.value; $('fRadV').textContent=e.target.value; render(); });
        $('fRad').addEventListener('change',()=>pushHistory());
      }
      add(`<div class="fxHint">${isFill
        ? 'Fills paint bottom to top, each with its own opacity and blend mode.'
        : 'Inside/outside alignment is rendered by clipping, since canvas strokes are centred. Dash accepts a comma-separated list.'}</div>`);
    }
  }

  if(page==='Image'){
    add(`<div class="fxHint">A flattened pixel layer, ${Math.round(obj.w)}×${Math.round(obj.h)}px.
      Its vector source was replaced when it was flattened — undo brings that back.</div>`);
    add(`<button class="rollBtn" id="imDl">Download this layer</button>`);
    $('imDl').addEventListener('click',()=>{
      const a=document.createElement('a');
      a.href=obj.src; a.download=(obj.name||'layer')+'.png'; a.click();
    });
  }

  if(page==='Effects'){
    const FS=window.FxStack;
    if(!FS||!obj.fx){ add(`<div class="fxHint">No effect stack on this object.</div>`); }
    else{
      const mat=FS.activeMaterial(obj.fx);
      const shadowed=FS.shadowedMaterials(obj.fx);
      add(`<div class="fxHint">Effects apply bottom to top. Drag order with the
        arrows; the eye toggles an entry without losing its settings. Click a
        name to open its own panel.</div>`);
      if(shadowed.length){
        add(`<div class="fxWarn">${shadowed.length} material effect${shadowed.length===1?' is':'s are'}
          enabled below <b>${FS.label(mat.type)}</b> and cannot show —
          only the topmost material renders. Reorder or switch the others off.</div>`);
      }
      // top of stack listed FIRST, the way layers read
      [...obj.fx].reverse().forEach((e,ri)=>{
        const i=obj.fx.length-1-ri;
        const on=FS.entryOn(e);
        const isMat=FS.slotOf(e.type)==='material';
        const wins=mat&&mat.id===e.id;
        add(`<div class="fxRow${on?' on':''}">
          <button class="fxEye" data-i="${i}" title="${e.on===false?'Enable':'Disable'}"
            aria-label="${e.on===false?'Enable':'Disable'} ${FS.label(e.type)}">${IC(e.on===false?'eyeOff':'eye',13)}</button>
          <button class="fxName" data-i="${i}">${FS.label(e.type)}</button>
          <span class="fxSlot">${isMat?(wins?'material':'hidden'):FS.slotOf(e.type)}</span>
          <button class="fxUp" data-i="${i}" title="Move up" aria-label="Move up" ${i===obj.fx.length-1?'disabled':''}>${IC('chevronUp',12)}</button>
          <button class="fxDn" data-i="${i}" title="Move down" aria-label="Move down" ${i===0?'disabled':''}>${IC('chevronDown',12)}</button>
        </div>`);
      });
      const wire=(cls,fn)=>body.querySelectorAll('.'+cls).forEach(el=>
        el.addEventListener('click',ev=>{ ev.stopPropagation(); fn(+el.dataset.i,el); }));
      wire('fxEye',i=>{ obj.fx[i].on=obj.fx[i].on===false; pushHistory(); refresh(); });
      wire('fxUp',i=>{ const a=obj.fx; [a[i],a[i+1]]=[a[i+1],a[i]]; pushHistory(); refresh(); });
      wire('fxDn',i=>{ const a=obj.fx; [a[i],a[i-1]]=[a[i-1],a[i]]; pushHistory(); refresh(); });
      wire('fxName',i=>{
        const PAGE={shadow:'Shadow',innerShadow:'Inner Shadow',glow:'Glow',grain:'Grain',
          gradient:'Gradient',light:'Light',prism:'Prism',capsule:'Capsule',strip:'Strip',
          blob:'Blob',glass2:'Glass 2',glass:'Glass'};
        const nm=PAGE[obj.fx[i].type];
        const idx=FX_PAGES(obj).indexOf(nm);
        if(idx>=0){ fxPage=idx; syncInspector(); }
      });
      add(`<div class="pSect">Presets</div>`);
      add(`<div class="gsBtns">
        <button class="rollBtn" id="fxSave">Save preset</button>
        <button class="rollBtn" id="fxLoad">Apply preset…</button></div>`);
      $('fxSave').addEventListener('click',()=>{
        const nm=prompt('Preset name:','Effect preset');
        if(!nm) return;
        const P=JSON.parse(localStorage.getItem('ce.fxPresets')||'{}');
        P[nm]=JSON.parse(JSON.stringify(obj.fx.map(e=>({type:e.type,on:e.on,params:e.params}))));
        localStorage.setItem('ce.fxPresets',JSON.stringify(P));
        status('Preset saved: '+nm);
      });
      $('fxLoad').addEventListener('click',()=>{
        const P=JSON.parse(localStorage.getItem('ce.fxPresets')||'{}');
        const names=Object.keys(P);
        if(!names.length){ status('No saved presets yet',true); return; }
        const nm=prompt('Apply which preset?\n\n'+names.join('\n'),names[0]);
        if(!nm||!P[nm]) return;
        selObjs().filter(o=>!o.locked&&o.fx).forEach(o=>{ o.fx=JSON.parse(JSON.stringify(P[nm])); });
        setActiveDoc(normalizeDoc(doc));
        pushHistory(); refresh();
      });
      add(`<button class="rollBtn danger" id="fxFlatten">Flatten to raster…</button>`);
      $('fxFlatten').addEventListener('click',flattenSelToRaster);
      add(`<div class="fxHint">Flattening is destructive and opt-in: it bakes the
        object and its whole stack into a pixel layer, and the vector data is gone
        (undo still gets it back).</div>`);
    }
  }

  if(page==='Boolean'){
    const B=obj;
    const res=boolResult(B);
    if(!(window.BooleanEngine&&BooleanEngine.available())){
      add(`<div class="fxWarn">The boolean engine is still loading, or this browser
        blocked the module. The operands are shown unmodified until it is ready.</div>`);
    }
    add(`<label class="slider">Operation<select id="blOp">
      <option value="union">Union</option>
      <option value="subtract">Subtract (bottom minus the rest)</option>
      <option value="intersect">Intersect</option>
      <option value="exclude">Exclude</option>
    </select></label>`);
    $('blOp').value=B.boolOp;
    $('blOp').addEventListener('change',e=>{ B.boolOp=e.target.value; delete B.__sig; pushHistory(); refresh(); });
    add(`<label class="slider">Fill rule<select id="blRule">
      <option value="nonzero">Non-zero</option><option value="evenodd">Even-odd</option>
    </select></label>`);
    $('blRule').value=B.fillRule;
    $('blRule').addEventListener('change',e=>{ B.fillRule=e.target.value; delete B.__sig; pushHistory(); refresh(); });
    add(`<div class="fxHint">${(B.children||[]).length} operands ·
      ${res?res.length+' resulting contour'+(res.length===1?'':'s'):'no result yet'}.
      The operands stay editable — enter the object (double-click) to move one and the
      result follows. Curves are flattened to polylines by the clipper, so a boolean of
      two circles comes back as a fine-grained polygon, not arcs.</div>`);
    add(`<div class="gsBtns">
      <button class="rollBtn" id="blFlat">Flatten to path</button>
      <button class="rollBtn" id="blRel">Release operands</button></div>`);
    $('blFlat').addEventListener('click',()=>{ setSelIds(new Set([B.id])); flattenBoolean(); });
    $('blRel').addEventListener('click',()=>{ setSelIds(new Set([B.id])); releaseBoolean(); });
  }

  if(page==='Instance'){
    const def=(doc.frame.components||[]).find(d=>d.id===obj.compId);
    if(!def){ add(`<div class="fxWarn">This instance points at a definition that no longer exists, so it renders as nothing. Delete it, or recreate the component.</div>`); }
    else{
      add(`<div class="fxHint"><b>${def.name}</b> — ${def.kind}.
        ${def.kind==='symbol'
          ? 'A symbol shows exactly what its source shows; edit the source to change every instance.'
          : 'Overrides below apply to this instance only.'}</div>`);
      if(def.kind==='component'&&def.variants.length){
        add(`<label class="slider">${def.variantKey}<select id="inVar">
          <option value="">Default</option>`+
          def.variants.map(v=>`<option value="${v.name}">${v.name}</option>`).join('')+
          `</select></label>`);
        $('inVar').value=obj.variant||'';
        $('inVar').addEventListener('change',e=>{ obj.variant=e.target.value; delete obj.__sig;
          pushHistory('Variant'); refresh(); });
      }
      if(def.kind==='component'){
        // §6.7 per-instance overrides, addressed by name path
        const tree=instanceTree(obj);
        const rows=[];
        (function walk(o,trail){
          const t=trail.concat(o.name||o.type);
          if(o.type==='text'||o.fills||o.strokes) rows.push({key:t.join('/'),o});
          (o.children||[]).forEach(k=>walk(k,t));
        })(def.root,[]);
        add(`<div class="pSect">Overrides</div>`);
        rows.slice(0,12).forEach((r,ri)=>{
          const ov=obj.overrides[r.key]||{};
          add(`<div class="pSect" style="border:0;margin:6px 0 2px;opacity:.7">${r.key}</div>`);
          if(r.o.type==='text'){
            add(`<label class="slider">Text <input type="text" id="ovT${ri}" value="${(ov.text!==undefined?ov.text:r.o.text)||''}"></label>`);
            $('ovT'+ri).addEventListener('input',e=>{
              obj.overrides[r.key]={...obj.overrides[r.key],text:e.target.value};
              delete obj.__sig; render(); });
            $('ovT'+ri).addEventListener('change',()=>pushHistory('Override text'));
          }
          const base=r.o.type==='text'?r.o.color:((r.o.fills&&r.o.fills[0]&&r.o.fills[0].color)||'#cccccc');
          add(`<div class="row2">
            <label class="slider">Colour <input type="color" id="ovC${ri}" value="${ov.color||base}"></label>
            <label class="chk"><input type="checkbox" id="ovH${ri}" ${ov.hidden?'checked':''}> Hide</label>
          </div>`);
          $('ovC'+ri).addEventListener('input',e=>{
            obj.overrides[r.key]={...obj.overrides[r.key],color:e.target.value};
            delete obj.__sig; render(); });
          $('ovC'+ri).addEventListener('change',()=>pushHistory('Override colour'));
          $('ovH'+ri).addEventListener('change',e=>{
            obj.overrides[r.key]={...obj.overrides[r.key],hidden:e.target.checked};
            delete obj.__sig; pushHistory('Override visibility'); refresh(); });
        });
      }
      add(`<div class="gsBtns">
        <button class="rollBtn" id="inReset">Reset overrides</button>
        <button class="rollBtn" id="inDetach">Detach</button></div>`);
      $('inReset').addEventListener('click',resetInstances);
      $('inDetach').addEventListener('click',detachInstances);
      add(`<button class="rollBtn" id="inUpd">Update source from selection…</button>`);
      $('inUpd').addEventListener('click',()=>{
        alert('Select the object you want to become the new source, then use Edit ▸ Update component.');
      });
    }
  }

  if(page==='Layout'){
    const L=obj.layout;
    add(`<label class="slider">Direction<select id="lyMode">
      <option value="none">None</option>
      <option value="horizontal">Horizontal</option>
      <option value="vertical">Vertical</option></select></label>`);
    $('lyMode').value=L.mode;
    $('lyMode').addEventListener('change',e=>{ L.mode=e.target.value; pushHistory('Layout'); refresh(); });
    if(L.mode!=='none'){
      const sl=(id,label,min,max,get,set)=>{
        add(`<label class="slider">${label} <span id="${id}V">${Math.round(get())}</span>
          <input type="range" id="${id}" min="${min}" max="${max}" value="${get()}"></label>`);
        $(id).addEventListener('input',e=>{ set(+e.target.value); $(id+'V').textContent=e.target.value; render(); });
        $(id).addEventListener('change',()=>pushHistory('Layout'));
      };
      sl('lyGap','Gap',0,200,()=>L.gap,v=>L.gap=v);
      add(`<div class="pSect">Padding</div>`);
      sl('lyPT','Top',0,200,()=>L.padding.t,v=>L.padding.t=v);
      sl('lyPR','Right',0,200,()=>L.padding.r,v=>L.padding.r=v);
      sl('lyPB','Bottom',0,200,()=>L.padding.b,v=>L.padding.b=v);
      sl('lyPL','Left',0,200,()=>L.padding.l,v=>L.padding.l=v);
      add(`<div class="row2">
        <label class="slider">Align<select id="lyAlign">
          <option value="start">Start</option><option value="center">Center</option>
          <option value="end">End</option><option value="stretch">Stretch</option></select></label>
        <label class="slider">Justify<select id="lyJust">
          <option value="start">Start</option><option value="center">Center</option>
          <option value="end">End</option><option value="between">Space between</option></select></label>
      </div>`);
      $('lyAlign').value=L.align; $('lyJust').value=L.justify;
      $('lyAlign').addEventListener('change',e=>{ L.align=e.target.value; pushHistory('Layout'); render(); });
      $('lyJust').addEventListener('change',e=>{ L.justify=e.target.value; pushHistory('Layout'); render(); });
      add(`<label class="chk"><input type="checkbox" id="lyHug" ${L.hug?'checked':''}> Hug contents</label>`);
      $('lyHug').addEventListener('change',e=>{ L.hug=e.target.checked; pushHistory('Layout'); render(); });
      add(`<div class="fxHint">Children with sizing "fill" share the leftover space.
        Mark a child absolute in its own panel to take it out of the stack.</div>`);
    }
  }

  if(page==='Group'||page==='Frame'){
    add(`<div class="fxHint">${(obj.children||[]).length} child object${(obj.children||[]).length===1?'':'s'}.
      Double-click on canvas (or in the layer tree) to go inside; Esc leaves.
      ⌘G groups a selection, ⇧⌘G ungroups, ⌥⌘F wraps it in a frame.</div>`);
    add(`<button class="rollBtn" id="grEnter">Enter container</button>`);
    $('grEnter').addEventListener('click',()=>enterContainer(obj.id));
    if(obj.type==='frame'){
      add(`<label class="chk"><input type="checkbox" id="frClip" ${obj.clip!==false?'checked':''}> Clip contents</label>`);
      $('frClip').addEventListener('change',e=>{ obj.clip=e.target.checked; pushHistory(); refresh(); });
      add(`<label class="slider">Corner radius <span id="frRadV">${obj.radius||0}</span>
        <input type="range" id="frRad" min="0" max="200" value="${obj.radius||0}"></label>`);
      $('frRad').addEventListener('input',e=>{ obj.radius=+e.target.value; $('frRadV').textContent=e.target.value; render(); });
      $('frRad').addEventListener('change',()=>pushHistory());
    }
    add(`<button class="rollBtn danger" id="grUn">Ungroup</button>`);
    $('grUn').addEventListener('click',()=>{ setSelIds(new Set([obj.id])); ungroupSel(); });
  }

  if(page==='Mask'){
    add(`<div class="fxHint">The container's TOP child becomes the mask for
      everything below it inside the container.</div>`);
    add(`<label class="slider">Mask type<select id="mkMode">
      <option value="none">None</option>
      <option value="clip">Clipping mask (vector shape)</option>
      <option value="alpha">Alpha mask (mask opacity)</option>
      <option value="luminance">Luminance mask (mask brightness)</option>
    </select></label>`);
    $('mkMode').value=obj.maskMode||'none';
    $('mkMode').addEventListener('change',e=>{ obj.maskMode=e.target.value; pushHistory(); refresh(); });
    if(obj.maskMode&&obj.maskMode!=='none'){
      add(`<label class="chk"><input type="checkbox" id="mkOn" ${obj.maskOn!==false?'checked':''}> Mask enabled</label>`);
      $('mkOn').addEventListener('change',e=>{ obj.maskOn=e.target.checked; pushHistory(); refresh(); });
      add(`<label class="chk"><input type="checkbox" id="mkInv" ${obj.maskInvert?'checked':''}> Invert mask</label>`);
      $('mkInv').addEventListener('change',e=>{ obj.maskInvert=e.target.checked; pushHistory(); refresh(); });
      add(`<div class="fxHint">Disabling keeps the mask object in place, so nothing is lost.
        Clip uses the shape's coverage; alpha and luminance read the mask's rendered pixels,
        so gradients and effects in the mask carry through.</div>`);
    }
  }

  const PIXEL_PANELS={
    Blur:['blur',[
      ['sel','kind','Type',[['gaussian','Gaussian'],['directional','Directional'],['zoom','Zoom']]],
      ['num','radius','Radius',0,200,1],
      ['when','kind','directional',[['num','angle','Angle',-180,180,1],['num','distance','Distance',0,400,1]]],
      ['when','kind','zoom',[['num','amount','Amount',0,1,0.01],
        ['num','cx','Centre X',-0.5,0.5,0.01],['num','cy','Centre Y',-0.5,0.5,0.01]]],
    ],'Gaussian and directional use the compositor\'s own blur; zoom accumulates scaled copies, which a CSS filter cannot express.'],
    Distortion:['distortion',[
      ['sel','mode','Mode',[['wave','Wave'],['twirl','Twirl'],['bulge','Bulge / pinch'],['ripple','Ripple']]],
      ['num','amount','Amount',-200,200,1],
      ['num','wavelength','Wavelength',0.01,2,0.01],
      ['num','phase','Phase',-360,360,1],
      ['num','radius','Radius',0.05,2,0.01],
      ['num','cx','Centre X',-0.5,0.5,0.01],['num','cy','Centre Y',-0.5,0.5,0.01],
      ['sel','axis','Axis',[['both','Both'],['x','X only'],['y','Y only']]],
      ['sel','edge','Edges',[['clamp','Clamp'],['wrap','Wrap'],['mirror','Mirror']]],
    ],'Bulge and pinch are the same control: positive bulges, negative pinches.'],
    Warp:['warp',[
      ['sel','envelope','Envelope',[['arc','Arc'],['arch','Arch'],['bulge','Bulge'],
        ['flag','Flag'],['wave','Wave'],['fisheye','Fisheye']]],
      ['num','strength','Strength',-100,100,1],
      ['sel','axis','Axis',[['horizontal','Horizontal'],['vertical','Vertical']]],
      ['sel','edge','Edges',[['clamp','Clamp'],['wrap','Wrap'],['mirror','Mirror']]],
    ],'The whole rendered object bends — its material, stripes and grain together.'],
    Displacement:['displacement',[
      ['num','scaleX','X scale',-300,300,1],
      ['num','scaleY','Y scale',-300,300,1],
      ['sel','channel','Channel',[['luminance','Luminance'],['red','Red'],['green','Green'],
        ['blue','Blue'],['alpha','Alpha']]],
      ['num','mapScale','Map scale',0.05,10,0.05],
      ['num','seed','Seed',1,9999,1],
      ['sel','edge','Edges',[['clamp','Clamp'],['wrap','Wrap'],['mirror','Mirror']]],
    ],'With no source map chosen the displacement is driven by procedural fBm noise, so it is usable on its own.'],
    Haze:['haze',[
      ['num','density','Density',0,1,0.01],
      ['num','octaves','Octaves',1,8,1],
      ['num','lacunarity','Lacunarity',1.1,4,0.05],
      ['num','gain','Gain',0.1,0.9,0.01],
      ['num','scale','Scale',0.02,2,0.01],
      ['num','falloff','Falloff',0.1,4,0.05],
      ['col','color','Tint'],
      ['num','seed','Seed',1,9999,1],
    ],'Fractal Brownian motion, accumulated toward the interior so it reads as volume rather than a flat overlay.'],
    Slice:['slice',[
      ['num','count','Slices',2,200,1],
      ['num','offset','Offset',-400,400,1],
      ['num','gap','Gap',0,200,1],
      ['sel','axis','Axis',[['horizontal','Horizontal'],['vertical','Vertical']]],
      ['sel','mode','Pattern',[['ramp','Ramped'],['random','Random']]],
      ['num','seed','Seed',1,9999,1],
    ],'Gaps are real holes, not stretched neighbours.'],
    Noise:['noise',[
      ['num','amount','Amount',0,1,0.01],
      ['num','scale','Grain size',1,32,1],
      ['chk','mono','Monochrome'],
      ['num','seed','Seed',1,9999,1],
    ],'Seeded, so a document looks identical on reload.'],
  };
  if(PIXEL_PANELS[page]){
    const [key,rows,hint]=PIXEL_PANELS[page];
    const E2=obj.effects[key];
    const put=(r)=>{
      const [kind,k,label,a,b2,st]=r;
      const id='px_'+k;
      if(kind==='num'){
        const fmt=v=>(st<1?(+v).toFixed(2):String(Math.round(v)));
        add(`<label class="slider">${label} <span id="${id}V">${fmt(E2[k])}</span>
          <input type="range" id="${id}" min="${a}" max="${b2}" step="${st}" value="${E2[k]}"></label>`);
        $(id).addEventListener('input',e=>{ E2[k]=+e.target.value; $(id+'V').textContent=fmt(+e.target.value);
          fxDraft=true; render(); fxDraft=false; });
        $(id).addEventListener('change',()=>{ pushHistory(); render(); });
      }else if(kind==='sel'){
        add(`<label class="slider">${label}<select id="${id}">`+
          a.map(([v,n])=>`<option value="${v}">${n}</option>`).join('')+`</select></label>`);
        $(id).value=E2[k];
        $(id).addEventListener('change',e=>{ E2[k]=e.target.value; pushHistory(); refresh(); });
      }else if(kind==='col'){
        add(`<label class="slider">${label} <input type="color" id="${id}" value="${E2[k]}"></label>`);
        $(id).addEventListener('input',e=>{ E2[k]=e.target.value; render(); });
        $(id).addEventListener('change',()=>pushHistory());
      }else if(kind==='chk'){
        add(`<label class="chk"><input type="checkbox" id="${id}" ${E2[k]?'checked':''}> ${label}</label>`);
        $(id).addEventListener('change',e=>{ E2[k]=e.target.checked; pushHistory(); render(); });
      }else if(kind==='when'){
        if(E2[k]===label) a.forEach(put);   // label holds the value to match
      }
    };
    rows.forEach(r=>{
      if(r[0]==='when'){ if(E2[r[1]]===r[2]) r[3].forEach(put); }
      else put(r);
    });
    add(`<div class="fxHint">${hint}</div>`);
  }

  if(page==='Inner Shadow'||page==='Glow'){
    const isGlow=page==='Glow';
    const E2=isGlow?obj.effects.glow:obj.effects.innerShadow;
    add(`<label class="slider"><input type="checkbox" id="fxOn" ${E2.on?'checked':''}> Enable ${page.toLowerCase()}</label>`);
    $('fxOn').addEventListener('change',e=>{ E2.on=e.target.checked; pushHistory(); refresh(); });
    if(E2.on){
      const sl=(id,label,min,max,step,k,fmt)=>{
        add(`<label class="slider">${label} <span id="${id}V">${fmt(E2[k])}</span>
          <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${E2[k]}"></label>`);
        $(id).addEventListener('input',e=>{ E2[k]=+e.target.value; $(id+'V').textContent=fmt(+e.target.value); render(); });
        $(id).addEventListener('change',()=>pushHistory());
      };
      const int=v=>String(Math.round(v)), pct=v=>Math.round(v*100)+'%', f2=v=>(+v).toFixed(2);
      if(isGlow){
        add(`<label class="slider">Type<select id="glType">
          <option value="outer">Outer</option><option value="inner">Inner</option></select></label>`);
        $('glType').value=E2.type;
        $('glType').addEventListener('change',e=>{ E2.type=e.target.value; pushHistory(); render(); });
        sl('glR','Radius',0,200,1,'radius',int);
        sl('glS','Spread',0,100,1,'spread',int);
        sl('glF','Falloff',0.2,4,0.1,'falloff',f2);
      }else{
        sl('isX','Offset X',-100,100,1,'x',int);
        sl('isY','Offset Y',-100,100,1,'y',int);
        sl('isB','Blur',0,150,1,'blur',int);
        sl('isS','Spread',0,100,1,'spread',int);
      }
      sl(isGlow?'glA':'isA','Opacity',0,1,0.01,'alpha',pct);
      add(`<label class="slider">Color <input type="color" id="fxCol" value="${E2.color}"></label>`);
      $('fxCol').addEventListener('input',e=>{ E2.color=e.target.value; render(); });
      $('fxCol').addEventListener('change',()=>pushHistory());
      add(`<label class="slider">Blend<select id="fxBlend">`+
        BLEND_MODES.map(m=>`<option value="${m}">${m}</option>`).join('')+`</select></label>`);
      $('fxBlend').value=E2.blend;
      $('fxBlend').addEventListener('change',e=>{ E2.blend=e.target.value; pushHistory(); render(); });
      add(`<div class="fxHint">${isGlow
        ? 'Outer glow lays under the object; inner glow is clipped inside it. Falloff concentrates the core.'
        : 'Cast inward from every edge by shadowing the inverse region through a clip.'}</div>`);
    }
  }

  if(page==='Prism'){
    const R=obj.effects.prism, PE=window.PrismEngine;
    if(!(PE&&PE.available())){
      add(`<div class="fxHint">Needs WebGL2 with float render targets, which this browser doesn't provide.</div>`);
    } else {
      add(`<label class="slider"><input type="checkbox" id="prOn" ${R.on?'checked':''}> Enable prism</label>`);
      $('prOn').addEventListener('change',e=>{
        R.on=e.target.checked;
        // First enable adopts a solid that matches what was drawn: an ellipse
        // becomes a sphere (or a pill if it is elongated), a rect stays a box.
        if(R.on&&!R.seeded){
          if(obj.type==='ellipse') R.shape=Math.abs(obj.w-obj.h)<Math.min(obj.w,obj.h)*0.25?2:7;
          R.seeded=true;
        }
        pushHistory(); refresh();
      });
      if(R.on){
        // The prism ADDS light. On a white page it adds white to white and the
        // result is an apparently empty canvas, which reads as a broken effect
        // rather than a wrong background — so say so, and offer the fix.
        const bg=(doc&&doc.frame.bg)||'#ffffff';
        const m=/^#([0-9a-f]{6})$/i.exec(bg);
        const lum=m?(()=>{const n=parseInt(m[1],16);
          return (0.2126*((n>>16)&255)+0.7152*((n>>8)&255)+0.0722*(n&255))/255;})():1;
        if(lum>0.45){
          add(`<div class="fxWarn">This page background is light. The prism adds
            light, so on a pale page there is nothing to see — the fan is there
            but it is white on white.
            <button class="rollBtn" id="prDark">Make the page dark</button></div>`);
          $('prDark').addEventListener('click',()=>{
            doc.frame.bg='#0b0c0e'; pushHistory(); refresh();
          });
        }
        // Slider drags render a draft; the change event that ends the drag
        // renders at full quality. Without this a single pointer move would
        // trigger a full multi-sample accumulation.
        const sl=(id,label,min,max,step,key,fmt)=>{
          add(`<label class="slider">${label} <span id="${id}V">${fmt(R[key])}</span>
            <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${R[key]}"></label>`);
          $(id).addEventListener('input',e=>{
            R[key]=+e.target.value; $(id+'V').textContent=fmt(+e.target.value);
            fxDraft=true; render(); fxDraft=false;
          });
          $(id).addEventListener('change',()=>{ pushHistory(); render(); });
        };
        const col=(id,label,key)=>{
          add(`<label class="slider">${label} <input type="color" id="${id}" value="${R[key]}"></label>`);
          $(id).addEventListener('input',e=>{ R[key]=e.target.value; fxDraft=true; render(); fxDraft=false; });
          $(id).addEventListener('change',()=>{ pushHistory(); render(); });
        };
        const f2=v=>(+v).toFixed(2), f3=v=>(+v).toFixed(3);
        const deg=v=>Math.round(v)+'°', int=v=>String(Math.round(v)), pct=v=>Math.round(v*100)+'%';

        add(`<div class="gsBtns">`+
          PE.PRESETS.map((p,i)=>`<button class="rollBtn" data-pp="${i}">${p.name}</button>`).join('')+
          `</div>`);
        body.querySelectorAll('[data-pp]').forEach(b=>b.addEventListener('click',()=>{
          Object.assign(R, PE.PRESETS[+b.dataset.pp].v);
          pushHistory(); refresh();
        }));

        add(`<div class="pSect">Solid</div>`);
        add(`<label class="slider">Shape<select id="prShape">`+
          PE.SHAPES.map(s=>`<option value="${s.id}">${s.label}</option>`).join('')+`</select></label>`);
        $('prShape').value=String(R.shape);
        $('prShape').addEventListener('change',e=>{ R.shape=+e.target.value; pushHistory(); render(); });
        sl('prThick','Thickness',0.01,3,0.005,'thickness',f2);
        sl('prCorner','Bevel',0,0.5,0.005,'corner',f2);
        sl('prWedge','Wedge',0,60,0.5,'wedge',deg);
        sl('prYaw','Yaw',-180,180,1,'yaw',deg);
        sl('prPitch','Pitch',-180,180,1,'pitch',deg);
        sl('prRoll','Roll',-180,180,1,'roll',deg);
        sl('prIor','Index of refraction',1,2.4,0.001,'ior',f3);
        sl('prDisp','Dispersion',0,0.6,0.001,'dispersion',f3);
        sl('prBody','Body opacity',0,1,0.005,'body',pct);

        add(`<div class="pSect">Beam</div>`);
        sl('prAz','Azimuth',-180,180,0.5,'azimuth',deg);
        sl('prEl','Elevation',-89,89,0.5,'elevation',deg);
        sl('prInt','Intensity',0,8,0.01,'intensity',f2);
        sl('prW','Width',0.005,2,0.005,'width',f3);
        sl('prSoft','Edge softness',0.5,6,0.05,'softness',f2);
        sl('prDist','Start distance',1,60,0.5,'distance',f2);
        sl('prAimX','Aim X',-4,4,0.01,'aimX',f2);
        sl('prAimY','Aim Y',-4,4,0.01,'aimY',f2);
        sl('prFall','Falloff',0,1,0.001,'falloff',f3);
        sl('prIn','Incoming gain',0,3,0.01,'inGain',f2);
        sl('prOut','Exit gain',0,4,0.01,'outGain',f2);

        add(`<div class="pSect">Spectrum</div>`);
        sl('prBend','Exit bend',-180,180,0.5,'bend',deg);
        sl('prFan','Fan spread',0,60,0.25,'fan',deg);
        sl('prBands','Bands',0,24,1,'bands',v=>+v===0?'continuous':int(v));
        sl('prFanRoll','Fan roll',-180,180,1,'fanRoll',deg);
        add(`<label class="slider">Spectrum<select id="prSpec">
          <option value="0">Physical</option><option value="1">Two colour</option></select></label>`);
        $('prSpec').value=String(R.spectrum);
        $('prSpec').addEventListener('change',e=>{ R.spectrum=+e.target.value; pushHistory(); refresh(); });
        if(R.spectrum===1){ col('prCA','Colour A','colorA'); col('prCB','Colour B','colorB'); }
        col('prBeam','Beam colour','beamColor');

        add(`<div class="pSect">Medium</div>`);
        sl('prAir','Air scatter',0,1,0.002,'airScatter',f3);
        sl('prFrost','Glass scatter',0,8,0.01,'glassScatter',f2);
        sl('prSat','Saturation',0,1.6,0.01,'saturation',f2);
        sl('prRim','Edge rim',0,2,0.01,'rim',f2);
        sl('prReach','Reach',0.3,4,0.05,'reach',f2);

        add(`<div class="pSect">Output</div>`);
        add(`<label class="slider">Blend<select id="prBlend">
          <option value="add">Add (glows over the page)</option>
          <option value="normal">Normal (carries its own alpha)</option></select></label>`);
        $('prBlend').value=R.blend;
        $('prBlend').addEventListener('change',e=>{ R.blend=e.target.value; pushHistory(); render(); });
        sl('prExpo','Exposure',0.1,4,0.005,'exposure',f2);
        sl('prShoulder','Shoulder',0,1,0.005,'shoulder',f2);
        sl('prGrain','Grain',0,0.1,0.001,'grain',f3);
        sl('prLens','Lens (FOV)',5,70,0.5,'fov',deg);
        sl('prQual','Quality (samples)',1,256,1,'quality',int);
        sl('prSteps','March steps',8,192,4,'steps',int);
        sl('prScale','Render scale',0.15,1,0.05,'scale',pct);
        add(`<div class="fxHint">A collimated beam traced forward through the solid — entry refraction, the walk inside, exit refraction — with the exit fan dispersed per wavelength. Ported from the Glass Prism app.<br><br>Unlike the other engines this one accumulates samples, so Quality costs real time; dragging a slider shows a draft. It renders across the whole page rather than clipped to the shape, because the fan has to leave the solid, and it ignores Pattern copies. Designed for a dark background.</div>`);
      }
    }
  }

  if(page==='Capsule'||page==='Strip'){
    const isCap=page==='Capsule';
    const E=isCap?obj.effects.capsule:obj.effects.strip;
    if(!(window.CapsuleEngine&&window.CapsuleEngine.available())){
      add(`<div class="fxHint">Needs WebGL2 with float render targets, which this browser doesn't provide.</div>`);
    } else {
      add(`<label class="slider"><input type="checkbox" id="cpOn" ${E.on?'checked':''}> Enable ${isCap?'capsule glass':'fluted glass'}</label>`);
      $('cpOn').addEventListener('change',e=>{ E.on=e.target.checked; pushHistory(); refresh(); });
      if(E.on){
        const sl=(id,label,min,max,step,key,fmt)=>{
          add(`<label class="slider">${label} <span id="${id}V">${fmt(E[key])}</span>
            <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${E[key]}"></label>`);
          $(id).addEventListener('input',e=>{
            E[key]=+e.target.value; $(id+'V').textContent=fmt(+e.target.value);
            fxDraft=true; render(); fxDraft=false;
          });
          $(id).addEventListener('change',()=>{ pushHistory(); render(); });
        };
        const col=(id,label,key)=>{
          add(`<label class="slider">${label} <input type="color" id="${id}" value="${E[key]}"></label>`);
          $(id).addEventListener('input',e=>{ E[key]=e.target.value; fxDraft=true; render(); fxDraft=false; });
          $(id).addEventListener('change',()=>{ pushHistory(); render(); });
        };
        const f2=v=>(+v).toFixed(2), f3=v=>(+v).toFixed(3);
        const deg=v=>Math.round(v)+'°', int=v=>String(Math.round(v)), pct=v=>Math.round(v)+'%';
        if(isCap){
          add(`<div class="pSect">Inner lens</div>`);
          sl('cpLens','Lens size',0.1,1.2,0.005,'lensSize',f2);
          sl('cpSquash','Lens squash',0.5,1.6,0.005,'lensSquash',f2);
          sl('cpShift','Lens position',-0.5,0.5,0.005,'lensShift',f2);
          sl('cpRough','Roughness',0,0.6,0.005,'roughness',f2);
          sl('cpIIor','Lens IOR',1,2.2,0.005,'lensIor',f3);
          sl('cpIAbs','Lens absorb',0,8,0.05,'lensAbsorb',f2);
          col('cpITint','Lens tint','lensTint');
          add(`<div class="pSect">Outer glass</div>`);
          sl('cpIor','IOR',1,2,0.005,'ior',f3);
          sl('cpDisp','Dispersion',0,0.06,0.0005,'dispersion',f3);
          sl('cpAbs','Absorb',0,3,0.01,'absorb',f2);
          col('cpTint','Absorb tint','tint');
          sl('cpRefl','Reflection',0,100,1,'reflection',pct);
          add(`<div class="pSect">Scene</div>`);
          sl('cpDepth','Page depth',1.1,30,0.1,'depth',f2);
          add(`<div class="pSect">Output</div>`);
          sl('cpQual','Quality (samples)',1,128,1,'quality',int);
          sl('cpScale','Render scale',0.15,1,0.05,'scale',v=>Math.round(v*100)+'%');
          add(`<div class="fxHint">A path-traced glass pill with a lens floating inside it, refracting the page behind — the lens inverts and magnifies what it sees. Page depth sets how far behind the page reads as, which drives the inversion. Works best over colourful content, ignores Pattern copies, and (like Prism) dragging a slider shows a draft.</div>`);
        } else {
          sl('stBulge','Rib bulge',0,1,0.005,'bulge',f2);
          sl('stW','Rib width',0.02,0.5,0.005,'ribWidth',f2);
          sl('stAng','Rib angle',-90,90,1,'angle',deg);
          sl('stThick','Panel thickness',0.01,0.4,0.005,'thickness',f2);
          sl('stIor','IOR',1,2.2,0.005,'ior',f3);
          sl('stDisp','Dispersion',0,0.15,0.001,'dispersion',f3);
          sl('stSlope','Slope limit',0.2,20,0.1,'slopeLimit',f2);
          sl('stSmear','Smear distance',0.1,6,0.05,'smear',f2);
          add(`<div class="fxHint">Fluted/reeded glass: half-cylinder ribs smear whatever is behind the shape into vertical bands and split edges into colour. Smear distance is how far behind the page reads as — more distance, stronger banding. Put it over colourful layers.</div>`);
        }
      }
    }
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
        const n=blobGroup().length;
        const asGlass=!!groupGlassParams();
        add(n<2
          ? `<div class="fxHint" style="color:#b45309">Merging <b>1</b> shape — nothing to blend with yet, so Smoothness has no effect. Give this shape a <b>Pattern</b> with a negative gap, or enable ${isG2?'Glass 2':'Blob'} on another shape so the two merge.</div>`
          : `<div class="fxHint">Merging <b>${n}</b> shapes — every shape with Blob or Glass 2 on, plus their pattern copies. Rendering as <b>${asGlass?'liquid glass':'fill'}</b>${asGlass&&!isG2?' (a member has Glass 2 on)':''}.</div>`);
        add(`<label class="slider">Smoothness <span id="bbSmV">${B.smoothness}px</span>
          <input type="range" id="bbSm" min="0" max="300" value="${B.smoothness}"></label>`);
        $('bbSm').addEventListener('input',e=>{
          applyToGroup('shared',p=>p.smoothness=+e.target.value);
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
          applyToGroup('shared',p=>p.mode=e.target.value); pushHistory(); refresh();
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
  const obj=primary();
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
    const obj=primary(); if(!obj)return;
    const v=parseFloat(e.target.value); if(isNaN(v))return;
    if(obj.type==='text'&&(k==='w'||k==='h'))return;
    if(k==='x'||k==='y'){
      // translate (a line carries both endpoints); a multi-selection moves
      // as a set by the delta
      const dv=v-obj[k];
      const os=selIds.size>1?selObjs():[obj];
      os.forEach(o=>{ if(!o.locked) translateObj(o,k==='x'?dv:0,k==='y'?dv:0); });
    }else if(obj.type==='line'){ return; }
    else obj[k]=v;
    render();
  });
  $(id).addEventListener('change',()=>pushHistory());
});
$('pOpacity').addEventListener('input',e=>{
  const obj=primary(); if(!obj)return;
  obj.opacity=+e.target.value/100; $('pOpacityV').textContent=e.target.value+'%'; render();
});
$('pOpacity').addEventListener('change',()=>pushHistory());
document.querySelectorAll('#alignRow button').forEach(btn=>{
  btn.addEventListener('click',()=>{
    const os=selObjs().filter(o=>!o.locked); if(!os.length)return;
    const f=doc.frame;
    /* §2.8: what to align RELATIVE TO. With one object selected the artboard
     * is the only sensible frame; with several, the selection's own bounds is
     * the expected behaviour, and the PRIMARY object acts as the key object
     * when alignTo is set to it. */
    let R;
    if(alignTo==='artboard'||os.length===1) R={x:0,y:0,w:f.w,h:f.h};
    else if(alignTo==='key'){ const k=primary(); R=k?aabbOf(k):selBounds(); }
    else R=selBounds();
    os.forEach(obj=>{
      const b=aabbOf(obj);
      let dx=0, dy=0;
      switch(btn.dataset.align){
        case 'left': dx=R.x-b.x; break;
        case 'hcenter': dx=R.x+(R.w-b.w)/2-b.x; break;
        case 'right': dx=R.x+R.w-b.w-b.x; break;
        case 'top': dy=R.y-b.y; break;
        case 'vcenter': dy=R.y+(R.h-b.h)/2-b.y; break;
        case 'bottom': dy=R.y+R.h-b.h-b.y; break;
      }
      translateObj(obj,dx,dy);
    });
    pushHistory(); refresh();
  });
});

/* ---- Transform section (§2.2–2.5 numeric) ---- */
$('trRot').addEventListener('change',e=>{
  const os=selObjs().filter(o=>!o.locked&&o.type!=='line'); if(!os.length)return;
  const v=((+e.target.value||0)%360+360)%360;
  os.forEach(o=>o.rot=v);
  pushHistory(); refresh();
});
[['trSkX','skewX'],['trSkY','skewY']].forEach(([id,k])=>{
  $(id).addEventListener('change',e=>{
    const os=selObjs().filter(o=>!o.locked&&o.type!=='line'); if(!os.length)return;
    const v=clamp(+e.target.value||0,-75,75);
    os.forEach(o=>o[k]=v);
    pushHistory(); refresh();
  });
});
[['cH','h'],['cV','v']].forEach(([id,k])=>{
  $(id).addEventListener('change',e=>{
    selObjs().filter(o=>!o.locked).forEach(o=>o.constraints[k]=e.target.value);
    pushHistory('Constraints'); refresh();
  });
});
$('cSize').addEventListener('change',e=>{
  selObjs().filter(o=>!o.locked).forEach(o=>o.sizing=e.target.value);
  pushHistory('Sizing'); refresh();
});
$('cAbs').addEventListener('change',e=>{
  selObjs().filter(o=>!o.locked).forEach(o=>o.absolute=e.target.checked);
  pushHistory('Absolute'); refresh();
});
/* ---- §6.7/§6.8 instance panel ---------------------------------------- */
$('instVariant').addEventListener('change',e=>{
  selObjs().filter(o=>o.type==='instance').forEach(o=>{ o.variant=e.target.value; delete o.__sig; });
  pushHistory('Variant'); refresh();
});
$('instReset').addEventListener('click',()=>resetInstances());
$('instDetach').addEventListener('click',()=>detachInstances());
$('instUpdate').addEventListener('click',()=>pushInstanceToSource());
$('instSelectDef').addEventListener('click',()=>{
  // The definition is not an object on the canvas, so "go to source" selects
  // the first instance that has no overrides — the one that shows the source
  // as authored. Falling back to a message beats silently doing nothing.
  const inst=primary(); if(!inst||inst.type!=='instance') return;
  const clean=allObjects().find(o=>o.type==='instance'&&o.compId===inst.compId&&
    !Object.keys(o.overrides||{}).length&&!o.variant);
  if(clean){ setSelIds(new Set([clean.id])); refresh(); }
  else status('Every instance has overrides — reset one to see the source as authored.');
});
/* ---- §6.12 layout panel ---------------------------------------------- */
function eachFrame(fn,label){
  const fs=selObjs().filter(o=>o.type==='frame'&&!o.locked);
  if(!fs.length) return;
  fs.forEach(f=>{ f.layout=f.layout||{mode:'none',gap:0,padding:{t:0,r:0,b:0,l:0},
    align:'start',justify:'start',hug:false}; fn(f); });
  pushHistory(label); refresh();
}
$('lyMode').addEventListener('change',e=>eachFrame(f=>f.layout.mode=e.target.value,'Stack layout'));
$('lyGap').addEventListener('input',e=>eachFrame(f=>f.layout.gap=Math.max(0,+e.target.value||0),'Gap'));
$('lyHug').addEventListener('change',e=>eachFrame(f=>f.layout.hug=e.target.checked,'Hug contents'));
[['lyPT','t'],['lyPR','r'],['lyPB','b'],['lyPL','l']].forEach(([id,k])=>{
  $(id).addEventListener('input',e=>eachFrame(f=>{
    f.layout.padding=f.layout.padding||{t:0,r:0,b:0,l:0};
    f.layout.padding[k]=Math.max(0,+e.target.value||0);
  },'Padding'));
});
$('lyAlign').addEventListener('change',e=>eachFrame(f=>f.layout.align=e.target.value,'Align'));
$('lyJustify').addEventListener('change',e=>eachFrame(f=>f.layout.justify=e.target.value,'Distribute'));
$('objBlend').addEventListener('change',e=>{
  const os=selObjs().filter(o=>!o.locked); if(!os.length)return;
  os.forEach(o=>o.blend=e.target.value);
  pushHistory(); refresh();
});
$('trR90L').addEventListener('click',()=>rotateSel(-90));
$('trR90R').addEventListener('click',()=>rotateSel(90));
$('trFlipH').addEventListener('click',()=>flipSel('h'));
$('trFlipV').addEventListener('click',()=>flipSel('v'));
$('trScale').addEventListener('change',e=>{
  // §2.3 percentage scale about each object's centre
  const pct=parseFloat(e.target.value);
  if(!Number.isFinite(pct)||pct<=0){ e.target.value=''; return; }
  const f=clamp(pct,1,1000)/100;
  const os=selObjs().filter(o=>!o.locked); if(!os.length)return;
  os.forEach(o=>{
    const b=boxOf(o), cx=b.x+b.w/2, cy=b.y+b.h/2;
    if(o.type==='text'&&o.mode!=='area'){ o.size=clamp(Math.round(o.size*f),8,300); return; }
    if(o.type==='line'){
      o.x=cx+(o.x-cx)*f; o.y=cy+(o.y-cy)*f; o.x2=cx+(o.x2-cx)*f; o.y2=cy+(o.y2-cy)*f;
      return;
    }
    if(o.type==='path'){
      (o.subpaths||[]).forEach(sp=>sp.points.forEach(q=>{
        q.x=cx+(q.x-cx)*f; q.y=cy+(q.y-cy)*f;
        q.ox*=f; q.oy*=f; q.ix*=f; q.iy*=f; }));
      return;
    }
    o.w=Math.max(4,Math.round(o.w*f)); o.h=Math.max(4,Math.round(o.h*f));
    o.x=Math.round(cx-o.w/2); o.y=Math.round(cy-o.h/2);
  });
  e.target.value='';
  pushHistory(); refresh();
});

/* ---- §2.10 snapping glue ---------------------------------------------
 * The index is rebuilt at the START of a drag (not per move) from everything
 * EXCEPT what is being dragged — an object must never snap to itself. */
let snapIndex=null;
function buildSnapIndex(excludeIds){
  if(!doc||!window.SnapEngine){ snapIndex=null; return; }
  const others=[];
  allObjects().forEach(o=>{
    if(o.hidden||excludeIds.has(o.id)) return;
    if(CONTAINER(o)&&o.children&&o.children.some(k=>excludeIds.has(k.id))) return;
    const b=aabbOf(o);
    const anchors=[];
    if(o.type==='path') (o.subpaths||[]).forEach(sp=>sp.points.forEach(p=>anchors.push({x:p.x,y:p.y})));
    else if(o.type==='line'){ anchors.push({x:o.x,y:o.y},{x:o.x2,y:o.y2}); }
    others.push({obj:o,box:b,anchors});
  });
  snapIndex=SnapEngine.buildIndex({
    frame:doc.frame, guides:doc.frame.guides, grid:doc.frame.grid,
    others, settings:snapCfg,
  });
}
/** Apply snapping to a proposed box position. Returns {dx,dy}. */
function applySnap(box,suppressed){
  snapLines=[];
  if(!snapCfg.on||suppressed||!snapIndex||!window.SnapEngine) return {dx:0,dy:0};
  const tol=snapCfg.radius/view.z;      // screen px -> page units
  const r=SnapEngine.snapBox(snapIndex,box,tol);
  snapLines=r.lines;
  return {dx:r.dx,dy:r.dy};
}
function applySnapPoint(x,y,suppressed){
  snapLines=[];
  if(!snapCfg.on||suppressed||!snapIndex||!window.SnapEngine) return {dx:0,dy:0};
  const r=SnapEngine.snapPoint(snapIndex,x,y,snapCfg.radius/view.z);
  snapLines=r.lines;
  return {dx:r.dx,dy:r.dy};
}
/** §2.11 equal-spacing indicators for the current selection against peers. */
function computeGapHints(){
  gapHints=[];
  if(!snapCfg.on||!window.SnapEngine||!doc) return;
  const sel=selObjs(); if(!sel.length) return;
  const ref=selBounds();
  const peers=activeList().filter(o=>!o.hidden).map(o=>aabbOf(o));
  if(peers.length<3) return;
  ['h','v'].forEach(ax=>{
    SnapEngine.equalGaps(peers,ax,1.2/view.z,ref).forEach(g=>gapHints.push({axis:ax,...g}));
  });
}

/* ================= canvas interaction ================= */
/* §2.6: the eight handle positions of an object's (possibly rotated) frame,
 * in PAGE coords. ix encodes position: 0-3 corners TL,TR,BR,BL; 4-7 edges
 * T,R,B,L. Point text gets corners only (edge resize is meaningless). */
function handlePts(o){
  const b=boxOf(o), cx=b.x+b.w/2, cy=b.y+b.h/2;
  const r=(o.rot||0)*Math.PI/180, cs=Math.cos(r), sn=Math.sin(r);
  const P=(X,Y)=>({x:cx+(X-cx)*cs-(Y-cy)*sn, y:cy+(X-cx)*sn+(Y-cy)*cs});
  const pts=[
    {...P(b.x,b.y),ix:0},{...P(b.x+b.w,b.y),ix:1},
    {...P(b.x+b.w,b.y+b.h),ix:2},{...P(b.x,b.y+b.h),ix:3},
    {...P(cx,b.y),ix:4},{...P(b.x+b.w,cy),ix:5},
    {...P(cx,b.y+b.h),ix:6},{...P(b.x,cy),ix:7},
  ];
  return (o.type==='text'&&o.mode!=='area')?pts.slice(0,4):pts;
}
/** What a pointer at page p grabs on the primary object: a resize handle, a
 *  rotation zone just outside a corner, or nothing. */
function handleAt(o,p){
  const grip=9/view.z;
  const pts=handlePts(o);
  for(const h of pts) if(Math.hypot(p.x-h.x,p.y-h.y)<grip) return {kind:'resize',ix:h.ix};
  for(const h of pts.slice(0,4)){
    const d=Math.hypot(p.x-h.x,p.y-h.y);
    if(d>=grip&&d<26/view.z) return {kind:'rotate'};
  }
  return null;
}
function evtScreen(e){
  const r=canvas.getBoundingClientRect();
  return {x:e.clientX-r.left, y:e.clientY-r.top};
}
function evtPage(e){
  const s=evtScreen(e);
  return {x:(s.x-view.x)/view.z, y:(s.y-view.y)/view.z};
}
/* Deepest selectable object under a point, honouring isolation: at the top
 * level a click selects the outermost container; inside an entered container
 * it selects that container's own children. */
function hitObj(px,py){
  const L=activeList();
  for(let i=L.length-1;i>=0;i--){
    const o=L[i];
    if(!selectable(o)) continue;
    if(CONTAINER(o)){
      if(hitInside(o,px,py)) return o;
      continue;
    }
    if(hitLeaf(o,px,py)) return o;
  }
  return null;
}
function hitBoolean(o,px,py){
  const res=boolResult(o);
  if(!res||!res.length) return false;
  const proxy={type:'path',subpaths:res,fillRule:o.fillRule,fillOn:true,
    strokes:o.strokes,stroke:o.strokes&&o.strokes[0]};
  return pathHit(proxy,px,py,Math.max(6/view.z,4));
}
function hitInside(cont,px,py){
  if(cont.type==='boolean') return hitBoolean(cont,px,py);
  if(cont.type==='frame'){
    const b=boxOf(cont);
    if(cont.clip!==false&&!(px>=b.x&&px<=b.x+b.w&&py>=b.y&&py<=b.y+b.h)) return false;
  }
  let found=false;
  walkAll(cont.children,o=>{ if(!found&&!CONTAINER(o)&&selectable(o)&&hitLeaf(o,px,py)) found=true; });
  return found;
}
function hitLeaf(o,px,py){
  const lp=toLocal(o,px,py);
  if(o.type==='line'){
    const tol=Math.max(6/view.z,(o.stroke?o.stroke.width:4)/2+3);
    return distToSegment(px,py,o.x,o.y,o.x2,o.y2)<=tol;
  }
  if(o.type==='path') return pathHit(o,lp.x,lp.y,Math.max(6/view.z,4));
  const b=boxOf(o);
  return lp.x>=b.x&&lp.x<=b.x+b.w&&lp.y>=b.y&&lp.y<=b.y+b.h;
}
function hit(px,py){
  const o=hitObj(px,py);
  return o?activeList().indexOf(o):-1;
}
function hitOld(px,py){
  const ch=doc.frame.children;
  for(let i=ch.length-1;i>=0;i--){
    const o=ch[i];
    if(!selectable(o)) continue;   // §1.1: lock/hide suppress selectability
    if(o.type==='line'){
      // a thin diagonal line must not claim its whole bounding box
      const tol=Math.max(6/view.z,(o.stroke?o.stroke.width:4)/2+3);
      if(distToSegment(px,py,o.x,o.y,o.x2,o.y2)<=tol) return i;
      continue;
    }
    const lp=toLocal(o,px,py);
    if(o.type==='path'){
      if(pathHit(o,lp.x,lp.y,Math.max(6/view.z,4))) return i;
      continue;
    }
    const b=boxOf(o);
    if(lp.x>=b.x&&lp.x<=b.x+b.w&&lp.y>=b.y&&lp.y<=b.y+b.h) return i;
  }
  return -1;
}
/** Every selectable object under the point, topmost first — the alt-click
 *  depth cycle walks this stack. */
function hitAll(px,py){
  const out=[], L=activeList();
  for(let i=L.length-1;i>=0;i--){
    const o=L[i];
    if(!selectable(o)) continue;
    if(CONTAINER(o)?hitInside(o,px,py):hitLeaf(o,px,py)) out.push(i);
  }
  return out;
}
/** Topmost derived instance under the point, or null. Parents win over
 *  instances, so clicking the source never selects a copy. */
function hitInstance(px,py){
  const list=allInstances();
  for(let i=list.length-1;i>=0;i--){
    const o=list[i];
    const par=doc.frame.children.find(c=>c.id===o.parentId);
    if(par&&!selectable(par)) continue;   // instances follow the parent's lock/hide
    const b=boxOf(o);
    if(px>=b.x&&px<=b.x+b.w&&py>=b.y&&py<=b.y+b.h) return o;
  }
  return null;
}
/** Objects inside the current marquee. Touch mode by default; `contain`
 *  requires the whole object inside. */
function marqueeIds(contain){
  const x0=Math.min(marquee.x0,marquee.x1), y0=Math.min(marquee.y0,marquee.y1);
  const x1=Math.max(marquee.x0,marquee.x1), y1=Math.max(marquee.y0,marquee.y1);
  const ids=new Set();
  activeList().forEach(o=>{
    if(!selectable(o)) return;
    const b=aabbOf(o);
    const ok=contain
      ? (b.x>=x0&&b.y>=y0&&b.x+b.w<=x1&&b.y+b.h<=y1)
      : (b.x<x1&&b.x+b.w>x0&&b.y<y1&&b.y+b.h>y0);
    if(ok) ids.add(o.id);
  });
  return ids;
}

/* ---- viewport ops (§1.12–1.13) ---- */
let spaceDown=false;
function zoomAt(sx,sy,factor){          // zoom anchored at a screen point
  const z=clamp(view.z*factor,0.02,64);
  view.x=sx-(sx-view.x)*(z/view.z);
  view.y=sy-(sy-view.y)*(z/view.z);
  view.z=z; view.mode='free';
  paint();
}
function zoomTo(z){                      // absolute zoom about the stage centre
  const stage=$('stage');
  zoomAt(stage.clientWidth/2, stage.clientHeight/2, z/view.z);
}
function zoomToSelection(){
  const b=selBounds();
  if(!b){ view.mode='fit'; paint(); return; }
  const stage=$('stage'), pad=60;
  const z=clamp(Math.min((stage.clientWidth-2*pad)/b.w,(stage.clientHeight-2*pad)/b.h),0.02,8);
  view.z=z; view.mode='free';
  view.x=stage.clientWidth/2-(b.x+b.w/2)*z;
  view.y=stage.clientHeight/2-(b.y+b.h/2)*z;
  paint();
}
canvas.addEventListener('wheel',e=>{
  if(!doc) return;
  e.preventDefault();
  const s=evtScreen(e);
  if(e.ctrlKey||e.metaKey){
    // macOS pinch arrives as ctrl+wheel; cmd+scroll zooms deliberately too
    zoomAt(s.x,s.y,Math.exp(-e.deltaY*0.01));
  }else{
    // plain two-finger scroll pans; momentum comes from the native events
    view.x-=e.deltaX; view.y-=e.deltaY; view.mode='free';
    paint();
  }
},{passive:false});
$('zoomInput').addEventListener('change',e=>{
  const pct=parseFloat(e.target.value);
  if(Number.isFinite(pct)&&pct>0) zoomTo(clamp(pct,2,6400)/100);
  e.target.blur();
});
$('zoomInput').addEventListener('keydown',e=>{ if(e.key==='Enter') e.target.blur(); });
// re-fit (or just re-blit) when the window changes size — never re-render the doc
new ResizeObserver(()=>paint()).observe($('stage'));

/* ---- pointer state machine ---- */
let drag=null;
canvas.addEventListener('pointerdown',e=>{
  if(!doc){
    // no page yet: a shape tool means the user wants to start — open the
    // New Page flow rather than silently inventing a canvas
    if(tool!=='select'&&tool!=='zoom') openPageModal();
    return;
  }
  const s=evtScreen(e), p=evtPage(e);
  const cap=()=>{ try{canvas.setPointerCapture(e.pointerId);}catch(_){} };
  /* §2.11 / §0 constraint 2: guides are created by DRAGGING OUT OF A RULER.
   * There is deliberately no tap-to-create path — pressing a ruler and
   * releasing without moving creates nothing. */
  if(showRulers&&(s.x<RULER||s.y<RULER)&&e.button===0&&!spaceDown){
    const axis=s.x<RULER?'v':'h';       // left ruler emits vertical guides
    doc.frame.guides.push({axis,pos:axis==='v'?p.x:p.y,locked:false});
    guideDrag={index:doc.frame.guides.length-1,created:true,moved:false};
    drag={mode:'guide'};
    cap(); paint(); return;
  }
  // grab an existing guide near the pointer
  if(!spaceDown&&e.button===0&&doc.frame.guides.length){
    const tol=5/view.z;
    for(let i=doc.frame.guides.length-1;i>=0;i--){
      const g=doc.frame.guides[i];
      if(g.locked) continue;
      if(Math.abs((g.axis==='v'?p.x:p.y)-g.pos)<=tol){
        guideDrag={index:i,created:false,moved:false};
        drag={mode:'guide'};
        cap(); paint(); return;
      }
    }
  }
  // §1.12: space-hold or middle-mouse pans regardless of the active tool
  if(spaceDown||e.button===1){
    drag={mode:'pan',sx:s.x,sy:s.y,vx:view.x,vy:view.y};
    canvas.style.cursor='grabbing'; cap(); return;
  }
  if(e.button!==0) return;
  if(tool==='zoom'){
    drag={mode:'zoomRect',x0:p.x,y0:p.y,x1:p.x,y1:p.y,sx:s.x,sy:s.y,moved:false};
    cap(); return;
  }
  if(tool==='eyedrop'){ eyedrop(p,e); return; }
  if(tool==='pen'){
    const grip=10/view.z;
    if(!penDraft){
      // §1.3: clicking an open path's endpoint continues it
      const AL=activeList();
      for(let oi=AL.length-1;oi>=0;oi--){
        const o=AL[oi];
        if(o.type!=='path'||o.closed||!selectable(o)) continue;
        const first=o.points[0], last=o.points[o.points.length-1];
        if(Math.hypot(p.x-last.x,p.y-last.y)<grip){ penDraft={oi}; setSel(oi); refresh(); return; }
        if(Math.hypot(p.x-first.x,p.y-first.y)<grip){
          o.points.reverse();
          o.points.forEach(q=>{ const t=[q.ox,q.oy]; q.ox=q.ix; q.oy=q.iy; q.ix=t[0]; q.iy=t[1]; });
          penDraft={oi}; setSel(oi); refresh(); return;
        }
      }
      const obj=makeShape('path',p);
      obj.points=[{x:Math.round(p.x),y:Math.round(p.y),ox:0,oy:0,ix:0,iy:0,m:'corner'}];
      activeList().push(obj);
      penDraft={oi:activeList().length-1};
      setSel(penDraft.oi);
      drag={mode:'penHandle',pi:0};
      cap(); refresh(); return;
    }
    const o=penObj(), first=o.points[0];
    let nx=p.x, ny=p.y;
    if(e.shiftKey&&o.points.length){
      // §1.3: shift constrains the segment to 45° increments
      const lp=o.points[o.points.length-1];
      const a=Math.atan2(ny-lp.y,nx-lp.x), sn=Math.round(a/(Math.PI/4))*(Math.PI/4);
      const dd=Math.hypot(nx-lp.x,ny-lp.y);
      nx=lp.x+Math.cos(sn)*dd; ny=lp.y+Math.sin(sn)*dd;
    }
    if(o.points.length>=2&&Math.hypot(p.x-first.x,p.y-first.y)<grip){
      o.closed=true; penCommit(); return;      // close at the origin
    }
    o.points.push({x:Math.round(nx),y:Math.round(ny),ox:0,oy:0,ix:0,iy:0,m:'corner'});
    relinkPath(o);
    drag={mode:'penHandle',pi:o.points.length-1};
    cap(); render(); return;
  }
  if(tool==='pencil'){
    pencilRaw=[{x:p.x,y:p.y}];
    drag={mode:'pencil'};
    cap(); return;
  }
  if(tool==='crop'){
    drag={mode:'cropRect',x0:p.x,y0:p.y,moved:false};
    marquee={x0:p.x,y0:p.y,x1:p.x,y1:p.y};
    cap(); return;
  }
  if(tool==='node'){
    const o=nodeObj();
    const grip=10/view.z;
    if(o){
      // handle grips of selected anchors first
      for(const pi of nodeSel.pts){
        const a=o.points[pi];
        // A retracted handle sits ON its anchor; it must not shadow the
        // anchor itself, or corner points could never be moved.
        if((a.ox||a.oy)&&Math.hypot(p.x-(a.x+a.ox),p.y-(a.y+a.oy))<grip){ drag={mode:'nodeHandle',pi,which:'out',alt:e.altKey}; cap(); return; }
        if((a.ix||a.iy)&&Math.hypot(p.x-(a.x+a.ix),p.y-(a.y+a.iy))<grip){ drag={mode:'nodeHandle',pi,which:'in',alt:e.altKey}; cap(); return; }
      }
      // anchors
      for(let pi=0;pi<o.points.length;pi++){
        const a=o.points[pi];
        if(Math.hypot(p.x-a.x,p.y-a.y)<grip){
          if(e.shiftKey){ nodeSel.pts.has(pi)?nodeSel.pts.delete(pi):nodeSel.pts.add(pi); }
          else if(!nodeSel.pts.has(pi)) nodeSel.pts=new Set([pi]);
          drag={mode:'nodeMove',px:p.x,py:p.y,
            offs:[...nodeSel.pts].map(q=>({q,ox:o.points[q].x,oy:o.points[q].y}))};
          cap(); paint(); return;
        }
      }
      // segment drag: pull the two adjacent anchors together
      const near=nearestOnPath(o,p.x,p.y);
      if(near&&near.d<Math.max(6/view.z,(o.stroke.width/2)+3)){
        const j=(near.i+1)%o.points.length;
        drag={mode:'nodeMove',px:p.x,py:p.y,
          offs:[near.i,j].map(q=>({q,ox:o.points[q].x,oy:o.points[q].y}))};
        nodeSel.pts=new Set([near.i,j]);
        cap(); paint(); return;
      }
    }
    // pick a path to edit, or leave node mode over empty space
    const i2=hit(p.x,p.y);
    const t2=i2>=0&&doc.frame.children[i2];
    if(t2&&t2.type==='path'){ nodeSel={oi:i2,pts:new Set()}; setSel(i2); refresh(); }
    else { nodeSel=null; paint(); }
    return;
  }
  if(tool==='text'){
    drag={mode:'textDraw',x0:p.x,y0:p.y,moved:false};
    marquee={x0:p.x,y0:p.y,x1:p.x,y1:p.y};
    cap(); return;
  }
  if(tool!=='select'){
    // §1.5–1.8: drag to draw. Modifiers are applied live in pointermove —
    // shift constrains (square / circle / 45°), alt draws from the centre.
    const obj=makeShape(tool,p);
    activeList().push(obj);
    setSel(activeList().length-1); fxPage=0;
    buildSnapIndex(new Set([obj.id]));
    drag={mode:'draw',kind:tool,ox:p.x,oy:p.y,obj,moved:false};
    cap(); refresh(); return;
  }
  // §2.6: transform handles come before hit-testing — the rotate zones (and
  // corner grips at the exact boundary) sit OUTSIDE the object, where hit()
  // misses and the marquee would swallow the gesture.
  const prim0=primary();
  if(prim0&&!prim0.locked&&selIds.size===1&&prim0.type!=='line'){
    const grab=handleAt(prim0,p);
    if(grab&&grab.kind==='resize'){
      const b0=boxOf(prim0);
      buildSnapIndex(new Set([prim0.id]));
      drag={mode:'resize',ix:grab.ix,b0:{...b0},rot:prim0.rot||0,size0:prim0.size,
        pts0:prim0.type==='path'?(prim0.subpaths||[]).map(sp=>sp.points.map(q=>({...q}))):null};
      cap(); return;
    }
    if(grab&&grab.kind==='rotate'){
      const b0=boxOf(prim0);
      const cx=b0.x+b0.w/2, cy=b0.y+b0.h/2;
      drag={mode:'rotate',cx,cy,rot0:prim0.rot||0,a0:Math.atan2(p.y-cy,p.x-cx),
        copy:JSON.stringify(prim0)};
      cap(); return;
    }
  }
  // line endpoint grips take priority over a body hit on the primary line
  const prim=primary();
  if(prim&&prim.type==='line'&&selIds.size===1&&!prim.locked){
    const grip=12/view.z;
    if(Math.hypot(p.x-prim.x,p.y-prim.y)<grip){ drag={mode:'lineEnd',end:1,obj:prim}; cap(); return; }
    if(Math.hypot(p.x-prim.x2,p.y-prim.y2)<grip){ drag={mode:'lineEnd',end:2,obj:prim}; cap(); return; }
  }
  const i=hit(p.x,p.y);
  selInstance = i>=0 ? null : hitInstance(p.x,p.y);
  if(i<0){
    // empty space: marquee. Plain drag replaces the selection, shift adds.
    if(!selInstance){
      marquee={x0:p.x,y0:p.y,x1:p.x,y1:p.y};
      drag={mode:'marquee',additive:e.shiftKey,prev:new Set(selIds)};
      if(!e.shiftKey) setSel(-1);
      cap();
    }else{
      setSel(-1);
    }
    fxPage=0; refresh(); return;
  }
  // hit() indexes the ACTIVE list (the entered container, or the page), so the
  // id must come from the same list — reading the page's top level here
  // resolved to the wrong object inside a group and left stale selections.
  const id=activeList()[i].id;
  if(e.shiftKey){
    // §1.1: shift-click toggles membership; no drag starts from a shift-click
    if(selIds.has(id)&&selIds.size>1) selIds.delete(id);
    else selIds.add(id);
    setSelIds(selIds,id);
    fxPage=0; refresh(); return;
  }
  if(!selIds.has(id)){ setSel(i); fxPage=0; }
  else { sel=i; }   // member of a multi-selection: promote to primary, keep the set
  buildSnapIndex(new Set(selObjs().map(o=>o.id)));
  drag={mode:'move',moved:false,clickI:i,px:p.x,py:p.y,
    b0:selBounds(),
    offs:selObjs().map(o=>({o,ox:o.x,oy:o.y,ox2:o.x2,oy2:o.y2})),
    // §2.1 alt-drag duplicates: the copies move, the originals stay
    dup:e.altKey};
  cap(); refresh();
});
canvas.addEventListener('pointermove',e=>{
  lastPointer=evtScreen(e);
  if(drag&&drag.mode==='guide'){
    const p2=evtPage(e), g=doc.frame.guides[guideDrag.index];
    guideDrag.moved=true;
    let v=g.axis==='v'?p2.x:p2.y;
    if(!(e.metaKey||e.ctrlKey)&&doc.frame.grid&&doc.frame.grid.snap){
      const st=doc.frame.grid.size/Math.max(1,doc.frame.grid.subdivisions);
      if(st>0) v=Math.round(v/st)*st;
    }
    g.pos=Math.round(v);
    paint(); return;
  }
  if(!drag){
    if(tool==='pen'&&penDraft&&doc){ penHover=evtPage(e); paint(); }
    else if(showRulers&&doc&&(lastPointer.x<RULER||lastPointer.y<RULER)){
      canvas.style.cursor=lastPointer.x<RULER?'col-resize':'row-resize';
    }
    else if(tool==='select'&&doc&&selIds.size===1&&!spaceDown){
      const obj=primary();
      if(obj&&obj.type!=='line'&&!obj.locked){
        const g2=handleAt(obj,evtPage(e));
        // §2.6 cursor feedback; the diagonal pairs swap as the frame rotates
        const quad=Math.round(((obj.rot||0)%180)/45)%2===1;
        canvas.style.cursor=!g2?'default'
          :g2.kind==='rotate'?'alias'
          :g2.ix===4||g2.ix===6?(quad?'ew-resize':'ns-resize')
          :g2.ix===5||g2.ix===7?(quad?'ns-resize':'ew-resize')
          :(g2.ix===0||g2.ix===2)!==quad?'nwse-resize':'nesw-resize';
      }
    }
    return;
  }
  const s=evtScreen(e);
  if(drag.mode==='pan'){
    view.x=drag.vx+(s.x-drag.sx); view.y=drag.vy+(s.y-drag.sy); view.mode='free';
    paint(); return;
  }
  if(!doc) return;
  const p=evtPage(e);
  if(drag.mode==='zoomRect'){
    drag.x1=p.x; drag.y1=p.y;
    if(Math.abs(s.x-drag.sx)>4||Math.abs(s.y-drag.sy)>4) drag.moved=true;
    marquee=drag.moved?{x0:drag.x0,y0:drag.y0,x1:p.x,y1:p.y}:null;
    paint(); return;
  }
  if(drag.mode==='marquee'){
    marquee.x1=p.x; marquee.y1=p.y;
    const ids=marqueeIds(e.altKey);          // alt during marquee = contain mode
    if(drag.additive) drag.prev.forEach(x=>ids.add(x));
    setSelIds(ids);
    paint(); syncLayers(); return;
  }
  if(drag.mode==='penHandle'){
    const o=penObj(); if(!o){ drag=null; return; }
    const a=o.points[drag.pi];
    let dx=p.x-a.x, dy=p.y-a.y;
    if(e.shiftKey){
      const an=Math.atan2(dy,dx), sn=Math.round(an/(Math.PI/4))*(Math.PI/4);
      const dd=Math.hypot(dx,dy);
      dx=Math.cos(sn)*dd; dy=Math.sin(sn)*dd;
    }
    a.ox=Math.round(dx); a.oy=Math.round(dy);
    if(e.altKey){ a.m='free'; }                 // §1.3 alt breaks symmetry mid-draw
    else { a.ix=-a.ox; a.iy=-a.oy; a.m='smooth'; }
    render(); return;
  }
  if(drag.mode==='pencil'){
    const lp=pencilRaw[pencilRaw.length-1];
    if(Math.hypot(p.x-lp.x,p.y-lp.y)>1.2) pencilRaw.push({x:p.x,y:p.y});
    marquee=null; paint();
    // live ink preview in screen space
    const z=view.z;
    ctx.save();
    ctx.setTransform(z*(Math.min(devicePixelRatio||1,2)),0,0,z*(Math.min(devicePixelRatio||1,2)),view.x*(Math.min(devicePixelRatio||1,2)),view.y*(Math.min(devicePixelRatio||1,2)));
    ctx.strokeStyle='#111'; ctx.lineWidth=2/z; ctx.lineJoin=ctx.lineCap='round';
    ctx.beginPath();
    pencilRaw.forEach((q,i)=>i?ctx.lineTo(q.x,q.y):ctx.moveTo(q.x,q.y));
    ctx.stroke(); ctx.restore();
    return;
  }
  if(drag.mode==='cropRect'||drag.mode==='textDraw'){
    drag.moved=true;
    marquee.x1=p.x; marquee.y1=p.y;
    paint(); return;
  }
  if(drag.mode==='nodeHandle'){
    const o=nodeObj(); if(!o){ drag=null; return; }
    const a=o.points[drag.pi];
    const dx=p.x-a.x, dy=p.y-a.y;
    if(drag.alt) a.m='free';
    if(drag.which==='out'){ a.ox=dx; a.oy=dy; }
    else { a.ix=dx; a.iy=dy; }
    if(a.m==='smooth'){
      if(drag.which==='out'){ a.ix=-a.ox; a.iy=-a.oy; }
      else { a.ox=-a.ix; a.oy=-a.iy; }
    }else if(a.m==='asym'){
      // same angle, keep the other side's length (§1.2 asymmetric mode)
      const src=drag.which==='out'?[a.ox,a.oy]:[a.ix,a.iy];
      const an=Math.atan2(src[1],src[0]);
      if(drag.which==='out'){
        const L=Math.hypot(a.ix,a.iy); a.ix=Math.cos(an+Math.PI)*L; a.iy=Math.sin(an+Math.PI)*L;
      }else{
        const L=Math.hypot(a.ox,a.oy); a.ox=Math.cos(an+Math.PI)*L; a.oy=Math.sin(an+Math.PI)*L;
      }
    }
    render(); return;
  }
  if(drag.mode==='nodeMove'){
    const o=nodeObj(); if(!o){ drag=null; return; }
    let dx=p.x-drag.px, dy=p.y-drag.py;
    if(drag.offs.length===1){
      const q0=drag.offs[0];
      const sn=applySnapPoint(q0.ox+dx,q0.oy+dy,e.metaKey||e.ctrlKey);
      dx+=sn.dx; dy+=sn.dy;
    }
    drag.offs.forEach(({q,ox,oy})=>{ o.points[q].x=Math.round(ox+dx); o.points[q].y=Math.round(oy+dy); });
    render(); return;
  }
  if(drag.mode==='draw'){
    const o=drag.obj; drag.moved=true;
    if(drag.kind==='line'){
      let x2=p.x, y2=p.y;
      if(e.shiftKey){
        // §1.8: shift constrains to 45° increments
        const a=Math.atan2(y2-drag.oy,x2-drag.ox);
        const sn=Math.round(a/(Math.PI/4))*(Math.PI/4);
        const dd=Math.hypot(x2-drag.ox,y2-drag.oy);
        x2=drag.ox+Math.cos(sn)*dd; y2=drag.oy+Math.sin(sn)*dd;
      }
      o.x=Math.round(drag.ox); o.y=Math.round(drag.oy);
      o.x2=Math.round(x2); o.y2=Math.round(y2);
    }else{
      let px2=p.x, py2=p.y;
      if(!(e.metaKey||e.ctrlKey)){
        const sn=applySnapPoint(px2,py2,false);
        px2+=sn.dx; py2+=sn.dy;
      }
      let w=px2-drag.ox, h=py2-drag.oy;
      if(e.shiftKey){
        // square / circle / regular polygon
        const m=Math.max(Math.abs(w),Math.abs(h));
        w=(w<0?-1:1)*m; h=(h<0?-1:1)*m;
      }
      if(e.altKey){
        // draw from the centre
        o.x=Math.round(drag.ox-Math.abs(w)); o.y=Math.round(drag.oy-Math.abs(h));
        o.w=Math.max(1,Math.round(Math.abs(w)*2)); o.h=Math.max(1,Math.round(Math.abs(h)*2));
      }else{
        o.x=Math.round(Math.min(drag.ox,drag.ox+w)); o.y=Math.round(Math.min(drag.oy,drag.oy+h));
        o.w=Math.max(1,Math.round(Math.abs(w))); o.h=Math.max(1,Math.round(Math.abs(h)));
      }
    }
    render(); syncInspector(); return;
  }
  if(drag.mode==='lineEnd'){
    const o=drag.obj;
    let nx=p.x, ny=p.y;
    if(e.shiftKey){
      // snap about the other endpoint
      const ax=drag.end===1?o.x2:o.x, ay=drag.end===1?o.y2:o.y;
      const a=Math.atan2(ny-ay,nx-ax);
      const sn=Math.round(a/(Math.PI/4))*(Math.PI/4);
      const dd=Math.hypot(nx-ax,ny-ay);
      nx=ax+Math.cos(sn)*dd; ny=ay+Math.sin(sn)*dd;
    }
    if(drag.end===1){ o.x=Math.round(nx); o.y=Math.round(ny); }
    else{ o.x2=Math.round(nx); o.y2=Math.round(ny); }
    render(); syncInspector(); return;
  }
  if(drag.mode==='move'){
    if(!drag.moved&&drag.dup){
      // §2.1 alt-drag duplicate: clone the selection, drag the clones
      const clones=drag.offs.map(({o})=>{
        const c2=JSON.parse(JSON.stringify(o)); c2.id=newId(); return c2;
      });
      doc.frame.children.push(...clones);
      setSelIds(new Set(clones.map(c2=>c2.id)));
      drag.offs=clones.map(o=>({o,ox:o.x,oy:o.y,ox2:o.x2,oy2:o.y2}));
      drag.clickI=doc.frame.children.length-1;
      syncLayers();
    }
    drag.moved=true;
    // Round the DELTA once, not each object: relative spacing inside a
    // multi-selection survives the move exactly. Shift constrains to the
    // dominant axis (§2.1).
    let ddx=Math.round(p.x-drag.px), ddy=Math.round(p.y-drag.py);
    if(e.shiftKey){ if(Math.abs(ddx)>Math.abs(ddy)) ddy=0; else ddx=0; }
    // §2.10: snap the selection's own bounds; the modifier suppresses it
    if(drag.b0){
      const prop={x:drag.b0.x+ddx, y:drag.b0.y+ddy, w:drag.b0.w, h:drag.b0.h};
      const sn=applySnap(prop, e.metaKey||e.ctrlKey||e.altKey);
      ddx+=Math.round(sn.dx); ddy+=Math.round(sn.dy);
      if(e.shiftKey){ if(Math.abs(ddx)>Math.abs(ddy)) ddy=0; else ddx=0; }
    }
    drag.offs.forEach(({o,ox,oy,ox2,oy2})=>{
      if(o.locked) return;
      o.x=ox+ddx; o.y=oy+ddy;
      if(o.type==='line'){ o.x2=ox2+ddx; o.y2=oy2+ddy; }
    });
    render(); syncInspector(); return;
  }
  if(drag.mode==='rotate'){
    const obj=primary(); if(!obj) return;
    let deg=drag.rot0+(Math.atan2(p.y-drag.cy,p.x-drag.cx)-drag.a0)*180/Math.PI;
    if(e.shiftKey) deg=Math.round(deg/15)*15;      // §2.2 shift = 15° steps
    obj.rot=((Math.round(deg*10)/10)%360+360)%360;
    const sc=evtScreen(e);
    drag.readout={text:Math.round(obj.rot)+'°',sx:sc.x,sy:sc.y};
    render(); syncInspector(); return;
  }
  if(drag.mode==='resize'){
    const obj=primary(); if(!obj) return;
    const b0=drag.b0, r=drag.rot*Math.PI/180;
    const c0={x:b0.x+b0.w/2, y:b0.y+b0.h/2};
    // pointer into the unrotated frame of the ORIGINAL box
    let pxr=p.x, pyr=p.y;
    if(!drag.rot){                    // axis-aligned only: snap the grabbed edge
      const sn2=applySnapPoint(pxr,pyr,e.metaKey||e.ctrlKey);
      pxr+=sn2.dx; pyr+=sn2.dy;
    }
    const cs=Math.cos(-r), sn=Math.sin(-r);
    const lp={x:c0.x+(pxr-c0.x)*cs-(pyr-c0.y)*sn,
              y:c0.y+(pxr-c0.x)*sn+(pyr-c0.y)*cs};
    // fixed point: the opposite corner/edge (or the centre with alt)
    const FIX=[[b0.x+b0.w,b0.y+b0.h],[b0.x,b0.y+b0.h],[b0.x,b0.y],[b0.x+b0.w,b0.y],
               [c0.x,b0.y+b0.h],[b0.x,c0.y],[c0.x,b0.y],[b0.x+b0.w,c0.y]][drag.ix];
    const corner=drag.ix<4, alt=e.altKey;
    let w1=b0.w, h1=b0.h;
    const fx=alt?c0.x:FIX[0], fy=alt?c0.y:FIX[1], k=alt?2:1;
    if(corner||drag.ix===5||drag.ix===7) w1=Math.max(4,Math.abs(lp.x-fx)*k);
    if(corner||drag.ix===4||drag.ix===6) h1=Math.max(4,Math.abs(lp.y-fy)*k);
    if(e.shiftKey&&corner){                        // §2.3 aspect lock
      const sc2=Math.max(w1/b0.w,h1/b0.h);
      w1=b0.w*sc2; h1=b0.h*sc2;
    }
    // new centre in the local frame keeps the fixed point fixed
    let cl;
    if(alt) cl={x:c0.x,y:c0.y};
    else{
      const sxd=Math.sign(c0.x-fx)||1, syd=Math.sign(c0.y-fy)||1;
      cl={x:(corner||drag.ix===5||drag.ix===7)?fx+sxd*w1/2:c0.x,
          y:(corner||drag.ix===4||drag.ix===6)?fy+syd*h1/2:c0.y};
    }
    // rotate the new centre back to page space about the original centre
    const cs2=Math.cos(r), sn2=Math.sin(r);
    const c1={x:c0.x+(cl.x-c0.x)*cs2-(cl.y-c0.y)*sn2,
              y:c0.y+(cl.x-c0.x)*sn2+(cl.y-c0.y)*cs2};
    if(obj.type==='frame'&&window.Components){
      // §6.11: children react to the frame's new size per their own pinning
      const prev={x:b0.x,y:b0.y,w:b0.w,h:b0.h};
      obj.x=Math.round(c1.x-w1/2); obj.y=Math.round(c1.y-h1/2);
      obj.w=Math.round(w1); obj.h=Math.round(h1);
      Components.applyConstraints(obj,prev,CHELP);
      const sc4=evtScreen(e);
      drag.readout={text:Math.round(w1)+' × '+Math.round(h1),sx:sc4.x,sy:sc4.y};
      render(); syncInspector(); return;
    }
    if(obj.type==='text'&&obj.mode!=='area'){
      // point text scales its size instead of a box
      obj.size=clamp(Math.round(drag.size0*(h1/b0.h)),8,300);
      const nb=boxOf(obj);
      obj.x+= (c1.x-(nb.x+nb.w/2));
      obj.y+= (c1.y-(nb.y+nb.h/2));
    }else if(obj.type==='path'){
      // scale every anchor and handle about the original box
      const sx3=w1/b0.w, sy3=h1/b0.h;
      (obj.subpaths||[]).forEach((sp,si)=>{
        const base=drag.pts0&&drag.pts0[si]; if(!base) return;
        sp.points.forEach((q,qi)=>{
          const q0=base[qi]; if(!q0) return;
          q.x=c1.x+(q0.x-c0.x)*sx3; q.y=c1.y+(q0.y-c0.y)*sy3;
          q.ox=q0.ox*sx3; q.oy=q0.oy*sy3; q.ix=q0.ix*sx3; q.iy=q0.iy*sy3;
        });
      });
    }else{
      obj.w=Math.round(w1); obj.h=Math.round(h1);
      obj.x=Math.round(c1.x-w1/2); obj.y=Math.round(c1.y-h1/2);
    }
    const sc3=evtScreen(e);
    drag.readout={text:Math.round(w1)+' × '+Math.round(h1),sx:sc3.x,sy:sc3.y};
    render(); syncInspector(); return;
  }
});
const endDrag=e=>{
  if(!drag) return;
  const d=drag; drag=null;
  snapLines=[]; snapIndex=null;
  try{canvas.releasePointerCapture(e.pointerId);}catch(_){}
  if(d.mode==='guide'){
    const g=doc.frame.guides[guideDrag.index];
    const s2=evtScreen(e);
    // released back over a ruler, or never moved after being created:
    // discard it rather than leaving a stray guide at the edge
    const overRuler=showRulers&&(s2.x<RULER||s2.y<RULER);
    if((guideDrag.created&&!guideDrag.moved)||overRuler)
      doc.frame.guides.splice(guideDrag.index,1);
    guideDrag=null;
    pushHistory(); refresh(); return;
  }
  if(d.mode==='pan'){ canvas.style.cursor=spaceDown?'grab':cursorForTool(); return; }
  if(d.mode==='zoomRect'){
    marquee=null;
    if(d.moved){
      // §1.13 marquee zoom: frame the dragged region
      const stage=$('stage');
      const w=Math.abs(d.x1-d.x0), h=Math.abs(d.y1-d.y0);
      if(w>2&&h>2){
        const z=clamp(Math.min(stage.clientWidth/w,stage.clientHeight/h)*0.9,0.02,64);
        view.z=z; view.mode='free';
        view.x=stage.clientWidth/2-(Math.min(d.x0,d.x1)+w/2)*z;
        view.y=stage.clientHeight/2-(Math.min(d.y0,d.y1)+h/2)*z;
      }
      paint();
    }else{
      const s=evtScreen(e);
      zoomAt(s.x,s.y,e.altKey?0.5:2);       // click in, alt-click out
    }
    return;
  }
  if(d.mode==='penHandle'){ render(); return; }   // anchor handled; history at commit
  if(d.mode==='nodeHandle'||d.mode==='nodeMove'){ pushHistory(); refresh(); return; }
  if(d.mode==='pencil'){
    const raw=pencilRaw; pencilRaw=null;
    if(!raw||raw.length<3){ paint(); return; }
    const obj=makeShape('path',raw[0]);
    obj.points=fitStroke(raw);
    obj.subpaths[0].points=obj.points;
    obj.name='Pencil';
    // §1.4 auto-close when the stroke ends near its start
    const f0=obj.points[0], fl=obj.points[obj.points.length-1];
    if(Math.hypot(f0.x-fl.x,f0.y-fl.y)<12/view.z){ obj.points.pop(); obj.closed=true; }
    obj.subpaths[0].closed=obj.closed;
    activeList().push(obj);
    setSel(activeList().length-1);
    pushHistory(); refresh(); return;
  }
  if(d.mode==='textDraw'){
    marquee=null;
    const p2=evtPage(e);
    const w=Math.abs(p2.x-d.x0), h=Math.abs(p2.y-d.y0);
    const obj=makeShape('text',{x:Math.min(d.x0,p2.x),y:Math.min(d.y0,p2.y)});
    if(d.moved&&w>30&&h>20){
      // §1.9 area text: the dragged box is the frame
      obj.mode='area'; obj.w=Math.round(w); obj.h=Math.round(h);
      obj.autosize='fixed';
    }
    activeList().push(obj);
    setSel(activeList().length-1); fxPage=0;
    setTool('select');
    pushHistory(); refresh(); return;
  }
  if(d.mode==='cropRect'){
    marquee=null;
    if(d.moved){
      const p2=evtPage(e);
      cropPage(Math.min(d.x0,p2.x),Math.min(d.y0,p2.y),Math.abs(p2.x-d.x0),Math.abs(p2.y-d.y0));
    }
    setTool('select');
    return;
  }
  if(d.mode==='draw'){
    if(!d.moved||Math.max(boxOf(d.obj).w,boxOf(d.obj).h)<4) applyDefaultSize(d.obj,{x:d.ox,y:d.oy});
    setTool('select');
    pushHistory(); refresh(); return;
  }
  if(d.mode==='lineEnd'){ pushHistory(); refresh(); return; }
  if(d.mode==='marquee'){ marquee=null; paint(); syncLayers(); syncInspector(); return; }
  if(d.mode==='rotate'){
    // §2.2 rotate-and-copy: alt on release leaves the original behind
    if(e.altKey&&d.copy){
      const orig=JSON.parse(d.copy); orig.id=newId();
      const cur=primary();
      const L=listOf(cur), idx=L.indexOf(cur);
      L.splice(idx,0,orig);
      setSelIds(new Set([cur.id]));
    }
    pushHistory(); refresh(); return;
  }
  if(d.mode==='resize'){ pushHistory(); refresh(); return; }
  if(d.mode==='move'&&!d.moved){
    if(d.dup){
      // §1.1 alt-CLICK (no drag) cycles depth through overlapping objects
      const p2=evtPage(e);
      const stack=hitAll(p2.x,p2.y);
      if(stack.length>1){
        const cur=stack.indexOf(sel);
        setSel(stack[(cur+1)%stack.length]);
        fxPage=0; refresh(); return;
      }
    }
    // a plain click on a member of a multi-selection collapses to it
    if(selIds.size>1){ setSel(d.clickI); refresh(); }
    return;                                  // nothing changed: no history entry
  }
  pushHistory();
};
canvas.addEventListener('pointerup',endDrag);
canvas.addEventListener('pointercancel',endDrag);

/* ---- §1.3 pen ---- */
let penDraft=null;    // {oi} index of the path being authored
let penHover=null;    // page point for the rubber-band preview
function penObj(){ return penDraft?activeList()[penDraft.oi]:null; }
/** Keep the `points`/`closed` aliases pointing at subpath 0 after any edit
 *  that replaced the array wholesale. */
function relinkPath(o){
  if(!o||o.type!=='path') return;
  if(!o.subpaths||!o.subpaths.length) o.subpaths=[{points:o.points,closed:!!o.closed}];
  o.subpaths[0].points=o.points;
  o.subpaths[0].closed=o.closed;
}
function penCommit(){
  const o=penObj();
  relinkPath(o);
  penDraft=null; penHover=null;
  if(o&&o.points.length<2){ const L=listOf(o); L.splice(L.indexOf(o),1); setSel(-1); }
  pushHistory(); refresh();
}
/* ---- §1.4 pencil ---- */
let pencilOpts={tolerance:2.5, smoothing:3};
let pencilRaw=null;
function fitStroke(raw){
  // stabilizer: moving average, strength = window size
  const w=Math.max(1,Math.round(pencilOpts.smoothing));
  const sm=raw.map((p,i)=>{
    let x=0,y=0,n=0;
    for(let j=Math.max(0,i-w);j<=Math.min(raw.length-1,i+w);j++){ x+=raw[j].x; y+=raw[j].y; n++; }
    return {x:x/n,y:y/n};
  });
  // Ramer–Douglas–Peucker simplification at the fitting tolerance
  const keep=new Array(sm.length).fill(false);
  keep[0]=keep[sm.length-1]=true;
  const rdp=(a,b)=>{
    let mi=-1,md=0;
    for(let i=a+1;i<b;i++){
      const d=distToSegment(sm[i].x,sm[i].y,sm[a].x,sm[a].y,sm[b].x,sm[b].y);
      if(d>md){ md=d; mi=i; }
    }
    if(md>pencilOpts.tolerance){ keep[mi]=true; rdp(a,mi); rdp(mi,b); }
  };
  if(sm.length>2) rdp(0,sm.length-1);
  const pts=sm.filter((_,i)=>keep[i]);
  // Catmull-Rom tangents -> cubic handles, all smooth anchors
  return pts.map((p,i)=>{
    const prev=pts[Math.max(0,i-1)], next=pts[Math.min(pts.length-1,i+1)];
    const tx=(next.x-prev.x)/6, ty=(next.y-prev.y)/6;
    return {x:Math.round(p.x),y:Math.round(p.y),
      ox:Math.round(tx),oy:Math.round(ty),ix:Math.round(-tx),iy:Math.round(-ty),m:'smooth'};
  });
}
/* ---- §1.2 node editing ---- */
let nodeSel=null;     // {oi, pts:Set<anchorIndex>}
function nodeObj(){ return nodeSel?activeList()[nodeSel.oi]:null; }
/** Split the segment AFTER anchor i at parameter t, preserving the curve
 *  exactly (de Casteljau). */
function splitSegment(o,i,t){
  const P=o.points, a=P[i], b=P[(i+1)%P.length];
  const p0=[a.x,a.y], p1=[a.x+a.ox,a.y+a.oy], p2=[b.x+b.ix,b.y+b.iy], p3=[b.x,b.y];
  const lerp=(u,v)=>[u[0]+(v[0]-u[0])*t, u[1]+(v[1]-u[1])*t];
  const q0=lerp(p0,p1), q1=lerp(p1,p2), q2=lerp(p2,p3);
  const r0=lerp(q0,q1), r1=lerp(q1,q2);
  const sp=lerp(r0,r1);
  a.ox=q0[0]-a.x; a.oy=q0[1]-a.y;
  b.ix=q2[0]-b.x; b.iy=q2[1]-b.y;
  P.splice(i+1,0,{x:sp[0],y:sp[1],
    ix:r0[0]-sp[0],iy:r0[1]-sp[1], ox:r1[0]-sp[0],oy:r1[1]-sp[1], m:'asym'});
}
/** Nearest (segment index, t, distance) on a path to a page point. */
function nearestOnPath(o,px,py){
  const P=o.points, nSeg=o.closed?P.length:P.length-1;
  let best=null;
  for(let i=0;i<nSeg;i++){
    const a=P[i], b=P[(i+1)%P.length];
    for(let k=0;k<=24;k++){
      const t=k/24, u=1-t;
      const X=u*u*u*a.x+3*u*u*t*(a.x+a.ox)+3*u*t*t*(b.x+b.ix)+t*t*t*b.x;
      const Y=u*u*u*a.y+3*u*u*t*(a.y+a.oy)+3*u*t*t*(b.y+b.iy)+t*t*t*b.y;
      const d=Math.hypot(px-X,py-Y);
      if(!best||d<best.d) best={i,t,d};
    }
  }
  return best;
}

/* ---- eyedropper (§1.10) ----
 * Samples the COMPOSITED page raster, so it reads engine output and gradients,
 * not just stored fills. Plain click = 1px, shift = 3×3 average, cmd = 5×5.
 * Alt-click copies the full appearance (fill + effects) of the object under
 * the cursor onto the selection. Clicking outside the page opens the
 * platform's screen-wide picker where the browser provides one. */
function samplePage(x,y,n){
  const g=frameBuf.getContext('2d');
  const x0=clamp(Math.round(x-(n-1)/2),0,Math.max(0,frameBuf.width-n));
  const y0=clamp(Math.round(y-(n-1)/2),0,Math.max(0,frameBuf.height-n));
  const d=g.getImageData(x0,y0,n,n).data;
  let r=0,gg=0,b=0,c=0;
  for(let i=0;i<d.length;i+=4){ r+=d[i]; gg+=d[i+1]; b+=d[i+2]; c++; }
  return '#'+[r,gg,b].map(v=>Math.round(v/c).toString(16).padStart(2,'0')).join('');
}
function applySampledColor(hex,fallbackI){
  let os=selObjs();
  if(!os.length&&fallbackI>=0) os=[doc.frame.children[fallbackI]];
  if(!os.length) return;
  os.forEach(o=>{
    if(o.locked) return;
    if(o.type==='text') o.color=hex;
    else if(o.type==='line'||o.type==='path'){ o.strokes[0].kind='solid'; o.strokes[0].color=hex; }
    else { o.fills[0].kind='solid'; o.fills[0].color=hex; }
  });
  pushHistory(); refresh();
}
function eyedrop(p,e){
  const f=doc.frame;
  const inPage=p.x>=0&&p.y>=0&&p.x<f.w&&p.y<f.h;
  if(!inPage){
    // outside the page: the platform picker samples anywhere on screen
    if(window.EyeDropper) new EyeDropper().open()
      .then(r=>applySampledColor(r.sRGBHex,hit(p.x,p.y))).catch(()=>{});
    return;
  }
  const under=hit(p.x,p.y);
  if(e.altKey){
    // full appearance: fill + effects from the top object under the cursor
    const src=doc.frame.children[under]; if(!src) return;
    const os=selObjs().filter(o=>o!==src&&!o.locked);
    if(!os.length) return;
    os.forEach(o=>{
      if(src.fills&&o.fills) o.fills=JSON.parse(JSON.stringify(src.fills));
      if(src.strokes&&o.strokes) o.strokes=JSON.parse(JSON.stringify(src.strokes));
      if(o.type==='text'&&src.type==='text') o.color=src.color;
      if(src.effects&&o.effects) o.effects=JSON.parse(JSON.stringify(src.effects));
    });
    setActiveDoc(normalizeDoc(doc));   // re-clamp copied effects per target type
    pushHistory(); refresh(); return;
  }
  const n=(e.metaKey||e.ctrlKey)?5:e.shiftKey?3:1;
  applySampledColor(samplePage(p.x,p.y,n),under);
}

/* ---- §2.2/§2.4/§2.5 numeric transforms ---- */
function flipSel(axis){
  const os=selObjs().filter(o=>!o.locked); if(!os.length) return;
  os.forEach(o=>{
    const b=boxOf(o), cx=b.x+b.w/2, cy=b.y+b.h/2;
    if(o.type==='line'){
      if(axis==='h'){ o.x=2*cx-o.x; o.x2=2*cx-o.x2; }
      else { o.y=2*cy-o.y; o.y2=2*cy-o.y2; }
      return;
    }
    if(o.type==='path'){
      (o.subpaths||[]).forEach(sp=>sp.points.forEach(q=>{
        if(axis==='h'){ q.x=2*cx-q.x; q.ox=-q.ox; q.ix=-q.ix; }
        else { q.y=2*cy-q.y; q.oy=-q.oy; q.iy=-q.iy; }
      }));
      return;
    }
    if(axis==='h') o.mirrorX=!o.mirrorX; else o.mirrorY=!o.mirrorY;
  });
  pushHistory(); refresh();
}
function rotateSel(delta){
  const os=selObjs().filter(o=>!o.locked&&o.type!=='line'); if(!os.length) return;
  // §2.2 "rotate each object individually": each about its own centre
  os.forEach(o=>{ o.rot=(((o.rot||0)+delta)%360+360)%360; });
  pushHistory(); refresh();
}

/* ---- §6.7/§6.8 component + symbol commands ---- */
function makeDefinition(kind){
  const os=selObjs().filter(o=>!o.locked&&o.type!=='instance');
  if(!os.length) return;
  const L=listOf(os[0]);
  if(!os.every(o=>listOf(o)===L)) return;
  const name=prompt(`${kind==='symbol'?'Symbol':'Component'} name:`,os[0].name||'Component');
  if(name===null) return;
  // one object becomes the root directly; several are wrapped in a group
  let root;
  if(os.length===1) root=JSON.parse(JSON.stringify(os[0]));
  else{
    let x0=1e9,y0=1e9;
    os.forEach(o=>{ const b=aabbOf(o); x0=Math.min(x0,b.x); y0=Math.min(y0,b.y); });
    root={type:'group',name:name.trim()||'Component',id:newId(),x:x0,y:y0,opacity:1,
      children:os.map(o=>JSON.parse(JSON.stringify(o)))};
  }
  const def={id:newId(),name:(name.trim()||'Component'),kind,root,variantKey:'Variant',variants:[]};
  doc.frame.components.push(def);
  // the selection is REPLACED by an instance, so the thing on canvas is now
  // driven by the definition rather than being a detached copy of it
  const idxs=os.map(o=>L.indexOf(o)).sort((a,b)=>a-b);
  const b0=aabbOf(os[0]);
  let bx=1e9,by=1e9;
  os.forEach(o=>{ const b=aabbOf(o); bx=Math.min(bx,b.x); by=Math.min(by,b.y); });
  for(let i=idxs.length-1;i>=0;i--) L.splice(idxs[i],1);
  const inst={type:'instance',name:def.name,id:newId(),compId:def.id,
    x:bx,y:by,opacity:1,overrides:{},variant:''};
  L.splice(idxs[0],0,inst);
  setActiveDoc(normalizeDoc(doc));
  defsChanged();
  setSelIds(new Set([inst.id]));
  pushHistory('Create '+kind); refresh();
}
function placeInstance(defId){
  const def=(doc.frame.components||[]).find(d=>d.id===defId);
  if(!def) return;
  const b=boxOf(def.root);
  const inst={type:'instance',name:def.name,id:newId(),compId:def.id,
    x:Math.round(b.x+40),y:Math.round(b.y+40),opacity:1,overrides:{},variant:''};
  activeList().push(inst);
  setActiveDoc(normalizeDoc(doc));
  setSelIds(new Set([inst.id]));
  pushHistory('Place instance'); refresh();
}
/** §6.7 detach: bake the resolved tree into ordinary objects. */
function detachInstances(){
  const os=selObjs().filter(o=>o.type==='instance');
  if(!os.length) return;
  const made=[];
  os.forEach(o=>{
    const t=instanceTree(o);
    if(!t) return;
    const copy=JSON.parse(JSON.stringify(t));
    delete copy.__instanceOf;
    reid(copy);
    copy.name=o.name+' (detached)';
    const L=listOf(o);
    L.splice(L.indexOf(o),1,copy);
    made.push(copy.id);
  });
  if(!made.length) return;
  setActiveDoc(normalizeDoc(doc));
  setSelIds(new Set(made));
  pushHistory('Detach instance'); refresh();
}
/** §6.7 reset: throw away this instance's overrides. */
function resetInstances(){
  const os=selObjs().filter(o=>o.type==='instance');
  if(!os.length) return;
  os.forEach(o=>{ o.overrides={}; o.variant=''; delete o.__sig; });
  pushHistory('Reset instance'); refresh();
}
/** §6.7 edit the source: swap the definition's root for the current selection. */
function updateDefinitionFrom(defId){
  const def=(doc.frame.components||[]).find(d=>d.id===defId);
  const os=selObjs().filter(o=>o.type!=='instance');
  if(!def||os.length!==1) return;
  def.root=JSON.parse(JSON.stringify(os[0]));
  setActiveDoc(normalizeDoc(doc));
  defsChanged();
  pushHistory('Update component'); refresh();
}
/** §6.7 "push overrides to the source": the selected instance's RESOLVED tree
 *  becomes the definition, and its own overrides are dropped because they are
 *  now the source. Every other instance follows, except where its own override
 *  covers the same child — that override still wins, which is the point of it.
 *  A symbol has no overrides, so this is a no-op for one. */
function pushInstanceToSource(){
  const inst=primary();
  if(!inst||inst.type!=='instance') return;
  const def=(doc.frame.components||[]).find(d=>d.id===inst.compId);
  if(!def) return;
  if(def.kind==='symbol'){ status('Symbols have no overrides to push.'); return; }
  const tree=instanceTree(inst);
  if(!tree) return;
  const root=JSON.parse(JSON.stringify(tree));
  delete root.__instanceOf; delete root.__sig; delete root.__tree;
  if(inst.variant){
    const v=def.variants.find(x=>x.name===inst.variant);
    if(v) v.root=root; else def.root=root;
  }else def.root=root;
  inst.overrides={}; delete inst.__sig;
  setActiveDoc(normalizeDoc(doc));
  defsChanged();
  pushHistory('Push to source'); refresh();
}
function addVariant(defId){
  const def=(doc.frame.components||[]).find(d=>d.id===defId);
  const os=selObjs().filter(o=>o.type!=='instance');
  if(!def||os.length!==1) return;
  const n=prompt('Variant name:','Variant '+(def.variants.length+2));
  if(n===null) return;
  def.variants.push({name:n.trim()||('Variant '+(def.variants.length+2)),
    root:JSON.parse(JSON.stringify(os[0]))});
  setActiveDoc(normalizeDoc(doc));
  defsChanged();
  pushHistory('Add variant'); refresh();
}
function deleteDefinition(defId){
  const A=doc.frame.components, i=A.findIndex(d=>d.id===defId);
  if(i<0) return;
  const used=allObjects().filter(o=>o.type==='instance'&&o.compId===defId).length;
  if(used&&!confirm(`${used} instance${used===1?'':'s'} use this. Delete anyway?\nThose instances will render as nothing.`)) return;
  A.splice(i,1);
  defsChanged();
  pushHistory('Delete component'); refresh();
}

/* ---- §6.5 artboard commands ---- */
const AB_PRESETS=[['Landscape',900,600],['Square',1080,1080],['Wide',1600,900],
  ['Portrait',1080,1350],['Story',1080,1920],['A4 @96dpi',794,1123]];
function addArtboard(w,h,name){
  if(!doc) return;
  const A=doc.frame.artboards;
  // place it to the RIGHT of everything so far, with a comfortable gutter
  const right=A.reduce((m,a)=>Math.max(m,a.x+a.w),0);
  const a={id:newId(),name:name||('Artboard '+(A.length+1)),
    x:A.length?right+80:0, y:0, w:w||900, h:h||600, bg:'#ffffff', clip:true, show:true};
  A.push(a);
  growFrameToArtboards();
  selArtboard=a.id;
  pushHistory('Add artboard'); refresh();
}
function duplicateArtboard(id){
  const A=doc.frame.artboards, i=A.findIndex(a=>a.id===id);
  if(i<0) return;
  const src=A[i];
  const right=A.reduce((m,a)=>Math.max(m,a.x+a.w),0);
  const dx=right+80-src.x, dy=0;
  const copy={...src,id:newId(),name:src.name+' copy',x:src.x+dx,y:src.y+dy};
  // the artboard's CONTENT comes with it
  const kids=objectsInArtboard(src).filter(o=>listOf(o)===doc.frame.children);
  const clones=kids.map(o=>{ const c=JSON.parse(JSON.stringify(o)); reid(c);
    translateObj(c,dx,dy); return c; });
  A.splice(i+1,0,copy);
  doc.frame.children.push(...clones);
  growFrameToArtboards();
  selArtboard=copy.id;
  pushHistory('Duplicate artboard'); refresh();
}
function removeArtboard(id,withContent){
  const A=doc.frame.artboards, i=A.findIndex(a=>a.id===id);
  if(i<0||A.length<=1) return;
  const a=A[i];
  if(withContent){
    const kill=new Set(objectsInArtboard(a).map(o=>o.id));
    const prune=list=>{ for(let j=list.length-1;j>=0;j--){
      if(kill.has(list[j].id)) list.splice(j,1);
      else if(CONTAINER(list[j])) prune(list[j].children); } };
    prune(doc.frame.children);
  }
  A.splice(i,1);
  selArtboard=null;
  pushHistory('Delete artboard'); refresh();
}
function moveArtboard(id,dir){
  const A=doc.frame.artboards, i=A.findIndex(a=>a.id===id);
  const j=i+dir;
  if(i<0||j<0||j>=A.length) return;
  [A[i],A[j]]=[A[j],A[i]];
  pushHistory('Reorder artboards'); refresh();
}
/** The page canvas has to cover every artboard, or content falls off it. */
function growFrameToArtboards(){
  const f=doc.frame;
  let w=f.w, h=f.h;
  (f.artboards||[]).forEach(a=>{ w=Math.max(w,a.x+a.w); h=Math.max(h,a.y+a.h); });
  f.w=clamp(Math.ceil(w),100,8000); f.h=clamp(Math.ceil(h),100,8000);
}
/** §6.5: export one artboard on its own. */
function exportArtboard(id){
  const a=(doc.frame.artboards||[]).find(x=>x.id===id);
  if(!a) return;
  const c=document.createElement('canvas');
  c.width=Math.round(a.w); c.height=Math.round(a.h);
  const cx=c.getContext('2d');
  cx.translate(-a.x,-a.y);
  drawDoc(cx,doc.frame.w,doc.frame.h);
  c.toBlob(b=>{
    const u=URL.createObjectURL(b), el=document.createElement('a');
    el.href=u; el.download=(a.name||'artboard')+'.png'; el.click();
    setTimeout(()=>URL.revokeObjectURL(u),2000);
  },'image/png');
}
function exportAllArtboards(){
  (doc.frame.artboards||[]).forEach((a,i)=>setTimeout(()=>exportArtboard(a.id),i*350));
}

/* ---- §6.6 page commands ---- */
function duplicatePage(i){
  if(i<0||i>=pages.length) return;
  const copy=JSON.parse(JSON.stringify(pages[i]));
  copy.frame.name=(copy.frame.name||'Page')+' copy';
  // fresh ids throughout, or the two pages share identity
  const reidAll=list=>list.forEach(o=>{ o.id=newId(); if(CONTAINER(o)) reidAll(o.children||[]); });
  reidAll(copy.frame.children||[]);
  (copy.frame.artboards||[]).forEach(a=>a.id=newId());
  pages.splice(i+1,0,copy);
  setActivePage(i+1);
  pushHistory('Duplicate page'); refresh();
}
function movePage(i,dir){
  const j=i+dir;
  if(i<0||j<0||j>=pages.length) return;
  const cur=pages[pageIdx];
  [pages[i],pages[j]]=[pages[j],pages[i]];
  setActivePage(pages.indexOf(cur));
  pushHistory('Reorder pages'); refresh();
}
function renamePage(i){
  const p=pages[i]; if(!p) return;
  const n=prompt('Page name:',p.frame.name||'Page');
  if(n===null) return;
  p.frame.name=n.trim()||p.frame.name;
  pushHistory('Rename page'); refresh();
}
function deletePage(i){
  if(pages.length<=1||i<0) return;
  if(!confirm(`Delete "${pages[i].frame.name}" and everything on it?`)) return;
  pages.splice(i,1);
  setActivePage(Math.min(i,pages.length-1));
  setSel(-1);
  pushHistory('Delete page'); refresh();
}
/** §6.6 cross-page paste, styles intact — the objects are copied whole. */
let pageClip=null;
function copySel(){
  const os=selObjs();
  if(!os.length) return;
  pageClip=JSON.parse(JSON.stringify(os));
  status(`Copied ${os.length} object${os.length===1?'':'s'}`);
}
function pasteClip(){
  if(!pageClip||!doc) return;
  const made=[];
  pageClip.forEach(o=>{
    const c=JSON.parse(JSON.stringify(o));
    reid(c); translateObj(c,20,20);
    activeList().push(c); made.push(c.id);
  });
  setActiveDoc(normalizeDoc(doc));
  setSelIds(new Set(made));
  pushHistory('Paste'); refresh();
}

/* ---- §6.9 groups / §6.10 frames ---- */
function groupSel(asFrame){
  const os=selObjs().filter(o=>!o.locked);
  if(os.length<(asFrame?1:2)) return;
  // everything must share one parent list, else the grouping is ambiguous
  const L=listOf(os[0]);
  if(!os.every(o=>listOf(o)===L)) return;
  const idxs=os.map(o=>L.indexOf(o)).sort((a,b)=>a-b);
  const at=idxs[0];
  let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
  os.forEach(o=>{ const b=aabbOf(o);
    x0=Math.min(x0,b.x); y0=Math.min(y0,b.y);
    x1=Math.max(x1,b.x+b.w); y1=Math.max(y1,b.y+b.h); });
  const g={type:asFrame?'frame':'group', name:asFrame?'Frame':'Group',
    id:newId(), x:x0, y:y0, opacity:1,
    // children keep their absolute coordinates; the container records the box
    children:idxs.map(i=>L[i])};
  if(asFrame){ g.w=Math.max(4,x1-x0); g.h=Math.max(4,y1-y0); g.clip=true; g.fills=[]; }
  for(let i=idxs.length-1;i>=0;i--) L.splice(idxs[i],1);
  L.splice(at,0,g);
  setActiveDoc(normalizeDoc(doc));
  setSelIds(new Set([g.id]));
  pushHistory(); refresh();
}
function ungroupSel(){
  const os=selObjs().filter(o=>CONTAINER(o)&&!o.locked);
  if(!os.length) return;
  const freed=[];
  os.forEach(g=>{
    const L=listOf(g), at=L.indexOf(g);
    const kids=g.children||[];
    // a container transform has to be baked into the children it releases
    if(g.rot||g.mirrorX||g.mirrorY) kids.forEach(k=>{
      k.rot=(((k.rot||0)+(g.rot||0))%360+360)%360;
      if(g.mirrorX) k.mirrorX=!k.mirrorX;
      if(g.mirrorY) k.mirrorY=!k.mirrorY;
    });
    if(g.opacity!==undefined&&g.opacity<1)
      kids.forEach(k=>k.opacity=clamp((k.opacity===undefined?1:k.opacity)*g.opacity,0.05,1));
    L.splice(at,1,...kids);
    freed.push(...kids.map(k=>k.id));
  });
  setActiveDoc(normalizeDoc(doc));
  setSelIds(new Set(freed));
  pushHistory(); refresh();
}
function enterContainer(id){ enteredId=id; setSel(-1); refresh(); }
function exitContainer(){
  if(!enteredId) return false;
  const f=findById(enteredId);
  const parentOf=f&&f.parent?f.parent.id:null;
  enteredId=parentOf;
  if(f) setSelIds(new Set([f.obj.id]));
  refresh(); return true;
}

/* §5.15: flatten-to-raster, the EXPLICIT destructive action. Renders the
 * object with its whole stack into a bitmap and replaces it with an image
 * layer. Undo restores the vector. */
function flattenSelToRaster(){
  const os=selObjs().filter(o=>!o.locked&&o.type!=='image');
  if(!os.length) return;
  if(!confirm(os.length===1
      ? `Flatten "${os[0].name}" and its effects into a pixel layer?\nThe vector data is replaced (undo restores it).`
      : `Flatten ${os.length} objects into pixel layers?`)) return;
  const made=[];
  os.forEach(o=>{
    const b=aabbOf(o);
    const e=o.effects||{};
    const pad=Math.ceil(Math.max(24,
      (e.shadow?e.shadow.blur+e.shadow.spread:0)+(e.glow?e.glow.radius+e.glow.spread:0)));
    const x=Math.floor(b.x-pad), y=Math.floor(b.y-pad);
    const w=Math.ceil(b.w+pad*2), h=Math.ceil(b.h+pad*2);
    if(w<1||h<1||w>4096||h>4096) return;
    const cv2=document.createElement('canvas');
    cv2.width=w; cv2.height=h;
    const cx=cv2.getContext('2d');
    cx.translate(-x,-y);
    drawList(cx,doc.frame.w,doc.frame.h,[o],0);
    const L=listOf(o), at=L.indexOf(o);
    const img={type:'image',name:o.name+' (flattened)',id:newId(),
      x,y,w,h,opacity:1,src:cv2.toDataURL('image/png')};
    L.splice(at,1,img);
    made.push(img.id);
  });
  if(!made.length) return;
  setActiveDoc(normalizeDoc(doc));
  setSelIds(new Set(made));
  pushHistory(); refresh();
}

/* ---- §3.3–3.6 boolean operations ---- */
function booleanSel(op){
  const os=selObjs().filter(o=>!o.locked&&o.type!=='text'&&o.type!=='line');
  if(os.length<2) return;
  const L=listOf(os[0]);
  if(!os.every(o=>listOf(o)===L)) return;      // one parent list only
  const idxs=os.map(o=>L.indexOf(o)).sort((a,b)=>a-b);
  // subject first = the BOTTOM-most object, so "subtract" reads as
  // "the shape underneath, minus the ones on top" (§3.3–3.6: the result
  // inherits the bottom-most object's appearance)
  const ordered=idxs.map(i=>L[i]);
  const src=ordered[0];
  const node={type:'boolean',name:op[0].toUpperCase()+op.slice(1),id:newId(),
    x:0,y:0,opacity:1,boolOp:op,fillRule:'nonzero',fillOn:true,
    fills:src.fills?JSON.parse(JSON.stringify(src.fills)):[{kind:'solid',color:'#cccccc'}],
    strokes:src.strokes?JSON.parse(JSON.stringify(src.strokes)):[],
    children:ordered};
  for(let i=idxs.length-1;i>=0;i--) L.splice(idxs[i],1);
  L.splice(idxs[0],0,node);
  setActiveDoc(normalizeDoc(doc));
  setSelIds(new Set([node.id]));
  pushHistory(); refresh();
}
/** §3.3–3.6 destructive flatten: replace the live boolean with a plain path. */
function flattenBoolean(){
  const os=selObjs().filter(o=>o.type==='boolean'&&!o.locked);
  if(!os.length) return;
  const made=[];
  os.forEach(o=>{
    const res=boolResult(o);
    if(!res||!res.length) return;
    const L=listOf(o), at=L.indexOf(o);
    const p={type:'path',name:o.name,id:newId(),x:0,y:0,
      opacity:o.opacity,subpaths:JSON.parse(JSON.stringify(res)),
      fillRule:o.fillRule,fillOn:true,
      fills:JSON.parse(JSON.stringify(o.fills||[])),
      strokes:JSON.parse(JSON.stringify(o.strokes||[]))};
    L.splice(at,1,p);
    made.push(p.id);
  });
  if(!made.length) return;
  setActiveDoc(normalizeDoc(doc));
  setSelIds(new Set(made));
  pushHistory(); refresh();
}
/** Give the operands back, discarding the operation. */
function releaseBoolean(){
  const os=selObjs().filter(o=>o.type==='boolean'&&!o.locked);
  if(!os.length) return;
  const freed=[];
  os.forEach(o=>{
    const L=listOf(o), at=L.indexOf(o);
    L.splice(at,1,...(o.children||[]));
    freed.push(...(o.children||[]).map(k=>k.id));
  });
  setActiveDoc(normalizeDoc(doc));
  setSelIds(new Set(freed));
  pushHistory(); refresh();
}

/* ---- §3.7 compound paths ---- */
function makeCompound(){
  const os=selObjs().filter(o=>o.type==='path'&&!o.locked);
  if(os.length<2) return;
  const L=listOf(os[0]);
  if(!os.every(o=>listOf(o)===L)) return;
  const idxs=os.map(o=>L.indexOf(o)).sort((a,b)=>a-b);
  const src=L[idxs[0]];
  const sps=idxs.flatMap(i=>JSON.parse(JSON.stringify(L[i].subpaths||[])));
  for(let i=idxs.length-1;i>=0;i--) L.splice(idxs[i],1);
  const p={type:'path',name:src.name,id:newId(),x:0,y:0,opacity:src.opacity,
    subpaths:sps, fillRule:'evenodd', fillOn:true,
    fills:JSON.parse(JSON.stringify(src.fills||[])),
    strokes:JSON.parse(JSON.stringify(src.strokes||[]))};
  L.splice(idxs[0],0,p);
  setActiveDoc(normalizeDoc(doc));
  setSelIds(new Set([p.id]));
  pushHistory(); refresh();
}
function releaseCompound(){
  const os=selObjs().filter(o=>o.type==='path'&&(o.subpaths||[]).length>1&&!o.locked);
  if(!os.length) return;
  const made=[];
  os.forEach(o=>{
    const L=listOf(o), at=L.indexOf(o);
    const parts=o.subpaths.map((sp,i)=>({...JSON.parse(JSON.stringify(o)),
      id:newId(), name:o.name+' '+(i+1), subpaths:[JSON.parse(JSON.stringify(sp))]}));
    L.splice(at,1,...parts);
    made.push(...parts.map(p=>p.id));
  });
  setActiveDoc(normalizeDoc(doc));
  setSelIds(new Set(made));
  pushHistory(); refresh();
}

/* §2.11 / §0 constraint 2: the OTHER approved creation path — numeric entry.
 * Ruler-drag and this dialog are the only two ways a guide comes into being. */
function addGuideNumeric(axis){
  if(!doc) return;
  const f=doc.frame;
  const dflt=Math.round(axis==='v'?f.w/2:f.h/2);
  const v=prompt(`${axis==='v'?'Vertical':'Horizontal'} guide position (px):`,String(dflt));
  const n=parseFloat(v);
  if(!Number.isFinite(n)) return;
  f.guides.push({axis,pos:Math.round(n),locked:false});
  pushHistory(); refresh();
}
let guidesHidden=false;
function openGridPanel(){
  if(!doc) return;
  const g=doc.frame.grid;
  const size=parseFloat(prompt('Grid size (px):',String(g.size)));
  if(Number.isFinite(size)) g.size=clamp(size,1,500);
  const sub=parseFloat(prompt('Subdivisions:',String(g.subdivisions)));
  if(Number.isFinite(sub)) g.subdivisions=clamp(Math.round(sub),1,10);
  g.show=true;
  pushHistory(); render();
}

/* ---- §2.9 distribution ---- */
function distributeSel(axis,mode,spacing){
  const os=selObjs().filter(o=>!o.locked);
  if(os.length<3&&!(spacing!==undefined&&os.length>=2)) return;
  const H=axis==='h';
  const box=o=>aabbOf(o);
  const sorted=[...os].sort((a,b)=>(H?box(a).x-box(b).x:box(a).y-box(b).y));
  if(spacing!==undefined){
    // exact gap between successive edges, anchored on the first object
    let cur=H?box(sorted[0]).x+box(sorted[0]).w:box(sorted[0]).y+box(sorted[0]).h;
    for(let i=1;i<sorted.length;i++){
      const b=box(sorted[i]);
      translateObj(sorted[i], H?(cur+spacing-b.x):0, H?0:(cur+spacing-b.y));
      const nb=box(sorted[i]);
      cur=H?nb.x+nb.w:nb.y+nb.h;
    }
  }else if(mode==='centers'){
    const first=box(sorted[0]), last=box(sorted[sorted.length-1]);
    const c0=H?first.x+first.w/2:first.y+first.h/2;
    const c1=H?last.x+last.w/2:last.y+last.h/2;
    const step=(c1-c0)/(sorted.length-1);
    sorted.forEach((o,i)=>{
      const b=box(o), c=H?b.x+b.w/2:b.y+b.h/2;
      translateObj(o, H?(c0+step*i-c):0, H?0:(c0+step*i-c));
    });
  }else{
    // equal GAPS between edges across the existing extent
    const first=box(sorted[0]), last=box(sorted[sorted.length-1]);
    const span=(H?last.x-(first.x+first.w):last.y-(first.y+first.h));
    const inner=sorted.slice(1,-1);
    const totalInner=inner.reduce((a,o)=>a+(H?box(o).w:box(o).h),0);
    const gap=(span-totalInner)/(sorted.length-1);
    let cur=H?first.x+first.w:first.y+first.h;
    inner.forEach(o=>{
      const b=box(o);
      translateObj(o, H?(cur+gap-b.x):0, H?0:(cur+gap-b.y));
      const nb=box(o);
      cur=H?nb.x+nb.w:nb.y+nb.h;
    });
  }
  pushHistory(); refresh();
}

/* ---- §1.11 crop: resize the page, translating content ---- */
function cropPage(x,y,w,h){
  if(!doc||w<20||h<20) return;
  const f=doc.frame;
  x=Math.round(x); y=Math.round(y);
  w=clamp(Math.round(w),100,4000); h=clamp(Math.round(h),100,4000);
  f.children.forEach(o=>translateObj(o,-x,-y));
  f.w=w; f.h=h;
  view.mode='fit';
  pushHistory(); refresh();
}
function cropToSelection(){
  const b=selBounds(); if(!b) return;
  cropPage(b.x,b.y,b.w,b.h);
}

canvas.addEventListener('dblclick',e=>{
  if(!doc) return;
  const p=evtPage(e);
  if(tool==='node'&&nodeSel){
    const o=nodeObj(), grip=10/view.z;
    // §1.2 corner <-> smooth conversion on an anchor
    for(let pi=0;pi<o.points.length;pi++){
      const a=o.points[pi];
      if(Math.hypot(p.x-a.x,p.y-a.y)<grip){
        if(a.m==='corner'){
          const prev=o.points[(pi-1+o.points.length)%o.points.length];
          const next=o.points[(pi+1)%o.points.length];
          const tx=(next.x-prev.x)/6, ty=(next.y-prev.y)/6;
          a.ox=Math.round(tx); a.oy=Math.round(ty);
          a.ix=-a.ox; a.iy=-a.oy; a.m='smooth';
        }else{
          a.ox=a.oy=a.ix=a.iy=0; a.m='corner';   // retract to zero = corner
        }
        pushHistory(); refresh(); return;
      }
    }
    // §1.2 add an anchor on the segment, preserving the curve exactly
    const near=nearestOnPath(o,p.x,p.y);
    if(near&&near.d<Math.max(6/view.z,(o.stroke.width/2)+3)){
      splitSegment(o,near.i,near.t);
      pushHistory(); refresh();
    }
    return;
  }
  // §6.9 select tool: double-click enters a container, or starts node editing
  if(tool==='select'){
    const o=hitObj(p.x,p.y);
    if(o&&CONTAINER(o)){ enterContainer(o.id); return; }
    if(o&&o.type==='path'){
      const i=activeList().indexOf(o);
      setTool('node'); nodeSel={oi:i,pts:new Set()}; setSel(i); refresh();
    }
  }
});

/* ---- selection commands (§1.1) ---- */
function selectAllCmd(){
  if(!doc) return;
  setSelIds(new Set(activeList().filter(selectable).map(c=>c.id)));
  refresh();
}
function deselectCmd(){ setSel(-1); selInstance=null; refresh(); }
function invertSelCmd(){
  if(!doc) return;
  setSelIds(new Set(activeList().filter(c=>selectable(c)&&!selIds.has(c.id)).map(c=>c.id)));
  refresh();
}
function selectSame(kind){
  const ref=primary(); if(!ref) return;
  const key=o=>{
    if(kind==='fill') return o.type==='text' ? 'text:'+o.color : JSON.stringify(o.fills||o.strokes);
    if(kind==='size'){ const b=boxOf(o); return Math.round(b.w)+'x'+Math.round(b.h); }
    const fx=o.effects||{};
    return ['gradient','light','prism','capsule','strip','blob','glass','glass2','shadow']
      .filter(k=>fx[k]&&fx[k].on).join(',')
      +(fx.grain&&fx.grain.amount>0?'+grain':'')
      +(o.pattern?'+pattern':'');
  };
  const rk=key(ref);
  setSelIds(new Set(allObjects().filter(c=>selectable(c)&&key(c)===rk).map(c=>c.id)),ref.id);
  refresh();
}
/* §2.1 arrow nudge, shift ×10; a burst coalesces into one undo step */
let nudgeTimer=null;
function nudgeSel(dx,dy){
  const os=selObjs().filter(o=>!o.locked); if(!os.length) return;
  os.forEach(o=>translateObj(o,dx,dy));
  render(); syncInspector();
  clearTimeout(nudgeTimer);
  nudgeTimer=setTimeout(pushHistory,400);
}

/* ================= tools ================= */
function cursorForTool(){
  if(tool==='select'||tool==='node') return 'default';
  if(tool==='zoom') return 'zoom-in';
  return 'crosshair';
}
function setTool(t){
  tool=t;
  if(t!=='pen'&&penDraft) penCommit();       // switching tools ends the draft
  if(t!=='node') nodeSel=null;
  document.querySelectorAll('.tool').forEach(b=>b.classList.toggle('active',b.dataset.tool===t));
  const po=$('pencilOpts');
  if(po) po.style.display=t==='pencil'?'':'none';
  canvas.style.cursor=cursorForTool();
  paint();
}
document.querySelectorAll('.tool').forEach(b=>b.addEventListener('click',()=>setTool(b.dataset.tool)));
/* Objects created by the TOOLS never pass through normalizeDoc, so they were
 * only PARTLY formed: makeShape wrote `fill` but not `fills[]`, `points` but
 * not `subpaths[]`, and no `fx` stack at all. Since the renderer moved to the
 * array forms, that meant a freshly drawn shape had nothing to paint — it was
 * invisible, and count-based tests never noticed.
 *
 * Rather than keep a second, drifting copy of the rules, run the real
 * normaliser over the one object. It mutates in place, so identity (and the
 * live aliases it sets up) is preserved. */
function ensureFx(obj){
  if(!obj) return;
  normChildren([obj],0);
}

const SHAPE_DEFAULT={rect:[160,120],ellipse:[160,120],polygon:[140,140]};
function makeShape(kind,p){
  let obj;
  if(kind==='text')
    obj={type:'text',name:'Text',x:p.x,y:p.y,text:'Text',size:36,weight:600,color:'#111111',
      align:'left',mode:'point',lineHeight:1.2,tracking:0,valign:'top',autosize:'fixed',caseTf:'none',opacity:1};
  else if(kind==='line')
    obj={type:'line',name:'Line',x:p.x,y:p.y,x2:p.x,y2:p.y,
      stroke:{width:4,color:'#111111'},arrowStart:'none',arrowEnd:'none',arrowSize:12,opacity:1};
  else if(kind==='path')
    obj={type:'path',name:'Path',x:0,y:0,
      subpaths:[{points:[],closed:false}],points:[],closed:false,
      fillRule:'nonzero',fillOn:false,
      stroke:{width:3,color:'#111111'},fill:{kind:'solid',color:'#d9d9d9'},opacity:1};
  else if(kind==='polygon')
    obj={type:'polygon',name:'Polygon',x:p.x,y:p.y,w:1,h:1,sides:5,innerRatio:1,radius:0,opacity:1,
      fill:{kind:'solid',color:'#d9d9d9'}};
  else obj={type:kind,name:kind==='rect'?'Rectangle':'Ellipse',
    x:p.x,y:p.y,w:1,h:1,radius:kind==='rect'?8:0,opacity:1,
    fill:{kind:'solid',color:'#d9d9d9'}};
  obj.effects=DEFAULT_EFFECTS();
  ensureFx(obj);
  // keep the alias identity: subpath 0 IS obj.points, not a copy
  if(obj.type==='path') obj.subpaths[0].points=obj.points;
  /* NO PATTERN ON A NEW SHAPE. This used to attach DEFAULT_PATTERN(), whose
   * `columns` is 4 — so drawing one rectangle with the rect tool immediately
   * produced FOUR rectangles on the canvas. Pattern is opt-in: the Pattern
   * panel shows "No pattern on this object" with an "+ Add pattern" button
   * when the field is absent, which is the intended way in.
   *
   * Batteries missed this for the same reason bug #13 hid: they build
   * documents by assigning to `doc`, which runs normalizeDoc, where
   * normalizePattern(undefined) is falsy and the field is deleted. Only the
   * TOOL path attached one, and asserting that a drawn shape paints at its
   * centre passes just as well with four copies as with one. */
  obj.id=newId();
  return obj;
}
function addShapeAt(kind,p){
  if(!doc){ openPageModal(); return; }   // no silent premade page
  const obj=makeShape(kind,p);
  applyDefaultSize(obj,p);
  activeList().push(obj);
  setSel(activeList().length-1); fxPage=0;
  pushHistory(); refresh();
}
/** A click without a drag still yields a usable object at a default size. */
function applyDefaultSize(obj,p){
  if(obj.type==='text') return;
  if(obj.type==='line'){ obj.x=p.x-80; obj.y=p.y; obj.x2=p.x+80; obj.y2=p.y; return; }
  const [w,h]=SHAPE_DEFAULT[obj.type]||[160,120];
  obj.x=Math.round(p.x-w/2); obj.y=Math.round(p.y-h/2); obj.w=w; obj.h=h;
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
function reid(o){
  o.id=newId();
  if(CONTAINER(o)) (o.children||[]).forEach(reid);
}
function duplicateSel(){
  const os=selObjs(); if(!os.length)return;
  const copies=[];
  os.forEach(o=>{
    const c=JSON.parse(JSON.stringify(o));
    // Fresh ids throughout: the copy is an INDEPENDENT subtree, so pattern
    // instances derive from it rather than staying linked to the original.
    reid(c);
    translateObj(c,16,16);
    c.name=o.name+' copy';
    listOf(o).push(c);
    copies.push(c);
  });
  setSelIds(new Set(copies.map(c=>c.id)));
  pushHistory(); refresh();
}
function deleteSel(){
  if(!doc||!selIds.size)return;
  const kill=new Set(selIds);
  const prune=list=>{
    for(let i=list.length-1;i>=0;i--){
      if(kill.has(list[i].id)) list.splice(i,1);
      else if(CONTAINER(list[i])) prune(list[i].children);
    }
  };
  prune(doc.frame.children);
  if(enteredId&&!findById(enteredId)) enteredId=null;
  setSel(-1);
  pushHistory(); refresh();
}
/* ---------------- New Page flow ---------------- */
function openPageModal(){
  $('npName').value='Page '+(pages.length+1);
  $('pageModal').style.display='flex';
}
function closePageModal(){ $('pageModal').style.display='none'; }
/* §6.14 history panel: every entry, named, with a jump to any prior state. */
function syncHistoryPanel(){
  const list=$('historyList');
  if(!list) return;
  list.innerHTML='';
  if(!HIST){ return; }
  const rows=HIST.list();
  const mk=(label,idx,cur,n)=>{
    const r=document.createElement('div');
    r.className='histRow'+(cur?' cur':'')+(idx>HIST.i?' future':'');
    r.innerHTML=`<span class="hName">${label}</span>`+(n?`<span class="hOps">${n}</span>`:'');
    r.title=idx<0?'Original state':`Jump to after "${label}"`;
    r.addEventListener('click',()=>historyJump(idx));
    list.appendChild(r);
  };
  mk('Original',-1,HIST.i===-1,0);
  rows.forEach(r=>mk(r.name,r.i,r.current,r.ops));
  const foot=$('historyFoot');
  if(foot){
    const kb=Math.round(HIST.size()/1024);
    foot.textContent=`${rows.length} step${rows.length===1?'':'s'} · ${kb} KB · limit ${HIST.limit}`;
  }
}
const rowBtn=(row,icon,title,fn,dis)=>{
  const b=document.createElement('button');
  b.type='button'; b.className='rowBtn'; b.title=title;
  b.setAttribute('aria-label',title);
  b.innerHTML=IC(icon,12);
  if(dis) b.disabled=true;
  b.addEventListener('click',ev=>{ ev.stopPropagation(); fn(); });
  row.appendChild(b); return b;
};
function syncPageRow(){
  const list=$('pageList'); list.innerHTML='';
  pages.forEach((pg,i)=>{
    const row=document.createElement('div');
    row.className='pageRow'+(i===pageIdx?' sel':'');
    const nm=document.createElement('span');
    nm.className='pName'; nm.textContent=pg.frame.name;
    row.appendChild(nm);
    row.title=`${pg.frame.w}×${pg.frame.h} — double-click to rename`;
    rowBtn(row,'chevronUp','Move page up',()=>movePage(i,-1),i===0);
    rowBtn(row,'chevronDown','Move page down',()=>movePage(i,1),i===pages.length-1);
    rowBtn(row,'duplicate','Duplicate page',()=>duplicatePage(i));
    rowBtn(row,'trash','Delete page',()=>deletePage(i),pages.length<=1);
    row.addEventListener('click',()=>{
      setActivePage(i); setSel(-1); selInstance=null; selArtboard=null; refresh();
    });
    row.addEventListener('dblclick',ev=>{ ev.stopPropagation(); renamePage(i); });
    list.appendChild(row);
  });
  syncArtboardRow();
}
/* §6.5 artboard list — the same affordances as pages. */
function syncArtboardRow(){
  const list=$('artboardList');
  if(!list) return;
  list.innerHTML='';
  if(!doc) return;
  (doc.frame.artboards||[]).forEach(a=>{
    const row=document.createElement('div');
    row.className='pageRow'+(selArtboard===a.id?' sel':'')+(a.show?'':' isHidden');
    const nm=document.createElement('span');
    nm.className='pName'; nm.textContent=a.name;
    row.appendChild(nm);
    const cnt=document.createElement('span');
    cnt.className='linkBadge'; cnt.textContent=String(objectsInArtboard(a).length);
    cnt.title='objects on this artboard';
    row.appendChild(cnt);
    row.title=`${a.w}×${a.h} — double-click to rename`;
    rowBtn(row,'eye',a.show?'Hide artboard':'Show artboard',()=>{
      a.show=!a.show; pushHistory('Artboard visibility'); refresh(); });
    rowBtn(row,'download','Export this artboard',()=>exportArtboard(a.id));
    rowBtn(row,'duplicate','Duplicate artboard',()=>duplicateArtboard(a.id));
    rowBtn(row,'trash','Delete artboard',()=>{
      const n=objectsInArtboard(a).length;
      const withContent=n>0&&confirm(`Delete its ${n} object${n===1?'':'s'} too?\n\nOK deletes them, Cancel keeps them on the page.`);
      removeArtboard(a.id,withContent);
    },(doc.frame.artboards||[]).length<=1);
    row.addEventListener('click',()=>{
      selArtboard=a.id;
      const stage=$('stage'), pad=60;
      const zz=clamp(Math.min((stage.clientWidth-2*pad)/a.w,(stage.clientHeight-2*pad)/a.h),0.02,4);
      view.z=zz; view.mode='free';
      view.x=stage.clientWidth/2-(a.x+a.w/2)*zz;
      view.y=stage.clientHeight/2-(a.y+a.h/2)*zz;
      refresh();
    });
    row.addEventListener('dblclick',ev=>{
      ev.stopPropagation();
      const n=prompt('Artboard name:',a.name);
      if(n===null) return;
      a.name=n.trim()||a.name;
      pushHistory('Rename artboard'); refresh();
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
  setSel(-1); selInstance=null;
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
$('btnNewArtboard').addEventListener('click',()=>addArtboard());
$('layerSearch').addEventListener('input',()=>syncLayers());
$('layerSearch').addEventListener('keydown',e=>{
  e.stopPropagation();
  if(e.key==='Escape'){ e.target.value=''; syncLayers(); e.target.blur(); }
});

const CMDS={
  new:openPageModal,
  exportPng:exportPNG, undo, redo, duplicate:duplicateSel, delete:deleteSel,
  makeComponent(){ makeDefinition('component'); },
  makeSymbol(){ makeDefinition('symbol'); },
  detach:detachInstances, resetInstance:resetInstances,
  addArtboard(){ addArtboard(); },
  artboardPreset(){
    const list=AB_PRESETS.map((p,i)=>`${i+1}. ${p[0]} ${p[1]}×${p[2]}`).join('\n');
    const v=prompt('New artboard size:\n\n'+list+'\n\nEnter a number, or W×H',
      '1');
    if(!v) return;
    const n=parseInt(v,10);
    if(n>=1&&n<=AB_PRESETS.length){ const p=AB_PRESETS[n-1]; addArtboard(p[1],p[2],p[0]); return; }
    const m=v.match(/(\d+)\s*[x×,\s]\s*(\d+)/);
    if(m) addArtboard(+m[1],+m[2]);
  },
  exportArtboards(){ exportAllArtboards(); },
  copy:copySel, paste:pasteClip,
  duplicatePage(){ duplicatePage(pageIdx); },
  renamePage(){ renamePage(pageIdx); },
  deletePage(){ deletePage(pageIdx); },
  historyLimit(){
    const v=prompt('History depth (10–2000 steps):',String(HIST?HIST.limit:200));
    const n=parseFloat(v); if(Number.isFinite(n)) setHistoryLimit(n);
  },
  clearHistory(){ if(HIST){ HIST.reset(); syncHistoryPanel(); } },
  toggleRulers(){ showRulers=!showRulers; paint(); },
  toggleGrid(){ if(doc){ doc.frame.grid.show=!doc.frame.grid.show; pushHistory(); render(); } },
  toggleSnap(){ snapCfg.on=!snapCfg.on; paint(); },
  toggleGuides(){ if(doc){ guidesHidden=!guidesHidden; paint(); } },
  clearGuides(){ if(doc){ doc.frame.guides=[]; pushHistory(); refresh(); } },
  addGuideV(){ addGuideNumeric('v'); },
  addGuideH(){ addGuideNumeric('h'); },
  gridSettings:openGridPanel,
  zoomFit(){ view.mode='fit'; paint(); },
  zoomActual(){ zoomTo(1); },
  zoom200(){ zoomTo(2); },
  zoomSel:zoomToSelection,
  selectAll:selectAllCmd, deselect:deselectCmd, invertSel:invertSelCmd,
  cropSel:cropToSelection,
  group(){ groupSel(false); }, frame(){ groupSel(true); }, ungroup:ungroupSel,
  boolUnion(){ booleanSel('union'); }, boolSubtract(){ booleanSel('subtract'); },
  boolIntersect(){ booleanSel('intersect'); }, boolExclude(){ booleanSel('exclude'); },
  boolFlatten:flattenBoolean, boolRelease:releaseBoolean,
  compound:makeCompound, releaseCompound,
  distH(){ distributeSel('h','centers'); },
  distV(){ distributeSel('v','centers'); },
  distHGap(){ distributeSel('h','gaps'); },
  distVGap(){ distributeSel('v','gaps'); },
  distExact(){
    const v=prompt('Exact spacing between edges, in px:','24');
    const n=parseFloat(v);
    if(Number.isFinite(n)) distributeSel('h','exact',n);
  },
  sameFill(){ selectSame('fill'); },
  sameEffects(){ selectSame('effects'); },
  sameSize(){ selectSame('size'); },
};
/* Effects menu: jump the inspector to that engine for the selected object. */
document.querySelectorAll('.dropdown button[data-fx]').forEach(b=>{
  b.addEventListener('click',e=>{
    e.stopPropagation();
    document.querySelectorAll('.menu').forEach(m=>m.classList.remove('open'));
    const obj=primary();
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
  else if(meta&&e.key.toLowerCase()==='g'&&!e.shiftKey){ e.preventDefault(); groupSel(false); }
  else if(meta&&e.shiftKey&&e.key.toLowerCase()==='g'){ e.preventDefault(); ungroupSel(); }
  else if(meta&&e.altKey&&e.key.toLowerCase()==='f'){ e.preventDefault(); groupSel(true); }
  else if(meta&&e.key.toLowerCase()==='c'){ e.preventDefault(); copySel(); }
  else if(meta&&e.key.toLowerCase()==='v'){ e.preventDefault(); pasteClip(); }
  else if(meta&&e.key.toLowerCase()==='a'){ e.preventDefault(); selectAllCmd(); }
  else if(meta&&e.shiftKey&&e.key.toLowerCase()==='i'){ e.preventDefault(); invertSelCmd(); }
  else if(meta&&e.key==='0'){ e.preventDefault(); view.mode='fit'; paint(); }
  else if(meta&&e.key==='1'){ e.preventDefault(); zoomTo(1); }
  else if(meta&&e.key==='2'){ e.preventDefault(); zoomTo(2); }
  else if(!meta&&e.shiftKey&&e.code==='Digit2'){ e.preventDefault(); zoomToSelection(); }
  else if(e.key==='Escape'&&$('pageModal').style.display!=='none'){ closePageModal(); }
  else if((e.key==='Escape'||e.key==='Enter')&&penDraft){ e.preventDefault(); penCommit(); }
  else if(e.key==='Escape'&&tool==='node'&&nodeSel){ nodeSel=null; setTool('select'); paint(); }
  else if(e.key==='Escape'&&enteredId){ exitContainer(); }
  else if(e.key==='Escape'){ deselectCmd(); }
  else if(e.key==='Backspace'&&penDraft){
    // §1.3: backspace deletes the last placed anchor while drawing
    e.preventDefault();
    const o=penObj();
    o.points.pop();
    if(!o.points.length){ doc.frame.children.splice(penDraft.oi,1); penDraft=null; setSel(-1); }
    refresh();
  }
  else if((e.key==='Delete'||e.key==='Backspace')&&tool==='node'&&nodeSel&&nodeSel.pts.size){
    // §1.2: delete anchors, reconnecting the neighbours
    e.preventDefault();
    const o=nodeObj();
    o.points=o.points.filter((_,i)=>!nodeSel.pts.has(i));
    relinkPath(o);
    nodeSel.pts=new Set();
    if(o.points.length<2){ const L=listOf(o); L.splice(L.indexOf(o),1); nodeSel=null; setSel(-1); setTool('select'); }
    pushHistory(); refresh();
  }
  else if(e.key==='Delete'||e.key==='Backspace'){ e.preventDefault(); deleteSel(); }
  else if(/^Arrow/.test(e.key)&&tool==='node'&&nodeSel&&nodeSel.pts.size){
    // §1.2 anchor nudge with the same step rules as objects
    e.preventDefault();
    const st=e.shiftKey?10:1, o=nodeObj();
    const dx=e.key==='ArrowLeft'?-st:e.key==='ArrowRight'?st:0;
    const dy=e.key==='ArrowUp'?-st:e.key==='ArrowDown'?st:0;
    nodeSel.pts.forEach(pi=>{ o.points[pi].x+=dx; o.points[pi].y+=dy; });
    render();
    clearTimeout(nudgeTimer); nudgeTimer=setTimeout(pushHistory,400);
  }
  else if(e.key==='ArrowLeft'){ e.preventDefault(); nudgeSel(e.shiftKey?-10:-1,0); }
  else if(e.key==='ArrowRight'){ e.preventDefault(); nudgeSel(e.shiftKey?10:1,0); }
  else if(e.key==='ArrowUp'){ e.preventDefault(); nudgeSel(0,e.shiftKey?-10:-1); }
  else if(e.key==='ArrowDown'){ e.preventDefault(); nudgeSel(0,e.shiftKey?10:1); }
  else if(e.key===' '){ e.preventDefault(); if(!e.repeat){ spaceDown=true; if(!drag) canvas.style.cursor='grab'; } }
  else if(e.key==='v'||e.key==='V') setTool('select');
  else if(e.key==='r'||e.key==='R') setTool('rect');
  else if(e.key==='o'||e.key==='O') setTool('ellipse');
  else if(e.key==='t'||e.key==='T') setTool('text');
  else if(meta&&e.key===';'){ e.preventDefault(); CMDS.toggleGuides(); }
  else if(meta&&e.key==="'"){ e.preventDefault(); CMDS.toggleGrid(); }
  else if(meta&&e.shiftKey&&e.key.toLowerCase()==='r'){ e.preventDefault(); CMDS.toggleRulers(); }
  else if(meta&&e.shiftKey&&e.key.toLowerCase()==='s'){ e.preventDefault(); CMDS.toggleSnap(); }
  else if(e.key==='z'||e.key==='Z') setTool('zoom');
  else if(e.key==='P'&&e.shiftKey) setTool('polygon');   // pen took the P key
  else if(e.key==='p') setTool('pen');
  else if(e.key==='a'||e.key==='A') setTool('node');
  else if(e.key==='n'||e.key==='N') setTool('pencil');
  else if(e.key==='c'||e.key==='C') setTool('crop');
  else if(e.key==='l'||e.key==='L') setTool('line');
  else if(e.key==='i'||e.key==='I') setTool('eyedrop');
});
document.addEventListener('keyup',e=>{
  if(e.key===' '){ spaceDown=false; if(!drag) canvas.style.cursor=cursorForTool(); }
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
    setSel(-1); fxPage=0;
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
(function bootHistory(){
  initHistory();
})();

(function hydrateIcons(){
  if(window.Icons) Icons.hydrate(document);
})();

(function wirePencilOpts(){
  const t=$('pcTol'), sm=$('pcSmooth');
  if(!t) return;
  t.value=pencilOpts.tolerance; sm.value=pencilOpts.smoothing;
  t.addEventListener('input',e=>{ pencilOpts.tolerance=+e.target.value; $('pcTolV').textContent=(+e.target.value).toFixed(1); });
  sm.addEventListener('input',e=>{ pencilOpts.smoothing=+e.target.value; $('pcSmoothV').textContent=e.target.value; });
})();

window.__editor={ get doc(){return doc;}, set doc(d){setActiveDoc(normalizeDoc(d)); setSel(-1); selInstance=null; pushHistory(); refresh();},
  get pages(){return pages;}, get pageIdx(){return pageIdx;}, setActivePage,
  get sel(){return sel;}, set sel(i){setSel(i); fxPage=0; refresh();},
  get selInstance(){return selInstance;},
  get view(){return view;},
  get snapCfg(){return snapCfg;},
  get guides(){return doc?doc.frame.guides:[];},
  get snapLines(){return snapLines;},
  get gapHints(){return gapHints;},
  set alignTo(v){alignTo=v;}, get alignTo(){return alignTo;},
  set showRulers(v){showRulers=v; paint();}, get showRulers(){return showRulers;},
  get enteredId(){return enteredId;},
  setSelIds, selObjs, allObjects, findById, activeList, primary,
  groupSel, ungroupSel, distributeSel, enterContainer, exitContainer,
  placeInstance, detachInstances, resetInstances, makeDefinition,
  updateDefinitionFrom, addVariant, deleteDefinition, defsChanged, instanceTree,
  placeObject, boxOf, translateObj, CHELP, normalizeDoc, setActiveDoc,
  compactDoc, compactPages, paintCacheClear,
  get paintCacheSize(){return _paintCache.size;},
  set paintCacheOff(v){ _paintCacheOff=!!v; paintCacheClear(); },
  pushInstanceToSource,
  artboardOf, objectsInArtboard, addArtboard, duplicateArtboard, removeArtboard,
  exportArtboard, duplicatePage, movePage, renamePage, deletePage,
  copySel, pasteClip, moveLayer,
  historySize:()=>HIST?HIST.size():0,
  historyList:()=>HIST?HIST.list():[],
  historyJump, setHistoryLimit, pushHistory,
  render, refresh, normalizeDoc,
  patternInstances, allInstances, instanceBounds, normalizePattern,
  duplicateSel, deleteSel,
  limits:{MAX_PATTERN_INSTANCES,MAX_GRID_AXIS,MAX_GAP,MAX_OFFSET,MAX_JITTER,MAX_HOLES,MIN_SIZE_FACTOR} };
})();
