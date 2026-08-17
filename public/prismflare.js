/* Prism Flare — a spectral light rig (§5.x material slot).
 *
 * PROVENANCE. Ported from the author's own standalone prism-flare.html, and
 * REPLACED in session 18 with the author's revised standalone: the fixed
 * three-preset fan tables became an editable beam list (up to 16, per-beam
 * angle/width/dispersion/hue/intensity/reach), and the physical spectrum
 * gained seven alternative palettes blended against it. Both shaders are
 * carried across essentially verbatim; the plumbing is ours. Nothing is
 * derived from Shadertoy or any other licensed source — see
 * SHADER-PROVENANCE.md. Published constructions used and credited rather
 * than claimed: the Vogel/golden-angle spiral in the bloom gather, and
 * Gaussian lobe fits to the CIE cone responses.
 *
 * WHAT IT IS. Wedge-shaped beams radiate from a source point. Wavelength is a
 * function of the angle ACROSS each wedge rather than of position in the
 * frame, which is what a prism actually does and why the bands stay parallel
 * to the fan edges however the rig is aimed. Palettes are blended AGAINST the
 * physical spectrum rather than replacing it, so a chosen palette inherits
 * the spectrum's uneven luminance — the bright mid band, the dim violet
 * tail — instead of reading as a flat gradient. A second pass adds bloom,
 * tone map and grain.
 *
 * IT PAINTS ITS OWN BACKGROUND, AND THAT IS THE POINT. Additive light onto a
 * white artboard saturates at 255 and is mathematically invisible (measured
 * at exactly 0 contrast in session 15). This engine renders a complete
 * scene — background included — so it reads on any page colour; `transparent`
 * drops the background and lets luminance carry coverage instead.
 *
 * PLUMBING ADDITION, not in the standalone: the present pass takes u_alpha
 * for that transparent mode. The standalone composites on its own dark stage
 * and needs no alpha at all.
 *
 * NO ANIMATION. A document is static and must export as what you see.
 */
