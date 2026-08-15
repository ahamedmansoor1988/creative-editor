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
/* Viewport: page->screen is s = p*z + (x,y). 'fit' auto-frames the page until
 * the user pans or zooms, which flips it to 'free'. */
let view={z:1,x:0,y:0,mode:'fit'};
let fxPage=0;            // engines pager
/* Multi-select: selIds is the source of truth; `sel` stays the PRIMARY
 * selected index so every single-object code path (inspector, engines,
 * duplicate) keeps working unchanged. Invariant: sel>=0 implies
 * children[sel].id is in selIds. */
let selIds=new Set();
/* Prism and Capsule accumulate samples synchronously, so a full-quality pass
 * is far too slow to run on every pointer move. Slider `input` renders a
 * draft; the `change` that ends the drag renders properly. */
let fxDraft=false;

const DEFAULT_EFFECTS=()=>({
  shadow:{on:false,x:0,y:6,blur:18,color:'#000000',alpha:0.25},
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
    if(!['rect','ellipse','text','polygon','line','path'].includes(c.type)) c.type='rect';
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
    }else if(c.type==='path'){
      c.points=(Array.isArray(c.points)?c.points:[]).slice(0,500).map(p=>({
        x:+p.x||0, y:+p.y||0,
        ox:+p.ox||0, oy:+p.oy||0, ix:+p.ix||0, iy:+p.iy||0,
        m:['corner','smooth','asym','free'].includes(p.m)?p.m:'corner',
      }));
      c.closed=!!c.closed; c.fillOn=!!c.fillOn;
      const st=c.stroke||{};
      c.stroke={width:clamp(+st.width===0?0:(+st.width||3),0,100),
                color:/^#[0-9a-fA-F]{6}$/.test(st.color||'')?st.color:'#111111'};
      c.x=+c.x||0; c.y=+c.y||0;
      if(!c.fill||!c.fill.kind) c.fill={kind:'solid',color:'#d9d9d9'};
      delete c.pattern;
    }else if(c.type==='line'){
      c.x2=Number.isFinite(+c.x2)?+c.x2:c.x+160;
      c.y2=Number.isFinite(+c.y2)?+c.y2:c.y;
      const st=c.stroke||{};
      c.stroke={width:clamp(+st.width||4,1,100),
                color:/^#[0-9a-fA-F]{6}$/.test(st.color||'')?st.color:'#111111'};
      const HEADS=['none','triangle','open','circle','bar'];
      c.arrowStart=HEADS.includes(c.arrowStart)?c.arrowStart:'none';
      c.arrowEnd=HEADS.includes(c.arrowEnd)?c.arrowEnd:'none';
      c.arrowSize=clamp(+c.arrowSize||12,4,60);
      delete c.pattern; delete c.fill;
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
      c.effects={shadow:sh, grain:gr, gradient:grd, glass:gla, blob:blo, glass2:gl2, light:li, prism:pr, capsule:cap, strip:st};
    }
    // Stable identity. Required so instances can carry an explicit parentId.
    if(typeof c.id!=='string'||!c.id) c.id=newId();
    // §1.1: lock suppresses canvas selectability, hide suppresses render too.
    // Document state, so they round-trip through save/load and history.
    c.locked=!!c.locked; c.hidden=!!c.hidden;
    if(c.type!=='text'&&c.type!=='line'&&c.type!=='path'){
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
  setSel(-1); selInstance=null; refresh();
}

/* ================= selection model ================= */
/** Single-select: collapses the id-set to one object (or none). */
function setSel(i){
  sel=i;
  selIds.clear();
  const o=i>=0&&doc&&doc.frame.children[i];
  if(o) selIds.add(o.id);
}
/** Multi-select from ids. `primaryId` (default: last id) becomes `sel`. */
function setSelIds(ids,primaryId){
  selIds=new Set(ids);
  if(!doc||!selIds.size){ sel=-1; return; }
  const ch=doc.frame.children;
  // drop ids that no longer exist
  selIds.forEach(id=>{ if(!ch.some(c=>c.id===id)) selIds.delete(id); });
  const pid=primaryId&&selIds.has(primaryId)?primaryId:[...selIds][selIds.size-1];
  sel=ch.findIndex(c=>c.id===pid);
}
function selObjs(){ return doc?doc.frame.children.filter(c=>selIds.has(c.id)):[]; }
/** Union bounds of the selection, or null. */
function selBounds(){
  const os=selObjs(); if(!os.length) return null;
  let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
  os.forEach(o=>{ const b=boxOf(o);
    x0=Math.min(x0,b.x); y0=Math.min(y0,b.y);
    x1=Math.max(x1,b.x+b.w); y1=Math.max(y1,b.y+b.h); });
  return {x:x0,y:y0,w:x1-x0,h:y1-y0};
}
function selectable(o){ return !o.locked&&!o.hidden; }
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
function pathPath(c,o){
  const P=o.points; if(!P.length) return;
  c.moveTo(P[0].x,P[0].y);
  for(let i=1;i<P.length;i++){
    const a=P[i-1], b=P[i];
    c.bezierCurveTo(a.x+a.ox,a.y+a.oy, b.x+b.ix,b.y+b.iy, b.x,b.y);
  }
  if(o.closed&&P.length>2){
    const a=P[P.length-1], b=P[0];
    c.bezierCurveTo(a.x+a.ox,a.y+a.oy, b.x+b.ix,b.y+b.iy, b.x,b.y);
    c.closePath();
  }
}
function pathFor(c,obj){
  c.beginPath();
  if(obj.type==='path'){ pathPath(c,obj); return; }
  if(obj.type==='ellipse') ellipsePath(c,obj);
  else if(obj.type==='polygon') polygonPath(c,obj);
  else if(obj.type==='line'){
    c.moveTo(obj.x,obj.y); c.lineTo(obj.x2,obj.y2);
  }
  else rectPath(c,obj);
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
/* Blob and Glass 2 are ONE merged body with two possible materials, not two
 * separate groups. Splitting them meant a Blob shape and a Glass 2 shape could
 * never merge — each sat alone in its own group. Membership is therefore
 * "either effect is on"; the material is glass when ANY member asks for it. */
function inBlobGroup(o){
  const e=o&&o.effects;
  return o&&!o.hidden&&o.type!=='text'&&e&&((e.blob&&e.blob.on)||(e.glass2&&e.glass2.on));
}
function blobGroup(){
  if(!doc) return [];
  const out=[];
  doc.frame.children.forEach(o=>{ if(inBlobGroup(o)) out.push(o,...patternInstances(o)); });
  return out;
}
function groupGlassParams(){
  if(!doc) return null;
  const o=doc.frame.children.find(x=>x.type!=='text'&&x.effects&&x.effects.glass2&&x.effects.glass2.on);
  return o?o.effects.glass2:null;
}
function groupBlobParams(){
  if(!doc) return null;
  const o=doc.frame.children.find(inBlobGroup);
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
  return doc.frame.children.find(inBlobGroup)===obj;
}

function drawDoc(c,W,H){
  const f=doc.frame;
  c.fillStyle=f.bg; c.fillRect(0,0,W,H);
  // Parent first, then its complete linked instances, through the SAME draw
  // path — which is what guarantees an ellipse parent yields ellipses.
  f.children.forEach(obj=>{
    if(obj.hidden) return;            // §1.1: hidden suppresses render entirely
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
    if(li&&li.on&&obj.type!=='text'&&window.LightEngine&&window.LightEngine.available()){
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
    if(pr&&pr.on&&obj.type!=='text'&&window.PrismEngine&&window.PrismEngine.available()){
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
    if(cap&&cap.on&&obj.type!=='text'&&window.CapsuleEngine&&window.CapsuleEngine.available()){
      // Like Glass: the capsule IS the material, refracting everything painted
      // so far, so the object's own fill is deliberately not painted first.
      // Pattern copies are skipped — each would need its own trace.
      window.CapsuleEngine.capsule(c.canvas,W,H,{x:obj.x,y:obj.y,w:obj.w,h:obj.h},cap,fxDraft);
      return;
    }
    const st=fx.strip;
    if(st&&st.on&&obj.type!=='text'&&window.CapsuleEngine&&window.CapsuleEngine.available()){
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
    if(obj.type==='path'){
      const st=obj.stroke||{width:3,color:'#111111'};
      c.beginPath(); pathPath(c,obj);
      if(obj.fillOn&&obj.closed){ c.fillStyle=fillStyleFor(c,obj,boxOf(obj)); c.fill(); }
      if(st.width>0){
        c.strokeStyle=st.color; c.lineWidth=st.width;
        c.lineJoin='round'; c.lineCap='round'; c.stroke();
      }
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
    c.fillStyle=fillStyleFor(c,obj,b);
    if(plain==='flood'){
      // Blob layer: this shape's colour has to exist wherever the blend gives
      // it weight, including the neck outside its own outline.
      c.fillRect(0,0,c.canvas.width,c.canvas.height);
    } else {
      pathFor(c,obj); c.fill();
    }
    c.shadowColor='transparent';
    // Stripe fill paints OVER the flat fill rather than replacing it: the flat
    // fill above is what casts the drop shadow, and a clipped drawImage cannot.
    const grd=obj.effects.gradient;
    if(grd&&grd.on&&window.GradientEngine&&b.w>=1&&b.h>=1){
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
  if(obj.type==='text') return textBox(obj);
  if(obj.type==='path'){
    let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
    obj.points.forEach(p=>{
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
  if(o.type==='line'){ o.x2+=dx; o.y2+=dy; }
  if(o.type==='path') o.points.forEach(p=>{ p.x+=dx; p.y+=dy; });
}
/* Scratch context for exact fill/stroke hit-testing of bézier paths. */
const hitCtx=document.createElement('canvas').getContext('2d');
function pathHit(o,px,py,tol){
  hitCtx.setTransform(1,0,0,1,0,0);
  hitCtx.beginPath(); pathPath(hitCtx,o);
  hitCtx.lineWidth=Math.max(tol*2,(o.stroke?o.stroke.width:3)+tol);
  if(o.fillOn&&o.closed&&hitCtx.isPointInPath(px,py)) return true;
  return hitCtx.isPointInStroke(px,py);
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
  frameBuf.width=f.w; frameBuf.height=f.h;
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
    ctx.strokeStyle='#3b82f6'; ctx.lineWidth=1.6/z;
    ctx.strokeRect(b.x,b.y,b.w,b.h);
  });
  // primary object carries the resize handle
  const obj=doc.frame.children[sel];
  if(obj&&obj.type!=='text'&&!obj.locked){
    const b=boxOf(obj), hs=7/z;
    ctx.fillStyle='#fff'; ctx.strokeStyle='#3b82f6'; ctx.lineWidth=1.6/z;
    ctx.fillRect(b.x+b.w-hs/2,b.y+b.h-hs/2,hs,hs);
    ctx.strokeRect(b.x+b.w-hs/2,b.y+b.h-hs/2,hs,hs);
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
  doc.frame.children.forEach(o=>{
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
  if(marquee){
    const x=Math.min(marquee.x0,marquee.x1), y=Math.min(marquee.y0,marquee.y1);
    const w=Math.abs(marquee.x1-marquee.x0), h=Math.abs(marquee.y1-marquee.y0);
    ctx.fillStyle='rgba(59,130,246,.08)';
    ctx.strokeStyle='#3b82f6'; ctx.lineWidth=1/z;
    ctx.fillRect(x,y,w,h); ctx.strokeRect(x,y,w,h);
  }
  ctx.setTransform(1,0,0,1,0,0);
  const zi=$('zoomInput');
  if(document.activeElement!==zi) zi.value=Math.round(z*100)+'%';
}
function render(){ renderDoc(); paint(); }

/* ================= UI sync ================= */
function refresh(){ render(); syncLayers(); syncInspector(); syncPageRow(); }
// Text measured before the webfont finishes loading renders with fallback
// metrics; re-render once fonts settle so text is never left stale.
if(document.fonts&&document.fonts.ready) document.fonts.ready.then(()=>{ if(doc) render(); });

function syncLayers(){
  const list=$('layerList'); list.innerHTML='';
  if(!doc) return;
  const glyph={rect:'▭',ellipse:'◯',text:'T'};
  [...doc.frame.children].reverse().forEach((c,ri)=>{
    const i=doc.frame.children.length-1-ri;
    const row=document.createElement('div');
    row.className=(selIds.has(c.id)?'sel':'')
      +(c.pattern&&c.pattern.mode!=='none'?' isParent':'')
      +(c.hidden?' isHidden':'');
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
    // §1.1: hide suppresses render + selection, lock suppresses selection.
    // Both live in the document, so they undo and round-trip.
    const tgl=(cls,on,title,fn)=>{
      const b=document.createElement('button');
      b.type='button'; b.className='layerTgl'+(on?' on':'');
      b.textContent=cls==='eye'?(on?'◡':'👁'):(on?'🔒':'🔓');
      b.title=title;
      b.addEventListener('click',ev=>{ ev.stopPropagation(); fn(); pushHistory(); refresh(); });
      row.appendChild(b);
    };
    tgl('lock',c.locked,c.locked?'Unlock':'Lock',()=>{ c.locked=!c.locked; });
    tgl('eye',c.hidden,c.hidden?'Show':'Hide',()=>{
      c.hidden=!c.hidden;
      if(c.hidden&&selIds.has(c.id)){ selIds.delete(c.id); setSelIds(selIds); }
    });
    row.addEventListener('click',ev=>{
      selInstance=null; fxPage=0;
      if(ev.shiftKey){
        // §1.1 via the panel: shift-click toggles membership
        if(selIds.has(c.id)&&selIds.size>1) selIds.delete(c.id);
        else selIds.add(c.id);
        setSelIds(selIds,c.id);
      }else setSel(i);
      refresh();
    });
    list.appendChild(row);
  });
}

const FX_PAGES=obj=>{
  if(obj.type==='text') return ['Text','Shadow'];
  if(obj.type==='line') return ['Line','Shadow'];
  if(obj.type==='path') return ['Path','Fill','Gradient','Light','Shadow','Grain'];
  // polygons clip fine through pathFor, but the glass-family engines fit a
  // 3D solid to the box and would render a misleading rect footprint
  if(obj.type==='polygon') return ['Shape','Pattern','Fill','Gradient','Light','Shadow','Grain'];
  return ['Shape','Pattern','Fill','Gradient','Light','Prism','Capsule','Strip','Blob','Glass','Glass 2','Shadow','Grain'];
};

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
  buildFx(obj);
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
    case 'Path':     return !!(obj.closed||obj.fillOn);
    case 'Pattern':  return !!obj.pattern;
    case 'Fill':     return obj.fill&&obj.fill.kind!=='solid';
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
    add(`<div class="fxHint">${P.points.length} anchors · ${P.closed?'closed':'open'} path.
      Double-click the path with the Select tool (or press A) to edit nodes:
      drag anchors and handles, double-click an anchor to convert corner/smooth,
      double-click a segment to add an anchor, Delete removes selected anchors.</div>`);
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
    // §1.9: paragraph + area controls
    const sel2=(id,label,opts,key)=>{
      add(`<label class="slider">${label}<select id="${id}">`+
        opts.map(([v,n])=>`<option value="${v}">${n}</option>`).join('')+`</select></label>`);
      $(id).value=String(obj[key]);
      $(id).addEventListener('change',e=>{ obj[key]=e.target.value; pushHistory(); refresh(); });
    };
    const sl2=(id,label,min,max,step,key,fmt)=>{
      add(`<label class="slider">${label} <span id="${id}V">${fmt(obj[key])}</span>
        <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${obj[key]}"></label>`);
      $(id).addEventListener('input',e=>{ obj[key]=+e.target.value; $(id+'V').textContent=fmt(+e.target.value); render(); });
      $(id).addEventListener('change',()=>pushHistory());
    };
    add(`<div class="pSect">Paragraph</div>`);
    sel2('tAlign','Alignment',[['left','Left'],['center','Center'],['right','Right']],'align');
    sl2('tLead','Line height',0.7,3,0.05,'lineHeight',v=>(+v).toFixed(2));
    sl2('tTrack','Tracking',-10,60,0.5,'tracking',v=>(+v).toFixed(1)+'px');
    sel2('tCase','Case',[['none','As typed'],['upper','UPPERCASE'],['lower','lowercase'],['title','Title Case']],'caseTf');
    add(`<div class="pSect">Frame</div>`);
    sel2('tMode','Mode',[['point','Point text'],['area','Area text (wraps)']],'mode');
    if(obj.mode==='area'){
      sel2('tAuto','Sizing',[['fixed','Fixed (clips + overflow badge)'],['height','Auto-height']],'autosize');
      sel2('tVal','Vertical align',[['top','Top'],['middle','Middle'],['bottom','Bottom']],'valign');
    }
    add(`<div class="fxHint">Area text wraps to its frame — drag with the Text tool to create one, or switch mode here. The red badge marks clipped overflow. Text on a path, columns and OpenType features are later §1.9 sessions.</div>`);
  }

  if(page==='Gradient'){
    const G=obj.effects.gradient;
    const GE=window.GradientEngine;
    add(`<label class="slider"><input type="checkbox" id="gsOn" ${G.on?'checked':''}> Enable gradient stripe</label>`);
    $('gsOn').addEventListener('change',e=>{
      G.on=e.target.checked;
      // First enable adopts the object's own fill, so "add object, pick a
      // colour, apply the effect" lands on that colour rather than on the
      // plugin's stock blue/orange. Later toggles leave the user's edits alone.
      if(G.on&&!G.seeded&&GE){ const s=GE.seedFromFill(obj.fill); G.g1=s.g1; G.g2=s.g2; G.seeded=true; }
      pushHistory(); refresh();
    });
    if(G.on&&GE){
      const sl=(id,label,min,max,step,key,fmt)=>{
        add(`<label class="slider">${label} <span id="${id}V">${fmt(G[key])}</span>
          <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${G[key]}"></label>`);
        $(id).addEventListener('input',e=>{ G[key]=+e.target.value; $(id+'V').textContent=fmt(+e.target.value); render(); });
        $(id).addEventListener('change',()=>pushHistory());
      };
      const chk=(id,label,key)=>{
        add(`<label class="chk"><input type="checkbox" id="${id}" ${G[key]?'checked':''}> ${label}</label>`);
        $(id).addEventListener('change',e=>{ G[key]=e.target.checked; pushHistory(); render(); });
      };
      const int=v=>String(Math.round(v)), pct=v=>Math.round(v)+'%', f2=v=>(+v).toFixed(2);

      add(`<label class="slider">Preset<select id="gsPre">
        <option value="">Custom…</option>`+
        GE.PRESETS.map((p,i)=>`<option value="${i}">${p.name}</option>`).join('')+
        `</select></label>`);
      $('gsPre').addEventListener('change',e=>{
        const p=GE.PRESETS[+e.target.value];
        if(!p) return;
        G.g1=p.g1.map(s=>({...s})); G.g2=p.g2.map(s=>({...s})); G.seeded=true;
        pushHistory(); refresh();
      });
      add(`<div class="gsBtns">
        <button class="rollBtn" id="gsRand">⚄ Randomize</button>
        <button class="rollBtn" id="gsSeed">Use fill colours</button></div>`);
      $('gsRand').addEventListener('click',()=>{
        G.g1=GE.randomStops(G.g1.length); G.g2=GE.randomStops(G.g2.length);
        G.bandHeight=20+Math.floor(Math.random()*80);
        G.split=20+Math.floor(Math.random()*60);
        G.drift=-8+Math.floor(Math.random()*16);
        G.g1shift=-30+Math.floor(Math.random()*60);
        G.g2shift=-30+Math.floor(Math.random()*60);
        G.seeded=true; pushHistory(); refresh();
      });
      $('gsSeed').addEventListener('click',()=>{
        const s=GE.seedFromFill(obj.fill); G.g1=s.g1; G.g2=s.g2; G.seeded=true;
        pushHistory(); refresh();
      });

      add(`<div class="pSect">Stripe</div>`);
      sl('gsBand','Band height',2,200,1,'bandHeight',int);
      sl('gsSplit','Split',5,95,1,'split',pct);
      sl('gsDrift','Drift',-20,20,0.5,'drift',f2);
      sl('gsAng','Angle',0,359,1,'angle',v=>Math.round(v)+'°');

      add(`<div class="pSect">Phase</div>`);
      sl('gsPhase','Per-band phase',-0.5,0.5,0.01,'phase',f2);
      chk('gsBounce','Bounce phase (keep cycling on tall shapes)','bounce');
      sl('gsS1','Gradient 1 shift',-50,50,1,'g1shift',int);
      sl('gsS2','Gradient 2 shift',-50,50,1,'g2shift',int);

      add(`<div class="pSect">Mirror</div>`);
      chk('gsMX','Mirror horizontally','mirrorX');
      chk('gsMY','Mirror vertically','mirrorY');

      [1,2].forEach(n=>{
        const key='g'+n, stops=G[key];
        add(`<div class="pSect">Gradient ${n}</div>`);
        stops.forEach((s,i)=>{
          add(`<div class="stopRow">
            <input type="color" class="gsC${n}" data-si="${i}" value="${s.color}">
            <input type="range" class="gsP${n}" data-si="${i}" min="0" max="100" value="${Math.round(s.pos*100)}">
            <button class="stopDel" data-si="${i}" data-g="${n}" title="Remove stop" ${stops.length<=2?'disabled':''}>×</button>
          </div>`);
        });
        body.querySelectorAll('.gsC'+n).forEach(el=>{
          el.addEventListener('input',e=>{ G[key][+e.target.dataset.si].color=e.target.value; render(); });
          el.addEventListener('change',()=>pushHistory());
        });
        body.querySelectorAll('.gsP'+n).forEach(el=>{
          el.addEventListener('input',e=>{ G[key][+e.target.dataset.si].pos=+e.target.value/100; render(); });
          el.addEventListener('change',()=>pushHistory());
        });
        if(stops.length<GE.MAX_STOPS){
          add(`<button class="rollBtn" id="gsAdd${n}">+ Add stop to gradient ${n}</button>`);
          $('gsAdd'+n).addEventListener('click',()=>{
            G[key]=G[key].concat({color:GE.randomColor(),pos:Math.random()}).sort((a,b)=>a.pos-b.pos);
            pushHistory(); refresh();
          });
        }
      });
      body.querySelectorAll('.stopDel').forEach(el=>{
        el.addEventListener('click',e=>{
          const k='g'+e.target.dataset.g;
          if(G[k].length<=2) return;
          G[k]=G[k].filter((_,i)=>i!==+e.target.dataset.si);
          pushHistory(); refresh();
        });
      });
      add(`<div class="fxHint">Horizontal bands, split left/right at a drifting point, each side ramping through its own gradient. Ported from the Gradient Stripe plugin.</div>`);
    }
  }

  if(page==='Light'){
    const L=obj.effects.light;
    if(!(window.LightEngine&&window.LightEngine.available())){
      add(`<div class="fxHint">Needs WebGL2, which this browser doesn't provide.</div>`);
    } else {
      add(`<label class="slider"><input type="checkbox" id="ltOn" ${L.on?'checked':''}> Enable light</label>`);
      $('ltOn').addEventListener('change',e=>{ L.on=e.target.checked; pushHistory(); refresh(); });
      if(L.on){
        add(`<label class="slider">Shape<select id="ltMode">`+
          window.LightEngine.MODES.map(m=>`<option value="${m.id}">${m.label}</option>`).join('')+
          `</select></label>`);
        $('ltMode').value=String(L.mode);
        $('ltMode').addEventListener('change',e=>{ L.mode=+e.target.value; pushHistory(); render(); });
        const sl=(id,label,min,max,step,key,fmt)=>{
          const v=L[key];
          add(`<label class="slider">${label} <span id="${id}V">${fmt(v)}</span>
            <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${v}"></label>`);
          $(id).addEventListener('input',e=>{ L[key]=+e.target.value; $(id+'V').textContent=fmt(+e.target.value); render(); });
          $(id).addEventListener('change',()=>pushHistory());
        };
        const f2=v=>(+v).toFixed(2);
        sl('ltInt','Intensity',0,2.8,0.01,'intensity',f2);
        sl('ltThroat','Throat',-0.2,0.55,0.01,'throat',f2);
        sl('ltMouth','Mouth',0.35,1.4,0.01,'mouth',f2);
        sl('ltCurve','Curve',1,3.2,0.01,'curve',f2);
        sl('ltDens','Density',2,36,0.1,'density',v=>(+v).toFixed(1));
        sl('ltGlow','Inner glow',0,2.5,0.01,'innerGlow',f2);
        sl('ltBloom','Bloom',0,2.5,0.01,'bloom',f2);
        sl('ltFall','Falloff',0,2.5,0.01,'falloff',f2);
        sl('ltFade','Left fade',0,1,0.01,'leftFade',f2);
        sl('ltMesh','Mesh amount',0,2.5,0.01,'meshMix',f2);
        sl('ltBand','Band shift',0,2,0.01,'bandFlow',f2);
        sl('ltBeamL','Beam length',0.1,2,0.01,'beamLength',f2);
        sl('ltBeamG','Beam glow',0,2.5,0.01,'beamGlow',f2);
        add(`<label class="chk" style="margin-top:6px"><input type="checkbox" id="ltAlpha" ${L.transparent?'checked':''}> Transparent background</label>`);
        $('ltAlpha').addEventListener('change',e=>{ L.transparent=e.target.checked; pushHistory(); render(); });
        add(`<div class="row2" style="margin-top:8px">
          <label class="slider">Core <input type="color" id="ltCore" value="${L.core}"></label>
          <label class="slider">Inner <input type="color" id="ltInner" value="${L.inner}"></label>
        </div>
        <div class="row2">
          <label class="slider">Deep <input type="color" id="ltDeep" value="${L.deep}"></label>
          <label class="slider">Mesh <input type="color" id="ltMeshC" value="${L.mesh}"></label>
        </div>`);
        if(!L.transparent){
          add(`<label class="slider">Background <input type="color" id="ltBg" value="${L.bg}"></label>`);
          $('ltBg').addEventListener('input',e=>{ L.bg=e.target.value; render(); });
          $('ltBg').addEventListener('change',()=>pushHistory());
        }
        [['ltCore','core'],['ltInner','inner'],['ltDeep','deep'],['ltMeshC','mesh']].forEach(([id,key])=>{
          $(id).addEventListener('input',e=>{ L[key]=e.target.value; render(); });
          $(id).addEventListener('change',()=>pushHistory());
        });
        add(`<div class="fxHint">Volumetric light cone, clipped to this shape. Ported from the Funnel Light plugin.</div>`);
      }
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
  const obj=doc&&doc.frame.children[sel]; if(!obj)return;
  obj.opacity=+e.target.value/100; $('pOpacityV').textContent=e.target.value+'%'; render();
});
$('pOpacity').addEventListener('change',()=>pushHistory());
document.querySelectorAll('#alignRow button').forEach(btn=>{
  btn.addEventListener('click',()=>{
    const os=selObjs().filter(o=>!o.locked); if(!os.length)return;
    const f=doc.frame;
    os.forEach(obj=>{
      const b=boxOf(obj);
      let dx=0, dy=0;
      switch(btn.dataset.align){
        case 'left': dx=-b.x; break;
        case 'hcenter': dx=(f.w-b.w)/2-b.x; break;
        case 'right': dx=f.w-b.w-b.x; break;
        case 'top': dy=-b.y; break;
        case 'vcenter': dy=(f.h-b.h)/2-b.y; break;
        case 'bottom': dy=f.h-b.h-b.y; break;
      }
      translateObj(obj,dx,dy);
    });
    pushHistory(); refresh();
  });
});

/* ================= canvas interaction ================= */
function evtScreen(e){
  const r=canvas.getBoundingClientRect();
  return {x:e.clientX-r.left, y:e.clientY-r.top};
}
function evtPage(e){
  const s=evtScreen(e);
  return {x:(s.x-view.x)/view.z, y:(s.y-view.y)/view.z};
}
function hit(px,py){
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
    if(o.type==='path'){
      if(pathHit(o,px,py,Math.max(6/view.z,4))) return i;
      continue;
    }
    const b=boxOf(o);
    if(px>=b.x&&px<=b.x+b.w&&py>=b.y&&py<=b.y+b.h) return i;
  }
  return -1;
}
/** Every selectable object under the point, topmost first — the alt-click
 *  depth cycle walks this stack. */
function hitAll(px,py){
  const out=[], ch=doc.frame.children;
  for(let i=ch.length-1;i>=0;i--){
    if(!selectable(ch[i])) continue;
    const b=boxOf(ch[i]);
    if(px>=b.x&&px<=b.x+b.w&&py>=b.y&&py<=b.y+b.h) out.push(i);
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
  doc.frame.children.forEach(o=>{
    if(!selectable(o)) return;
    const b=boxOf(o);
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
      for(let oi=doc.frame.children.length-1;oi>=0;oi--){
        const o=doc.frame.children[oi];
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
      doc.frame.children.push(obj);
      penDraft={oi:doc.frame.children.length-1};
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
    doc.frame.children.push(obj);
    setSel(doc.frame.children.length-1); fxPage=0;
    drag={mode:'draw',kind:tool,ox:p.x,oy:p.y,obj,moved:false};
    cap(); refresh(); return;
  }
  // line endpoint grips take priority over a body hit on the primary line
  const prim=doc.frame.children[sel];
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
  const id=doc.frame.children[i].id;
  if(e.altKey){
    // §1.1 click-through: alt-click cycles depth through overlapping objects
    const stack=hitAll(p.x,p.y);
    const cur=stack.indexOf(sel);
    setSel(stack[(cur+1)%stack.length]);
    fxPage=0; refresh(); return;
  }
  if(e.shiftKey){
    // §1.1: shift-click toggles membership; no drag starts from a shift-click
    if(selIds.has(id)&&selIds.size>1) selIds.delete(id);
    else selIds.add(id);
    setSelIds(selIds,id);
    fxPage=0; refresh(); return;
  }
  if(!selIds.has(id)){ setSel(i); fxPage=0; }
  else { sel=i; }   // member of a multi-selection: promote to primary, keep the set
  const obj=doc.frame.children[i], b=boxOf(obj);
  const nearHandle=obj.type!=='text'&&obj.type!=='line'&&selIds.size===1&&
    Math.abs(p.x-(b.x+b.w))<12/view.z && Math.abs(p.y-(b.y+b.h))<12/view.z;
  drag=nearHandle?{mode:'resize'}:{
    mode:'move',moved:false,clickI:i,px:p.x,py:p.y,
    offs:selObjs().map(o=>({o,ox:o.x,oy:o.y,ox2:o.x2,oy2:o.y2})),
  };
  cap(); refresh();
});
canvas.addEventListener('pointermove',e=>{
  if(!drag){
    if(tool==='pen'&&penDraft&&doc){ penHover=evtPage(e); paint(); }
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
    const dx=p.x-drag.px, dy=p.y-drag.py;
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
      let w=p.x-drag.ox, h=p.y-drag.oy;
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
    drag.moved=true;
    // Round the DELTA once, not each object: relative spacing inside a
    // multi-selection survives the move exactly.
    const ddx=Math.round(p.x-drag.px), ddy=Math.round(p.y-drag.py);
    drag.offs.forEach(({o,ox,oy,ox2,oy2})=>{
      if(o.locked) return;
      o.x=ox+ddx; o.y=oy+ddy;
      if(o.type==='line'){ o.x2=ox2+ddx; o.y2=oy2+ddy; }
    });
    render(); syncInspector(); return;
  }
  const obj=doc.frame.children[sel]; if(!obj) return;
  obj.w=Math.max(8,Math.round(p.x-obj.x)); obj.h=Math.max(8,Math.round(p.y-obj.y));
  render(); syncInspector();
});
const endDrag=e=>{
  if(!drag) return;
  const d=drag; drag=null;
  try{canvas.releasePointerCapture(e.pointerId);}catch(_){}
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
    obj.name='Pencil';
    // §1.4 auto-close when the stroke ends near its start
    const f0=obj.points[0], fl=obj.points[obj.points.length-1];
    if(Math.hypot(f0.x-fl.x,f0.y-fl.y)<12/view.z){ obj.points.pop(); obj.closed=true; }
    doc.frame.children.push(obj);
    setSel(doc.frame.children.length-1);
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
    doc.frame.children.push(obj);
    setSel(doc.frame.children.length-1); fxPage=0;
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
  if(d.mode==='move'&&!d.moved){
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
function penObj(){ return penDraft?doc.frame.children[penDraft.oi]:null; }
function penCommit(){
  const o=penObj();
  penDraft=null; penHover=null;
  if(o&&o.points.length<2){ doc.frame.children.splice(doc.frame.children.indexOf(o),1); setSel(-1); }
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
function nodeObj(){ return nodeSel?doc.frame.children[nodeSel.oi]:null; }
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
    else if(o.type==='line') o.stroke.color=hex;
    else o.fill={kind:'solid',color:hex};
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
      if(src.fill&&o.type!=='text'&&o.type!=='line') o.fill=JSON.parse(JSON.stringify(src.fill));
      if(o.type==='text'&&src.type==='text') o.color=src.color;
      if(src.effects&&o.effects) o.effects=JSON.parse(JSON.stringify(src.effects));
    });
    setActiveDoc(normalizeDoc(doc));   // re-clamp copied effects per target type
    pushHistory(); refresh(); return;
  }
  const n=(e.metaKey||e.ctrlKey)?5:e.shiftKey?3:1;
  applySampledColor(samplePage(p.x,p.y,n),under);
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
  // select tool: double-click a path to start editing its nodes
  if(tool==='select'){
    const i=hit(p.x,p.y);
    if(i>=0&&doc.frame.children[i].type==='path'){
      setTool('node'); nodeSel={oi:i,pts:new Set()}; setSel(i); refresh();
    }
  }
});

/* ---- selection commands (§1.1) ---- */
function selectAllCmd(){
  if(!doc) return;
  setSelIds(new Set(doc.frame.children.filter(selectable).map(c=>c.id)));
  refresh();
}
function deselectCmd(){ setSel(-1); selInstance=null; refresh(); }
function invertSelCmd(){
  if(!doc) return;
  setSelIds(new Set(doc.frame.children.filter(c=>selectable(c)&&!selIds.has(c.id)).map(c=>c.id)));
  refresh();
}
function selectSame(kind){
  const ref=doc&&doc.frame.children[sel]; if(!ref) return;
  const key=o=>{
    if(kind==='fill') return o.type==='text' ? 'text:'+o.color : JSON.stringify(o.fill);
    if(kind==='size'){ const b=boxOf(o); return Math.round(b.w)+'x'+Math.round(b.h); }
    const fx=o.effects||{};
    return ['gradient','light','prism','capsule','strip','blob','glass','glass2','shadow']
      .filter(k=>fx[k]&&fx[k].on).join(',')
      +(fx.grain&&fx.grain.amount>0?'+grain':'')
      +(o.pattern?'+pattern':'');
  };
  const rk=key(ref);
  setSelIds(new Set(doc.frame.children.filter(c=>selectable(c)&&key(c)===rk).map(c=>c.id)),ref.id);
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
    obj={type:'path',name:'Path',x:0,y:0,points:[],closed:false,fillOn:false,
      stroke:{width:3,color:'#111111'},fill:{kind:'solid',color:'#d9d9d9'},opacity:1};
  else if(kind==='polygon')
    obj={type:'polygon',name:'Polygon',x:p.x,y:p.y,w:1,h:1,sides:5,innerRatio:1,radius:0,opacity:1,
      fill:{kind:'solid',color:'#d9d9d9'}};
  else obj={type:kind,name:kind==='rect'?'Rectangle':'Ellipse',
    x:p.x,y:p.y,w:1,h:1,radius:kind==='rect'?8:0,opacity:1,
    fill:{kind:'solid',color:'#d9d9d9'}};
  obj.effects=DEFAULT_EFFECTS();
  if(obj.type!=='text'&&obj.type!=='line'&&obj.type!=='path') obj.pattern=DEFAULT_PATTERN();
  obj.id=newId();
  return obj;
}
function addShapeAt(kind,p){
  if(!doc){ openPageModal(); return; }   // no silent premade page
  const obj=makeShape(kind,p);
  applyDefaultSize(obj,p);
  doc.frame.children.push(obj);
  setSel(doc.frame.children.length-1); fxPage=0;
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
function duplicateSel(){
  const os=selObjs(); if(!os.length)return;
  const copies=os.map(o=>{
    const c=JSON.parse(JSON.stringify(o));
    // A fresh id makes the copy an INDEPENDENT parent: its instances derive
    // from it, not from the original, so the compositions never stay linked.
    c.id=newId();
    c.x+=16; c.y+=16; c.name=o.name+' copy';
    return c;
  });
  doc.frame.children.push(...copies);
  setSelIds(new Set(copies.map(c=>c.id)));
  pushHistory(); refresh();
}
function deleteSel(){
  if(!doc||!selIds.size)return;
  doc.frame.children=doc.frame.children.filter(c=>!selIds.has(c.id));
  setSel(-1);
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
      setActivePage(i); setSel(-1); selInstance=null; refresh();
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

const CMDS={
  new:openPageModal,
  exportPng:exportPNG, undo, redo, duplicate:duplicateSel, delete:deleteSel,
  zoomFit(){ view.mode='fit'; paint(); },
  zoomActual(){ zoomTo(1); },
  zoom200(){ zoomTo(2); },
  zoomSel:zoomToSelection,
  selectAll:selectAllCmd, deselect:deselectCmd, invertSel:invertSelCmd,
  cropSel:cropToSelection,
  sameFill(){ selectSame('fill'); },
  sameEffects(){ selectSame('effects'); },
  sameSize(){ selectSame('size'); },
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
  else if(meta&&e.key.toLowerCase()==='a'){ e.preventDefault(); selectAllCmd(); }
  else if(meta&&e.shiftKey&&e.key.toLowerCase()==='i'){ e.preventDefault(); invertSelCmd(); }
  else if(meta&&e.key==='0'){ e.preventDefault(); view.mode='fit'; paint(); }
  else if(meta&&e.key==='1'){ e.preventDefault(); zoomTo(1); }
  else if(meta&&e.key==='2'){ e.preventDefault(); zoomTo(2); }
  else if(!meta&&e.shiftKey&&e.code==='Digit2'){ e.preventDefault(); zoomToSelection(); }
  else if(e.key==='Escape'&&$('pageModal').style.display!=='none'){ closePageModal(); }
  else if((e.key==='Escape'||e.key==='Enter')&&penDraft){ e.preventDefault(); penCommit(); }
  else if(e.key==='Escape'&&tool==='node'&&nodeSel){ nodeSel=null; setTool('select'); paint(); }
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
    nodeSel.pts=new Set();
    if(o.points.length<2){ doc.frame.children.splice(nodeSel.oi,1); nodeSel=null; setSel(-1); setTool('select'); }
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
  render, refresh, normalizeDoc,
  patternInstances, allInstances, instanceBounds, normalizePattern,
  duplicateSel, deleteSel,
  limits:{MAX_PATTERN_INSTANCES,MAX_GRID_AXIS,MAX_GAP,MAX_OFFSET,MAX_JITTER,MAX_HOLES,MIN_SIZE_FACTOR} };
})();
