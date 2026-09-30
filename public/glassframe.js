/* Glass Frame — a ray-marched glass ring or square frame (material slot).
 *
 * PROVENANCE. Written for this app on 30 Sep 2026 as a WebGL2 port of the
 * author's own Figma shader "Iridescent Glass Frame" (WGSL, same session). The
 * maths is carried across line for line; only the plumbing changed. Nothing
 * here is derived from Shadertoy or any other licensed source — see
 * SHADER-PROVENANCE.md.
 *
 * WHAT IT IS. One SDF: a rounded rectangle profile swept around an axis, where
 * the sweep's "radius" is a superellipse norm. Squareness 0 is a circle (a
 * ring), 1 is a rounded square (a frame). Each pixel traces 16 wavelengths,
 * each with its own index of refraction, through up to six surface events —
 * reflect, refract in, march inside, refract out or reflect internally — so
 * the rainbow edges are real dispersion, not a gradient painted on.
 *
 * WHERE THE COLOUR COMES FROM. Glass has none. The environment is a dark
 * studio with white softboxes plus a banded holographic wash; dispersion
 * splits the softboxes into rainbows and the wash gives the faces colour.
 * `hue` slides the wash, which is what moves the bands across the glass.
 *
 * WHY IT IS A MATERIAL. It generates its own pixels and never reads the page,
 * so it caches: a trace is expensive (~0.2 s at 640 px), and the cache means
 * it runs once per parameter change, not once per repaint.
 */