(function () {
  "use strict";

  const MAXF = 16; // shader array size — the ceiling, not the count

  const VERT = `#version 300 es
void main(){
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

  /* ------------------------------------------------------------------ *
   * SCENE PASS — additive light field in polar coordinates.
   * ------------------------------------------------------------------ */
  const SCENE = `#version 300 es
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
uniform vec3  u_coreCol, u_tint, u_colA, u_colB;
uniform float u_duo;
uniform int   u_pal;
uniform float u_gap, u_gapFall, u_spine, u_spineW, u_edgeGrow;
uniform int   u_nf;
uniform float u_fAng[${MAXF}];
uniform float u_fWidth[${MAXF}];
uniform float u_fDisp[${MAXF}];
uniform float u_fHue[${MAXF}];
uniform float u_fInt[${MAXF}];
uniform float u_fReach[${MAXF}];

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

vec3 hsv2rgb(vec3 c){
  vec3 q = abs(fract(c.xxx + vec3(0.0, 2.0/3.0, 1.0/3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(q - 1.0, 0.0, 1.0), c.y);
}
vec3 ramp3(float t, vec3 a, vec3 b, vec3 c){
  return t < 0.5 ? mix(a, b, t * 2.0) : mix(b, c, (t - 0.5) * 2.0);
}

/* Named palettes over the same dispersion coordinate. Prism is the
   physical cone response; Rainbow is a flat HSV sweep, which is more
   saturated but has none of the spectrum's uneven luminance. The rest
   are ordinary three-stop ramps. */
vec3 palette(float t){
  t = clamp(t, 0.0, 1.0);
  if(u_pal == 1) return hsv2rgb(vec3(t * 0.85, 1.0, 1.0));                              // Rainbow
  if(u_pal == 2) return mix(u_colA, u_colB, t);                                          // Duotone
  if(u_pal == 3) return ramp3(t, vec3(1.00,0.60,0.18), vec3(1.00,0.18,0.39), vec3(0.48,0.18,0.97)); // Sunset
  if(u_pal == 4) return ramp3(t, vec3(0.49,0.98,1.00), vec3(0.17,0.48,1.00), vec3(0.95,0.96,1.00)); // Ice
  if(u_pal == 5) return ramp3(t, vec3(1.00,0.18,0.80), vec3(0.71,1.00,0.18), vec3(0.18,0.91,1.00)); // Neon
  if(u_pal == 6) return ramp3(t, vec3(1.00,0.82,0.00), vec3(1.00,0.42,0.00), vec3(0.78,0.12,0.35)); // Ember
  if(u_pal == 7) return ramp3(t, vec3(0.18,1.00,0.71), vec3(0.18,0.61,1.00), vec3(0.76,0.18,1.00)); // Aurora
  return spectrum(t);                                                                    // Prism
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

  for(int i=0;i<${MAXF};i++){
    if(i >= u_nf) break;
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
    // The bend scales with each beam's own offset from the fan centre, so
    // the middle stays true and the outer ones sweep hardest. Saturate
    // smoothly instead of clamping — a slope discontinuity is precisely
    // what reads as a crease in the beam.
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
    // Edge softness grows with distance: real shafts are tightest at the
    // source and diffuse as the beam travels. aa stays the floor — it is
    // the anti-aliasing minimum.
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
    // A real fixture emits from a disc rather than a point; fading the
    // beams in over that disc removes the r = 0 singularity.
    fall *= smoothstep(0.0, APERTURE, r);

    float lam = 0.5 + x * u_fDisp[i] * u_gDisp + u_fHue[i];
    // Blended against the physical spectrum rather than replacing it, so
    // the chosen palette inherits the spectrum's uneven luminance — the
    // bright mid band, the dim violet tail — instead of reading as a flat
    // two-stop gradient.
    vec3 base = mix(spectrum(lam), palette(lam), u_duo);
    acc += base * u_tint * prof * fall * inten;

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
  const PRESENT = `#version 300 es
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
    // Threshold BEFORE gathering — bloom must see only what is genuinely
    // over-bright, or it lifts the blacks to grey haze.
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

  /* Alpha — plumbing addition for this app, not in the standalone. 1 fills
   * the box with the whole scene, background included. 0 drops the
   * background and luminance IS the coverage: bright means present, so the
   * flare can sit over artwork already on the page. */
  float al = u_alpha > 0.5 ? 1.0
           : clamp(dot(c, vec3(0.2126, 0.7152, 0.0722)) * 1.6, 0.0, 1.0);
  fragColor = vec4(clamp(c, 0.0, 1.0), al);
}`;

  let gl = null,
    cv = null,
    progScene = null,
    progShow = null,
    vao = null;
  let sceneTex = null,
    sceneFbo = null,
    W = 0,
    H = 0,
    hasFloat = false,
    failed = false;
  const L = {};

  function loc(prog, name) {
    const k = (prog === progScene ? "s:" : "p:") + name;
    if (!(k in L)) L[k] = gl.getUniformLocation(prog, name);
    return L[k];
  }

  function init() {
    if (gl) return true;
    if (failed) return false;
    try {
      cv = document.createElement("canvas");
      gl = cv.getContext("webgl2", {
        antialias: false,
        alpha: true,
        preserveDrawingBuffer: true,
      });
      if (!gl) throw new Error("WebGL2 unavailable");
      hasFloat = !!gl.getExtension("EXT_color_buffer_float");
      const compile = (src, type) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
          throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      const program = (fs) => {
        const p = gl.createProgram();
        gl.attachShader(p, compile(VERT, gl.VERTEX_SHADER));
        gl.attachShader(p, compile(fs, gl.FRAGMENT_SHADER));
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS))
          throw new Error(gl.getProgramInfoLog(p));
        return p;
      };
      progScene = program(SCENE);
      progShow = program(PRESENT);
      vao = gl.createVertexArray();
      return true;
    } catch (e) {
      console.warn("prism flare engine disabled:", e.message);
      failed = true;
      gl = null;
      return false;
    }
  }

  function alloc(w, h) {
    if (sceneTex) {
      gl.deleteTexture(sceneTex);
      gl.deleteFramebuffer(sceneFbo);
    }
    sceneTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, sceneTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, hasFloat ? gl.RGBA16F : gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    sceneFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sceneTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    W = w;
    H = h;
  }

  const rad = (d) => (d * Math.PI) / 180;
  const hexToLin = (h) => {
    const n = parseInt(String(h || "#000000").slice(1), 16) || 0;
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map((v) =>
      v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4),
    );
  };

  /* Preset fan tables from the standalone, used when the document carries no
   * explicit beam list. Each row: [angle, width, dispersion, hue, intensity,
   * reach]. Reference is ONE beam now — the standalone's comment: "Add builds
   * from whatever is selected; starting from eight means deleting seven." */
  function fansFor(name) {
    if (name === "burst") {
      const out = [];
      const n = 8;
      for (let i = 0; i < n; i++)
        out.push([i * (360 / n) - 157, 7 + (i % 3) * 4, 0.75, (i % 4) * 0.14 - 0.2, 0.75, 1.7]);
      return out;
    }
    if (name === "blades")
      return [
        [36, 1.2, 1.1, 0.3, 1.4, 0.95],
        [28, 1.0, 1.1, 0.05, 1.25, 1.05],
        [20, 1.4, 1.0, -0.2, 1.2, 1.15],
        [10, 1.0, 1.1, 0.2, 1.1, 1.25],
        [-1, 1.6, 0.95, -0.05, 1.0, 1.35],
        [-14, 1.0, 1.1, 0.25, 0.95, 1.45],
        [-28, 1.3, 1.0, 0, 0.85, 1.55],
        [-43, 1.0, 1.1, -0.25, 0.8, 1.65],
      ];
    return [[0.0, 7.0, 0.8, 0.0, 0.9, 1.5]]; // reference: one good beam
  }
  /** Effective beams for a param set: the explicit list, else the preset. */
  function beamsOf(P) {
    if (Array.isArray(P.beams) && P.beams.length)
      return P.beams
        .slice(0, MAXF)
        .map((b) => [+b.ang || 0, +b.width || 4, +b.disp || 0, +b.hue || 0,
                     b.inten === undefined ? 0.8 : +b.inten, +b.reach || 1.5]);
    return fansFor(P.preset || "reference");
  }

  /** Render into a w x h canvas. Returns it, or null if unavailable. */
  function render(w, h, P) {
    if (!init()) return null;
    w = Math.max(2, Math.round(w));
    h = Math.max(2, Math.round(h));
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
    }
    if (w !== W || h !== H) alloc(w, h);

    const fans = beamsOf(P);
    const fA = new Float32Array(MAXF), fW = new Float32Array(MAXF),
      fD = new Float32Array(MAXF), fH = new Float32Array(MAXF),
      fI = new Float32Array(MAXF), fR = new Float32Array(MAXF);
    for (let i = 0; i < fans.length && i < MAXF; i++) {
      const f = fans[i];
      fA[i] = rad(f[0]); fW[i] = rad(f[1]); fD[i] = f[2];
      fH[i] = f[3]; fI[i] = f[4]; fR[i] = f[5];
    }

    gl.bindVertexArray(vao);
    gl.useProgram(progScene);
    gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFbo);
    gl.viewport(0, 0, W, H);
    const S = (n) => loc(progScene, n);
    gl.uniform2f(S("u_res"), W, H);
    gl.uniform2f(S("u_src"), P.srcX === undefined ? 0.24 : +P.srcX, P.srcY === undefined ? 0.66 : +P.srcY);
    gl.uniform1f(S("u_pan"), rad(P.pan === undefined ? -32 : +P.pan));
    gl.uniform1f(S("u_converge"), rad(P.converge === undefined ? 90 : +P.converge));
    gl.uniform1f(S("u_spread"), P.spread === undefined ? 1 : +P.spread);
    gl.uniform1f(S("u_gDisp"), P.dispersion === undefined ? 1 : +P.dispersion);
    gl.uniform1f(S("u_gReach"), P.reach === undefined ? 1 : +P.reach);
    gl.uniform1f(S("u_gInt"), P.brightness === undefined ? 1 : +P.brightness);
    gl.uniform1f(S("u_beamX"), +P.beamX || 0);
    gl.uniform1f(S("u_beamY"), +P.beamY || 0);
    gl.uniform1f(S("u_haze"), P.haze === undefined ? 0.1 : +P.haze);
    gl.uniform1f(S("u_spine"), +P.spine || 0);
    gl.uniform1f(S("u_spineW"), P.spineWidth === undefined ? 120 : +P.spineWidth);
    gl.uniform1f(S("u_gap"), +P.gap || 0);
    gl.uniform1f(S("u_gapFall"), P.gapFalloff === undefined ? 2.2 : +P.gapFalloff);
    gl.uniform1f(S("u_coreOn"), P.core === false ? 0 : 1);
    gl.uniform1f(S("u_core"), P.coreSize === undefined ? 0.018 : +P.coreSize);
    gl.uniform1f(S("u_widMul"), P.width === undefined ? 1 : +P.width);
    gl.uniform1f(S("u_edge"), P.edge === undefined ? 0.12 : +P.edge);
    gl.uniform1f(S("u_edgeGrow"), +P.edgeGrow || 0);
    gl.uniform1f(S("u_curve"), +P.curve || 0);
    gl.uniform1f(S("u_curveRise"), P.curveRise === undefined ? 2 : +P.curveRise);
    gl.uniform1f(S("u_halo"), P.halo === undefined ? 2.2 : +P.halo);
    gl.uniform1f(S("u_falloff"), P.falloff === undefined ? 0.25 : +P.falloff);
    gl.uniform3fv(S("u_coreCol"), hexToLin(P.coreColor || "#ffffff"));
    gl.uniform3fv(S("u_tint"), hexToLin(P.tint || "#ffffff"));
    gl.uniform1f(S("u_duo"), P.paletteBlend === undefined ? 1 : +P.paletteBlend);
    gl.uniform1i(S("u_pal"), Math.max(0, Math.min(7, P.palette | 0)));
    gl.uniform3fv(S("u_colA"), hexToLin(P.colA || "#ff36c8"));
    gl.uniform3fv(S("u_colB"), hexToLin(P.colB || "#3fe6ff"));
    gl.uniform1i(S("u_nf"), Math.min(fans.length, MAXF));
    gl.uniform1fv(S("u_fAng"), fA);
    gl.uniform1fv(S("u_fWidth"), fW);
    gl.uniform1fv(S("u_fDisp"), fD);
    gl.uniform1fv(S("u_fHue"), fH);
    gl.uniform1fv(S("u_fInt"), fI);
    gl.uniform1fv(S("u_fReach"), fR);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.useProgram(progShow);
    gl.viewport(0, 0, W, H);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sceneTex);
    const Q = (n) => loc(progShow, n);
    gl.uniform1i(Q("u_scene"), 0);
    gl.uniform2f(Q("u_res"), W, H);
    gl.uniform1f(Q("u_expo"), P.exposure === undefined ? 1 : +P.exposure);
    gl.uniform1f(Q("u_sat"), P.saturation === undefined ? 1.2 : +P.saturation);
    gl.uniform1f(Q("u_grain"), P.grain === undefined ? 0.02 : +P.grain);
    gl.uniform1f(Q("u_vig"), P.vignette === undefined ? 0.35 : +P.vignette);
    gl.uniform1f(Q("u_alpha"), P.transparent ? 0 : 1);
    gl.uniform3fv(Q("u_bg"), hexToLin(P.bg || "#000000"));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return cv;
  }

  window.FlareEngine = {
    render,
    available: () => init(),
    PRESETS: ["reference", "burst", "blades"],
    PALETTES: ["Prism (physical)", "Rainbow", "Duotone", "Sunset", "Ice", "Neon", "Ember", "Aurora"],
    fansFor,
    MAXF,
  };
})();
