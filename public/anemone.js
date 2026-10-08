/* Anemone Tunnel — a 3D tunnel of soft jelly fingers (material slot).
 *
 * PROVENANCE. Written for this app on 8 Oct 2026 as a WebGL2 port of the
 * author's own Figma shader "Anemone Tunnel" (WGSL, same session), itself
 * tuned side by side against a reference. Nothing here is derived from
 * Shadertoy or any other licensed source — see SHADER-PROVENANCE.md.
 *
 * TWO PASSES.
 *  1. SCENE — ray-marched. One curled finger (two capsules, smoothly joined)
 *     is defined once and repeated round the tunnel and along its depth, so
 *     thousands cost about one. Lit like the reference: a soft key from the
 *     camera side, light from the opening that turns deep fingers and tips
 *     pale lime, fake translucency through thin parts, a rim, gap shadows,
 *     coloured ambient, and haze into the water. Depth rides out in alpha.
 *  2. LENS — a thin-lens blur that reads that depth: each sample spreads onto
 *     a pixel only if its own blur circle reaches it, so near fingers soften
 *     and the focused band stays crisp, without the grain of jittered rays.
 *
 * WHY IT IS A MATERIAL. It generates its own pixels and caches: a render is
 * a fraction of a second, so it runs once per parameter change.
 */
