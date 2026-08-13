/* Creative Editor — canvas, inspector, engines, agentic bar. */
(function(){
"use strict";

/* ================= helpers ================= */
const $=id=>document.getElementById(id);
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
const rr=v=>Math.round(v*100)/100;

/* ================= document ================= */
let doc=null;            // {frame:{name,w,h,bg,children:[]}}
let sel=-1;              // index into children
let tool='select';
let fxPage=0;            // engines pager

const DEFAULT_EFFECTS=()=>({
  shadow:{on:false,x:0,y:6,blur:18,color:'#000000',alpha:0.25},
  grain:{amount:0},
});
const DEFAULT_ENGINE=()=>({
  mode:'none', bands:4, gap:10, vary:0.6, window:0.7, empty:0.15,
  seed:Math.floor(Math.random()*99999999),
});

function mulberry32(seed){
  let a=seed>>>0;
  return function(){
    a|=0; a=(a+0x6D2B79F5)|0;
    let t=Math.imul(a^(a>>>15),1|a);
    t=(t+Math.imul(t^(t>>>7),61|t))^t;
    return ((t^(t>>>14))>>>0)/4294967296;
  };
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
      c.effects={shadow:sh, grain:gr};
    }
    if(c.type!=='text'){
      const e=Object.assign(DEFAULT_ENGINE(), c.engine||{});
      e.mode=['rows','columns','grid','mixed'].includes(e.mode)?e.mode:'none';
      e.bands=clamp(Math.round(+e.bands||4),1,14);
      e.gap=clamp(+e.gap||0,0,60);
      e.vary=clamp(+e.vary||0,0,1);
      e.window=clamp(e.window===undefined?0.7:+e.window,0,1);
      e.empty=clamp(+e.empty||0,0,0.8);
      e.seed=Math.floor(+e.seed)||DEFAULT_ENGINE().seed;
      c.engine=e;
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
  hist.stack.push(JSON.stringify(doc));
  if(hist.stack.length>60) hist.stack.shift();
  hist.i=hist.stack.length-1;
}
function undo(){ if(hist.i>0){ hist.i--; doc=JSON.parse(hist.stack[hist.i]); sel=-1; refresh(); } }
function redo(){ if(hist.i<hist.stack.length-1){ hist.i++; doc=JSON.parse(hist.stack[hist.i]); sel=-1; refresh(); } }

/* ================= render ================= */
const canvas=$('out'), ctx=canvas.getContext('2d');
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

/* ---------- pattern engine (ported from the gradient tool) ---------- */
function hexToRgbArr(h){const n=parseInt(h.slice(1),16);return [(n>>16)&255,(n>>8)&255,n&255];}
function rgbToHexStr(c){return '#'+c.map(v=>Math.round(clamp(v,0,255)).toString(16).padStart(2,'0')).join('');}
// The object's own fill doubles as the engine palette.
function enginePalette(obj){
  if(obj.fill.kind!=='solid') return [...obj.fill.stops].sort((a,b)=>a.pos-b.pos);
  const c=hexToRgbArr(obj.fill.color);
  const dark=c.map(v=>v*0.25);
  return [{pos:0,color:rgbToHexStr(dark)},{pos:1,color:obj.fill.color}];
}
function samplePalette(pal,t){
  t=clamp(t,0,1);
  if(t<=pal[0].pos) return pal[0].color;
  if(t>=pal[pal.length-1].pos) return pal[pal.length-1].color;
  for(let i=0;i<pal.length-1;i++){
    const a=pal[i],b=pal[i+1];
    if(t>=a.pos&&t<=b.pos){
      const sp=b.pos-a.pos,k=sp<=0?0:(t-a.pos)/sp;
      const ca=hexToRgbArr(a.color),cb=hexToRgbArr(b.color);
      return rgbToHexStr([ca[0]+(cb[0]-ca[0])*k,ca[1]+(cb[1]-ca[1])*k,ca[2]+(cb[2]-ca[2])*k]);
    }
  }
  return pal[pal.length-1].color;
}
// A sub-range of the palette as exact gradient stops (t1<t0 = reversed).
function windowStops(pal,t0,t1){
  const rev=t1<t0, lo=Math.min(t0,t1), hi=Math.max(t0,t1), span=hi-lo;
  const out=[{pos:0,color:samplePalette(pal,lo)}];
  if(span>1e-6) pal.forEach(p=>{
    if(p.pos>lo+1e-6&&p.pos<hi-1e-6) out.push({pos:(p.pos-lo)/span,color:p.color});
  });
  out.push({pos:1,color:samplePalette(pal,hi)});
  return rev?out.map(s=>({pos:1-s.pos,color:s.color})).reverse():out;
}
function pickWindow(rng,amt){
  if(amt<=0.001) return rng()<0.5?[0,1]:[1,0];
  const minW=1-(1-0.16)*amt;
  const w=minW+rng()*(1-minW)*(1-0.45*amt);
  const start=rng()*(1-w);
  return rng()<0.5?[start,start+w]:[start+w,start];
}
/* Split the object's box into pattern segments. Coordinates are frame px. */
function engineInstances(obj){
  const E=obj.engine;
  const pal=enginePalette(obj);
  const rng=mulberry32(E.seed);
  const baseAngle=obj.fill.kind==='solid'?0:(obj.fill.angle||0);
  const out=[];
  const seg=(x,y,w,h)=>{
    const [t0,t1]=pickWindow(rng,E.window);
    let angle=baseAngle;
    const r=rng();
    if(r<0.42) angle=(angle+180)%360;
    out.push({x,y,w,h,angle,stops:windowStops(pal,t0,t1)});
  };
  const B=E.bands, g=E.gap;
  const bx=obj.x, by=obj.y, bw=obj.w, bh=obj.h;
  const varyOf=base=>base*(1-E.vary*0.5+rng()*E.vary);

  if(E.mode==='rows'||E.mode==='mixed'){
    const rowH=(bh-(B-1)*g)/B;
    if(rowH<2) return out;
    for(let i=0;i<B;i++){
      const y=by+i*(rowH+g);
      let x=bx+(E.mode==='mixed'&&rng()<0.5?rng()*bw*0.12:0);
      let guard=0;
      const baseW=bw/3;
      while(x<bx+bw-4 && guard++<60){
        const w=clamp(varyOf(baseW),8,bx+bw-x);
        if(rng()>=E.empty) seg(x,y,w,rowH);
        x+=w+g;
      }
    }
  } else if(E.mode==='columns'){
    const colW=(bw-(B-1)*g)/B;
    if(colW<2) return out;
    for(let i=0;i<B;i++){
      const x=bx+i*(colW+g);
      let y=by, guard=0;
      const baseH=bh/3;
      while(y<by+bh-4 && guard++<60){
        const h=clamp(varyOf(baseH),8,by+bh-y);
        if(rng()>=E.empty) seg(x,y,colW,h);
        y+=h+g;
      }
    }
  } else { // grid
    const cols=Math.max(1,Math.round(bw/(bh/B)));
    const cw=(bw-(cols-1)*g)/cols, chh=(bh-(B-1)*g)/B;
    if(cw<2||chh<2) return out;
    for(let r2=0;r2<B;r2++) for(let c2=0;c2<cols;c2++){
      if(rng()<E.empty) continue;
      const w=clamp(varyOf(cw),cw*0.2,cw), h=clamp(varyOf(chh),chh*0.2,chh);
      seg(bx+c2*(cw+g)+(cw-w)/2, by+r2*(chh+g)+(chh-h)/2, w, h);
    }
  }
  return out;
}
function drawEngine(c,obj){
  const rad=Math.min(obj.radius||0, 24);
  engineInstances(obj).forEach(s2=>{
    const a=s2.angle*Math.PI/180, dx=Math.cos(a), dy=Math.sin(a);
    const cx=s2.x+s2.w/2, cy=s2.y+s2.h/2, ext=Math.abs(dx)*s2.w/2+Math.abs(dy)*s2.h/2;
    const g=c.createLinearGradient(cx-dx*ext,cy-dy*ext,cx+dx*ext,cy+dy*ext);
    s2.stops.forEach(st=>g.addColorStop(st.pos,st.color));
    c.fillStyle=g;
    const r=Math.min(rad,s2.w/2,s2.h/2);
    c.beginPath();
    if(r>0.5){
      c.moveTo(s2.x+r,s2.y);
      c.arcTo(s2.x+s2.w,s2.y,s2.x+s2.w,s2.y+s2.h,r);
      c.arcTo(s2.x+s2.w,s2.y+s2.h,s2.x,s2.y+s2.h,r);
      c.arcTo(s2.x,s2.y+s2.h,s2.x,s2.y,r);
      c.arcTo(s2.x,s2.y,s2.x+s2.w,s2.y,r);
      c.closePath();
    } else c.rect(s2.x,s2.y,s2.w,s2.h);
    c.fill();
  });
}
function drawDoc(c,W,H){
  const f=doc.frame;
  c.fillStyle=f.bg; c.fillRect(0,0,W,H);
  f.children.forEach(obj=>{
    c.save();
    c.globalAlpha=obj.opacity;
    const sh=obj.effects.shadow;
    if(sh.on){ c.shadowColor=hexAlpha(sh.color,sh.alpha); c.shadowBlur=sh.blur; c.shadowOffsetX=sh.x; c.shadowOffsetY=sh.y; }
    if(obj.type==='text'){
      c.font=`${obj.weight} ${obj.size}px Inter,-apple-system,sans-serif`;
      c.fillStyle=obj.color; c.textBaseline='top';
      c.textAlign=obj.align==='center'?'center':'left';
      c.fillText(obj.text,obj.x,obj.y);
      c.restore(); return;
    }
    const b={x:obj.x,y:obj.y,w:obj.w,h:obj.h};
    if(obj.engine && obj.engine.mode!=='none'){
      // Pattern engine: the box becomes an area filled with varied
      // gradient segments drawn from the object's own palette.
      drawEngine(c,obj);
    } else {
      c.fillStyle=fillStyleFor(c,obj,b);
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
  });
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
  $('emptyHint').style.display = doc&&doc.frame.children.length ? 'none':'';
  if(!has){ canvas.width=1; canvas.height=1; return; }
  const f=doc.frame;
  const stage=$('stage'), pad=40;
  const availW=stage.clientWidth-pad, availH=stage.clientHeight-pad;
  const scale=Math.min(1.5, availW/f.w, availH/f.h);
  canvas.width=Math.round(f.w*scale); canvas.height=Math.round(f.h*scale);
  ctx.setTransform(scale,0,0,scale,0,0);
  drawDoc(ctx,f.w,f.h);
  // selection overlay (screen-only)
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
function refresh(){ render(); syncLayers(); syncInspector(); }

function syncLayers(){
  const list=$('layerList'); list.innerHTML='';
  if(!doc) return;
  const glyph={rect:'▭',ellipse:'◯',text:'T'};
  [...doc.frame.children].reverse().forEach((c,ri)=>{
    const i=doc.frame.children.length-1-ri;
    const row=document.createElement('div');
    if(i===sel) row.className='sel';
    row.innerHTML=`<span class="glyph">${glyph[c.type]||'▭'}</span>`;
    row.appendChild(document.createTextNode(c.type==='text'?c.text.slice(0,18):c.name));
    row.addEventListener('click',()=>{ sel=i; fxPage=0; refresh(); });
    list.appendChild(row);
  });
}

const FX_PAGES=obj=>obj.type==='text' ? ['Text','Shadow'] : ['Pattern','Fill','Shadow','Grain'];

function syncInspector(){
  const obj=doc&&doc.frame.children[sel];
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
    const E=obj.engine;
    add(`<label class="slider">Mode
      <select id="enMode">
        <option value="none">Off — plain fill</option>
        <option value="rows">Rows</option>
        <option value="mixed">Rows (loose)</option>
        <option value="columns">Columns</option>
        <option value="grid">Grid</option>
      </select></label>`);
    $('enMode').value=E.mode;
    $('enMode').addEventListener('change',e=>{ E.mode=e.target.value; pushHistory(); refresh(); });
    if(E.mode!=='none'){
      const sl=(id,label,min,max,val,fmt)=>{
        add(`<label class="slider">${label} <span id="${id}V">${fmt(val)}</span>
          <input type="range" id="${id}" min="${min}" max="${max}" value="${val}"></label>`);
      };
      sl('enBands','Bands',1,14,E.bands,v=>v);
      sl('enGap','Gap',0,40,E.gap,v=>v+'px');
      sl('enVary','Size variation',0,100,Math.round(E.vary*100),v=>v+'%');
      sl('enWin','Palette window',0,100,Math.round(E.window*100),v=>v+'%');
      sl('enEmpty','Empty slots',0,80,Math.round(E.empty*100),v=>v+'%');
      const wire=(id,f,fmt)=>{
        $(id).addEventListener('input',e=>{ f(+e.target.value); $(id+'V').textContent=fmt(+e.target.value); render(); });
        $(id).addEventListener('change',()=>pushHistory());
      };
      wire('enBands',v=>E.bands=v,v=>v);
      wire('enGap',v=>E.gap=v,v=>v+'px');
      wire('enVary',v=>E.vary=v/100,v=>v+'%');
      wire('enWin',v=>E.window=v/100,v=>v+'%');
      wire('enEmpty',v=>E.empty=v/100,v=>v+'%');
      add(`<button class="rollBtn" id="enRoll">↻ Reroll pattern</button>`);
      $('enRoll').addEventListener('click',()=>{
        E.seed=Math.floor(Math.random()*99999999);
        pushHistory(); render();
      });
      add(`<div class="fxHint">Colors come from this shape's Fill — edit the gradient on the Fill page.</div>`);
    }
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
let drag=null;
canvas.addEventListener('pointerdown',e=>{
  if(!doc) return;
  const p=evtFrame(e);
  if(tool!=='select'){ addShapeAt(tool,p); setTool('select'); return; }
  const i=hit(p.x,p.y);
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
  if(!doc) doc=newDoc();
  const f=doc.frame;
  let obj;
  if(kind==='text') obj={type:'text',name:'Text',x:p.x,y:p.y,text:'Text',size:36,weight:600,color:'#111111',align:'left',opacity:1};
  else obj={type:kind,name:kind==='rect'?'Rectangle':'Ellipse',
    x:p.x-80,y:p.y-60,w:160,h:120,radius:kind==='rect'?8:0,opacity:1,
    fill:{kind:'solid',color:'#d9d9d9'}};
  obj.effects=DEFAULT_EFFECTS();
  if(obj.type!=='text') obj.engine=DEFAULT_ENGINE();
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
const CMDS={
  new(){ doc=newDoc(); sel=-1; pushHistory(); refresh(); },
  exportPng:exportPNG, undo, redo, duplicate:duplicateSel, delete:deleteSel,
};
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
    doc=normalizeDoc(data.doc);
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

/* ================= init ================= */
window.addEventListener('resize',render);
doc=newDoc(); pushHistory(); refresh();

/* test hook */
window.__editor={ get doc(){return doc;}, set doc(d){doc=normalizeDoc(d); sel=-1; pushHistory(); refresh();},
  get sel(){return sel;}, set sel(i){sel=i; fxPage=0; refresh();}, render, refresh };
})();
