/* Liquid Gradient — a warped multi-point colour field (§4.x material slot).
 *
 * PROVENANCE. Ported from the author's own standalone liquid-gradient.html.
 * The fragment shader is carried across essentially verbatim; only the
 * plumbing changed (see below). Nothing here is derived from Shadertoy or any
 * other licensed source — see SHADER-PROVENANCE.md. Two pieces of published
 * mathematics are used and are credited there rather than claimed: Björn
 * Ottosson's OKLab transform matrices (public domain), and the standard
 * quintic-smoothstep gradient-noise construction.
 *
 * WHAT IT IS. N colour points are blended by inverse-distance (Shepard)
 * weighting, and the SAMPLE POSITION is displaced first by a chain of warps.
 * The blend happens in OKLab rather than sRGB, which is why the midpoint
 * between two saturated colours stays saturated instead of passing through
 * grey — the single most visible difference from an ordinary mesh gradient.
 *
 * WARPS CHAIN, THEY DO NOT SUM. Each warp is evaluated at the position the one
 * above it produced, so Curl over Liquid curls an already-flowing field. Adding
 * two independent offsets gives a different, and much flatter, picture.
 *
 * WHY IT IS A MATERIAL AND NOT A BACKDROP EFFECT. It generates its own colour
 * from nothing, so it never reads the page beneath it. That also means it can
 * be cached like any other material — unlike glass, prism, capsule and strip.
 *
 * NO ANIMATION, DELIBERATELY. The standalone runs a clock. A document here is
 * static and must export as what you see, so `phase` is an ordinary parameter
 * that moves the field rather than a timer that animates it. Same maths, and
 * the result is reproducible.
 */
