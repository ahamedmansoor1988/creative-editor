/* Prism engine — a collimated beam traced forward through a glass solid,
 * dispersed per wavelength.
 *
 * Shaders carried over from the standalone Glass Prism app
 * (~/Documents/execution agent/glass-prism.html). What changed, and why:
 *
 *  - The standalone page is a STAGED SCENE: orbit camera, gradient backdrop,
 *    reflective floor, vignette. None of that belongs in a document editor,
 *    where the page already has a background and other layers sit behind. All
 *    of it is gone, and the camera is pinned straight down -Z.
 *  - The solid is TRANSLATED to the selected object's box (uCentre) and sized
 *    from it, so the object the user drew is the prism. The projection is
 *    solved on the JS side so the rendered solid lands exactly on the box.
 *  - It renders FULL CANVAS, not clipped to the shape. A prism's whole point is
 *    that light leaves it — clipping to the outline would delete the fan and
 *    leave a lit rectangle.
 *  - uAlphaMode, as in the Light engine, so the result composites over the
 *    document instead of painting a black room.
 *
 * The optics — entry refraction, the walk inside with total internal
 * reflection, exit refraction, the per-wavelength path prepass, Zucconi's
 * spectral fit — are untouched.
 *
 * This engine is unlike every other one here in that it is PROGRESSIVE: each
 * sample traces one wavelength, so a single pass is a noisy monochrome smear
 * and the spectrum only resolves once enough samples accumulate. The loop runs
 * synchronously inside render(), which is why quality is a real cost and why
 * dragging a slider renders a draft.
 */
