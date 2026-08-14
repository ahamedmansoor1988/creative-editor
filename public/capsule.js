/* Capsule + Strip engines — path-traced pill glass and fluted/reeded glass.
 *
 * Both ported from the standalone Glass Capsule app
 * (~/Documents/execution agent/glass-capsule.html). What changed, and why:
 *
 *  - The standalone renders against a synthetic cyclorama (positioned sky
 *    sphere + key light + floor). In a document there is no scene — the glass
 *    must refract THE PAGE behind it, so the environment lookups are replaced
 *    by sampling the canvas-so-far as a plane a controlled distance behind the
 *    solid. The distance is what lets the inner lens invert and magnify, which
 *    is where the whole capsule look comes from.
 *  - The capsule is fitted to the drawn object's box (same projection maths as
 *    the Prism engine), running along the box's longer axis.
 *  - The strip panel was a slab floating in the 3D scene; here it becomes the
 *    object itself: everything behind the box is smeared into ribs, and the
 *    caller clips the result to the object's outline.
 *
 * The optics are otherwise carried over: Schlick Fresnel, per-channel
 *  dispersion (each wavelength takes its OWN path through the solid), the
 * analytic inner-lens ellipsoid, Beer-Lambert absorption, TIR handling, and
 * the real reeded-arc rib profile with its slope limit.
 *
 * Capsule accumulates samples (roughness and AA are jittered), so like Prism
 * it renders a draft during slider drags. Strip is a single deterministic
 * pass and costs almost nothing.
 */
