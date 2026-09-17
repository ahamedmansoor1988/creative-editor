/* Fractal glass — fluted glass over a colour field of its own.
 *
 * The sibling of Reed glass, and the difference is the whole point. Reed glass
 * is a backdrop material: it refracts the LAYERS BENEATH it and has no colour
 * of its own. This one refracts a field it generates itself from a palette, so
 * it is a fill: put it on a shape and the shape becomes the glass and the
 * subject at once, with nothing needed underneath.
 *
 * PROVENANCE. Both the flute optics and the field are the author's own
 * reed-glass/index.html. The optics are the same trace() carried across
 * untouched — Snell in, arc height + slab, Snell out, the air gap, three IORs
 * for dispersion, Fresnel, the studio strip light, the seam. The field is its
 * "thermal blobs" source: a handful of gaussians summed, soft-saturated, and
 * read through a colour ramp.
 *
 * Two departures, both deliberate:
 *
 *   - NO TIME. The standalone animates the blobs on a 24-second loop. A
 *     document is static and must export as what you see, so the blobs sit at
 *     fixed positions and Drift X/Y move them by hand instead.
 *   - NO SOURCE PASS. The standalone renders the field into a texture and
 *     refracts that. Here the field is a function, so a refracted ray simply
 *     evaluates it at the displaced point. No framebuffer, no margin to keep
 *     the edge flutes fed, and no resolution to lose — the field is sharp at
 *     any zoom because it is never rasterised before it is sampled.
 */
