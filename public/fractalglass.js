/* Fractal Glass — gradient strips with per-strip offset (§5.x material slot).
 *
 * PROVENANCE. Ported from the author's own standalone glass-ribbons.html
 * ("Strips — gradient strip generator"). The shader is carried across
 * essentially verbatim; plumbing changes, each documented at its site:
 *   - uv is normalised PER AXIS instead of by height, so the strip rack fills
 *     the shape's box at any aspect ratio;
 *   - uDir swaps the axes so strips can run vertically or horizontally;
 *   - the present tail gains coverage alpha, so `transparent` lets the page
 *     show through the gaps between strips;
 *   - uTime became uPhase, an ordinary parameter — a document is static and
 *     must export as what you see, so the Motion group (drift, pulse, field
 *     drift) is deliberately not ported as animation.
 *
 * WHAT IT IS. The user's flow, in order: draw a shape, give it a gradient
 * fill, apply this effect. The shape's interior becomes N discrete strips,
 * and each strip is a WINDOW ONTO A SHARED COLOUR FIELD built from the
 * fill's own gradient stops. uStep is how far apart in field space two
 * neighbouring strips sample — that discontinuity is what keeps the strips
 * reading as separate glass panels instead of one smooth gradient, and it is
 * the entire "fractal glass" illusion. uMag is how much field one strip
 * spans. Per-strip vignette and sheen give each panel volume.
 *
 * The standalone's own analysis (measured off its reference frame): widths
 * near-uniform, heights NOT — the lens silhouette is strips of differing
 * height sharing one centre line, and a strip is a two-stop vertical
 * gradient, not a slice of anything. No refraction, no dispersion. Just
 * rectangles — which is why the edges must stay genuinely hard: they are
 * AA'd against the pixel footprint rather than blurred.
 *
 * COLOURS COME FROM THE SHAPE'S FILL. The six field colours are sampled off
 * the object's own gradient stops (evenly, with stop interpolation), so
 * changing the fill re-lights the strips. A solid or missing fill falls back
 * to the standalone's palette.
 */
(function () {
  "use strict";

  const VS = `#version 300 es
void main(){
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

  const FS = `#version 300 es
precision highp float;
out vec4 fragColor;

uniform vec2  uRes;
uniform float uPhase;
uniform float uDir;                       // 0 vertical strips, 1 horizontal
uniform float uCount, uSpread, uGap, uCenterY, uSkewX;
uniform float uHMax, uHMin, uHShape, uHSkew, uHJit, uFade;
uniform vec3  uC0,uC1,uC2,uC3,uC4,uC5;
uniform float uRampOff, uRampSpan, uTopLift, uBotDrop, uBotHue, uSat;
uniform float uWarp, uWarpScale, uBlend, uFieldTilt;
uniform float uMag, uStep, uVign, uVignPow, uVignY, uSheen;
uniform vec3  uBg;
uniform float uGlow, uGlowR, uExposure, uGamma, uGrain;
uniform float uAlphaMode;                 // 1 = coverage alpha (gaps see through)

float hash11(float p){ p = fract(p * 0.1031); p *= p + 33.33; return fract(p * (p + p)); }

vec3 pal(int i){
  if(i==0) return uC0;  if(i==1) return uC1;  if(i==2) return uC2;
  if(i==3) return uC3;  if(i==4) return uC4;  return uC5;
}

/* ---- organic colour field --------------------------------------- *
 * Each strip contains a 2D gradient, not a flat hue: the strips are
 * windows onto a shared colour field, each magnifying a different part
 * of it. Domain warping by fbm is what stops the blend reading as six
 * tidy blobs — it is where the organic quality comes from.
 * ------------------------------------------------------------------ */
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash11(dot(i, vec2(1.0, 57.0)));
  float b = hash11(dot(i + vec2(1.0, 0.0), vec2(1.0, 57.0)));
  float c = hash11(dot(i + vec2(0.0, 1.0), vec2(1.0, 57.0)));
  float d = hash11(dot(i + vec2(1.0, 1.0), vec2(1.0, 57.0)));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++){ v += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return v;
}

vec3 field(vec2 p){
  if (uWarp > 0.0){
    float w = uWarp;
    p += vec2(fbm(p * uWarpScale + 11.3), fbm(p * uWarpScale - 7.1)) * w - w * 0.5;
  }
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 6; i++){
    float fi = float(i);
    vec2 c = vec2((fi / 5.0 - 0.5) * 2.0,
                  sin(fi * 2.3999 + uPhase) * uFieldTilt);
    vec2 d = (p - c) / max(uBlend, 1e-3);
    float w = 1.0 / (dot(d, d) + 0.05);
    w *= w;
    acc += pal(i) * w;
    wsum += w;
  }
  return acc / max(wsum, 1e-5);
}