(function(){
"use strict";

const MAX=8;      // colour points
const SLOTS=3;    // chained warp slots
const WARPS=['none','liquid','curl','marble','wave'];

const VERT=`#version 300 es
in vec2 a_pos;
void main(){ gl_Position=vec4(a_pos,0.0,1.0); }`;

const FRAG=`#version 300 es
precision highp float;

uniform vec2  u_res;
uniform float u_time;
uniform int   u_detail;
uniform float u_power;
uniform float u_contrast;
uniform float u_grain;
uniform int   u_count;
uniform vec2  u_pts[${MAX}];
uniform vec3  u_cols[${MAX}];
uniform float u_sizes[${MAX}];
uniform int   u_wType[${SLOTS}];
uniform float u_wAmt[${SLOTS}];
uniform float u_wScale[${SLOTS}];

out vec4 fragColor;

// --- OKLab (Ottosson transform, published matrices) ---
vec3 linToOklab(vec3 c){
  float l = 0.4122214708*c.r + 0.5363325363*c.g + 0.0514459929*c.b;
  float m = 0.2119034982*c.r + 0.6806995451*c.g + 0.1073969566*c.b;
  float s = 0.0883024619*c.r + 0.2817188376*c.g + 0.6299787005*c.b;
  float l_ = pow(max(l,0.0), 1.0/3.0);
  float m_ = pow(max(m,0.0), 1.0/3.0);
  float s_ = pow(max(s,0.0), 1.0/3.0);
  return vec3(
    0.2104542553*l_ + 0.7936177850*m_ - 0.0040720468*s_,
    1.9779984951*l_ - 2.4285922050*m_ + 0.4505937099*s_,
    0.0259040371*l_ + 0.7827717662*m_ - 0.8086757660*s_);
}
vec3 oklabToLin(vec3 c){
  float l_ = c.x + 0.3963377774*c.y + 0.2158037573*c.z;
  float m_ = c.x - 0.1055613458*c.y - 0.0638541728*c.z;
  float s_ = c.x - 0.0894841775*c.y - 1.2914855480*c.z;
  float l = l_*l_*l_, m = m_*m_*m_, s = s_*s_*s_;
  return vec3(
     4.0767416621*l - 3.3077115913*m + 0.2309699292*s,
    -1.2684380046*l + 2.6097574011*m - 0.3413193965*s,
    -0.0041960863*l - 0.7034186147*m + 1.7076147010*s);
}

// --- noise ---------------------------------------------------------
float hash21(vec2 p){
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
vec2 hash22(vec2 p){
  vec2 k = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(k) * 43758.5453) * 2.0 - 1.0;
}
float gnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*f*(f*(f*6.0 - 15.0) + 10.0);
  float a = dot(hash22(i + vec2(0,0)), f - vec2(0,0));
  float b = dot(hash22(i + vec2(1,0)), f - vec2(1,0));
  float c = dot(hash22(i + vec2(0,1)), f - vec2(0,1));
  float d = dot(hash22(i + vec2(1,1)), f - vec2(1,1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 0.7 + 0.5;
}
float fbm(vec2 p, int oct){
  float v = 0.0, amp = 0.5, norm = 0.0;
  for(int i=0;i<6;i++){
    if(i >= oct) break;
    v += amp * gnoise(p);
    norm += amp;
    p *= 2.03; amp *= 0.5;
  }
  return v / max(norm, 1e-5);
}

// --- warps ---------------------------------------------------------
// Each returns a displacement in field units. They share a signature so
// the stack can dispatch on type without knowing what any of them do.

// Iterated fBm: the offset field is itself displaced by a second pass.
// Warping the warp is what separates "liquid" from "wobbly".
vec2 warpLiquid(vec2 p, float sc, int oct, float t){
  vec2 np = p * sc;
  vec2 q = vec2(fbm(np + t, oct), fbm(np + vec2(5.2,1.3) - t, oct));
  vec2 r = vec2(fbm(np + 3.0*q + vec2(1.7,9.2), oct),
                fbm(np + 3.0*q + vec2(8.3,2.8), oct));
  return r - 0.5;
}

// Curl of a scalar noise field: the PERPENDICULAR gradient, which makes
// the displacement divergence-free. Volume-preserving flow neither piles
// up nor tears, and that is the whole reason ink reads as fluid where an
// fBm warp reads as stretched putty. Same noise, rotated derivative.
vec2 warpCurl(vec2 p, float sc, int oct, float t){
  vec2 np = p * sc + t;
  const float e = 0.02;
  float dy = fbm(np + vec2(0.0, e), oct) - fbm(np - vec2(0.0, e), oct);
  float dx = fbm(np + vec2(e, 0.0), oct) - fbm(np - vec2(e, 0.0), oct);
  return vec2(dy, -dx) / (2.0 * e) * 0.25;
}

// A sine whose PHASE is perturbed by noise. The sine gives hard periodic
// banding, the noise bends the bands — which is exactly how stone veining
// and paper marbling look.
vec2 warpMarble(vec2 p, float sc, int oct, float t){
  float n = fbm(p * sc + t, oct);
  return vec2(sin((p.x * sc + n * 4.0) * 3.14159),
              sin((p.y * sc + n * 4.0) * 3.14159)) * 0.35;
}

// Plain orthogonal ripple. No noise at all — useful as a regular
// counterweight when the other slots are all organic.
vec2 warpWave(vec2 p, float sc, int oct, float t){
  return vec2(sin(p.y * sc * 6.2831 + t), cos(p.x * sc * 6.2831 + t)) * 0.35;
}

// Warps CHAIN rather than sum: each is evaluated at the position the one
// above it produced. Curl over Liquid curls the already-flowing field,
// which is a different picture from adding two independent offsets.
vec2 applyStack(vec2 p, int oct, float t){
  vec2 pos = p;
  for(int i=0;i<${SLOTS};i++){
    int ty = u_wType[i];
    float a = u_wAmt[i];
    if(ty == 0 || a <= 0.0) continue;
    float sc = u_wScale[i];
    vec2 d = vec2(0.0);
    if(ty == 1)      d = warpLiquid(pos, sc, oct, t);
    else if(ty == 2) d = warpCurl(pos, sc, oct, t);
    else if(ty == 3) d = warpMarble(pos, sc, oct, t);
    else if(ty == 4) d = warpWave(pos, sc, oct, t);
    pos += d * a;
  }
  return pos;
}

// Shepard blend, accumulated in OKLab so saturation survives the midpoint.
vec3 evalField(vec2 pos, float aspect){
  float w[${MAX}];
  float wmax = 0.0;
  for(int i=0;i<${MAX};i++){
    w[i] = 0.0;
    if(i >= u_count) continue;
    vec2 pt = vec2(u_pts[i].x * aspect, u_pts[i].y);
    // Per-point Size scales the distance: small = tight and crisp,
    // large = a wide soft wash.
    float d = distance(pos, pt) / max(u_sizes[i], 0.05);
    w[i] = 1.0 / (pow(d, u_power) + 1e-4);
    wmax = max(wmax, w[i]);
  }
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for(int i=0;i<${MAX};i++){
    if(i >= u_count) break;
    float wi = pow(w[i] / max(wmax, 1e-9), u_contrast);
    acc  += linToOklab(u_cols[i]) * wi;
    wsum += wi;
  }
  return acc / max(wsum, 1e-6);
}

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  float aspect = u_res.x / u_res.y;
  vec2 p = vec2(uv.x * aspect, uv.y);

  vec2 warped = applyStack(p, u_detail, u_time * 0.05);
  vec3 lin = oklabToLin(evalField(warped, aspect));

  // Grain in linear space, before the transfer curve — it dithers away
  // the banding that wide slow ramps would otherwise show.
  float g = hash21(gl_FragCoord.xy + fract(u_time) * 97.0) - 0.5;
  lin += g * u_grain * 0.055;

  lin = max(lin, 0.0);
  vec3 srgb = mix(lin * 12.92,
                  1.055 * pow(lin, vec3(1.0/2.4)) - 0.055,
                  step(vec3(0.0031308), lin));
  fragColor = vec4(clamp(srgb, 0.0, 1.0), 1.0);
}`;

let gl=null, cv=null, prog=null, vao=null, loc=null, failed=false;

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
    loc={res:U('u_res'),time:U('u_time'),detail:U('u_detail'),power:U('u_power'),
      contrast:U('u_contrast'),grain:U('u_grain'),count:U('u_count'),
      pts:U('u_pts'),cols:U('u_cols'),sizes:U('u_sizes'),
      wType:U('u_wType'),wAmt:U('u_wAmt'),wScale:U('u_wScale')};
    return true;
  }catch(e){
    console.warn('liquid gradient engine disabled:',e.message);
    failed=true; gl=null; return false;
  }
}

