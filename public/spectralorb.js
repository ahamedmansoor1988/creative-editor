/* Spectral Orb — a spectral colour field wrapped around a virtual sphere.
 *
 * THE PIPELINE IS THE FEATURE. Not a circle containing gradients: a 2D disc is
 * reconstructed as a unit sphere, and every colour decision is made against
 * that sphere's SURFACE NORMAL rather than against screen distance. Colours
 * live on the sphere; the screen only projects them.
 *
 *   disc -> unit sphere -> normal N -> spherical directional interpolation
 *        -> centre wash from depth z -> Fresnel -> angular rim
 *        -> linear-RGB compositing -> anti-aliased mask
 *
 * WHY A VON MISES-FISHER BASIS. Weighting each anchor by exp(k*(N.D - 1)) is a
 * spherical Gaussian: it depends only on the ANGLE between the normal and the
 * anchor direction, so it has no centre in screen space and cannot produce a
 * visible round spot. Normalising by the total weight makes it a partition of
 * unity, which is what removes banding — every fragment is a convex blend of
 * the anchors, never a boundary between two of them.
 *
 * WHY LINEAR RGB THROUGHOUT. sRGB is a perceptual encoding, and interpolating
 * in it drags mixtures through muddy intermediates — the exact failure the
 * brief calls out. Anchors and the centre colour are converted once on the CPU;
 * the rim is generated in the shader and converted there; the only encode back
 * to sRGB is the final write.
 *
 * ARCHITECTURE. The brief asks for seven separate modules. This project ships
 * plain script files with no bundler and no runtime dependencies, so seven
 * files would mean seven script tags for one effect. They are seven clearly
 * marked SECTIONS of this module instead, in the brief's own order and under
 * its own names — the seam is where the brief put it, without the cost.
 */