/* Rodrigues rotation about the grey axis — a hue shift without an
   RGB<->HSV round trip. */
vec3 hueShift(vec3 c, float a){
  const vec3 k = vec3(0.57735027);
  float ca = cos(a);
  return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
}
vec3 saturate3(vec3 c, float s){
  return mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, s);
}

/* Height envelope across the rack. t is -1..1 with 0 in the middle. */
float envelope(float t){
  float sk = clamp(uHSkew, -0.98, 0.98);
  float u = clamp((t - sk) / max(1.0 - abs(sk), 1e-3), -1.0, 1.0);
  return clamp(1.0 - pow(abs(u), uHShape), 0.0, 1.0);
}

/* One evaluation of the strip field. Edges are AA'd against the pixel
   footprint rather than blurred, so they stay genuinely hard without
   stair-stepping. Returns colour in rgb, coverage in a. */
vec4 strips(vec2 uv, vec2 px){
  float n = max(floor(uCount + 0.5), 1.0);
  float pitch = uSpread / n;

  // shear x by y, so the rack can lean while strips stay vertical
  float x = uv.x + uv.y * tan(uSkewX);

  float fc = x / pitch;
  float cell = floor(fc + 0.5);
  float halfN = (n - 1.0) * 0.5;
  if (abs(cell) > halfN + 0.001) return vec4(0.0);

  float local = (fc - cell) * pitch;               // -pitch/2 .. pitch/2
  float t = (n <= 1.0) ? 0.0 : cell / max(halfN, 1e-4);

  float halfW = pitch * (1.0 - uGap) * 0.5;
  float sx = 1.0 - smoothstep(halfW - px.x, halfW + px.x, abs(local));
  if (sx <= 0.0) return vec4(0.0);

  float h = mix(uHMin, uHMax, envelope(t));
  h *= 1.0 + uHJit * (hash11(cell + 7.0) - 0.5);
  float hh = max(h, 1e-4) * 0.5;

  float dy = abs(uv.y - uCenterY);
  float fade = max(uFade, px.y);
  float sy = 1.0 - smoothstep(hh - fade, hh, dy);
  if (sy <= 0.0) return vec4(0.0);

  // Window onto the field. uStep is how far apart in field space two
  // neighbouring strips sample — that discontinuity is what keeps the
  // strips reading as separate panels instead of one smooth gradient.
  // uMag is how much field one strip spans.
  float fx = cell * uStep + (local / max(pitch, 1e-4)) * uMag + uRampOff;
  float fy = (uv.y - uCenterY) / max(hh, 1e-4) * uRampSpan;
  vec3 base = saturate3(field(vec2(fx, fy)), uSat);

  // vertical ramp inside the panel
  float g = clamp((uv.y - (uCenterY - hh)) / (2.0 * hh), 0.0, 1.0);
  vec3 col = mix(hueShift(base, radians(uBotHue)) * uBotDrop, base * uTopLift, g);

  // Glass-panel shading: each strip vignettes toward its OWN edges and
  // carries a soft sheen off-centre, which is what gives a strip volume
  // rather than reading as flat fill.
  float lx = abs(local) / max(halfW, 1e-4);          // 0 centre, 1 edge
  float ly = dy / max(hh, 1e-4);
  float vig = (1.0 - uVign * pow(clamp(lx, 0.0, 1.0), uVignPow))
            * (1.0 - uVignY * pow(clamp(ly, 0.0, 1.0), 2.0));
  col *= max(vig, 0.0);
  col += base * uSheen * exp(-pow((lx - 0.35) * 3.2, 2.0)) * (1.0 - ly * 0.6);

  float cov = sx * sy;
  return vec4(col * cov, cov);
}