(function(){
"use strict";

const VERT=`#version 300 es
in vec2 a_pos;
void main(){ gl_Position=vec4(a_pos,0.0,1.0); }`;

const FRAG=`#version 300 es
precision highp float;
uniform vec2 u_res;
uniform vec3 u_rot;
uniform float u_holeOn;
uniform float u_ior, u_disp, u_irid, u_film, u_depth, u_hole, u_bub, u_scr, u_expo, u_sq, u_hue;
uniform vec4 u_bg;
out vec4 fragColor;

mat3 M;

mat3 rotX(float a){ float c=cos(a), s=sin(a); return mat3(vec3(1.0,0.0,0.0), vec3(0.0,c,s), vec3(0.0,-s,c)); }
mat3 rotY(float a){ float c=cos(a), s=sin(a); return mat3(vec3(c,0.0,-s), vec3(0.0,1.0,0.0), vec3(s,0.0,c)); }
mat3 rotZ(float a){ float c=cos(a), s=sin(a); return mat3(vec3(c,s,0.0), vec3(-s,c,0.0), vec3(0.0,0.0,1.0)); }

float hash3(vec3 p){ return fract(sin(dot(p, vec3(127.1,311.7,74.7)))*43758.5453); }
float hash2(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }

vec3 spectrum(float x){
  return clamp(0.5+0.5*cos(6.2831853*(x+vec3(0.0,0.33,0.67))), 0.0, 1.0);
}

float sdRing(vec3 pw){
  vec3 p=M*pw;
  float outerR=1.0, innerR=u_hole, h=u_depth, rad=0.07;
  float mid=(outerR+innerR)*0.5, hw=(outerR-innerR)*0.5;
  float n=mix(2.0,10.0,u_sq);
  vec2 ax=abs(p.xz)+vec2(1e-5);
  float rl=pow(pow(ax.x,n)+pow(ax.y,n),1.0/n);
  vec2 q=vec2(rl-mid,p.y);
  vec2 dd=abs(q)-vec2(hw-rad,h-rad);
  // Hole off: the same rounded profile, but running all the way to the axis.
  vec2 ds=vec2(rl-(outerR-rad),abs(p.y)-(h-rad));
  dd=mix(ds,dd,step(0.5,u_holeOn));
  return length(max(dd,vec2(0.0)))+min(max(dd.x,dd.y),0.0)-rad;
}

vec3 calcN(vec3 p){
  float e=0.003; // wider than the march epsilon: the superellipse norm is not an exact distance, and a tight probe picks up its error as rim noise
  vec3 k1=vec3(1.0,-1.0,-1.0), k2=vec3(-1.0,-1.0,1.0), k3=vec3(-1.0,1.0,-1.0), k4=vec3(1.0);
  return normalize(k1*sdRing(p+k1*e)+k2*sdRing(p+k2*e)+k3*sdRing(p+k3*e)+k4*sdRing(p+k4*e));
}

float fresnel(float cosi, float ior){
  float r0=(ior-1.0)/(ior+1.0); float f0=r0*r0;
  return f0+(1.0-f0)*pow(1.0-cosi,5.0);
}

float softbox(vec3 d, vec3 c, float size){
  return smoothstep(cos(size), cos(size*0.55), dot(d, normalize(c)));
}

vec3 env(vec3 d){
  vec3 c=vec3(0.01);
  vec3 wash=spectrum(d.x*0.55+d.y*0.35+d.z*0.2+u_hue);
  float band=pow(0.5+0.5*sin((d.x*1.7+d.y*1.1-d.z*0.6)*4.0),3.0);
  c+=wash*wash*2.4*band*(0.3+0.7*smoothstep(-0.8,0.4,d.z));
  c+=vec3(1.0)*7.0*softbox(d,vec3(-0.8,0.45,0.4),0.38);
  c+=vec3(1.0)*5.0*softbox(d,vec3(0.9,0.1,0.25),0.3);
  c+=vec3(1.0)*8.0*softbox(d,vec3(0.1,1.0,0.15),0.25);
  c+=vec3(1.0,0.85,0.6)*3.0*softbox(d,vec3(0.25,-0.9,0.3),0.4);
  c+=vec3(1.0)*2.5*softbox(d,vec3(0.35,0.2,-1.0),0.3);
  c+=vec3(1.0)*2.0*softbox(d,vec3(-0.5,-0.4,-0.8),0.25);
  return c;
}

vec3 wlColor(float x){
  return vec3(
    max(0.0,1.0-abs(x-0.12)/0.3)+max(0.0,1.0-abs(x-1.0)/0.15)*0.4,
    max(0.0,1.0-abs(x-0.48)/0.3),
    max(0.0,1.0-abs(x-0.85)/0.3));
}

float scratch(vec3 p){
  float s=0.0;
  for(int i=0;i<3;i++){
    float fi=float(i), a=fi*2.1+0.4;
    vec3 dir=normalize(vec3(cos(a),sin(a*1.7),sin(a)));
    vec3 dir2=normalize(cross(dir,vec3(0.3,0.7,0.2)));
    float x=dot(p,dir)*38.0;
    float cell=floor(x), seg=floor(dot(p,dir2)*5.0);
    float h=hash2(vec2(cell+fi*17.0,seg));
    float line=1.0-smoothstep(0.0,0.05,abs(fract(x)-0.5-(h-0.5)*0.8));
    s+=line*step(0.86,h);
  }
  return s;
}

float bubbles(vec3 p){
  vec3 q=p*16.0, c=floor(q), f=fract(q);
  float h=hash3(c);
  vec3 center=vec3(hash3(c+1.3),hash3(c+2.7),hash3(c+5.1))*0.8+0.1;
  float rad=0.03+0.07*hash3(c+9.2);
  return step(0.72,h)*(1.0-smoothstep(rad*0.5,rad,length(f-center)));
}

float march(vec3 ro, vec3 rd){
  float t=0.0;
  for(int i=0;i<120;i++){
    float d=sdRing(ro+rd*t);
    if(d<0.0008) return t;
    t+=d*0.8;
    if(t>12.0) break;
  }
  return -1.0;
}

vec3 trace(vec3 ro, vec3 rd, float ior){
  vec3 w=vec3(1.0), col=vec3(0.0);
  bool inside=false;
  for(int ev=0;ev<6;ev++){
    if(!inside){
      float t=march(ro,rd);
      if(t<0.0){ col+=w*env(rd); return col; }
      vec3 p=ro+rd*t, n=calcN(p);
      float cosi=clamp(dot(-rd,n),0.0,1.0);
      float F=fresnel(cosi,ior);
      vec3 film=mix(vec3(1.0),spectrum(u_film*cosi+0.15),u_irid);
      float sc=scratch(M*p)*u_scr;
      col+=w*(F*env(reflect(rd,n))*film*1.6+sc*0.35*vec3(1.0));
      w*=(1.0-F)*mix(vec3(1.0),film,0.6);
      rd=refract(rd,n,1.0/ior);
      ro=p-n*0.003;
      inside=true;
    }else{
      float t=0.0;
      for(int i=0;i<64;i++){
        float d=-sdRing(ro+rd*t);
        if(d<0.0008) break;
        t+=max(d*0.8,0.002);
        if(t>6.0) break;
      }
      vec3 p=ro+rd*t;
      float bsum=0.0;
      for(int k=0;k<10;k++) bsum+=bubbles(M*(ro+rd*(t*(float(k)+0.5)/10.0)));
      col+=w*bsum*0.18*u_bub;
      w*=exp(-t*vec3(0.12,0.05,0.12));
      vec3 n=calcN(p);
      vec3 rOut=refract(rd,-n,ior);
      if(dot(rOut,rOut)<0.0001){
        rd=reflect(rd,-n); ro=p-n*0.003;
      }else{
        w*=(1.0-fresnel(clamp(dot(rOut,n),0.0,1.0),ior));
        rd=rOut; ro=p+n*0.003; inside=false;
      }
    }
  }
  return col+w*env(rd)*0.5;
}

void main(){
  M=transpose(rotZ(u_rot.z)*rotY(u_rot.y)*rotX(u_rot.x));
  float mn=min(u_res.x,u_res.y);
  // FIT on the shorter side, y up: a tall or wide box keeps the whole solid.
  vec2 sc0=(gl_FragCoord.xy-0.5*u_res)*2.0/mn;
  vec3 ro=vec3(0.0,0.0,5.0);
  float px=2.0/mn;
  bool near=march(ro,normalize(vec3(sc0*0.36,-1.0)))>0.0;
  vec3 sum=vec3(0.0), wsum=vec3(0.0);
  float cover=0.0;
  // NO per-pixel random jitter: it turned the dispersion into coloured
  // speckle. Wavelengths are fixed and evenly spaced; each also takes a fixed
  // sub-pixel offset (golden-angle spiral), so the 16 samples double as AA.
  for(int k=0;k<16;k++){
    float fk=(float(k)+0.5)/16.0;
    float ang=float(k)*2.39996;
    vec2 jit=vec2(cos(ang),sin(ang))*sqrt(fk)*px*0.6;
    vec3 rd=normalize(vec3((sc0+jit)*0.36,-1.0));
    vec3 wl=wlColor(fk);
    float ior=u_ior+u_disp*(fk-0.5)*2.0;
    vec3 c=u_bg.rgb;
    if(near||march(ro,rd)>0.0){
      if(march(ro,rd)>0.0){ c=trace(ro,rd,ior); cover+=1.0; }
    }
    sum+=c*wl; wsum+=wl;
  }
  vec3 col=sum/max(wsum,vec3(0.001));
  float covered=cover/16.0;
  vec3 lit=pow(vec3(1.0)-exp(-col*u_expo),vec3(1.0/2.2));
  vec3 outc=mix(u_bg.rgb,lit,covered);
  float a=mix(u_bg.a,1.0,covered);
  fragColor=vec4(outc*a,a); // premultiplied: the canvas is
}`;

/* Defaults the app, tests and any caller agree on. Same numbers as the
 * published Figma shader so the two render the same look. */
const DEFAULTS=Object.freeze({
  squareness:1, holeOn:true, tiltX:65, tiltY:-45, spin:-15, depth:0.5, hole:0.72,
  ior:1.5, dispersion:0.28, iridescence:0.85, film:2.5, hue:0.1,
  bubbles:0.6, scratches:0.15, exposure:1.3, bg:'#000000', transparent:false,
});
/* Longest side actually traced. Above this the canvas is upscaled when drawn:
 * a 2000 px box would otherwise block the page for seconds per change. */
const MAX_SIDE=1200;
/* While a slider is being dragged: fewer pixels, fast enough to follow the hand. */
const DRAFT_SIDE=480;
const CACHE_MAX=8;

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
    const U=n=>gl.getUniformLocation(prog,n);
    loc={};
    ['res','holeOn','rot','ior','disp','irid','film','depth','hole','bub','scr','expo','sq','hue','bg']
      .forEach(k=>{ loc[k]=U('u_'+k); });
    return true;
  }catch(e){
    console.warn('glass frame engine disabled:',e.message);
    failed=true; gl=null; return false;
  }
}