(function(){
"use strict";

const VERT=`#version 300 es
in vec2 a;
void main(){ gl_Position=vec4(a,0.0,1.0); }`;

const SCENE=`#version 300 es
precision highp float;
uniform vec2 R;
uniform vec4 u_a,u_b,u_c,u_d,u_e;
uniform vec3 u_near,u_deep,u_haze;
out vec4 o;
#define DEPTH u_a.x
#define PER u_a.y
#define SP u_a.z
#define LEN u_a.w
#define TH u_b.x
#define CURL u_b.y
#define LEAN u_b.z
#define TWIST u_b.w
#define VARY u_c.x
#define WOB u_c.y
#define PHASE u_c.z
#define LIGHT u_c.w
#define TRANS u_d.x
#define RIM u_d.y
#define AO u_d.z
#define GLOW u_d.w
#define HAZE u_e.x
#define FOV u_e.y
#define BUB u_e.z
#define EXPO u_e.w
const float WALL=1.0;
float h(vec2 p){ vec2 q=fract(p*vec2(123.34,456.21)); q+=dot(q,q+45.32); return fract(q.x*q.y); }
float vnoise(float x){ float i=floor(x), f=fract(x); return mix(h(vec2(i,7.0)),h(vec2(i+1.0,7.0)),f*f*(3.0-2.0*f)); }
float smin(float a,float b,float k){ float hh=clamp(0.5+0.5*(b-a)/k,0.0,1.0); return mix(b,a,hh)-k*hh*(1.0-hh); }
float sdCap(vec3 p, vec3 a, vec3 b, float r){ vec3 pa=p-a, ba=b-a; float t=clamp(dot(pa,ba)/dot(ba,ba),0.0,1.0); return length(pa-ba*t)-r; }
// one curled finger: root on the wall -> a bent middle -> a rounded tip,
// pointing in toward the axis and leaning toward the camera
float finger(vec3 p, float k, float j){
  float zk=k*SP;
  if(k<0.0||zk>DEPTH) return 1e3;
  vec2 id=vec2(k,j);
  float off=mod(k,2.0)*0.5;
  float a=(j+off+(h(id)-0.5)*VARY*0.7)/PER*6.2831853+TWIST*zk;
  // the opening is not a circle: finger length follows a slow wobble round it
  float wob=1.0+WOB*(vnoise(a*1.6+zk*0.7)-0.5)*1.2;
  float L=LEN*wob*(0.75+0.5*h(id+3.1)*VARY);
  float r=TH*(0.85+0.3*h(id+7.7));
  vec2 dir=vec2(cos(a),sin(a)), tan2=vec2(-dir.y,dir.x);
  float sway=(0.5+0.5*sin(PHASE+zk*1.9+j*0.8))*VARY;
  vec3 root=vec3(dir*WALL, zk);
  vec3 mid=root+vec3(-dir*L*0.55+tan2*CURL*L*0.25*(0.5+sway), -LEAN*L*0.4);
  vec3 tip=mid+vec3(-dir*L*0.45+tan2*CURL*L*0.45*(0.4+sway), -LEAN*L*0.6);
  return smin(sdCap(p,root,mid,r*1.05),sdCap(p,mid,tip,r),0.03);
}
float map(vec3 p){
  float a=atan(p.y,p.x);
  float k0=floor(p.z/SP+0.5);
  float best=1e3;
  for(int dk=-1;dk<=1;dk++){
    float k=k0+float(dk);
    float zk=k*SP;
    float off=mod(k,2.0)*0.5;
    float j0=floor((a-TWIST*zk)/6.2831853*PER-off+0.5);
    for(int dj=-2;dj<=2;dj++){
      float j=mod(j0+float(dj),PER);
      best=min(best,finger(p,k,j));
    }
  }
  return min(best,WALL+0.03-length(p.xy));
}
vec3 nrm(vec3 p){ vec2 e=vec2(0.0015,0.0);
  return normalize(vec3(map(p+e.xyy)-map(p-e.xyy),map(p+e.yxy)-map(p-e.yxy),map(p+e.yyx)-map(p-e.yyx))); }
// the open water beyond: the light source of the whole scene
vec3 water(vec3 rd){
  float c=length(rd.xy/max(rd.z,0.2));
  return mix(u_haze*0.95,u_haze*0.6,smoothstep(0.0,0.9,c));
}
void main(){
  vec2 uv=(gl_FragCoord.xy-0.5*R)/R.y;
  vec3 ro=vec3(0.0,0.0,-0.35);
  vec3 rd=normalize(vec3(uv*FOV,1.0));
  float t=0.05; bool hit=false;
  for(int i=0;i<120;i++){
    float d=map(ro+rd*t);
    if(d<0.0012){ hit=true; break; }
    t+=d*0.85;
    if(t>DEPTH+3.0) break;
  }
  vec3 bg=water(rd);
  vec3 col;
  float tt=hit?t:DEPTH+3.0;
  if(!hit) col=bg;
  else{
    vec3 p=ro+rd*t, n=nrm(p);
    float dz=clamp(p.z/DEPTH,0.0,1.0);
    // how much light from the opening reaches this depth: deep fingers sit in
    // it and go pale lime, near ones stay deep green
    // ...and on the TIPS: the parts reaching toward the centre catch the light
    // from the opening, so the whole inner area glows pale
    float inward=clamp(1.0-length(p.xy),0.0,1.0);
    float lit=clamp(pow(dz,0.8)+inward*0.3*sqrt(dz+0.05),0.0,1.0);
    vec3 alb=mix(u_near,u_deep,lit);
    vec3 toLight=normalize(vec3(0.25,0.45,-1.0));   // soft key from the camera side
    vec3 toOpen=normalize(vec3(-p.xy*0.6,1.0));      // the glow from the opening
    float key=0.5+0.5*dot(n,toLight);
    float open=max(dot(n,toOpen),0.0);
    // gap shadow: how buried this point is among its neighbours
    float occ=0.0, sc=1.0;
    for(int i=1;i<=4;i++){ float hh=0.03*float(i); occ+=(hh-map(p+n*hh))*sc; sc*=0.6; }
    occ=clamp(1.0-occ*6.0*AO,0.2,1.0);
    // translucency: thin parts let the opening's light through
    float thin=clamp(1.0+(map(p-n*0.05)+map(p-n*0.1))/0.1,0.0,1.0);
    vec3 amb=mix(u_haze*0.35,u_deep*0.3,lit);           // shadows take the water's colour
    col=alb*(amb+key*0.75*LIGHT)*occ;
    // a soft sheen on the tops, like wet jelly
    col+=vec3(0.9,1.0,0.85)*pow(max(dot(reflect(rd,n),toLight),0.0),12.0)*0.18*LIGHT*occ;
    col+=alb*u_deep*TRANS*thin*(0.25+0.9*lit)*0.6;
    col+=mix(u_haze,u_deep,0.6)*GLOW*open*(0.15+0.85*lit)*0.45*occ;
    float fr=pow(1.0-max(dot(n,-rd),0.0),3.0);
    col+=mix(u_haze,vec3(1.0),0.5)*RIM*fr*0.35*(0.4+0.6*lit);
    // haze: colours fade into the water with distance
    col=mix(col,bg,(1.0-exp(-t*HAZE*0.35))*smoothstep(0.3,1.0,dz));
  }
  // bubbles drift at their own depths; the lens pass blurs them by depth too
  for(int b=0;b<16;b++){
    vec2 id=vec2(float(b),3.0);
    if(h(id)>BUB) continue;
    vec2 bp=(vec2(h(id+1.0),h(id+2.0))-0.5)*vec2(R.x/R.y,1.0)*0.95;
    float bz=0.4+3.0*h(id+4.0);
    float br=(0.006+0.012*h(id+5.0))/bz*1.5;
    float d=length(uv-bp);
    if(d<br&&bz<tt){ col=mix(col,vec3(0.85,1.0,0.95),smoothstep(br,br*0.4,d)*0.5); tt=bz; }
  }
  col=vec3(1.0)-exp(-col*1.6*EXPO);
  // a touch more colour: the tone curve above greys saturated greens
  float lum=dot(col,vec3(0.299,0.587,0.114));
  col=clamp(mix(vec3(lum),col,1.35),0.0,1.0);
  // depth travels with the colour so the lens pass can blur by it
  o=vec4(pow(col,vec3(0.95)),clamp(tt/12.0,0.0,1.0));
}`;

const LENS=`#version 300 es
precision highp float;
uniform sampler2D S;
uniform vec2 R;
uniform float u_focus,u_ap,u_maxr;
out vec4 o;
float coc(float dn){ float d=max(dn*12.0,0.05); return min(u_ap*abs(d-u_focus)/d*R.y*0.02,u_maxr); }
void main(){
  vec2 px=gl_FragCoord.xy;
  vec4 c0=texture(S,px/R);
  float r0=coc(c0.a);
  vec3 acc=c0.rgb; float w=1.0;
  const int N=72;
  for(int i=0;i<N;i++){
    float fi=float(i)+0.5;
    float rr=sqrt(fi/float(N))*u_maxr, th=fi*2.39996;
    vec2 off=vec2(cos(th),sin(th))*rr;
    vec4 s=texture(S,(px+off)/R);
    float rs=coc(s.a);
    // a sample spreads onto this pixel if its own blur circle reaches here;
    // something behind a sharp subject may not spill over it
    float reach=s.a>c0.a?min(rs,r0):rs;
    float ws=smoothstep(rr-1.5,rr+0.5,reach);
    acc+=s.rgb*ws; w+=ws;
  }
  o=vec4(acc/w,1.0);
}`;

/* The Figma shader's numbers, so the two render the same look. */
const DEFAULTS=Object.freeze({
  depth:2.6, fingers:16, spacing:0.24, length:0.5, thickness:0.075, curl:0.25, lean:0.15, twist:0.45,
  variation:0.7, wobble:0.35, phase:0, light:1, translucency:0.9, rim:0.6, gapShadow:0.7, glow:1,
  haze:0.35, focus:2.2, aperture:0.9, fov:0.95, bubbles:0.5, exposure:1.1,
  nearColor:'#0b5c45', deepColor:'#dcef8a', waterColor:'#3a8a98',
});
const MAX_SIDE=1000;
/* While a slider is being dragged: fewer pixels, fast enough to follow the hand. */
const DRAFT_SIDE=420;
const CACHE_MAX=6;

let gl=null, cv=null, P1=null, P2=null, quad=null, tex=null, fb=null, texW=0, texH=0, failed=false;
const cache=new Map();

function program(fs){
  const sh=(t,s)=>{ const x=gl.createShader(t); gl.shaderSource(x,s); gl.compileShader(x);
    if(!gl.getShaderParameter(x,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x; };
  const p=gl.createProgram();
  gl.attachShader(p,sh(gl.VERTEX_SHADER,VERT)); gl.attachShader(p,sh(gl.FRAGMENT_SHADER,fs));
  gl.linkProgram(p);
  if(!gl.getProgramParameter(p,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

function init(){
  if(gl) return true;
  if(failed) return false;
  try{
    cv=document.createElement('canvas');
    gl=cv.getContext('webgl2',{preserveDrawingBuffer:true,antialias:false,alpha:true});
    if(!gl) throw new Error('WebGL2 unavailable');
    P1=program(SCENE); P2=program(LENS);
    quad=gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,quad);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1, 3,-1, -1,3]),gl.STATIC_DRAW);
    tex=gl.createTexture(); fb=gl.createFramebuffer();
    return true;
  }catch(e){
    console.warn('anemone tunnel engine disabled:',e.message);
    failed=true; gl=null; return false;
  }
}

function use(p){
  gl.useProgram(p);
  const a=gl.getAttribLocation(p,'a');
  gl.bindBuffer(gl.ARRAY_BUFFER,quad); gl.enableVertexAttribArray(a);
  gl.vertexAttribPointer(a,2,gl.FLOAT,false,0,0);
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
  if(texW!==W||texH!==H){
    gl.bindTexture(gl.TEXTURE_2D,tex);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,W,H,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER,fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,tex,0);
    texW=W; texH=H;
  }
  const n=(key,lo)=>{ const v=+P[key]; return Number.isFinite(v)?v:(lo!==undefined?lo:DEFAULTS[key]); };
  // pass 1: the scene, colour + depth, into the texture
  gl.bindFramebuffer(gl.FRAMEBUFFER,fb);
  gl.viewport(0,0,W,H);
  use(P1);
  const U=s=>gl.getUniformLocation(P1,s);
  gl.uniform2f(U('R'),W,H);
  gl.uniform4f(U('u_a'),n('depth'),n('fingers'),n('spacing'),n('length'));
  gl.uniform4f(U('u_b'),n('thickness'),n('curl'),n('lean'),n('twist'));
  gl.uniform4f(U('u_c'),n('variation'),n('wobble'),n('phase'),n('light'));
  gl.uniform4f(U('u_d'),n('translucency'),n('rim'),n('gapShadow'),n('glow'));
  gl.uniform4f(U('u_e'),n('haze'),n('fov'),n('bubbles'),n('exposure'));
  gl.uniform3fv(U('u_near'),hexRgb(P.nearColor));
  gl.uniform3fv(U('u_deep'),hexRgb(P.deepColor));
  gl.uniform3fv(U('u_haze'),hexRgb(P.waterColor));
  gl.drawArrays(gl.TRIANGLES,0,3);
  // pass 2: the lens, reading that depth
  gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  gl.viewport(0,0,W,H);
  use(P2);
  const V=s=>gl.getUniformLocation(P2,s);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,tex);
  gl.uniform1i(V('S'),0);
  gl.uniform2f(V('R'),W,H);
  gl.uniform1f(V('u_focus'),n('focus'));
  gl.uniform1f(V('u_ap'),n('aperture'));
  gl.uniform1f(V('u_maxr'),Math.max(4,H*0.06));
  gl.drawArrays(gl.TRIANGLES,0,3);

  const out=document.createElement('canvas');
  out.width=W; out.height=H;
  out.getContext('2d').drawImage(cv,0,0);
  cache.set(key,out);
  while(cache.size>CACHE_MAX) cache.delete(cache.keys().next().value);
  return out;
}

window.AnemoneEngine={render,available:()=>init(),DEFAULTS};
})();