void main(){
  /* Per-axis normalise (plumbing change from the standalone, which divides
   * by height only): the rack must fill the SHAPE'S box at any aspect. uDir
   * swaps the axes so "vertical strips" becomes "horizontal strips". */
  vec2 uv = (2.0 * gl_FragCoord.xy - uRes) / uRes;
  vec2 px = 2.0 / uRes;
  if (uDir > 0.5){ uv = uv.yx; px = px.yx; }

  vec4 acc = strips(uv, px);

  if (uGlow > 0.0){
    vec4 g = vec4(0.0);
    for (int i = 0; i < 8; i++){
      float a = float(i) * 0.7853982;
      g += strips(uv + vec2(cos(a), sin(a)) * uGlowR, px);
    }
    acc += g * 0.125 * uGlow;
  }

  vec3 col = uBg + acc.rgb * uExposure;
  col = pow(max(col, 0.0), vec3(1.0 / uGamma));

  float d = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  col += (d - 0.5) * uGrain;
  col += (fract(sin(dot(gl_FragCoord.xy, vec2(93.9898, 47.233))) * 24634.6345) - 0.5) / 255.0;

  /* Coverage alpha — plumbing addition. With it, the gaps between strips and
   * the space beyond short strips are HOLES the page shows through, which is
   * what makes the effect read as the user's shape repeated rather than a
   * poster pasted into the box. */
  float al = uAlphaMode > 0.5 ? clamp(acc.a, 0.0, 1.0) : 1.0;
  fragColor = vec4(clamp(col, 0.0, 1.0), al);
}`;

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
      gl = cv.getContext("webgl2", { antialias: false, alpha: true, preserveDrawingBuffer: true });
      if (!gl) throw new Error("WebGL2 unavailable");
      const sh = (s, t) => {
        const x = gl.createShader(t);
        gl.shaderSource(x, s);
        gl.compileShader(x);
        if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x));
        return x;
      };
      prog = gl.createProgram();
      gl.attachShader(prog, sh(VS, gl.VERTEX_SHADER));
      gl.attachShader(prog, sh(FS, gl.FRAGMENT_SHADER));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(prog));
      gl.useProgram(prog);
      vao = gl.createVertexArray();
      return true;
    } catch (e) {
      console.warn("fractal glass engine disabled:", e.message);
      failed = true;
      gl = null;
      return false;
    }
  }

  const hex2rgb = (h) => [
    parseInt(h.slice(1, 3), 16) / 255,
    parseInt(h.slice(3, 5), 16) / 255,
    parseInt(h.slice(5, 7), 16) / 255,
  ];
  const srgb2lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const linHex = (h) => hex2rgb(String(h || "#000000")).map(srgb2lin);
  const rad = (d) => (d * Math.PI) / 180;

  /* The standalone's default palette — the fallback when the shape has no
   * gradient fill to sample. */
  const FALLBACK = ["#0a3a8c", "#0b93b4", "#37c9c1", "#efe6b0", "#f79a1e", "#c94fae"];

  /** Six field colours sampled evenly off a gradient's stops. */
  function colorsFromStops(stops) {
    if (!Array.isArray(stops) || stops.length < 2) return FALLBACK;
    const st = stops
      .filter((s) => s && /^#[0-9a-fA-F]{6}$/.test(s.color))
      .map((s) => ({ p: Math.max(0, Math.min(1, +s.pos || 0)), c: s.color }))
      .sort((a, b) => a.p - b.p);
    if (st.length < 2) return FALLBACK;
    const lerp = (a, b, t) => {
      const A = hex2rgb(a),
        B = hex2rgb(b);
      const c = A.map((v, i) => Math.round((v + (B[i] - v) * t) * 255));
      return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
    };
    const at = (t) => {
      if (t <= st[0].p) return st[0].c;
      for (let i = 0; i < st.length - 1; i++) {
        const a = st[i],
          b = st[i + 1];
        if (t >= a.p && t <= b.p) {
          const u = b.p - a.p > 1e-6 ? (t - a.p) / (b.p - a.p) : 0;
          return lerp(a.c, b.c, u);
        }
      }
      return st[st.length - 1].c;
    };
    const out = [];
    for (let i = 0; i < 6; i++) out.push(at(i / 5));
    return out;
  }

  /** Render into a w x h canvas. `stops` is the shape's gradient stops or null. */
  function render(w, h, P, stops) {
    if (!init()) return null;
    w = Math.max(2, Math.round(w));
    h = Math.max(2, Math.round(h));
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog);
    gl.bindVertexArray(vao);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const cols = colorsFromStops(stops);
    gl.uniform2f(loc("uRes"), w, h);
    gl.uniform1f(loc("uPhase"), +P.phase || 0);
    gl.uniform1f(loc("uDir"), P.direction === "h" ? 1 : 0);
    gl.uniform1f(loc("uCount"), Math.max(3, Math.min(64, Math.round(P.count || 11))));
    gl.uniform1f(loc("uSpread"), P.spread === undefined ? 2 : +P.spread);
    gl.uniform1f(loc("uGap"), P.gap === undefined ? 0.075 : +P.gap);
    gl.uniform1f(loc("uCenterY"), +P.centerY || 0);
    gl.uniform1f(loc("uSkewX"), rad(+P.slant || 0));
    gl.uniform1f(loc("uHMax"), P.hMax === undefined ? 2 : +P.hMax);
    gl.uniform1f(loc("uHMin"), P.hMin === undefined ? 2 : +P.hMin);
    gl.uniform1f(loc("uHShape"), P.hShape === undefined ? 1.45 : +P.hShape);
    gl.uniform1f(loc("uHSkew"), +P.hSkew || 0);
    gl.uniform1f(loc("uHJit"), +P.hJit || 0);
    gl.uniform1f(loc("uFade"), P.fade === undefined ? 0.035 : +P.fade);
    cols.forEach((c, i) => gl.uniform3fv(loc("uC" + i), linHex(c)));
    gl.uniform1f(loc("uRampOff"), +P.shift || 0);
    gl.uniform1f(loc("uRampSpan"), P.rampSpan === undefined ? 0.95 : +P.rampSpan);
    gl.uniform1f(loc("uTopLift"), P.topLift === undefined ? 1.16 : +P.topLift);
    gl.uniform1f(loc("uBotDrop"), P.botDrop === undefined ? 0.3 : +P.botDrop);
    gl.uniform1f(loc("uBotHue"), P.botHue === undefined ? 12 : +P.botHue);
    gl.uniform1f(loc("uSat"), P.sat === undefined ? 1.25 : +P.sat);
    gl.uniform1f(loc("uWarp"), P.warp === undefined ? 0.75 : +P.warp);
    gl.uniform1f(loc("uWarpScale"), P.warpScale === undefined ? 1.6 : +P.warpScale);
    gl.uniform1f(loc("uBlend"), P.blend === undefined ? 0.3 : +P.blend);
    gl.uniform1f(loc("uFieldTilt"), P.fieldTilt === undefined ? 0.75 : +P.fieldTilt);
    gl.uniform1f(loc("uMag"), P.span === undefined ? 0.95 : +P.span);
    gl.uniform1f(loc("uStep"), P.offset === undefined ? 0.19 : +P.offset);
    gl.uniform1f(loc("uVign"), P.vign === undefined ? 0.5 : +P.vign);
    gl.uniform1f(loc("uVignPow"), P.vignPow === undefined ? 2.6 : +P.vignPow);
    gl.uniform1f(loc("uVignY"), P.vignY === undefined ? 0.3 : +P.vignY);
    gl.uniform1f(loc("uSheen"), P.sheen === undefined ? 0.28 : +P.sheen);
    gl.uniform3fv(loc("uBg"), linHex(P.bg || "#000000"));
    gl.uniform1f(loc("uGlow"), P.glow === undefined ? 0.16 : +P.glow);
    gl.uniform1f(loc("uGlowR"), P.glowR === undefined ? 0.032 : +P.glowR);
    gl.uniform1f(loc("uExposure"), P.exposure === undefined ? 1.08 : +P.exposure);
    gl.uniform1f(loc("uGamma"), P.gamma === undefined ? 2.2 : +P.gamma);
    gl.uniform1f(loc("uGrain"), P.grain === undefined ? 0.006 : +P.grain);
    gl.uniform1f(loc("uAlphaMode"), P.transparent === false ? 0 : 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return cv;
  }

  /* Presets from the standalone, plus Repeat — the full-height rack that
   * matches "the shape got repeated" most literally. */
  const PRESETS = {
    repeat: { hMin: 2, hMax: 2, fade: 0.02, vignY: 0.15 },
    lens: { hMax: 0.86, hMin: 0.15, hShape: 1.45, fade: 0.035 },
    even: { hMin: 0.62, hMax: 0.62, hShape: 4.0, count: 11, gap: 0.07, glow: 0.2 },
    spiky: {
      hShape: 0.5,
      hMin: 0.06,
      hMax: 0.85,
      hJit: 0.55,
      count: 17,
      gap: 0.16,
      fade: 0.02,
      glow: 0.42,
      topLift: 1.5,
    },
  };

  window.FractalGlassEngine = {
    render,
    available: () => init(),
    colorsFromStops,
    PRESETS: Object.keys(PRESETS),
    presetValues: (k) => PRESETS[k] || null,
    FALLBACK,
  };
})();