function hexRgb(hex){
  const n=parseInt(String(hex||'#000000').slice(1),16)||0;
  return [((n>>16)&255)/255,((n>>8)&255)/255,(n&255)/255];
}

/** Render into a canvas for a w x h box. Returns a canvas (possibly smaller
 *  than w x h — draw it scaled into the box) or null if unavailable. */
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
  const deg=Math.PI/180, n=(v,d)=>Number.isFinite(+v)?+v:d;
  const bg=hexRgb(P.bg);
  gl.uniform2f(loc.res,W,H);
  gl.uniform3f(loc.rot,n(P.tiltX,65)*deg,n(P.tiltY,-45)*deg,n(P.spin,-15)*deg);
  gl.uniform1f(loc.ior,n(P.ior,1.5));
  gl.uniform1f(loc.disp,n(P.dispersion,0.28));
  gl.uniform1f(loc.irid,n(P.iridescence,0.85));
  gl.uniform1f(loc.film,n(P.film,2.5));
  gl.uniform1f(loc.depth,n(P.depth,0.5));
  gl.uniform1f(loc.hole,n(P.hole,0.72));
  gl.uniform1f(loc.holeOn,P.holeOn===false?0:1);
  gl.uniform1f(loc.bub,n(P.bubbles,0.6));
  gl.uniform1f(loc.scr,n(P.scratches,0.15));
  gl.uniform1f(loc.expo,n(P.exposure,1.3));
  gl.uniform1f(loc.sq,n(P.squareness,1));
  gl.uniform1f(loc.hue,n(P.hue,0.1));
  gl.uniform4f(loc.bg,bg[0],bg[1],bg[2],P.transparent?0:1);
  gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES,0,3);

  // The GL canvas is shared, so what goes in the cache is a 2D copy.
  const out=document.createElement('canvas');
  out.width=W; out.height=H;
  out.getContext('2d').drawImage(cv,0,0);
  cache.set(key,out);
  while(cache.size>CACHE_MAX) cache.delete(cache.keys().next().value);
  return out;
}

window.GlassFrameEngine={render,available:()=>init(),DEFAULTS};
})();