(function(){
"use strict";

const PATH_N = 128;          // wavelength buckets in the path prepass
const DRAFT_SAMPLES = 10;    // while a slider is moving

const SHAPES = [
  {id:0, label:'Rounded box'}, {id:1, label:'Triangular prism'}, {id:2, label:'Sphere'},
  {id:3, label:'Cylinder'},    {id:4, label:'Hex prism'},        {id:5, label:'Octahedron'},
  {id:6, label:'Torus'},       {id:7, label:'Capsule'},          {id:8, label:'Cone'},
];

const VS = `#version 300 es
void main(){
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/* Shared verbatim by the path and trace programs so the SDF has exactly one
   definition. Locations a given program does not use come back null, and
   WebGL treats those uploads as no-ops. */
const UNIFORMS = `
uniform vec3  uBeamDir;
uniform float uBInt, uBWidth, uBSoft, uBDist, uBFall, uBIn, uBOut;
uniform float uBOffX, uBOffY;
uniform vec3  uSize, uCentre;
uniform float uCorner, uIor, uDisp, uWedge, uFan, uFanRoll;
uniform int   uShape;
uniform mat3  uRot;
uniform float uFog, uFrost, uSat, uAmbient, uRim;
uniform vec3  uSpecNorm;
uniform float uSceneR, uPathN;
uniform float uBend, uOpacity, uSpecMode, uBands;
uniform vec3  uFill, uInColor, uColA, uColB;
uniform int   uSteps;
uniform vec3  uCamPos;
uniform mat3  uCamBasis;
uniform float uFov;
`;

const GEOM = `
/* The standalone app sized every solid with its own per-axis sliders, so each
 * one was tuned by hand. Here the box the user drew IS the size, so every
 * shape is fitted to that box: nothing may spill outside the selection
 * rectangle, and the bevel is inset rather than added on top (an SDF rounded
 * with "- uCorner" grows by uCorner in every direction unless you shrink the
 * base shape by it first). */
float sdShape(vec3 r){
  float mn = min(uSize.x, uSize.y);        // the box's short half-axis
  float k  = min(uCorner, mn * 0.98);
  if (uShape == 1){                        // equilateral triangular prism
    vec3 q = abs(r);
    // An equilateral triangle's width is fixed by its height (w = 1.1547h), so
    // on a tall narrow box a height-driven triangle bursts out of the sides.
    // Take whichever of the two constraints binds.
    float th = min(uSize.y, uSize.x * 1.1547);
    return max(q.z - uSize.z,
               max(q.x * 0.866025 + r.y * 0.5, -r.y) - (th * 0.5 - k)) - k;
  }
  if (uShape == 2) return length(r) - mn;                    // sphere
  if (uShape == 3){                                          // cylinder
    vec2 d = vec2(length(r.xz) - (mn - k), abs(r.y) - (uSize.y - k));
    return min(max(d.x, d.y), 0.0) + length(max(d, 0.0)) - k;
  }
  if (uShape == 4){                                          // hex prism
    const vec3 c = vec3(-0.8660254, 0.5, 0.57735);
    // apothem, so the hexagon's WIDTH (its long axis) lands on the box edge
    float a = (mn - k) * 0.8660254;
    vec3 p = abs(r);
    p.xy -= 2.0 * min(dot(c.xy, p.xy), 0.0) * c.xy;
    vec2 d = vec2(length(p.xy - vec2(clamp(p.x, -c.z * a, c.z * a), a))
                  * sign(p.y - a),
                  p.z - uSize.z);
    return min(max(d.x, d.y), 0.0) + length(max(d, 0.0)) - k;
  }
  if (uShape == 5){                                          // octahedron
    vec3 p = abs(r);
    return (p.x + p.y + p.z - (mn - k)) * 0.57735027 - k;
  }
  if (uShape == 6){                                          // torus
    // The ring lies in XY, not XZ. The camera looks down -Z, so the original
    // orientation presented the torus edge-on as a bar and the hole was never
    // visible at all.
    float tube = clamp(uSize.z, 0.02 * mn, mn * 0.9);
    vec2 q = vec2(length(r.xy) - (mn - tube), r.z);
    return length(q) - tube;
  }
  if (uShape == 7){                                          // capsule / pill
    // Runs along the box's LONGER axis, and the hemispherical caps are counted
    // INSIDE the box instead of added to it — the original added a full radius
    // at each end, which made a pill twice the height of the box it sat in.
    vec3 q = r;
    if (uSize.y >= uSize.x) q.y -= clamp(q.y, -(uSize.y - mn), uSize.y - mn);
    else                    q.x -= clamp(q.x, -(uSize.x - mn), uSize.x - mn);
    return length(q) - mn;
  }
  if (uShape == 8){                                          // cone
    vec2 q = vec2(length(r.xz), r.y);
    float h = uSize.y - k, r1 = mn - k, r2 = min(uSize.z, r1);
    vec2 k1 = vec2(r2, h);
    vec2 k2 = vec2(r2 - r1, 2.0 * h);
    vec2 ca = vec2(q.x - min(q.x, q.y < 0.0 ? r1 : r2), abs(q.y) - h);
    vec2 cb = q - k1 + k2 * clamp(dot(k1 - q, k2) / dot(k2, k2), 0.0, 1.0);
    float sg = (cb.x < 0.0 && ca.y < 0.0) ? -1.0 : 1.0;
    return sg * sqrt(min(dot(ca, ca), dot(cb, cb))) - k;
  }
  vec3 q = abs(r) - uSize + uCorner;                         // rounded box
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - uCorner;
}

/* uCentre is the addition: the solid sits on the selected object's box rather
   than at the world origin. */
float sdPrism(vec3 p){
  vec3 r = uRot * (p - uCentre);
  float d = sdShape(r);
  // Tilt the back face off parallel. Without this a slab is optically a
  // window: every wavelength exits parallel to how it entered.
  if (uWedge > 0.0){
    vec3 n = normalize(vec3(sin(uWedge), 0.0, -cos(uWedge)));
    d = max(d, dot(r, n) - uSize.z);
  }
  return d;
}

vec3 nrmPrism(vec3 p){
  vec2 e = vec2(1.0, -1.0) * 0.0004;
  return normalize(
    e.xyy * sdPrism(p + e.xyy) + e.yyx * sdPrism(p + e.yyx) +
    e.yxy * sdPrism(p + e.yxy) + e.xxx * sdPrism(p + e.xxx));
}

vec3 beamStart(){
  vec3 Ld = uBeamDir;
  vec3 up = abs(Ld.y) < 0.95 ? vec3(0.0,1.0,0.0) : vec3(1.0,0.0,0.0);
  vec3 bx = normalize(cross(Ld, up));
  vec3 by = cross(bx, Ld);
  return uCentre - Ld * uBDist + bx * uBOffX + by * uBOffY;
}
`;

/* PATH PASS — 128x3 pixels, once per render.
 * The beam's route through the solid depends on wavelength and nothing else,
 * so it is solved once per wavelength bucket into a small texture rather than
 * re-solved inside every camera ray.
 * Row 0 = entry point + hit flag, row 1 = exit point, row 2 = exit direction. */
const PATH = `#version 300 es
precision highp float;
precision highp int;
out vec4 fragColor;
` + UNIFORMS + `
const float EPS = 0.0006;
const int   MSTEPS = 96;
` + GEOM + `
vec3 rotAxis(vec3 v, vec3 axis, float a){
  float c = cos(a), s = sin(a);
  return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
}
float hitPrism(vec3 ro, vec3 rd){
  float t = 0.0;
  for (int i = 0; i < MSTEPS; i++){
    float d = sdPrism(ro + rd * t);
    if (d < EPS) return t;
    t += d;
    if (t > 200.0) break;
  }
  return -1.0;
}
float exitPrism(vec3 ro, vec3 rd){
  float t = 0.002;
  for (int i = 0; i < MSTEPS; i++){
    float d = -sdPrism(ro + rd * t);
    if (d < EPS) return t;
    t += max(d, 0.002);
    if (t > 200.0) break;
  }
  return t;
}
void main(){
  float lam = (floor(gl_FragCoord.x) + 0.5) / uPathN;
  float ior = uIor + uDisp * (0.5 - lam);

  vec3 Ld = uBeamDir;
  vec3 A0 = beamStart();
  vec3 A1 = A0 + Ld * (uBDist * 2.0 + 200.0);
  vec3 A2 = A1, D2 = Ld;
  float through = 0.0;

  float t = hitPrism(A0, Ld);
  if (t >= 0.0){
    A1 = A0 + Ld * t;
    vec3 n = nrmPrism(A1);
    vec3 d = refract(Ld, n, 1.0 / ior);
    if (dot(d, d) > 0.5){
      // Walk the inside until a face lets the ray out. A total internal
      // reflection is NOT an exit — letting it escape as one throws a bogus
      // beam back into the room. At high dispersion the short wavelengths TIR
      // while the long ones pass through, so this resolves per wavelength.
      vec3 q = A1 - n * 0.002;
      for (int i = 0; i < 4; i++){
        float ti = exitPrism(q, d);
        vec3 pe = q + d * ti;
        vec3 ne = nrmPrism(pe);
        vec3 dn = refract(d, -ne, ior);
        if (dot(dn, dn) > 0.5){
          A2 = pe; D2 = normalize(dn); through = 1.0; break;
        }
        d = reflect(d, -ne);
        q = pe + d * 0.003;
      }
      if (through < 0.5){ A2 = q; D2 = d; through = 1.0; }   // trapped
    }
  }

  // Art direction on top of whatever the geometry does. Bend swings the whole
  // fan off the entry axis by a fixed angle; Fan spreads it by wavelength
  // around that. A slab with parallel faces deviates nothing on its own, so
  // Bend is the only way to get a chevron out of one.
  if (through > 0.5 && (uFan != 0.0 || uBend != 0.0)){
    vec3 up = abs(D2.y) < 0.95 ? vec3(0.0,1.0,0.0) : vec3(1.0,0.0,0.0);
    vec3 ax = normalize(rotAxis(normalize(cross(D2, up)), D2, uFanRoll));
    D2 = normalize(rotAxis(D2, ax, uBend + (0.5 - lam) * uFan));
  }

  int row = int(floor(gl_FragCoord.y));
  fragColor = row == 0 ? vec4(A1, through)
            : row == 1 ? vec4(A2, 0.0)
            :            vec4(D2, 0.0);
}`;

/* TRACE PASS — camera rays. Reads the path texture, marches the volume, and
 * picks the silhouette out of the sign change it already crosses.
 * Alpha carries solid coverage so the present pass can composite normally. */
const TRACE = `#version 300 es
precision highp float;
precision highp int;
out vec4 fragColor;

uniform vec2  uRes;
uniform float uSample;
uniform sampler2D uPrev;
uniform sampler2D uPath;
` + UNIFORMS + GEOM + `
uint g_seed;
float rnd(){
  g_seed = g_seed * 747796405u + 2891336453u;
  uint r = ((g_seed >> ((g_seed >> 28) + 4u)) ^ g_seed) * 277803737u;
  r = (r >> 22) ^ r;
  return float(r) * 2.3283064365386963e-10;
}

/* Zucconi's six-bump fit to the CIE curves. x = 0 is ~400nm (violet), x = 1 is
 * ~700nm (red). uSpecNorm is integrated PER CHANNEL on the JS side — the three
 * curves have different areas under them, so one shared scalar leaves a full
 * spectrum yellow-green instead of white. */
vec3 bump3y(vec3 x, vec3 yo){
  vec3 y = 1.0 - x * x;
  return clamp(y - yo, 0.0, 1.0);
}
vec3 spectral(float x){
  const vec3 c1 = vec3(3.54585104, 2.93225262, 2.41593945);
  const vec3 x1 = vec3(0.69549072, 0.49228336, 0.27699880);
  const vec3 y1 = vec3(0.02312639, 0.15225084, 0.52607955);
  const vec3 c2 = vec3(3.90307140, 3.21182957, 3.96587128);
  const vec3 x2 = vec3(0.11748627, 0.86755042, 0.66077860);
  const vec3 y2 = vec3(0.84897130, 0.88445281, 0.73949448);
  return bump3y(c1 * (x - x1), y1) + bump3y(c2 * (x - x2), y2);
}

/* Radial falloff around a beam axis. uBSoft shapes it: 2 is a gaussian, higher
   tightens the core into a harder-edged shaft. */
float profile(float r){
  float x = r / max(uBWidth, 1e-4);
  return exp(-pow(x, uBSoft));
}
float segGlow(vec3 x, vec3 A, vec3 B){
  vec3 ab = B - A;
  float L = max(length(ab), 1e-5);
  vec3 d = ab / L;
  float s = clamp(dot(x - A, d), 0.0, L);
  return profile(length(x - (A + d * s)));
}
float rayGlow(vec3 x, vec3 A, vec3 d, out float along){
  float s = max(dot(x - A, d), 0.0);
  along = s;
  return profile(length(x - (A + d * s)));
}

vec3 gA0, gA1, gA2, gD2, gSpec, gIn;
bool gThrough;

vec3 marchVol(vec3 ro, vec3 rd, int steps, out float trans){
  trans = 1.0;
  vec3 oc = ro - uCentre;
  float b = dot(oc, rd), c = dot(oc, oc) - uSceneR * uSceneR;
  float h = b * b - c;
  if (h < 0.0) return vec3(0.0);
  h = sqrt(h);
  float t0 = max(-b - h, 0.0), t1 = -b + h;
  if (t1 <= t0) return vec3(0.0);

  float dt = (t1 - t0) / float(steps);
  float t = t0 + dt * rnd();          // jitter kills the ring banding
  vec3 acc = vec3(0.0);
  bool hitSurf = false, inside = false;
  vec3 surfP = vec3(0.0);

  for (int i = 0; i < steps; i++){
    vec3 x = ro + rd * t;
    float sd = sdPrism(x);
    bool nowIn = sd < 0.0;

    // Opaque body. Marching front to back means the first crossing is the near
    // face, so laying the fill down there and dropping the running
    // transmittance is what hides the beam's leg inside the shape and starts
    // the exit fan at the far edge instead of the near.
    if (nowIn && !inside){
      inside = true;
      if (!hitSurf){ hitSurf = true; surfP = x; }
      if (uOpacity > 0.0){
        acc += trans * uFill * uOpacity;
        trans *= 1.0 - uOpacity;
        if (trans < 0.004) break;
      }
    } else if (!nowIn && inside){
      inside = false;
    }

    float dens = nowIn ? uFrost : uFog;
    // Feather the integration sphere so a small Reach fades the beam out
    // instead of slicing it off with a hard edge.
    dens *= smoothstep(uSceneR, uSceneR * 0.75, length(x - uCentre));

    // Incoming shaft and the leg inside carry the source colour; only the exit
    // fan is dispersed. Physically the entry beam is white because every
    // wavelength shares that path.
    vec3 lit = uBIn * segGlow(x, gA0, gA1) * gIn;
    if (gThrough){
      lit += uBIn * segGlow(x, gA1, gA2) * gIn;
      float along;
      lit += uBOut * rayGlow(x, gA2, gD2, along) * exp(-along * uBFall) * gSpec;
    }
    acc += trans * dens * (lit * uBInt + (nowIn ? uAmbient : 0.0)) * dt;
    t += dt;
  }

  // Silhouette rim taken from the sign change the march already crossed,
  // rather than a second sphere-trace just to find the surface.
  if (hitSurf && uRim > 0.0){
    vec3 n = nrmPrism(surfP);
    acc += vec3(pow(1.0 - abs(dot(rd, n)), 4.0) * uRim * 0.05);
  }
  return acc;
}

vec4 render(vec2 frag){
  vec2 jit = vec2(rnd(), rnd()) - 0.5;
  vec2 uv = (2.0 * (frag + jit) - uRes) / uRes.y;
  float f = 1.0 / tan(radians(uFov) * 0.5);
  vec3 ro = uCamPos;
  vec3 rd = normalize(uCamBasis * vec3(uv, f));

  // One wavelength per sample. Accumulation over samples integrates the
  // spectrum, so the fan is continuous instead of a stack of N bands.
  float lam = rnd();
  // Quantising the wavelength snaps both the colour AND the exit direction,
  // so the fan resolves into separated ribbons — the infographic reading of a
  // prism rather than the photographic one.
  if (uBands >= 1.0){
    float n = floor(uBands);
    lam = (floor(lam * n) + 0.5) / n;
  }
  vec3 spec = uSpecMode > 0.5 ? mix(uColA, uColB, lam)
                              : spectral(lam) * uSpecNorm;
  gSpec = mix(vec3(dot(spec, vec3(0.3333))), spec, uSat);
  gIn = uInColor;

  int bi = clamp(int(lam * uPathN), 0, int(uPathN) - 1);
  vec4 r0 = texelFetch(uPath, ivec2(bi, 0), 0);
  gA0 = beamStart();
  gA1 = r0.xyz;
  gThrough = r0.w > 0.5;
  gA2 = texelFetch(uPath, ivec2(bi, 1), 0).xyz;
  gD2 = texelFetch(uPath, ivec2(bi, 2), 0).xyz;

  float tr;
  vec3 v = marchVol(ro, rd, uSteps, tr);
  return vec4(v, 1.0 - tr);          // alpha = how much of the page is blocked
}

void main(){
  ivec2 px = ivec2(gl_FragCoord.xy);
  g_seed = uint(px.x) * 1973u + uint(px.y) * 9277u
         + uint(uSample) * 26699u + 1u;
  vec4 c = render(gl_FragCoord.xy);
  vec4 prev = texelFetch(uPrev, px, 0);
  fragColor = mix(prev, c, 1.0 / (uSample + 1.0));
}`;

const PRESENT = `#version 300 es
precision highp float;
out vec4 fragColor;
uniform sampler2D uAccum;
uniform float uExpo, uShoulder, uGrain, uAlphaMode;

float h21(vec2 p){
  vec3 v = fract(vec3(p.xyx) * 0.1031);
  v += dot(v, v.yzx + 33.33);
  return fract((v.x + v.y) * v.z);
}
void main(){
  vec4 a = texelFetch(uAccum, ivec2(gl_FragCoord.xy), 0);
  vec3 c = a.rgb * uExpo;
  c = c / (1.0 + uShoulder * c);
  c = pow(max(c, 0.0), vec3(1.0 / 2.2));
  float n = h21(gl_FragCoord.xy) - h21(gl_FragCoord.xy + 71.7);
  c += n * uGrain;                       // film grain, doubles as dither
  c = clamp(c, 0.0, 1.0);
  // Add mode: the canvas composites with 'lighter', which scales by alpha, so
  // the colour must arrive at full alpha. Normal mode: the glow carries its own
  // coverage, unioned with the body's, so it can sit on a light page.
  float glow = clamp(max(max(c.r, c.g), c.b) * 1.3, 0.0, 1.0);
  float al = uAlphaMode > 0.5 ? 1.0 : clamp(max(glow, a.a), 0.0, 1.0);
  fragColor = vec4(c, al);
}`;

let gl=null, cv=null, progPath=null, progTrace=null, progShow=null, vao=null;
let pathTex=null, pathFbo=null, tex=[null,null], fbo=[null,null], AW=0, AH=0;
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
  const k = (prog===progTrace?'t:':prog===progPath?'p:':'s:') + name;
  if (!(k in U)) U[k] = gl.getUniformLocation(prog, name);
  return U[k];
}

function init(){
  if (gl || failed) return !failed;
  try{
    cv = document.createElement('canvas');
    gl = cv.getContext('webgl2', {premultipliedAlpha:false, antialias:false, alpha:true});
    if (!gl) throw new Error('WebGL2 unavailable');
    // The accumulation buffer must be float; without this the spectrum bands.
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('EXT_color_buffer_float unavailable');
    progPath = program(PATH); progTrace = program(TRACE); progShow = program(PRESENT);
    vao = gl.createVertexArray();

    pathTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, pathTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, PATH_N, 3);
    [[gl.TEXTURE_MIN_FILTER,gl.NEAREST],[gl.TEXTURE_MAG_FILTER,gl.NEAREST],
     [gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE],[gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE]]
      .forEach(([k,v])=>gl.texParameteri(gl.TEXTURE_2D,k,v));
    pathFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, pathFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pathTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return true;
  }catch(e){
    console.warn('prism engine disabled:', e.message);
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

const hex3 = h => {
  const n = parseInt(((h||'#ffffff').replace('#','')), 16) || 0;
  return [((n>>16)&255)/255, ((n>>8)&255)/255, (n&255)/255];
};
const srgb2lin = c => c <= 0.04045 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4);
const linHex = h => hex3(h).map(srgb2lin);
const rad = d => d * Math.PI / 180;

// Same six-bump fit as the shader, integrated once so a full-spectrum beam
// normalises to neutral white.
const SPEC_NORM = (() => {
  const c1=[3.54585104,2.93225262,2.41593945], x1=[0.69549072,0.49228336,0.27699880],
        y1=[0.02312639,0.15225084,0.52607955], c2=[3.90307140,3.21182957,3.96587128],
        x2=[0.11748627,0.86755042,0.66077860], y2=[0.84897130,0.88445281,0.73949448];
  const bump=(a,yo)=>Math.max(0, Math.min(1, 1 - a*a - yo));
  const s=[0,0,0];
  for (let i=0;i<512;i++){
    const x=(i+0.5)/512;
    for (let k=0;k<3;k++) s[k] += bump(c1[k]*(x-x1[k]), y1[k]) + bump(c2[k]*(x-x2[k]), y2[k]);
  }
  return s.map(v => 512/v);
})();

// Ry * Rx * Rz, column-major for WebGL
function eulerMat(yaw, pitch, roll){
  const cy=Math.cos(yaw), sy=Math.sin(yaw), cp=Math.cos(pitch), sp=Math.sin(pitch),
        cr=Math.cos(roll), sr=Math.sin(roll);
  return [ cy*cr + sy*sp*sr,  cp*sr,  -sy*cr + cy*sp*sr,
          -cy*sr + sy*sp*cr,  cp*cr,   sy*sr + cy*sp*cr,
           sy*cp,            -sp,      cy*cp ];
}

function setUniforms(prog, W, H, geom, P, S, R){
  const u = n => loc(prog, n);
  gl.uniform2f(u('uRes'), AW, AH);
  gl.uniform1f(u('uPathN'), PATH_N);
  gl.uniform1i(u('uSteps'), Math.max(8, Math.round(P.steps * (P._draft ? 0.6 : 1))));
  gl.uniform1f(u('uFov'), P.fov);

  // Camera pinned straight down -Z. Basis columns: right, up, forward.
  gl.uniform3f(u('uCamPos'), 0, 0, P.camZ);
  gl.uniformMatrix3fv(u('uCamBasis'), false, [1,0,0, 0,1,0, 0,0,-1]);

  gl.uniform3f(u('uCentre'), geom.cx, geom.cy, 0);
  gl.uniform3f(u('uSize'), geom.sx, geom.sy, geom.sz);
  gl.uniform1f(u('uCorner'), Math.min(geom.corner, geom.sx, geom.sy, geom.sz));
  gl.uniform1i(u('uShape'), P.shape|0);
  gl.uniform1f(u('uWedge'), rad(P.wedge));
  gl.uniform1f(u('uIor'), P.ior);
  gl.uniform1f(u('uDisp'), P.dispersion);
  gl.uniform1f(u('uOpacity'), P.body);
  gl.uniform3fv(u('uFill'), linHex(P.fill));
  gl.uniformMatrix3fv(u('uRot'), false, eulerMat(rad(P.yaw), rad(P.pitch), rad(P.roll)));

  const az = rad(P.azimuth), el = rad(P.elevation);
  gl.uniform3f(u('uBeamDir'),
    Math.cos(el)*Math.sin(az), Math.sin(el), Math.cos(el)*Math.cos(az));
  gl.uniform1f(u('uBInt'), P.intensity);
  // Beam geometry is expressed relative to the prism so the look survives a
  // resize: R is the solid's larger half-extent in world units.
  gl.uniform1f(u('uBWidth'), P.width * R);
  gl.uniform1f(u('uBSoft'), P.softness);
  gl.uniform1f(u('uBDist'), P.distance * R);
  gl.uniform1f(u('uBOffX'), P.aimX * R);
  gl.uniform1f(u('uBOffY'), P.aimY * R);
  gl.uniform1f(u('uBFall'), P.falloff / Math.max(R, 1e-4));
  gl.uniform1f(u('uBIn'), P.inGain);
  gl.uniform1f(u('uBOut'), P.outGain);

  gl.uniform1f(u('uBend'), rad(P.bend));
  gl.uniform1f(u('uFan'), rad(P.fan));
  gl.uniform1f(u('uFanRoll'), rad(P.fanRoll));
  gl.uniform1f(u('uBands'), Math.round(P.bands));
  gl.uniform1f(u('uSpecMode'), P.spectrum|0);
  gl.uniform3fv(u('uColA'), linHex(P.colorA));
  gl.uniform3fv(u('uColB'), linHex(P.colorB));
  gl.uniform3fv(u('uInColor'), linHex(P.beamColor));
  gl.uniform3fv(u('uSpecNorm'), SPEC_NORM);

  gl.uniform1f(u('uFog'), P.airScatter);
  gl.uniform1f(u('uFrost'), P.glassScatter);
  gl.uniform1f(u('uSat'), P.saturation);
  gl.uniform1f(u('uAmbient'), 0);
  gl.uniform1f(u('uRim'), P.rim);
  // Reach is a multiple of the canvas half-diagonal, so the default covers the
  // page whatever its aspect and the prism can still be near an edge.
  gl.uniform1f(u('uSceneR'), P.reach * S * Math.hypot(W/H, 1));
}

/* Render the prism full-canvas. `geom` is the selected object's box in canvas
 * pixels {x,y,w,h}; it is projected into world space here so the solid lands
 * exactly on it. Returns the WebGL canvas (at render scale) or null. */
function render(W, H, box, P, draft){
  if (!init()) return null;
  W = Math.max(2, Math.round(W)); H = Math.max(2, Math.round(H));
  // A draft drops resolution, march steps AND sample count together — cutting
  // only samples still costs the full per-pixel march and would not keep up
  // with a slider drag.
  const sc = Math.max(0.12, Math.min(1, P.scale * (draft ? 0.6 : 1)));
  const w = Math.max(2, Math.round(W*sc)), h = Math.max(2, Math.round(H*sc));
  cv.width = w; cv.height = h;
  alloc(w, h);

  // Screen -> world. uv = (2*frag - res)/res.y, and a ray through uv meets the
  // z=0 plane at world (uv * camZ/f), so one uv unit is camZ/f world units.
  const f = 1 / Math.tan(rad(P.fov) * 0.5);
  const S = P.camZ / f;
  const geom = {
    cx: ((2*(box.x + box.w/2) - W) / H) * S,
    cy: (-(2*(box.y + box.h/2) - H) / H) * S,      // canvas y is down, world y is up
    sx: (box.w / H) * S,
    sy: (box.h / H) * S,
    sz: 0,
    corner: 0,
  };
  geom.sz = Math.max(1e-3, P.thickness * Math.min(geom.sx, geom.sy));
  geom.corner = P.corner * Math.min(geom.sx, geom.sy);
  const R = Math.max(geom.sx, geom.sy);

  const samples = Math.max(1, Math.round(draft ? Math.min(DRAFT_SAMPLES, P.quality) : P.quality));
  P = Object.assign({}, P, {_draft: !!draft});

  gl.bindVertexArray(vao);
  gl.disable(gl.BLEND);

  // path prepass: 384 pixels, once
  gl.useProgram(progPath);
  gl.bindFramebuffer(gl.FRAMEBUFFER, pathFbo);
  gl.viewport(0, 0, PATH_N, 3);
  setUniforms(progPath, W, H, geom, P, S, R);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // accumulate
  gl.useProgram(progTrace);
  gl.viewport(0, 0, w, h);
  setUniforms(progTrace, W, H, geom, P, S, R);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, pathTex);
  gl.uniform1i(loc(progTrace,'uPath'), 1);
  let ping = 0;
  for (let s = 0; s < samples; s++){
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo[ping^1]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex[ping]);
    gl.uniform1i(loc(progTrace,'uPrev'), 0);
    gl.uniform1f(loc(progTrace,'uSample'), s);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    ping ^= 1;
  }

  // present
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.useProgram(progShow);
  gl.viewport(0, 0, w, h);
  gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex[ping]);
  gl.uniform1i(loc(progShow,'uAccum'), 0);
  gl.uniform1f(loc(progShow,'uExpo'), P.exposure);
  gl.uniform1f(loc(progShow,'uShoulder'), P.shoulder);
  gl.uniform1f(loc(progShow,'uGrain'), P.grain);
  gl.uniform1f(loc(progShow,'uAlphaMode'), P.blend === 'add' ? 1 : 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  return cv;
}

/* The standalone app's presets, with the scene furniture dropped and every
   size expressed relative to the object's box instead of in world units. */
const PRESETS = [
  { name:'Graphic',  // flat poster look: opaque body, wide soft beam swung off-axis
    v:{shape:0, thickness:0.35, corner:0.29, wedge:0, ior:1.50, dispersion:0, body:1,
       azimuth:90, elevation:-30, bend:56, fan:16, bands:0, spectrum:1,
       width:0.29, softness:2, intensity:3.0, inGain:1, outGain:2.1, falloff:0.008,
       airScatter:0.16, glassScatter:0, saturation:1.0, rim:0,
       exposure:1.10, shoulder:0.30} },
  { name:'Bands',    // infographic reading: discrete ribbons, not a smear
    v:{shape:5, thickness:1.0, corner:0.024, wedge:0, ior:1.50, dispersion:0, body:1,
       azimuth:90, elevation:-26, bend:52, fan:44, bands:7, spectrum:0,
       width:0.067, softness:2, intensity:3.4, inGain:1, outGain:2.6, falloff:0.004,
       airScatter:0.11, glassScatter:0, saturation:1.40, rim:0,
       exposure:1.20, shoulder:0.30} },
  { name:'Newton',   // real optics: an equilateral prism deviates on its own, fan 0
    v:{shape:1, thickness:0.545, corner:0.022, wedge:0, ior:1.62, dispersion:0.13, body:0,
       azimuth:90, elevation:24, bend:0, fan:0, bands:0, spectrum:0,
       width:0.055, softness:2.2, aimY:0.18, intensity:2.6, inGain:1, outGain:3.6, falloff:0.006,
       airScatter:0.052, glassScatter:1.15, saturation:1.40, rim:0.50,
       exposure:1.15, shoulder:0.28} },
  { name:'Wedge',    // thick non-parallel faces, no art direction
    v:{shape:0, thickness:0.867, corner:0.033, wedge:34, yaw:24, ior:1.66, dispersion:0.34, body:0,
       azimuth:74, elevation:6, bend:0, fan:0, bands:0, spectrum:0,
       width:0.233, softness:2, intensity:3.4, inGain:1, outGain:2.2, falloff:0.027,
       airScatter:0.075, glassScatter:1.2, saturation:1.3, rim:0.42,
       exposure:1.25, shoulder:0.24} },
];

window.PrismEngine = { render, available:()=>init(), SHAPES, PRESETS, DRAFT_SAMPLES };
})();
