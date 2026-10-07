/* Light Burst — a warp-speed light burst (material slot).
 *
 * PROVENANCE. Written for this app on 7 Oct 2026 as a WebGL2 port of the
 * author's own Figma shader "Light Burst" (WGSL, same session). The maths is
 * carried across line for line; only the plumbing changed. Nothing here is
 * derived from Shadertoy or any other licensed source — see
 * SHADER-PROVENANCE.md.
 *
 * WHAT IT IS. Everything radiates from one centre point, layered additively:
 * a blown-out core, a tapered starburst plus one long anamorphic streak, two
 * tilted halo rings carrying a spectrum across their width, three scales of
 * speed streaks (particles laid out in polar cells, so each streak points
 * away from the centre at any size), embers, a warm light leak where the
 * halo meets one side, bokeh and fine dust. A seed reshuffles
 * every particle without changing the look. Every particle also has a
 * DEPTH, seen through a thin lens (Focus distance, Aperture): out of focus it
 * spreads into the flat, crisp-edged disc a camera makes, nearer ones faster.
 * 7 Oct 2026 (later): the LIGHT itself (core, rays, long streak, halo) and the dust
 * now sit at depths too, so the lens softens the whole burst, not only the
 * particles (Mansoor: "only the dots are affected"). Chromatic aberration
 * samples red/blue slightly outward/inward from the picture centre (rainbow
 * fringes across the streaks); Background glow is a soft gradient around the
 * light. Both 0 by default, so earlier designs render as before. The background
 * can also be a Linear or Radial gradient (Background to Background 2).
 *
 * TRANSPARENT MODE is for laying the burst over a photo: the light comes out
 * with its own alpha, so on a layer blended Screen or Add it lights whatever
 * is beneath.
 *
 * WHY IT IS A MATERIAL. It generates its own pixels and never reads the page,
 * so it caches: one render per parameter change, not per repaint.
 */