(function(){
"use strict";

const DRAFT_SAMPLES = 8;
// Fixed telephoto camera, straight down -Z. Scene furniture, not a control.
const CAM_Z = 6.0, FOV = 18.0;

const VS = `#version 300 es
void main(){
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/* ---------------- capsule trace ---------------- */
const CAP_FRAG = `#version 300 es
precision highp float;
precision highp int;
out vec4 fragColor;

uniform sampler2D uBD;      // the page painted so far
uniform sampler2D uPrev;
uniform vec2  uRes;         // render target size
uniform float uSample, uS, uAspect;
uniform vec3  uCentre;
uniform float uRad, uHalf, uSwap;
uniform vec3  uLensR, uLensP;
uniform float uIor, uDisp, uIior, uRough;
uniform vec3  uAbsO, uAbsI;
uniform float uRefl, uBackD, uCamZ, uFov;

const float EPS = 0.0007;
const int   STEPS = 96;

uint g_seed;
float rnd(){
  g_seed = g_seed * 747796405u + 2891336453u;
  uint r = ((g_seed >> ((g_seed >> 28) + 4u)) ^ g_seed) * 277803737u;
  r = (r >> 22) ^ r;
  return float(r) * 2.3283064365386963e-10;
}
vec3 jitterDir(vec3 d, float r){
  if (r <= 0.0) return d;
  vec3 up = abs(d.y) < 0.9 ? vec3(0.0,1.0,0.0) : vec3(1.0,0.0,0.0);
  vec3 u = normalize(cross(up, d));
  vec3 v = cross(d, u);
  float a = rnd() * 6.28318530718;
  float s = r * r * sqrt(rnd()) * 2.0;
  return normalize(d + (u * cos(a) + v * sin(a)) * s);
}

/* Local frame: the capsule always runs along local Y; uSwap folds a wide box
   into that frame. The swap is its own inverse, so vectors go both ways
   through the same function. */
vec3 loc(vec3 v){ return uSwap > 0.5 ? v.yxz : v; }

float sdCap(vec3 p){
  vec3 q = loc(p - uCentre);
  q.y -= clamp(q.y, -uHalf, uHalf);
  return length(q) - uRad;
}
vec3 nrmCap(vec3 p){
  vec2 e = vec2(1.0, -1.0) * 0.0004;
  return normalize(
    e.xyy * sdCap(p + e.xyy) + e.yyx * sdCap(p + e.yyx) +
    e.yxy * sdCap(p + e.yxy) + e.xxx * sdCap(p + e.xxx));
}
float marchOut(vec3 ro, vec3 rd){
  float bound = uHalf + uRad;
  vec3 oc = ro - uCentre;
  float b = dot(oc, rd), c = dot(oc, oc) - bound * bound;
  float h = b * b - c;
  if (h < 0.0) return -1.0;
  float t = max(-b - sqrt(h), 0.0);
  for (int i = 0; i < STEPS; i++){
    float d = sdCap(ro + rd * t);
    if (d < EPS) return t;
    t += d;
    if (t > 60.0) break;
  }
  return -1.0;
}
float marchIn(vec3 ro, vec3 rd){
  float t = 0.002;
  for (int i = 0; i < STEPS; i++){
    float d = -sdCap(ro + rd * t);
    if (d < EPS) return t;
    t += max(d, 0.002);
    if (t > 60.0) break;
  }
  return t;
}
vec2 iLens(vec3 ro, vec3 rd){          // analytic ellipsoid, in the local frame
  vec3 o = (loc(ro - uCentre) - uLensP) / uLensR;
  vec3 d = loc(rd) / uLensR;
  float a = dot(d, d), b = dot(o, d), c = dot(o, o) - 1.0;
  float h = b * b - a * c;
  if (h < 0.0) return vec2(1.0, -1.0);
  h = sqrt(h);
  return vec2((-b - h) / a, (-b + h) / a);
}
vec3 nLens(vec3 p){
  vec3 nl = (loc(p - uCentre) - uLensP) / (uLensR * uLensR);
  return normalize(loc(nl));           // swap back into world
}
float schlick(float f0, float cosi){
  return f0 + (1.0 - f0) * pow(1.0 - cosi, 5.0);
}

/* The page as environment: a plane at z = -uBackD. Rays that end up pointing
   back toward the camera (front-face reflections) sample a mirrored copy —
   there is nothing in front of the page to see, and folding z keeps the
   reflection sourced from real page colours instead of a made-up sky. Decoded
   to linear so the Fresnel/absorption maths happens in the right domain. */
float sampleBD(vec3 p, vec3 d, int ch){
  vec3 dd = d;
  dd.z = -max(abs(dd.z), 0.04);
  float t = (-uBackD - p.z) / dd.z;
  vec2 hit = p.xy + dd.xy * t;
  vec2 uv = vec2((hit.x / (uS * uAspect) + 1.0) * 0.5,
                 (1.0 - hit.y / uS) * 0.5);
  float c = texture(uBD, clamp(uv, 0.0, 1.0))[ch];
  return pow(c, 2.2);
}

float glassTrace(vec3 ro, vec3 rd, float ior, int ch, out bool didHit){
  didHit = false;
  float t = marchOut(ro, rd);
  if (t < 0.0) return 0.0;
  didHit = true;

  vec3 p = ro + rd * t;
  vec3 n = nrmCap(p);
  float f0 = (ior - 1.0) / (ior + 1.0); f0 *= f0;
  float F  = schlick(f0, clamp(dot(-rd, n), 0.0, 1.0));

  float col = F * uRefl * sampleBD(p + n * 0.002, reflect(rd, n), ch);
  float thr = 1.0 - F;

  vec3 d = refract(rd, n, 1.0 / ior);
  vec3 q = p - n * 0.002;

  float absO = uAbsO[ch], absI = uAbsI[ch];
  float f0i  = (uIior - ior) / (uIior + ior); f0i *= f0i;

  for (int seg = 0; seg < 6; seg++){
    if (thr < 0.003) break;

    vec2  e     = iLens(q, d);
    float tExit = marchIn(q, d);

    if (e.y > 0.0 && e.x > 0.0008 && e.x < tExit){
      thr *= exp(-absO * e.x);
      q += d * e.x;

      vec3  ni = nLens(q);
      float Fi = schlick(f0i, clamp(dot(-d, ni), 0.0, 1.0));
      col += thr * Fi * uRefl * sampleBD(q + ni * 0.002, reflect(d, ni), ch) * 0.6;
      thr *= 1.0 - Fi;

      vec3 di = refract(d, ni, ior / uIior);
      if (dot(di, di) < 0.5){ d = reflect(d, ni); q += d * 0.003; continue; }
      di = jitterDir(di, uRough);

      vec2  e2 = iLens(q + di * 0.003, di);
      float tt = max(e2.y, 0.0);
      thr *= exp(-absI * tt);                    // Beer-Lambert in the lens
      q += di * (0.003 + tt);

      vec3 ne = -nLens(q);
      vec3 dn = refract(di, ne, uIior / ior);
      d = (dot(dn, dn) < 0.5) ? reflect(di, ne) : jitterDir(dn, uRough);
      q += d * 0.003;
      continue;
    }

    thr *= exp(-absO * tExit);
    q += d * tExit;
    vec3 nn = nrmCap(q);
    vec3 dout = refract(d, -nn, ior);
    if (dot(dout, dout) < 0.5){                  // TIR — stay inside
      d = reflect(d, -nn);
      q -= nn * 0.003;
      continue;
    }
    q += nn * 0.002;
    col += thr * sampleBD(q, dout, ch);
    thr = 0.0;
    break;
  }
  return col;
}

void main(){
  ivec2 px = ivec2(gl_FragCoord.xy);
  g_seed = uint(px.x) * 1973u + uint(px.y) * 9277u
         + uint(uSample) * 26699u + 1u;

  vec2 jit = vec2(rnd(), rnd()) - 0.5;
  vec2 uv = (2.0 * (gl_FragCoord.xy + jit) - uRes) / uRes.y;
  float f = 1.0 / tan(radians(uFov) * 0.5);
  vec3 ro = vec3(0.0, 0.0, uCamZ);
  vec3 rd = normalize(vec3(uv, -f));

  // Per channel from the first surface, so each wavelength takes its own
  // path — real dispersion, not a coloured outline pasted on the edge.
  vec3 col = vec3(0.0);
  bool hitAny = false;
  for (int ch = 0; ch < 3; ch++){
    float w = float(ch) - 1.0;
    bool hit;
    col[ch] = glassTrace(ro, rd, uIor * (1.0 + w * uDisp), ch, hit);
    hitAny = hitAny || hit;
  }
  vec4 c = vec4(col, hitAny ? 1.0 : 0.0);
  vec4 prev = texelFetch(uPrev, px, 0);
  fragColor = mix(prev, c, 1.0 / (uSample + 1.0));
}`;

const CAP_PRESENT = `#version 300 es
precision highp float;
out vec4 fragColor;
uniform sampler2D uAccum;
float h21(vec2 p){
  vec3 v = fract(vec3(p.xyx) * 0.1031);
  v += dot(v, v.yzx + 33.33);
  return fract((v.x + v.y) * v.z);
}
void main(){
  vec4 a = texelFetch(uAccum, ivec2(gl_FragCoord.xy), 0);
  // rgb accumulated with misses as black -> premultiplied; the 2d canvas
  // wants straight alpha, so unpremultiply before encoding back to sRGB.
  vec3 c = a.a > 1e-4 ? a.rgb / a.a : vec3(0.0);
  c = pow(max(c, 0.0), vec3(1.0 / 2.2));
  float d = h21(gl_FragCoord.xy) - h21(gl_FragCoord.xy + 71.7);
  fragColor = vec4(clamp(c + d / 255.0, 0.0, 1.0), a.a);
}`;

/* ---------------- strip (fluted / reeded panel) ---------------- */
const STRIP_FRAG = `#version 300 es
precision highp float;
out vec4 fragColor;
uniform sampler2D uBD;
uniform vec2  uRes;         // output = the object's box, in canvas px
uniform vec2  uPage;        // full canvas size
uniform vec2  uBoxPos;      // box top-left in canvas px
uniform float uRibW, uSag, uAng, uThick, uIor, uDisp, uSlopeMax, uSmear;

vec3 sampleBD(vec2 px){
  return texture(uBD, clamp(px / uPage, 0.0, 1.0)).rgb;
}
void main(){
  // box-local, top-down to match canvas coordinates
  vec2 l = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  float ca = cos(uAng), sa = sin(uAng);
  float x = l.x * ca + l.y * sa;                 // across-rib coordinate

  // Real reeded profile: a circular arc of sagitta uSag over the rib pitch.
  // With the radius derived from the sagitta, bulge 1 is exactly a
  // semicircle and everything below stays finite on its own.
  float hw = uRibW * 0.5;
  float sag = max(uSag, 1e-4);
  float R = (hw * hw + sag * sag) / (2.0 * sag);
  float xr = (fract(x / uRibW + 0.5) - 0.5) * uRibW;
  float slope = -xr / sqrt(max(R * R - xr * xr, 1e-6));
  slope = clamp(slope, -uSlopeMax, uSlopeMax);

  vec3 n = normalize(vec3(-slope * ca, -slope * sa, 1.0));

  // Two analytic refractions — ribbed front, flat back — per channel, then a
  // run to the page behind. The rib edges are where the look lives: as the
  // profile turns vertical, adjacent ribs sample wildly different spots and
  // the subject smears into bands with coloured edges.
  vec3 col;
  for (int ch = 0; ch < 3; ch++){
    float ior = uIor * (1.0 + (float(ch) - 1.0) * uDisp);
    vec3 d1 = refract(vec3(0.0, 0.0, -1.0), n, 1.0 / ior);
    if (dot(d1, d1) < 0.5) d1 = reflect(vec3(0.0, 0.0, -1.0), n);
    vec2 off = d1.xy * (uThick / max(abs(d1.z), 0.05));
    vec3 d2 = refract(d1, vec3(0.0, 0.0, 1.0), ior);
    if (dot(d2, d2) < 0.5) d2 = reflect(d1, vec3(0.0, 0.0, 1.0));
    off += d2.xy * (uSmear / max(abs(d2.z), 0.05));
    col[ch] = sampleBD(uBoxPos + l + off)[ch];
  }
  fragColor = vec4(col, 1.0);
}`;

let gl=null, cv=null, progCap=null, progShow=null, progStrip=null, vao=null;
let bdTex=null, tex=[null,null], fbo=[null,null], AW=0, AH=0;
let failed=false;
const U={};

function compile(src, type){
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}
function program(fs){
  const p = gl.createProgram();
  gl.attachShader(p, compile(VS, gl.VERTEX_SHADER));
  gl.attachShader(p, compile(fs, gl.FRAGMENT_SHADER));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}
function loc(prog, name){
  const k = (prog===progCap?'c:':prog===progStrip?'r:':'s:') + name;
  if (!(k in U)) U[k] = gl.getUniformLocation(prog, name);
  return U[k];
}
function init(){
  if (gl || failed) return !failed;
  try{
    cv = document.createElement('canvas');
    gl = cv.getContext('webgl2', {premultipliedAlpha:false, antialias:false, alpha:true});
    if (!gl) throw new Error('WebGL2 unavailable');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('EXT_color_buffer_float unavailable');
    progCap = program(CAP_FRAG); progShow = program(CAP_PRESENT); progStrip = program(STRIP_FRAG);
    vao = gl.createVertexArray();
    bdTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, bdTex);
    [[gl.TEXTURE_MIN_FILTER,gl.LINEAR],[gl.TEXTURE_MAG_FILTER,gl.LINEAR],
     [gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE],[gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE]]
      .forEach(([k,v])=>gl.texParameteri(gl.TEXTURE_2D,k,v));
    return true;
  }catch(e){
    console.warn('capsule engine disabled:', e.message);
    failed = true; gl = null; return false;
  }
}
function alloc(w, h){
  if (w === AW && h === AH) return;
  for (let i = 0; i < 2; i++){
    if (tex[i]){ gl.deleteTexture(tex[i]); gl.deleteFramebuffer(fbo[i]); }
    tex[i] = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex[i]);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, w, h);
    [[gl.TEXTURE_MIN_FILTER,gl.NEAREST],[gl.TEXTURE_MAG_FILTER,gl.NEAREST],
     [gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE],[gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE]]
      .forEach(([k,v])=>gl.texParameteri(gl.TEXTURE_2D,k,v));
    fbo[i] = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo[i]);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex[i], 0);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  AW = w; AH = h;
}
function uploadBackdrop(srcCanvas){
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, bdTex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);   // texel row 0 = canvas top
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, srcCanvas);
}
const hex3 = h => {
  const n = parseInt(((h||'#ffffff').replace('#','')), 16) || 0;
  return [((n>>16)&255)/255, ((n>>8)&255)/255, (n&255)/255];
};
const srgb2lin = c => c <= 0.04045 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4);
// Absorption from a "transmitted tint": white = clear.
const absorb = (hex, dens) => hex3(hex).map(srgb2lin).map(c => dens * (1 - c));

/* Path-trace the capsule over the page and composite it back into srcCanvas.
 * box is the object's {x,y,w,h} in canvas px. */
function capsule(srcCanvas, W, H, box, P, draft){
  if (!init()) return false;
  const sc = Math.max(0.15, Math.min(1, P.scale * (draft ? 0.6 : 1)));
  const w = Math.max(2, Math.round(W*sc)), h = Math.max(2, Math.round(H*sc));
  cv.width = w; cv.height = h;
  alloc(w, h);
  uploadBackdrop(srcCanvas);

  // Same screen->world solve as the Prism engine: one uv unit = camZ/f world
  // units on the z=0 plane, so the solid lands exactly on the drawn box.
  const f = 1 / Math.tan(FOV * Math.PI / 360);
  const S = CAM_Z / f;
  const cx = ((2*(box.x + box.w/2) - W) / H) * S;
  const cy = (-(2*(box.y + box.h/2) - H) / H) * S;
  const sx = (box.w / H) * S, sy = (box.h / H) * S;
  const mn = Math.min(sx, sy), half = Math.max(sx, sy) - mn;
  const swap = sx > sy ? 1 : 0;
  const lr = P.lensSize * mn;

  const samples = Math.max(1, Math.round(draft ? Math.min(DRAFT_SAMPLES, P.quality) : P.quality));

  gl.bindVertexArray(vao);
  gl.disable(gl.BLEND);
  gl.useProgram(progCap);
  gl.viewport(0, 0, w, h);
  const u = n => loc(progCap, n);
  gl.uniform2f(u('uRes'), w, h);
  gl.uniform1f(u('uS'), S);
  gl.uniform1f(u('uAspect'), W / H);
  gl.uniform1f(u('uCamZ'), CAM_Z);
  gl.uniform1f(u('uFov'), FOV);
  gl.uniform3f(u('uCentre'), cx, cy, 0);
  gl.uniform1f(u('uRad'), mn);
  gl.uniform1f(u('uHalf'), half);
  gl.uniform1f(u('uSwap'), swap);
  gl.uniform3f(u('uLensR'), lr, lr * P.lensSquash, lr);
  gl.uniform3f(u('uLensP'), 0, P.lensShift * (half + mn), 0);
  gl.uniform1f(u('uIor'), P.ior);
  gl.uniform1f(u('uDisp'), P.dispersion);
  gl.uniform1f(u('uIior'), P.lensIor);
  gl.uniform1f(u('uRough'), P.roughness);
  gl.uniform3fv(u('uAbsO'), absorb(P.tint, P.absorb));
  gl.uniform3fv(u('uAbsI'), absorb(P.lensTint, P.lensAbsorb));
  gl.uniform1f(u('uRefl'), P.reflection / 100);
  gl.uniform1f(u('uBackD'), Math.max(P.depth, 1.1) * mn);
  gl.uniform1i(u('uBD'), 2);

  let ping = 0;
  for (let s = 0; s < samples; s++){
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo[ping^1]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex[ping]);
    gl.uniform1i(u('uPrev'), 0);
    gl.uniform1f(u('uSample'), s);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    ping ^= 1;
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.useProgram(progShow);
  gl.viewport(0, 0, w, h);
  gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex[ping]);
  gl.uniform1i(loc(progShow,'uAccum'), 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  const ctx = srcCanvas.getContext('2d');
  ctx.drawImage(cv, 0, 0, W, H);
  return true;
}

/* Render the reeded panel for the object's box. Returns a box-sized canvas
 * (the caller clips it to the shape's outline and draws it in place). */
function strip(srcCanvas, W, H, box, P){
  if (!init()) return null;
  const w = Math.max(2, Math.min(2048, Math.round(box.w)));
  const h = Math.max(2, Math.min(2048, Math.round(box.h)));
  cv.width = w; cv.height = h;
  uploadBackdrop(srcCanvas);

  const ref = Math.min(box.w, box.h);
  gl.bindVertexArray(vao);
  gl.disable(gl.BLEND);
  gl.useProgram(progStrip);
  gl.viewport(0, 0, w, h);
  const u = n => loc(progStrip, n);
  gl.uniform2f(u('uRes'), w, h);
  gl.uniform2f(u('uPage'), W, H);
  gl.uniform2f(u('uBoxPos'), box.x, box.y);
  gl.uniform1f(u('uRibW'), Math.max(2, P.ribWidth * ref));
  gl.uniform1f(u('uSag'), P.bulge * P.ribWidth * ref * 0.5);
  gl.uniform1f(u('uAng'), P.angle * Math.PI / 180);
  gl.uniform1f(u('uThick'), P.thickness * ref);
  gl.uniform1f(u('uIor'), P.ior);
  gl.uniform1f(u('uDisp'), P.dispersion);
  gl.uniform1f(u('uSlopeMax'), P.slopeLimit);
  gl.uniform1f(u('uSmear'), P.smear * ref);
  gl.uniform1i(u('uBD'), 2);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  return cv;
}

window.CapsuleEngine = { capsule, strip, available:()=>init(), DRAFT_SAMPLES };
})();