/* sRGB hex -> linear, because the blend happens in linear light. Doing it in
 * gamma space is the classic way to get muddy midpoints. */
function hexToLinear(hex){
  const n=parseInt(String(hex||'#000000').slice(1),16)||0;
  return [((n>>16)&255)/255,((n>>8)&255)/255,(n&255)/255]
    .map(v=>v<=0.04045?v/12.92:Math.pow((v+0.055)/1.055,2.4));
}

/** Render into a w x h canvas. Returns it, or null if unavailable. */
function render(w,h,P){
  if(!init()) return null;
  w=Math.max(2,Math.round(w)); h=Math.max(2,Math.round(h));
  if(cv.width!==w||cv.height!==h){ cv.width=w; cv.height=h; }
  gl.viewport(0,0,w,h);
  gl.useProgram(prog);
  gl.bindVertexArray(vao);

  const count=Math.max(2,Math.min(MAX,P.count|0||2));
  const pts=new Float32Array(MAX*2), cols=new Float32Array(MAX*3), sizes=new Float32Array(MAX);
  for(let i=0;i<MAX;i++){
    const p=(P.pts&&P.pts[i])||[0.5,0.5];
    pts[i*2]=+p[0]||0; pts[i*2+1]=+p[1]||0;
    const c=hexToLinear((P.cols&&P.cols[i])||'#ffffff');
    cols[i*3]=c[0]; cols[i*3+1]=c[1]; cols[i*3+2]=c[2];
    sizes[i]=(P.sizes&&+P.sizes[i])||1;
  }
  const wt=new Int32Array(SLOTS), wa=new Float32Array(SLOTS), ws=new Float32Array(SLOTS);
  for(let i=0;i<SLOTS;i++){
    const s=(P.warps&&P.warps[i])||{};
    const ti=WARPS.indexOf(s.type||'none');
    wt[i]=ti<0?0:ti; wa[i]=+s.amt||0; ws[i]=+s.scale||1;
  }

  gl.uniform2f(loc.res,w,h);
  gl.uniform1f(loc.time,+P.phase||0);
  gl.uniform1i(loc.detail,Math.max(1,Math.min(6,P.detail|0||2)));
  gl.uniform1f(loc.power,+P.power||3.1);
  gl.uniform1f(loc.contrast,+P.contrast||1);
  gl.uniform1f(loc.grain,+P.grain||0);
  gl.uniform1i(loc.count,count);
  gl.uniform2fv(loc.pts,pts);
  gl.uniform3fv(loc.cols,cols);
  gl.uniform1fv(loc.sizes,sizes);
  gl.uniform1iv(loc.wType,wt);
  gl.uniform1fv(loc.wAmt,wa);
  gl.uniform1fv(loc.wScale,ws);
  gl.drawArrays(gl.TRIANGLES,0,3);
  return cv;
}

window.LiquidEngine={render,available:()=>init(),WARPS,MAX,SLOTS};
})();