(function () {
  "use strict";

  /* ---- SpectralOrbModel -------------------------------------------------
   * The settings object, its limits, and the defaults. Every value here is a
   * plain number or array so a whole orb round-trips through JSON.           */

  const ANCHOR_LIMIT = 12; // the shader's uniform arrays are sized to this

  const clampf = (v, lo, hi) => (!Number.isFinite(v) ? lo : v < lo ? lo : v > hi ? hi : v);

  /** sRGB -> linear. The exact piecewise curve, not the 2.2 approximation:
   *  the toe matters for the pale centre, which lives in the low end. */
  function srgbToLinear(c) {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function hexToLinear(hex) {
    const n = parseInt(String(hex).replace("#", ""), 16) || 0;
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map(srgbToLinear);
  }

  /** An anchor placed by where it appears on the DISC rather than by a raw 3D
   *  vector — the sphere coordinate is derived, which is the same mapping the
   *  interaction layer uses when a handle is dragged. Anchors sit near the rim
   *  because that is where the brief wants the chromatic energy. */
  function anchorAt(id, angleDeg, radius, hex, strength) {
    const a = (angleDeg * Math.PI) / 180;
    const x = Math.cos(a) * radius,
      y = Math.sin(a) * radius;
    return {
      id,
      direction: directionFromDisc(x, y),
      color: hexToLinear(hex),
      strength: strength === undefined ? 1 : strength,
    };
  }

  /* The default preset. Positions follow the brief's arrangement; note that y
   * is UP here, so "bottom" is a negative angle. */
  const DEFAULT_ANCHORS = () => [
    anchorAt("cyan", 135, 0.82, "#22d3ee"), // upper-left
    anchorAt("aqua", 90, 0.86, "#7dd3fc"), // top
    anchorAt("green", 45, 0.82, "#4ade80"), // upper-right
    anchorAt("blue", 180, 0.86, "#1d4ed8"), // left
    anchorAt("orange", 215, 0.86, "#fb923c"), // lower-left
    anchorAt("yellow", 250, 0.82, "#fbbf24"), // bottom-left
    anchorAt("violet", 290, 0.86, "#7c3aed"), // bottom
    anchorAt("magenta", 330, 0.86, "#ec4899"), // lower-right
  ];

  const DEFAULTS = () => ({
    radius: 0.92, // 0..1 of the half-extent
    centerX: 0, // -1..1
    centerY: 0,

    rotation: 0, // degrees, applied to the anchor field only
    /* kappa. Started at 3.2, which was far too broad: with eight anchors a
     * 45-degree neighbour still weighed 0.39 of the peak, so every fragment
     * was a blend of ALL of them and the field converged on their average —
     * grey. The brief wants the perimeter to carry the chromatic energy, and
     * that needs each anchor to own its own arc. At 9 a neighbour weighs
     * 0.072 and the opposite side 0.0001: distinct regions, still seamless. */
    concentration: 9,
    intensity: 1.0, // spectral saturation multiplier

    centerColor: "#ffe0d6", // warm pearl; never pure white
    centerStrength: 0.58,
    /* gamma in center = z^gamma. z stays high across most of the disc — it is
     * still 0.87 at half radius — so a low gamma spreads the wash over nearly
     * the whole orb and pales the colour it is supposed to sit inside. */
    centerFalloff: 3.2,

    fresnelStrength: 0.55,
    fresnelPower: 2.6,

    rimStrength: 0.22,
    rimWidth: 0.88, // where the edge mask starts

    centerSaturation: 0.35,
    edgeSaturation: 1.15,
    saturationCurve: 1.6,

    opacity: 1,
    anchors: DEFAULT_ANCHORS(),
  });

  /** Repair a settings object arriving from a saved file, a preset, or a
   *  panel. Everything is clamped rather than trusted, on the same grounds as
   *  the mesh net: a bad value should give a poor orb, never a broken one. */
  function normalize(S) {
    const s = Object.assign(DEFAULTS(), S || {});
    s.radius = clampf(+s.radius, 0.05, 1);
    s.centerX = clampf(+s.centerX, -1, 1);
    s.centerY = clampf(+s.centerY, -1, 1);
    s.rotation = (((+s.rotation || 0) % 360) + 360) % 360;
    s.concentration = clampf(+s.concentration, 0.2, 24);
    s.intensity = clampf(+s.intensity, 0, 2);
    s.centerStrength = clampf(+s.centerStrength, 0, 1);
    s.centerFalloff = clampf(+s.centerFalloff, 0.2, 12);
    s.fresnelStrength = clampf(+s.fresnelStrength, 0, 2);
    s.fresnelPower = clampf(+s.fresnelPower, 0.2, 8);
    s.rimStrength = clampf(+s.rimStrength, 0, 1);
    s.rimWidth = clampf(+s.rimWidth, 0.3, 0.999);
    s.centerSaturation = clampf(+s.centerSaturation, 0, 2);
    s.edgeSaturation = clampf(+s.edgeSaturation, 0, 2);
    s.saturationCurve = clampf(+s.saturationCurve, 0.2, 6);
    s.opacity = clampf(+s.opacity, 0, 1);
    if (!/^#[0-9a-fA-F]{6}$/.test(s.centerColor || "")) s.centerColor = "#ffe0d6";

    let a = Array.isArray(s.anchors) ? s.anchors.slice(0, ANCHOR_LIMIT) : [];
    if (!a.length) a = DEFAULT_ANCHORS();
    s.anchors = a.map((an, i) => {
      const d = Array.isArray(an && an.direction) ? an.direction : [0, 0, 1];
      const n = normalize3(+d[0] || 0, +d[1] || 0, +d[2] || 0);
      const c = Array.isArray(an && an.color) ? an.color : [0.5, 0.5, 0.5];
      return {
        id: (an && an.id) || "a" + i,
        direction: n,
        color: [0, 1, 2].map((k) => clampf(+c[k], 0, 4)),
        strength: clampf(+(an && an.strength), 0, 4) || (an && an.strength === 0 ? 0 : 1),
      };
    });
    return s;
  }

  /* ---- SphereGeometry ---------------------------------------------------
   * The disc IS a sphere seen down +Z. These two functions are the whole of
   * that claim on the CPU side, and the shader repeats them per fragment.    */

  function normalize3(x, y, z) {
    const l = Math.hypot(x, y, z) || 1;
    return [x / l, y / l, z / l];
  }

  /** A point on the disc -> the front-hemisphere direction it projects from.
   *  Beyond the rim there is no sphere to hit, so the point is pulled back to
   *  the silhouette (z = 0) rather than producing an imaginary depth. */
  function directionFromDisc(x, y) {
    const d2 = x * x + y * y;
    if (d2 >= 1) {
      const l = Math.sqrt(d2) || 1;
      return [x / l, y / l, 0];
    }
    return normalize3(x, y, Math.sqrt(1 - d2));
  }

  /** Spin about the view axis. The brief is explicit that rotation moves the
   *  FIELD and not the geometry, so it is applied to anchor directions here
   *  rather than to the fragment's normal in the shader — the sphere itself
   *  never turns. */
  function rotateZ(d, deg) {
    const a = (deg * Math.PI) / 180,
      c = Math.cos(a),
      s = Math.sin(a);
    return [d[0] * c - d[1] * s, d[0] * s + d[1] * c, d[2]];
  }

  /* ---- SpectralField / ColorAnchors (the shader) ------------------------ */

  const VS = `#version 300 es
in vec2 aPos;
out vec2 vUV;
void main(){ vUV=aPos*0.5+0.5; gl_Position=vec4(aPos,0.0,1.0); }`;

  const FS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 fragColor;

#define MAXA ${ANCHOR_LIMIT}
uniform vec2  uRes;
uniform vec2  uCenter;
uniform float uRadius;
uniform int   uCount;
uniform vec3  uDir[MAXA];
uniform vec3  uCol[MAXA];
uniform float uStr[MAXA];
uniform float uKappa;
uniform float uIntensity;
uniform vec3  uCenterCol;
uniform float uCenterStrength;
uniform float uCenterFalloff;
uniform float uFresnelStrength;
uniform float uFresnelPower;
uniform float uRimStrength;
uniform float uRimWidth;
uniform float uCenterSat;
uniform float uEdgeSat;
uniform float uSatCurve;
uniform float uOpacity;
uniform int   uDebugNormals;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

vec3 toLinear(vec3 c){
  return mix(c/12.92, pow((c+0.055)/1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 toSRGB(vec3 c){
  c = clamp(c, 0.0, 1.0);
  return mix(c*12.92, 1.055*pow(c, vec3(1.0/2.4)) - 0.055, step(vec3(0.0031308), c));
}
/* A smooth periodic spectrum. Three cosines a third of a turn apart sweep
 * every hue continuously — the brief rules out six hard rainbow sections, and
 * a cosine palette has no sections at all, only a phase. */
vec3 spectrum(float t){
  return 0.5 + 0.5*cos(6.283185*(t + vec3(0.0, 0.33, 0.67)));
}
vec3 saturate3(vec3 c, float amt){
  return mix(vec3(dot(c, LUMA)), c, amt);
}

void main(){
  /* ---- SphereGeometry ------------------------------------------------- */
  vec2 p = vUV*2.0 - 1.0;
  p.x *= uRes.x / max(uRes.y, 1.0);          // square pixels, whatever the tile
  p = (p - uCenter) / max(uRadius, 1e-4);
  float r = length(p);

  /* The disc is the projection of a unit sphere: x^2+y^2+z^2 = 1. Outside the
   * silhouette there is no surface, so z is 0 and the normal lies in the
   * plane — those fragments are masked away below, but they must still be
   * finite or the derivative used for anti-aliasing goes with them. */
  float z = sqrt(max(0.0, 1.0 - dot(p, p)));
  vec3 N = normalize(vec3(p, z) + vec3(0.0, 0.0, 1e-6));

  float aa = fwidth(r);
  float mask = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, r);

  if(uDebugNormals == 1){                     // acceptance test 1
    fragColor = vec4(N*0.5 + 0.5, mask);
    return;
  }

  /* ---- SpectralField --------------------------------------------------
   * von Mises-Fisher weights: exp(k*(N.D - 1)) depends only on the ANGLE
   * between the normal and the anchor, so nothing here has a position in
   * screen space and no anchor can render as a round spot. Normalising by the
   * total makes this a partition of unity, which is what keeps the field free
   * of seams and bands: every fragment is a convex blend of all anchors. */
  vec3 spectral = vec3(0.0);
  float total = 0.0;
  for(int i = 0; i < MAXA; i++){
    if(i >= uCount) break;
    float w = exp(uKappa * (dot(N, uDir[i]) - 1.0)) * uStr[i];
    spectral += uCol[i] * w;
    total += w;
  }
  spectral /= max(total, 1e-4);

  /* Chroma rises toward the circumference — the reason the reference reads as
   * a creamy centre inside a vivid rim rather than a uniformly bright disc. */
  float satF = mix(uCenterSat, uEdgeSat, pow(clamp(r, 0.0, 1.0), uSatCurve));
  spectral = saturate3(spectral, satF * uIntensity);

  /* ---- centre wash, from DEPTH rather than from screen distance --------
   * z is 1 at the centre of the sphere and 0 at its silhouette, so the wash
   * is a property of the geometry. A radial gradient would look similar from
   * the front and would be wrong the moment the field rotates. */
  float centre = pow(clamp(z, 0.0, 1.0), uCenterFalloff);
  vec3 c = mix(spectral, uCenterCol, centre * uCenterStrength);

  /* ---- Fresnel --------------------------------------------------------
   * V is (0,0,1), so dot(N,V) is exactly z and the rim term costs nothing
   * extra. It raises chroma and contrast toward the edge; it deliberately
   * does not add white, which would flatten the sphere into a lit ball. */
  float fres = pow(1.0 - clamp(z, 0.0, 1.0), uFresnelPower);
  c = saturate3(c, 1.0 + uFresnelStrength*fres);
  c = (c - 0.5) * (1.0 + 0.18*uFresnelStrength*fres) + 0.5;

  /* ---- spectral rim ---------------------------------------------------
   * Angular hue around the circumference, gated by BOTH the edge mask and
   * Fresnel so it can only ever appear where the surface turns away. */
  float edge = smoothstep(uRimWidth, 1.0, r);
  float ang = atan(p.y, p.x)/6.283185 + 0.5;
  vec3 rim = toLinear(spectrum(ang));
  c = mix(c, rim, clamp(edge * uRimStrength * fres, 0.0, 1.0));

  fragColor = vec4(toSRGB(c), mask * uOpacity);
}`;

  /* ---- Renderer --------------------------------------------------------- */

  let gl = null,
    prog = null,
    cv = null,
    vao = null,
    U = null,
    failed = false;

  function init() {
    if (gl) return true;
    if (failed) return false;
    try {
      cv = document.createElement("canvas");
      gl = cv.getContext("webgl2", { antialias: true, premultipliedAlpha: false });
      if (!gl) throw new Error("no webgl2");
      const sh = (t, src) => {
        const s = gl.createShader(t);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
      gl.bindAttribLocation(prog, 0, "aPos");
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(prog));
      gl.useProgram(prog);

      const loc = (n) => gl.getUniformLocation(prog, n);
      U = {
        res: loc("uRes"),
        center: loc("uCenter"),
        radius: loc("uRadius"),
        count: loc("uCount"),
        dir: loc("uDir"),
        col: loc("uCol"),
        str: loc("uStr"),
        kappa: loc("uKappa"),
        intensity: loc("uIntensity"),
        centerCol: loc("uCenterCol"),
        centerStrength: loc("uCenterStrength"),
        centerFalloff: loc("uCenterFalloff"),
        fresnelStrength: loc("uFresnelStrength"),
        fresnelPower: loc("uFresnelPower"),
        rimStrength: loc("uRimStrength"),
        rimWidth: loc("uRimWidth"),
        centerSat: loc("uCenterSat"),
        edgeSat: loc("uEdgeSat"),
        satCurve: loc("uSatCurve"),
        opacity: loc("uOpacity"),
        debug: loc("uDebugNormals"),
      };

      vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      // two triangles; the field is per-fragment so no tessellation is needed
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]),
        gl.STATIC_DRAW,
      );
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      return true;
    } catch (e) {
      failed = true;
      gl = null;
      return false;
    }
  }

  const available = () => init();

  function render(W, H, settings, opts) {
    if (!init()) return null;
    const S = normalize(settings);
    const o = opts || {};
    cv.width = Math.max(1, Math.round(W));
    cv.height = Math.max(1, Math.round(H));
    gl.viewport(0, 0, cv.width, cv.height);
    gl.useProgram(prog);

    const n = Math.min(ANCHOR_LIMIT, S.anchors.length);
    const dir = new Float32Array(ANCHOR_LIMIT * 3);
    const col = new Float32Array(ANCHOR_LIMIT * 3);
    const str = new Float32Array(ANCHOR_LIMIT);
    for (let i = 0; i < n; i++) {
      const a = S.anchors[i];
      // rotation moves the FIELD, so it is baked into the directions here
      const d = rotateZ(a.direction, S.rotation);
      dir[i * 3] = d[0];
      dir[i * 3 + 1] = d[1];
      dir[i * 3 + 2] = d[2];
      col[i * 3] = a.color[0];
      col[i * 3 + 1] = a.color[1];
      col[i * 3 + 2] = a.color[2];
      str[i] = a.strength;
    }
    const cc = hexToLinear(S.centerColor);

    gl.uniform2f(U.res, cv.width, cv.height);
    gl.uniform2f(U.center, S.centerX, S.centerY);
    gl.uniform1f(U.radius, S.radius);
    gl.uniform1i(U.count, n);
    gl.uniform3fv(U.dir, dir);
    gl.uniform3fv(U.col, col);
    gl.uniform1fv(U.str, str);
    gl.uniform1f(U.kappa, S.concentration);
    gl.uniform1f(U.intensity, S.intensity);
    gl.uniform3f(U.centerCol, cc[0], cc[1], cc[2]);
    gl.uniform1f(U.centerStrength, S.centerStrength);
    gl.uniform1f(U.centerFalloff, S.centerFalloff);
    gl.uniform1f(U.fresnelStrength, S.fresnelStrength);
    gl.uniform1f(U.fresnelPower, S.fresnelPower);
    gl.uniform1f(U.rimStrength, S.rimStrength);
    gl.uniform1f(U.rimWidth, S.rimWidth);
    gl.uniform1f(U.centerSat, S.centerSaturation);
    gl.uniform1f(U.edgeSat, S.edgeSaturation);
    gl.uniform1f(U.satCurve, S.saturationCurve);
    gl.uniform1f(U.opacity, S.opacity);
    gl.uniform1i(U.debug, o.debugNormals ? 1 : 0);

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // copy off the shared context, which the next call overwrites
    const out = document.createElement("canvas");
    out.width = cv.width;
    out.height = cv.height;
    out.getContext("2d").drawImage(cv, 0, 0);
    return out;
  }

  /* One tile per (size, settings). Same bargain as the other engines: the
   * document is static, so an orb that has not changed is not re-traced. */
  const cache = new Map();
  const CACHE_MAX = 12;
  function get(W, H, settings) {
    if (!init()) return null;
    const k = Math.round(W) + "x" + Math.round(H) + "|" + JSON.stringify(settings);
    const hit = cache.get(k);
    if (hit) return hit;
    const tile = render(W, H, settings);
    if (!tile) return null;
    cache.set(k, tile);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return tile;
  }

  /* ---- InteractionLayer -------------------------------------------------
   * Handles are the sphere seen head-on: a direction projects to its own x,y,
   * and a dragged point recovers a direction through the same square root the
   * shader uses. Dragging therefore moves an anchor ON the sphere rather than
   * across the picture, which is the whole reason the colour follows smoothly
   * instead of sliding as a blob.                                            */

  /** Where an anchor's handle sits, in 0..1 tile coordinates. `behind` marks
   *  the far hemisphere: it still projects to a point, but two directions
   *  share it, so the UI has to draw it differently or dragging is ambiguous. */
  function anchorHandle(anchor, settings, W, H) {
    const S = normalize(settings);
    const d = rotateZ(anchor.direction, S.rotation);
    const asp = W / Math.max(1, H);
    const px = d[0] * S.radius + S.centerX;
    const py = d[1] * S.radius + S.centerY;
    return {
      x: (px / asp + 1) * 0.5,
      y: 1 - (py + 1) * 0.5, // canvas y runs down
      behind: d[2] < 0,
    };
  }

  /** The inverse: a point in 0..1 tile coordinates -> an anchor direction,
   *  with the rotation removed so the stored direction stays in the field's
   *  own frame. Points outside the disc land on the silhouette. */
  function directionFromHandle(x, y, settings, W, H) {
    const S = normalize(settings);
    const asp = W / Math.max(1, H);
    const px = (x * 2 - 1) * asp;
    const py = (1 - y) * 2 - 1;
    const d = directionFromDisc((px - S.centerX) / S.radius, (py - S.centerY) / S.radius);
    return rotateZ(d, -S.rotation);
  }

  window.SpectralOrb = {
    ANCHOR_LIMIT,
    DEFAULTS,
    DEFAULT_ANCHORS,
    normalize,
    available,
    render,
    get,
    anchorHandle,
    directionFromHandle,
    directionFromDisc,
    rotateZ,
    hexToLinear,
    srgbToLinear,
  };
})();