(function(){
"use strict";

const VERT=`#version 300 es
in vec2 a_pos;
void main(){ gl_Position=vec4(a_pos,0.0,1.0); }`;

const FRAG=`#version 300 es
precision highp float;
uniform vec2 u_res, u_centre;
uniform float u_core, u_coreBright, u_rays, u_rayLen, u_rayAngle, u_streak;
uniform float u_ringR, u_ringW, u_rainbow, u_squash, u_tilt;
uniform float u_speed, u_speedLen, u_embers, u_emberSize, u_dust;
uniform float u_warm, u_seed, u_expo, u_transparent, u_leak, u_bokeh, u_focus, u_aperture, u_chroma, u_glow;
uniform vec3 u_bg, u_ember, u_glowCol, u_bg2;
uniform float u_bgMode, u_bgAngle;
out vec4 fragColor;

float h21(vec2 p){ vec2 q=fract(p*vec2(123.34,456.21)); q+=dot(q,q+45.32); return fract(q.x*q.y); }
float h11(float x){ return fract(sin(x*127.1)*43758.5453); }
vec2 rot(vec2 v,float a){ float c=cos(a), s=sin(a); return vec2(c*v.x-s*v.y, s*v.x+c*v.y); }
float angNoise(float th,float freq,float seed){
  float x=(th/6.2831853+0.5)*freq; float i=floor(x), f=fract(x);
  float a=h11(i+seed), b=h11(mod(i+1.0,freq)+seed);
  return mix(a,b,f*f*(3.0-2.0*f));
}
// A THIN LENS: depth z (0 near .. 1 far) is a distance; the blur circle is
// aperture x |d - focus| / d, so in front of the focus softens fastest.
float coc(float z,float focus,float aperture){
  float d=mix(0.5,5.0,z), df=mix(0.5,5.0,focus);
  return min(aperture*abs(d-df)/d,1.5);
}
// The light itself (core, rays, long streak, halo) sits at the default focus distance, so at the
// defaults it is sharp and moving Focus away, or opening the Aperture, softens the whole burst.
const float LIGHT_Z=0.65;
// widen a profile of width w by a lens blur b, keeping its total light (1D: w/w', 2D: (w/w')^2)
float wid(float w,float b){ return sqrt(w*w+b*b); }
float angDiff(float a,float b){ return abs(fract((a-b)/6.2831853+0.5)-0.5)*6.2831853; }

vec3 streaks(vec2 q,float r,float th,float bins,float density,float len,float width,float seed,float warm,vec3 ember,float emberMix,float focus,float aperture){
  vec3 col=vec3(0.0);
  float lr=log(r+0.03), m=0.42;
  float ca=floor((th/6.2831853+0.5)*bins), cr0=floor(lr/m);
  for(int k=0;k<2;k++){
    float cr=cr0-float(k);
    vec2 id=vec2(ca,cr)+seed;
    float h=h21(id);
    if(h>density) continue;
    float h2=h21(id+1.7), h3=h21(id+3.1), h4=h21(id+5.3);
    float thc=((ca+0.15+0.7*h2)/bins-0.5)*6.2831853;
    float rc=exp((cr+h3)*m)-0.03;
    float lenR=len*max(rc,0.02)*(0.35+h4);
    float t=(r-rc)/max(lenR,0.0005);
    if(t<0.0||t>1.0) continue;
    // each particle at its own depth; defocused it becomes a lens disc
    float z=h21(id+7.9);
    float blur=coc(z,focus,aperture);
    float near=mix(1.8,0.7,z);
    float w=min(width*(0.6+0.8*h2)*(0.6+rc)*near*(1.0+9.0*blur), 0.28*6.2831853/bins*max(r,0.05));
    float dpx=angDiff(th,thc)*r;
    float soft=0.18+0.5*min(blur,1.0);
    float along=smoothstep(0.0,soft,t)*smoothstep(1.0,1.0-soft-0.27,t);
    float gauss=exp(-(dpx*dpx)/(w*w));
    float disk=smoothstep(w,w*0.8,dpx)*(0.85+0.3*smoothstep(w*0.4,w*0.95,dpx));
    float inten=mix(gauss,disk,min(blur*1.5,1.0))*along*(0.4+1.2*h)/(1.0+6.0*blur);
    float isEmber=step(1.0-emberMix,h4);
    vec3 cool=mix(vec3(0.75,0.85,1.0),vec3(1.0,0.85,0.65),warm);
    col+=inten*mix(cool,ember,isEmber);
  }
  return col;
}

// Everything the burst emits at one pixel (px, y down). main() calls it once, or three times for
// chromatic aberration: red and blue are sampled a little outward / inward from the PICTURE centre,
// so radial streaks get colour fringes across their width, as a real lens gives them.
vec3 scene(vec2 px){
  float mn=min(u_res.x,u_res.y);
  vec2 c=u_centre*u_res;
  vec2 q=vec2(px.x-c.x, c.y-px.y)/mn;
  float r=length(q), th=atan(q.y,q.x);
  float seed=u_seed*17.0, warm=u_warm;
  vec3 col=vec3(0.0);
  float bl=0.03*coc(LIGHT_Z,u_focus,u_aperture);

  vec3 coreCol=mix(vec3(0.85,0.92,1.0),vec3(1.0,0.9,0.75),warm);
  float cs=max(u_core,0.01);
  float s1=wid(cs*0.04,bl), s2=wid(cs*0.13,bl), s3=wid(cs*0.22,bl), rb2=sqrt(r*r+bl*bl*0.25);
  col+=coreCol*u_coreBright*(exp(-rb2/s1)*2.5*pow(cs*0.04/s1,2.0)+exp(-pow(r/s2,2.0))*1.6*pow(cs*0.13/s2,2.0)
       +exp(-rb2/s3)*0.5*pow(cs*0.22/s3,2.0)+exp(-r/(cs*0.7))*0.05);

  float a0=u_rayAngle*0.0174533;
  for(int k=0;k<12;k++){
    float fk=float(k);
    if(fk>=u_rays) break;
    float ang=a0+fk*3.14159265/max(u_rays,1.0);
    vec2 v=rot(q,-ang);
    float lenK=u_rayLen*(0.45+0.9*h11(fk+seed));
    float wK=0.0016*(0.7+h11(fk*3.3+seed))*(1.0+7.0*exp(-abs(v.x)/(lenK*0.12)));
    float wB=wid(wK,bl);
    col+=coreCol*1.2*(wK/wB)*exp(-abs(v.y)/wB)*exp(-abs(v.x)/lenK);
  }
  float spikes=pow(angNoise(th,90.0,seed),7.0)+0.5*pow(angNoise(th,240.0,seed+9.0),9.0);
  col+=coreCol*spikes*exp(-r/(u_rayLen*0.22+0.01))*0.5*u_coreBright/(1.0+60.0*bl);

  vec2 sv=rot(q,-a0);
  float stW=wid(0.0022,bl);
  col+=vec3(0.8,0.9,1.0)*1.6*(0.0022/stW)*exp(-abs(sv.y)/stW)*exp(-abs(sv.x)/max(u_streak,0.001));

  float ringR=u_ringR, ringW0=max(u_ringW,0.002), ringW=wid(ringW0,bl), rb=u_rainbow;
  vec2 e=rot(q,-u_tilt*0.0174533);
  vec2 ev=vec2(e.x,e.y/max(u_squash,0.1));
  float re=length(ev);
  float wobble=0.25+0.75*pow(angNoise(atan(ev.y,ev.x),6.0,seed+3.0),1.5);
  float d1=(re-ringR)/ringW, d2=(re-ringR*0.62)/(ringW*0.8);
  float env1=exp(-d1*d1*0.5), env2=exp(-d2*d2*0.5)*0.4;
  vec3 spec1=clamp(0.5+0.5*cos(6.2831853*(clamp(0.5-d1*0.22,0.0,1.0)*0.75+vec3(0.0,0.33,0.67))),0.0,1.0);
  vec3 spec2=clamp(0.5+0.5*cos(6.2831853*(clamp(0.5-d2*0.22,0.0,1.0)*0.75+vec3(0.0,0.33,0.67))),0.0,1.0);
  col+=(mix(vec3(0.9),spec1*1.4,rb)*env1+mix(vec3(0.9),spec2*1.4,rb)*env2)*wobble*0.35*(ringW0/ringW);

  col+=streaks(q,r,th,140.0,u_speed*0.5,u_speedLen,0.0014,seed,warm,u_ember,0.0,u_focus,u_aperture)*0.7;
  col+=streaks(q,r,th,70.0,u_speed*0.6,u_speedLen*1.2,0.0022,seed+11.0,warm,u_ember,u_embers*0.5,u_focus,u_aperture)*1.1;
  col+=streaks(q,r,th,36.0,u_embers*0.5,u_speedLen*0.5,0.0040*u_emberSize,seed+23.0,warm,u_ember,1.0,u_focus,u_aperture)*1.8;

  vec2 g=q*260.0, gi=floor(g);
  if(h21(gi+seed)<u_dust*0.06*(0.3+0.7*exp(-r*2.5))){
    vec2 pp=gi+vec2(h21(gi+2.0),h21(gi+4.0));
    float dd=length(g-pp);
    // each speck at its own depth: out of focus it grows into a soft disc (cell units), same total light
    float db=min(coc(h21(gi+7.0),u_focus,u_aperture),1.0), dr=0.41+0.45*db;
    col+=vec3(0.9,0.95,1.0)*exp(-dd*dd/(dr*dr))*(0.3+h21(gi+6.0))*(0.168/(dr*dr));
  }

  vec2 lp=rot(vec2(-ringR,0.0),u_tilt*0.0174533);
  float ld=length(q-lp*vec2(1.15,1.0));
  col+=u_ember*u_leak*(exp(-ld/0.07)*1.4+exp(-ld/0.22)*0.35);

  vec2 bi=floor(q*7.0);
  for(int oy=-1;oy<=1;oy++) for(int ox=-1;ox<=1;ox++){
    vec2 cid=bi+vec2(float(ox),float(oy));
    if(h21(cid+seed*1.3)>u_bokeh*0.35) continue;
    vec2 bp=(cid+vec2(h21(cid+8.0),h21(cid+9.0)))/7.0;
    float edge=smoothstep(0.15,0.7,length(bp));
    float bz=h21(cid+12.0), bblur=coc(bz,u_focus,u_aperture);
    float br=min((0.006+0.016*h21(cid+10.0))*(0.5+edge)*mix(1.6,0.7,bz)*(1.0+2.5*bblur),0.12);
    float bd=length(q-bp);
    float disc=smoothstep(br,br*(0.75-0.2*min(bblur,1.0)),bd)*(0.8+0.4*smoothstep(br*0.4,br*0.95,bd))/(1.0+1.5*bblur);
    vec3 tint=mix(vec3(0.7,0.85,1.0),u_ember,step(0.4,h21(cid+11.0)));
    col+=tint*disc*(0.5+0.8*edge);
  }

  return col;
}

void main(){
  vec2 px=vec2(gl_FragCoord.x, u_res.y-gl_FragCoord.y);
  float mn=min(u_res.x,u_res.y);
  vec3 col;
  if(u_chroma>0.001){
    vec2 off=(px-0.5*u_res)*0.024*u_chroma;
    col=vec3(scene(px+off).r, scene(px).g, scene(px-off).b);
  } else col=scene(px);
  vec3 lit=pow(vec3(1.0)-exp(-col*u_expo),vec3(1.0/1.15));
  if(u_transparent>0.5){
    float a=clamp(max(lit.r,max(lit.g,lit.b)),0.0,1.0);
    fragColor=vec4(lit,a); // premultiplied: lit is already colour x alpha
    return;
  }
  vec2 cq=vec2(px.x-u_centre.x*u_res.x, px.y-u_centre.y*u_res.y)/mn;
  float gr=length(cq);
  // Background: one colour, or a gradient from Background to Background 2 — linear at an angle
  // (0 = left to right, 90 = top to bottom) or radial from the picture centre out to its corners.
  vec3 bg=u_bg;
  if(u_bgMode>0.5){
    vec2 uv=px/u_res-0.5; float t;
    if(u_bgMode<1.5){ float a=u_bgAngle*0.0174533; vec2 dir=vec2(cos(a),sin(a));
      t=clamp(dot(uv*u_res/mn,dir)/(0.5*(abs(dir.x)*u_res.x+abs(dir.y)*u_res.y)/mn)*0.5+0.5,0.0,1.0); }
    else t=clamp(length(uv*u_res/mn)/(0.5*length(u_res)/mn),0.0,1.0);
    bg=mix(u_bg,u_bg2,smoothstep(0.0,1.0,t));
  }
  bg+=u_glowCol*u_glow*(0.85*exp(-gr*gr/0.18)+0.25*exp(-gr/0.9));
  fragColor=vec4(clamp(bg+lit*(vec3(1.0)-bg*0.5),0.0,1.0),1.0);
}`;

/* The same numbers as the Figma shader, so the two render the same look. */
const DEFAULTS=Object.freeze({
  cx:0.5, cy:0.38, coreSize:1.5, coreBrightness:1, rays:3, rayLength:0.45, rayAngle:90, streak:0.9,
  haloSize:0.42, haloThickness:0.012, rainbow:0.8, haloSquash:0.38, haloTilt:-12,
  speedStreaks:0.25, streakLength:0.6, embers:0.35, emberSize:1, lightLeak:0.6, bokeh:0.4, dust:0.25,
  focus:0.65, aperture:0.8, chromatic:0, glow:0, glowColor:'#1f4f8f', bgMode:'solid', bg2:'#0b1a33', bgAngle:90, warmth:0.4, exposure:1.2, seed:1, emberColor:'#ff8c26', bg:'#03050d', transparent:false,
});
const MAX_SIDE=1400;
/* While a slider is being dragged: fewer pixels, fast enough to follow the hand. */
const DRAFT_SIDE=520;
const CACHE_MAX=8;
const U_NAMES=['res','centre','core','coreBright','rays','rayLen','rayAngle','streak','ringR','ringW','rainbow','squash','tilt',
  'speed','speedLen','embers','emberSize','dust','warm','seed','expo','transparent','leak','bokeh','focus','aperture','chroma','glow','bg','ember','glowCol','bg2','bgMode','bgAngle'];

let gl=null, cv=null, prog=null, vao=null, loc=null, failed=false;
const cache=new Map();

function init(){
  if(gl) return true;
  if(failed) return false;
  try{
    cv=document.createElement('canvas');
    gl=cv.getContext('webgl2',{preserveDrawingBuffer:true,antialias:false,alpha:true});
    if(!gl) throw new Error('WebGL2 unavailable');
    const compile=(t,s)=>{
      const sh=gl.createShader(t); gl.shaderSource(sh,s); gl.compileShader(sh);
      if(!gl.getShaderParameter(sh,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      return sh;
    };
    prog=gl.createProgram();
    gl.attachShader(prog,compile(gl.VERTEX_SHADER,VERT));
    gl.attachShader(prog,compile(gl.FRAGMENT_SHADER,FRAG));
    gl.linkProgram(prog);
    if(!gl.getProgramParameter(prog,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    vao=gl.createVertexArray(); gl.bindVertexArray(vao);
    const buf=gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER,buf);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1, 3,-1, -1,3]),gl.STATIC_DRAW);
    const a=gl.getAttribLocation(prog,'a_pos');
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a,2,gl.FLOAT,false,0,0);
    loc={};
    U_NAMES.forEach(k=>{ loc[k]=gl.getUniformLocation(prog,'u_'+k); });
    return true;
  }catch(e){
    console.warn('light burst engine disabled:',e.message);
    failed=true; gl=null; return false;
  }
}

function hexRgb(hex){
  const n=parseInt(String(hex||'#000000').slice(1),16)||0;
  return [((n>>16)&255)/255,((n>>8)&255)/255,(n&255)/255];
}

/** Render for a w x h box. Returns a canvas (possibly smaller than the box —
 *  draw it scaled into it) or null if unavailable. */
function render(w,h,P){
  if(!init()) return null;
  P=Object.assign({},DEFAULTS,P||{});
  let W=Math.max(2,Math.round(w)), H=Math.max(2,Math.round(h));
  const k=Math.min(1,(P.draft?DRAFT_SIDE:MAX_SIDE)/Math.max(W,H));
  W=Math.max(2,Math.round(W*k)); H=Math.max(2,Math.round(H*k));
  const key=[W,H].concat(Object.keys(DEFAULTS).map(n=>P[n])).join('|');
  const hit=cache.get(key);
  if(hit){ cache.delete(key); cache.set(key,hit); return hit; }

  if(cv.width!==W||cv.height!==H){ cv.width=W; cv.height=H; }
  gl.viewport(0,0,W,H);
  gl.useProgram(prog);
  gl.bindVertexArray(vao);
  const n=(v,d)=>Number.isFinite(+v)?+v:d, D=DEFAULTS, f=(key)=>gl.uniform1f(loc[key[0]],n(P[key[1]],D[key[1]]));
  gl.uniform2f(loc.res,W,H);
  gl.uniform2f(loc.centre,n(P.cx,D.cx),n(P.cy,D.cy));
  [['core','coreSize'],['coreBright','coreBrightness'],['rays','rays'],['rayLen','rayLength'],['rayAngle','rayAngle'],
   ['streak','streak'],['ringR','haloSize'],['ringW','haloThickness'],['rainbow','rainbow'],['squash','haloSquash'],
   ['tilt','haloTilt'],['speed','speedStreaks'],['speedLen','streakLength'],['embers','embers'],['emberSize','emberSize'],
   ['dust','dust'],['warm','warmth'],['seed','seed'],['expo','exposure'],['leak','lightLeak'],['bokeh','bokeh'],
   ['focus','focus'],['aperture','aperture'],['chroma','chromatic'],['glow','glow']].forEach(f);
  gl.uniform1f(loc.transparent,P.transparent?1:0);
  gl.uniform3fv(loc.bg,hexRgb(P.bg));
  gl.uniform3fv(loc.ember,hexRgb(P.emberColor));
  gl.uniform3fv(loc.glowCol,hexRgb(P.glowColor));
  gl.uniform3fv(loc.bg2,hexRgb(P.bg2));
  gl.uniform1f(loc.bgMode,({solid:0,linear:1,radial:2})[P.bgMode]||0);
  gl.uniform1f(loc.bgAngle,n(P.bgAngle,D.bgAngle));
  gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES,0,3);

  // the GL canvas is shared, so what goes in the cache is a 2D copy
  const out=document.createElement('canvas');
  out.width=W; out.height=H;
  out.getContext('2d').drawImage(cv,0,0);
  cache.set(key,out);
  while(cache.size>CACHE_MAX) cache.delete(cache.keys().next().value);
  return out;
}

window.LightBurstEngine={render,available:()=>init(),DEFAULTS};
})();
