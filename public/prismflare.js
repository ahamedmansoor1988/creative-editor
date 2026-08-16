/* Prism Flare — a spectral light rig (§5.x material slot).
 *
 * PROVENANCE. Ported from the author's own standalone prism-flare.html. Both
 * shaders are carried across essentially verbatim; only the plumbing changed.
 * Nothing is derived from Shadertoy or any other licensed source — see
 * SHADER-PROVENANCE.md. Two published constructions are used and credited
 * there rather than claimed: the Vogel/golden-angle spiral used for the bloom
 * gather, and Gaussian lobe fits to the CIE cone responses.
 *
 * WHAT IT IS. Eight angular wedges radiate from a source point. Wavelength is
 * a function of the angle ACROSS each wedge rather than of position in the
 * frame, which is what a prism actually does and why the bands stay parallel
 * to the fan edges however the rig is aimed. A second pass adds bloom, tone
 * maps and grains.
 *
 * IT PAINTS ITS OWN BACKGROUND, AND THAT IS THE POINT. The existing Prism
 * engine composites additively over the page, and session 15 established what
 * that costs: additive light onto a white artboard saturates at 255 and the
 * effect is mathematically invisible. Measured contrast there was exactly 0.
 * This engine renders a complete scene — background included — into the
 * object's own box, so it reads on any page colour. `bg` is a parameter, not
 * an assumption about what is underneath.
 *
 * WHY IT IS A MATERIAL AND NOT A BACKDROP EFFECT. It never samples the page,
 * so it caches like any other material.
 *
 * NO ANIMATION. Same reasoning as the other engines: a document is static and
 * must export as what you see, so there is no clock.
 */