(function () {
  "use strict";

  const VS = `#version 300 es
precision highp float;
void main(){
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

  const FS = `#version 300 es
precision highp float;
out vec4 o;
uniform vec2  uRes;        // panel size, device px
uniform float uFluteW;     // flute pitch, device px
uniform float uPhase;
uniform float uBulge;
uniform float uIor;
uniform float uDisp;
uniform float uThick;
uniform float uGap;
uniform float uSeamW;      // device px
uniform float uSeamDark;
uniform float uFresnel;
uniform float uSpec;
uniform float uLightAng;   // radians
uniform float uLightW;
uniform float uAmbient;
/* the field */
uniform vec3  uPal[8];     // palette ramp, sRGB
uniform int   uPalN;
uniform vec4  uBlobs[8];   // xy centre (field units), z size, w weight
uniform int   uBlobN;
uniform float uGain, uGamma, uFieldScale;
uniform vec2  uDrift;      // moves the whole field
const int AA = 4;

float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

/* The palette as a ramp. Five colours from the Iridescence sets become a
   continuous gradient; the field's scalar picks a point along it. */
vec3 ramp(float t){
  float n = float(uPalN - 1);
  float x = clamp(t, 0.0, 1.0) * n;
  float i = floor(x);
  float f = x - i;
  f = f * f * (3.0 - 2.0 * f);
  int a = int(i), b = int(min(i + 1.0, n));
  return mix(uPal[a], uPal[b], f);
}

/* The field, evaluated rather than sampled. p is in field units: the panel's
   shorter side is 1, so the look does not change with the shape's aspect. */
vec3 field(vec2 p){
  p = (p - uDrift) / max(uFieldScale, 1e-3);
  float f = 0.0;
  for (int i = 0; i < 8; i++){
    if (i >= uBlobN) break;
    vec4 b = uBlobs[i];
    vec2 d = p - b.xy;
    f += b.w * exp(-dot(d, d) / (2.0 * b.z * b.z));
  }
  float v = 1.0 - exp(-f * uGain);      // soft saturation, no clamp knee
  v = pow(v, uGamma);
  return ramp(v);
}

vec2 trace(float u, float ior, float R){
  float su = (u < 0.0) ? -1.0 : 1.0;
  float sa = clamp(abs(u) / R, 0.0, 0.9975);
  float ca = sqrt(1.0 - sa * sa);
  float alpha = asin(sa);
  float sg = sa / ior;
  float beta = alpha - asin(sg);
  float h = ca * R - (R - uBulge) + uThick;
  float dx = h * tan(beta);
  float sair = ior * sin(beta);
  float trans = 1.0;
  if (sair >= 0.9995) { sair = 0.9995; trans = 0.0; }
  dx += uGap * tan(asin(sair));
  return vec2(u - su * dx, trans);
}

/* Panel pixels -> field units. The shorter side is 1 and the origin is the
   panel's centre, so a square field stays square on any shape. */
vec2 toField(float sx, float sy){
  float mn = min(uRes.x, uRes.y);
  return (vec2(sx, sy) - 0.5 * uRes) / mn;
}

void main(){
  float fw = max(uFluteW, 2.0);
  float hw = 0.5 * fw;
  float R  = (1.0 + uBulge * uBulge) / (2.0 * uBulge);
  float F0 = (uIor - 1.0) / (uIor + 1.0); F0 *= F0;
  float sw = clamp(0.5 * uSeamW / hw, 0.0, 1.0);
  float sy = uRes.y - gl_FragCoord.y;              // top-down
  vec3 acc = vec3(0.0);
  for (int j = 0; j < AA; j++) {
    float x  = gl_FragCoord.x + (float(j) + 0.5) / float(AA) - 0.5;
    float xf = x / fw - uPhase;
    float i  = floor(xf);
    float u  = (xf - i - 0.5) * 2.0;
    float cx = (i + 0.5 + uPhase) * fw;
    vec2 tr = trace(u, uIor - uDisp, R);
    vec2 tg = trace(u, uIor,         R);
    vec2 tb = trace(u, uIor + uDisp, R);
    vec3 col = vec3(field(toField(cx + tr.x * hw, sy)).r,
                    field(toField(cx + tg.x * hw, sy)).g,
                    field(toField(cx + tb.x * hw, sy)).b);
    vec3 trans = vec3(tr.y, tg.y, tb.y);
    float sa = clamp(abs(u) / R, 0.0, 1.0);
    float ca = sqrt(1.0 - sa * sa);
    float F  = F0 + (1.0 - F0) * pow(1.0 - ca, 5.0);
    float Ft = clamp(F * uFresnel, 0.0, 1.0);
    /* The environment the facet reflects: the field, smeared wide so it has no
     * image in it. A sharp copy here paints a ghost of the field at its true
     * position instead of a reflection — the same trap Reed glass fell into. */
    vec3 mir = vec3(0.0);
    for (int k = -2; k <= 2; k++) mir += field(toField(x + float(k) * fw * 0.6, sy));
    mir /= 5.0;
    vec3 cT = mix(mir, col, trans) * (1.0 - Ft);
    float refl = 2.0 * asin(clamp(u / R, -1.0, 1.0));
    float lobe = exp(-pow((refl - uLightAng) / uLightW, 2.0));
    float refW = mix(F, 1.0, 1.0 - tg.y);
    vec3 cR = vec3(uAmbient + uSpec * lobe) * refW + Ft * mir;
    vec3 c = cT + cR;
    float seam = smoothstep(1.0 - sw, 1.0, abs(u));
    c *= 1.0 - uSeamDark * seam;
    acc += c;
  }
  vec3 c = acc / float(AA);
  c += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

  const MAX_TILE = 4096;

  /* Where the blobs sit. The standalone's motion table, frozen at phase zero:
   * its base positions, which are what the loop is a wander around. Drift
   * moves the whole set; there is no time. */
  const BLOB_DEF = [
    { p: [-0.1, 0.06], s: 1.0, w: 1.0 },
    { p: [0.14, -0.12], s: 0.8, w: 0.85 },
    { p: [0.0, 0.2], s: 1.2, w: 0.7 },
    { p: [-0.16, -0.22], s: 0.9, w: 0.9 },
    { p: [0.2, 0.24], s: 0.7, w: 0.75 },
    { p: [-0.24, 0.28], s: 1.1, w: 0.65 },
    { p: [0.24, -0.28], s: 0.85, w: 0.8 },
    { p: [0.04, 0.0], s: 1.3, w: 0.6 },
  ];

  let gl = null,
    cv = null,
    prog = null,
    vao = null,
    failed = false;
  const U = {};
  const loc = (n) => (n in U ? U[n] : (U[n] = gl.getUniformLocation(prog, n)));

  function init() {
    if (gl) return true;
    if (failed) return false;
    try {
      cv = document.createElement("canvas");
      gl = cv.getContext("webgl2", {
        antialias: false,
        alpha: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: true,
      });
      if (!gl) throw new Error("WebGL2 unavailable");
      const sh = (src, type) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      prog = gl.createProgram();
      gl.attachShader(prog, sh(VS, gl.VERTEX_SHADER));
      gl.attachShader(prog, sh(FS, gl.FRAGMENT_SHADER));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(prog));
      vao = gl.createVertexArray();
      return true;
    } catch (e) {
      console.warn("fractal glass engine disabled:", e.message);
      failed = true;
      gl = null;
      return false;
    }
  }

  const hex3 = (h) => {
    const s = /^#[0-9a-fA-F]{6}$/.test(h || "") ? h : "#000000";
    return [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
  };

  /**
   * Render the panel.
   * @param w,h  the panel in device px
   * @param P    the effect parameters; fluteW and seamW arrive in DEVICE px
   * @returns a w x h canvas, or null when the engine is unavailable
   */
  function render(w, h, P) {
    if (!init()) return null;
    w = Math.max(2, Math.min(MAX_TILE, Math.round(w)));
    h = Math.max(2, Math.min(MAX_TILE, Math.round(h)));
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog);
    gl.bindVertexArray(vao);
    gl.uniform2f(loc("uRes"), w, h);

    const num = (k, d) => (Number.isFinite(+P[k]) ? +P[k] : d);
    gl.uniform1f(loc("uFluteW"), Math.max(2, num("fluteW", 53)));
    gl.uniform1f(loc("uPhase"), num("phase", 0.06));
    gl.uniform1f(loc("uBulge"), num("bulge", 0.45));
    gl.uniform1f(loc("uIor"), num("ior", 1.5));
    gl.uniform1f(loc("uDisp"), num("disp", 0.008));
    gl.uniform1f(loc("uThick"), num("thick", 1));
    gl.uniform1f(loc("uGap"), num("gap", 10));
    gl.uniform1f(loc("uSeamW"), num("seamW", 1.6));
    gl.uniform1f(loc("uSeamDark"), num("seamDark", 0.75));
    gl.uniform1f(loc("uFresnel"), num("fresnel", 1));
    gl.uniform1f(loc("uSpec"), num("spec", 0.5));
    gl.uniform1f(loc("uLightAng"), (num("lightAng", 35) * Math.PI) / 180);
    gl.uniform1f(loc("uLightW"), num("lightW", 0.25));
    gl.uniform1f(loc("uAmbient"), num("ambient", 0.12));

    const pal =
      Array.isArray(P.colors) && P.colors.length >= 2
        ? P.colors.slice(0, 8)
        : ["#000000", "#ffffff"];
    const flat = new Float32Array(24);
    pal.forEach((c, i) => hex3(c).forEach((v, j) => (flat[i * 3 + j] = v)));
    gl.uniform3fv(loc("uPal"), flat);
    gl.uniform1i(loc("uPalN"), pal.length);

    const n = Math.max(1, Math.min(8, Math.round(num("blobs", 4))));
    const size = num("size", 0.2);
    const arr = new Float32Array(32);
    for (let i = 0; i < n; i++) {
      const d = BLOB_DEF[i];
      arr[i * 4] = d.p[0];
      arr[i * 4 + 1] = d.p[1];
      arr[i * 4 + 2] = size * d.s;
      arr[i * 4 + 3] = d.w;
    }
    gl.uniform4fv(loc("uBlobs"), arr);
    gl.uniform1i(loc("uBlobN"), n);
    gl.uniform1f(loc("uGain"), num("gain", 2.4));
    gl.uniform1f(loc("uGamma"), num("gamma", 1));
    gl.uniform1f(loc("uFieldScale"), Math.max(0.05, num("fieldScale", 1)));
    gl.uniform2f(loc("uDrift"), num("driftX", 0), num("driftY", 0));

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return cv;
  }

  const PRESETS = {
    reference: {},
    magnify: { gap: 0, thick: 0.6, bulge: 0.6, disp: 0.012, fluteW: 65, spec: 1.2 },
    fine: { fluteW: 22, bulge: 0.5, gap: 5, seamW: 1.0, spec: 1.2 },
    crystal: { ior: 1.9, disp: 0.05, bulge: 0.8, gap: 5, spec: 2.0, lightW: 0.14, ambient: 0.08 },
    clear: { spec: 0, ambient: 0, fresnel: 0, seamDark: 0.35 },
  };

  window.FractalFieldEngine = {
    VERSION: "20260917-field1",
    render,
    available: () => init(),
    PRESETS: Object.keys(PRESETS),
    presetValues: (k) => (PRESETS[k] ? Object.assign({}, PRESETS[k]) : null),
    BLOBS: BLOB_DEF.length,
  };
})();