(function(){
"use strict";

const NF=8;   // fans, fixed — mute one by setting its intensity to 0

const VERT=`#version 300 es
void main(){
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/* ------------------------------------------------------------------ *
 * SCENE PASS — additive light field in polar coordinates.
 * ------------------------------------------------------------------ */
const SCENE=`#version 300 es
precision highp float;
out vec4 fragColor;

uniform vec2  u_res;
uniform vec2  u_src;
uniform float u_pan, u_converge, u_spread, u_gDisp, u_gReach, u_gInt;
uniform float u_beamX, u_beamY;
uniform float u_haze;
uniform float u_coreOn, u_core, u_halo;
uniform float u_widMul, u_edge;
uniform float u_curve, u_curveRise, u_falloff;
uniform vec3  u_coreCol, u_tint;
uniform float u_gap, u_gapFall, u_spine, u_spineW, u_edgeGrow;
uniform float u_fAng[${NF}];
uniform float u_fWidth[${NF}];
uniform float u_fDisp[${NF}];
uniform float u_fHue[${NF}];
uniform float u_fInt[${NF}];
uniform float u_fReach[${NF}];
uniform float u_fStart[${NF}];

/* Gaussian lobes fitted to the cone responses. The RED channel gets a
   second small lobe at ~425nm: long-wave cones have a genuine secondary
   response in the violet, and without it the short end renders blue
   rather than violet and the fan loses its purple tail — the most
   recognisable part of a dispersion. */
// APERTURE must stay above zero: the beams are angular wedges, so the
// gaps between them converge on r = 0 as well, and at zero a pixel's
// angle there is arbitrary enough to land in a gap — which is what
// produced the one-pixel slivers around the source.
const float APERTURE = 0.055;
const float FLARE    = 0.85;

vec3 spectrum(float t){
  float w = 400.0 + clamp(t, 0.0, 1.0) * 300.0;
  float r = exp(-pow((w - 605.0) / 52.0, 2.0)) + 0.48 * exp(-pow((w - 425.0) / 28.0, 2.0));
  float g = exp(-pow((w - 540.0) / 56.0, 2.0));
  float b = exp(-pow((w - 458.0) / 52.0, 2.0)) + 0.22 * exp(-pow((w - 420.0) / 30.0, 2.0));
  return vec3(r, g, b);
}

// Signed angular difference wrapped to -PI..PI, branch-free.
float angDiff(float a, float b){
  float d = a - b;
  return atan(sin(d), cos(d));
}

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  float aspect = u_res.x / u_res.y;
  vec2 p = vec2(uv.x * aspect, uv.y);
  // Beam X/Y nudge the whole rig — source, core and fans together.
  vec2 s = vec2((u_src.x + u_beamX) * aspect, u_src.y + u_beamY);

  vec2 d = p - s;
  float r = length(d);          // everything pivots about the source
  float a = atan(d.y, d.x);

  vec3 acc = vec3(0.0);

  /* ---- the head ---------------------------------------------------
     A moving-head light bolted at the source. Pan and Converge aim a 3D
     axis; each fan is that axis yawed by its own offset. Projecting
     those 3D directions to screen is the whole point: as the rig swings
     toward the camera its fans bunch together, foreshorten and widen,
     and swinging away they stretch and narrow. A flat 2D rotation moves
     every fan by the same amount and can never do that. */
  float ccv = cos(u_converge), scv = sin(u_converge);

  for(int i=0;i<${NF};i++){
    float inten = u_fInt[i] * u_gInt;
    if(inten <= 0.0) continue;

    // The fan is a sheet of beams splayed in one plane, built facing down
    // +Z and then yawed by Converge. At 90° the sheet lies across the
    // view and opens fully; swinging toward 0 turns it edge-on and the
    // beams collapse together, which is the light aiming at the camera.
    float phi = u_fAng[i] * u_spread;
    vec3 v = vec3(cos(phi) * scv, sin(phi), cos(phi) * ccv);

    // How much of this beam lies across the view rather than along it.
    float f = length(v.xy);
    if(f < 1e-3) continue;
    float fanAng = atan(v.y, v.x) + u_pan;
    float fc = max(f, 0.22);

    // Down the barrel the cone opens toward us and the beam foreshortens
    // to almost nothing; side-on it is at full length and full narrowness.
    float wid  = max(u_fWidth[i] * u_widMul, 1e-4) / fc;
    float rch  = u_fReach[i] * u_gReach / fc;

    // Curve: bend the beam as it travels instead of firing it straight.
    // Saturate smoothly instead of clamping — a slope discontinuity is
    // precisely what reads as a crease in the beam.
    float bt   = 1.0 - exp(-r * 1.4);
    float bend = u_curve * (u_fAng[i] * u_spread) * pow(bt, u_curveRise);

    float x = angDiff(a, fanAng + bend) / wid;  // -1..1 across the wedge
    float ax = abs(x);
    if(ax > 2.4) continue;

    // Screen-space width of one pixel measured in wedge units. Derived
    // rather than taken from fwidth() because this loop has per-pixel
    // continues, and derivatives are undefined under non-uniform control
    // flow.
    float aa = clamp(1.0 / (max(r, 1e-4) * wid * u_res.y), 0.0, 0.9);
    // Edge softness grows with distance: in real shafts the boundary is
    // tightest at the source and diffuses as the beam travels.
    float ew = max(u_edge * (1.0 + u_edgeGrow * r), aa);

    float prof = (ax > 1.0 + aa) ? 0.0
               : (1.0 - smoothstep(1.0 - ew, 1.0 + aa, ax)) * mix(1.0, 1.0 - ax * ax, 0.55);
    // Haze is a soft skirt surviving past the wedge's hard edge —
    // scatter around the beam, not a wider beam.
    prof += exp(-ax * ax * 1.1) * u_haze * 1.8;

    // Between-beam wash. Haze is a gaussian, which dies too fast to
    // reach across a gap — a rational falloff has a far longer tail.
    if(u_gap > 0.0){
      prof += u_gap / (1.0 + pow(ax, u_gapFall) * 8.0)
                    * (1.0 - smoothstep(1.7, 2.4, ax));
    }

    float fall = exp(-r * rch) / (u_falloff + r);
    // A real fixture emits from a disc rather than a point, so fading the
    // beams in over that disc removes the r = 0 singularity instead of
    // trying to filter its symptoms.
    fall *= smoothstep(0.0, APERTURE, r);
    // Start lets a fan begin away from the core, so a blade can float
    // free of the flare instead of always growing out of it.
    fall *= smoothstep(u_fStart[i], u_fStart[i] + 0.045, r);

    float lam = 0.5 + x * u_fDisp[i] * u_gDisp + u_fHue[i];
    acc += spectrum(lam) * u_tint * prof * fall * inten;

    // Spine: a razor-thin ridge down each beam's centre. The reference
    // look is two scales at once — a hard bright line plus a wide soft
    // halo. A single wedge profile can be sharp OR broad, never both.
    if(u_spine > 0.0)
      acc += u_tint * exp(-ax * ax * u_spineW) * u_spine * fall * inten;
  }

  // ---- core -------------------------------------------------------
  if(u_coreOn > 0.5){
    acc += u_coreCol * exp(-(r * r) / max(u_core * u_core, 1e-7)) * FLARE * 3.0;
    // Tight halo only. A wide exponential skirt looks harmless in linear
    // space, but the 1/2.2 gamma lifts its tail into visible grey across
    // half the frame — the black has to come from the render.
    acc += u_coreCol * exp(-r / max(u_core * u_halo, 1e-4)) * FLARE * 0.30;
  }

  fragColor = vec4(acc, 1.0);
}`;

/* ------------------------------------------------------------------ *
 * PRESENT PASS — bloom, tone map, grain, vignette.
 * Vogel-spiral gather rather than a separable blur: with ~28 taps a
 * uniform disc clumps, and clumps read as rings around the source.
 * ------------------------------------------------------------------ */
const PRESENT=`#version 300 es
precision highp float;
out vec4 fragColor;

uniform sampler2D u_scene;
uniform vec2  u_res;
uniform float u_expo, u_sat, u_grain, u_vig, u_alpha;
uniform vec3  u_bg;

const float BLOOM = 0.60, BRADIUS = 40.0, BTHRESH = 0.55;

float h21(vec2 p){
  vec3 v = fract(vec3(p.xyx) * 0.1031);
  v += dot(v, v.yzx + 33.33);
  return fract((v.x + v.y) * v.z);
}

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  vec3 base = texture(u_scene, uv).rgb;

  // Per-pixel rotation of the spiral. Without it every pixel samples the
  // SAME offsets, so a small intensely bright core gets point-sampled into
  // coherent faint spokes radiating out of it. Rotating each pixel's
  // spiral decorrelates those spokes into fine noise.
  float srot = h21(gl_FragCoord.xy) * 6.2831853;

  vec3 bl = vec3(0.0);
  float tot = 0.0;
  for(int i=0;i<44;i++){
    float fi = float(i) + 0.5;
    float rr = sqrt(fi / 44.0) * BRADIUS;
    float th = fi * 2.39996323 + srot;                // golden angle
    vec2 off = vec2(cos(th), sin(th)) * rr / u_res;
    float w = 1.0 - rr / BRADIUS;
    // Threshold BEFORE gathering. Without it the gather is just a blur of
    // the whole frame added back on top, which lifts the blacks to grey
    // haze — bloom must see only what is genuinely over-bright.
    bl  += max(texture(u_scene, uv + off).rgb - BTHRESH, 0.0) * w;
    tot += w;
  }
  bl /= max(tot, 1e-4);

  vec3 c = u_bg + base + bl * BLOOM;
  c *= u_expo;
  c = 1.0 - exp(-c);                    // graceful clip to white

  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(lum), c, u_sat);

  vec2 q = uv - 0.5;
  c *= clamp(1.0 - u_vig * dot(q, q) * 2.4, 0.0, 1.0);

  c = pow(max(c, 0.0), vec3(1.0 / 2.2));
  c += (h21(gl_FragCoord.xy) - h21(gl_FragCoord.xy + 71.7)) * u_grain;
  c += (h21(gl_FragCoord.xy + 13.1) - 0.5) / 255.0;   // dither

  /* Alpha. u_alpha 1 fills the object's box with the whole scene,
   * background included — the mode that reads on any page colour. At 0 the
   * background drops out and only the light itself carries coverage, so the
   * flare can sit over artwork already on the page. Luminance IS the
   * coverage for a light effect: bright means present. */
  float al = u_alpha > 0.5 ? 1.0
           : clamp(dot(c, vec3(0.2126, 0.7152, 0.0722)) * 1.6, 0.0, 1.0);
  fragColor = vec4(clamp(c, 0.0, 1.0), al);
}`;

let gl=null, cv=null, progScene=null, progShow=null, vao=null;
let sceneTex=null, sceneFbo=null, W=0, H=0, hasFloat=false, failed=false;
const L={};

function loc(prog,name){
  const k=(prog===progScene?'s:':'p:')+name;
  if(!(k in L)) L[k]=gl.getUniformLocation(prog,name);
  return L[k];
}

function init(){
  if(gl) return true;
  if(failed) return false;
  try{
    cv=document.createElement('canvas');
    gl=cv.getContext('webgl2',{antialias:false,alpha:true,preserveDrawingBuffer:true});
    if(!gl) throw new Error('WebGL2 unavailable');
    hasFloat=!!gl.getExtension('EXT_color_buffer_float');
    const compile=(src,type)=>{
      const s=gl.createShader(type);
      gl.shaderSource(s,src); gl.compileShader(s);
      if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const program=fs=>{
      const p=gl.createProgram();
      gl.attachShader(p,compile(VERT,gl.VERTEX_SHADER));
      gl.attachShader(p,compile(fs,gl.FRAGMENT_SHADER));
      gl.linkProgram(p);
      if(!gl.getProgramParameter(p,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      return p;
    };
    progScene=program(SCENE);
    progShow=program(PRESENT);
    vao=gl.createVertexArray();
    return true;
  }catch(e){
    console.warn('prism flare engine disabled:',e.message);
    failed=true; gl=null; return false;
  }
}

function alloc(w,h){
  if(sceneTex){ gl.deleteTexture(sceneTex); gl.deleteFramebuffer(sceneFbo); }
  sceneTex=gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D,sceneTex);
  gl.texStorage2D(gl.TEXTURE_2D,1,hasFloat?gl.RGBA16F:gl.RGBA8,w,h);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  sceneFbo=gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER,sceneFbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,sceneTex,0);
  gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  W=w; H=h;
}

const rad=d=>d*Math.PI/180;
const hexToLin=h=>{
  const n=parseInt(String(h||'#000000').slice(1),16)||0;
  return [((n>>16)&255)/255,((n>>8)&255)/255,(n&255)/255]
    .map(v=>v<=0.04045?v/12.92:Math.pow((v+0.055)/1.055,2.4));
};

/* Fan layouts. Each entry is [angle, width, dispersion, hue, intensity,
 * reach, start]. These are the standalone's presets, kept because they are
 * what the look was tuned against. */
const PRESETS={
  reference:[[35,2.2,0.90,0.28,0.90,1.15,0],[25,13,0.55,0,0.60,1.60,0],
             [11,5.5,0.72,0.10,0.80,1.35,0],[-5,10,0.50,-0.16,0.70,1.75,0],
             [-21,3.6,0.85,0.22,0.85,1.45,0],[-36,8,0.62,0.05,0.55,2.00,0],
             [-56,4,0.70,0.15,0.45,2.20,0],[46,3,0.80,-0.10,0.40,1.90,0]],
  burst:null,   // generated, see fansFor
  blades:[[36,1.2,1.10,0.30,1.40,0.95,0],[28,1.0,1.10,0.05,1.25,1.05,0],
          [20,1.4,1.00,-0.20,1.20,1.15,0],[10,1.0,1.10,0.20,1.10,1.25,0],
          [-1,1.6,0.95,-0.05,1.00,1.35,0],[-14,1.0,1.10,0.25,0.95,1.45,0],
          [-28,1.3,1.00,0,0.85,1.55,0],[-43,1.0,1.10,-0.25,0.80,1.65,0]],
};
function fansFor(name){
  if(name==='burst'){
    const out=[];
    for(let i=0;i<NF;i++) out.push([i*45-157, 7+(i%3)*4, 0.75, (i%4)*0.14-0.2, 0.75, 1.70, 0]);
    return out;
  }
  return PRESETS[name]||PRESETS.reference;
}

/** Render into a w x h canvas. Returns it, or null if unavailable. */
function render(w,h,P){
  if(!init()) return null;
  w=Math.max(2,Math.round(w)); h=Math.max(2,Math.round(h));
  if(cv.width!==w||cv.height!==h){ cv.width=w; cv.height=h; }
  if(w!==W||h!==H) alloc(w,h);

  const fans=fansFor(P.preset||'reference');
  const fA=new Float32Array(NF), fW=new Float32Array(NF), fD=new Float32Array(NF),
        fH=new Float32Array(NF), fI=new Float32Array(NF),
        fR=new Float32Array(NF), fT=new Float32Array(NF);
  for(let i=0;i<NF;i++){
    const f=fans[i]||[0,4,0.7,0,0,1.5,0];
    fA[i]=rad(f[0]); fW[i]=rad(f[1]); fD[i]=f[2]; fH[i]=f[3];
    fI[i]=f[4];      fR[i]=f[5];      fT[i]=f[6];
  }

  gl.bindVertexArray(vao);
  gl.useProgram(progScene);
  gl.bindFramebuffer(gl.FRAMEBUFFER,sceneFbo);
  gl.viewport(0,0,W,H);
  const S=n=>loc(progScene,n);
  gl.uniform2f(S('u_res'),W,H);
  gl.uniform2f(S('u_src'),P.srcX===undefined?0.24:+P.srcX, P.srcY===undefined?0.66:+P.srcY);
  gl.uniform1f(S('u_pan'),rad(+P.pan||0));
  gl.uniform1f(S('u_converge'),rad(P.converge===undefined?90:+P.converge));
  gl.uniform1f(S('u_spread'),P.spread===undefined?1:+P.spread);
  gl.uniform1f(S('u_gDisp'),P.dispersion===undefined?1:+P.dispersion);
  gl.uniform1f(S('u_gReach'),P.reach===undefined?1:+P.reach);
  gl.uniform1f(S('u_gInt'),P.brightness===undefined?1:+P.brightness);
  gl.uniform1f(S('u_beamX'),+P.beamX||0);
  gl.uniform1f(S('u_beamY'),+P.beamY||0);
  gl.uniform1f(S('u_haze'),P.haze===undefined?0.10:+P.haze);
  gl.uniform1f(S('u_spine'),+P.spine||0);
  gl.uniform1f(S('u_spineW'),P.spineWidth===undefined?120:+P.spineWidth);
  gl.uniform1f(S('u_gap'),+P.gap||0);
  gl.uniform1f(S('u_gapFall'),P.gapFalloff===undefined?2.2:+P.gapFalloff);
  gl.uniform1f(S('u_coreOn'),P.core===false?0:1);
  gl.uniform1f(S('u_core'),P.coreSize===undefined?0.018:+P.coreSize);
  gl.uniform1f(S('u_widMul'),P.width===undefined?1:+P.width);
  gl.uniform1f(S('u_edge'),P.edge===undefined?0.12:+P.edge);
  gl.uniform1f(S('u_edgeGrow'),+P.edgeGrow||0);
  gl.uniform1f(S('u_curve'),+P.curve||0);
  gl.uniform1f(S('u_curveRise'),P.curveRise===undefined?2:+P.curveRise);
  gl.uniform1f(S('u_halo'),P.halo===undefined?2.2:+P.halo);
  gl.uniform1f(S('u_falloff'),P.falloff===undefined?0.25:+P.falloff);
  gl.uniform3fv(S('u_coreCol'),hexToLin(P.coreColor||'#ffffff'));
  gl.uniform3fv(S('u_tint'),hexToLin(P.tint||'#ffffff'));
  gl.uniform1fv(S('u_fAng'),fA);
  gl.uniform1fv(S('u_fWidth'),fW);
  gl.uniform1fv(S('u_fDisp'),fD);
  gl.uniform1fv(S('u_fHue'),fH);
  gl.uniform1fv(S('u_fInt'),fI);
  gl.uniform1fv(S('u_fReach'),fR);
  gl.uniform1fv(S('u_fStart'),fT);
  gl.drawArrays(gl.TRIANGLES,0,3);

  gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  gl.useProgram(progShow);
  gl.viewport(0,0,W,H);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D,sceneTex);
  const Q=n=>loc(progShow,n);
  gl.uniform1i(Q('u_scene'),0);
  gl.uniform2f(Q('u_res'),W,H);
  gl.uniform1f(Q('u_expo'),P.exposure===undefined?1:+P.exposure);
  gl.uniform1f(Q('u_sat'),P.saturation===undefined?1.2:+P.saturation);
  gl.uniform1f(Q('u_grain'),P.grain===undefined?0.02:+P.grain);
  gl.uniform1f(Q('u_vig'),P.vignette===undefined?0.35:+P.vignette);
  gl.uniform1f(Q('u_alpha'),P.transparent?0:1);
  gl.uniform3fv(Q('u_bg'),hexToLin(P.bg||'#000000'));
  gl.drawArrays(gl.TRIANGLES,0,3);
  return cv;
}

window.FlareEngine={render,available:()=>init(),PRESETS:['reference','burst','blades'],NF};
})();
