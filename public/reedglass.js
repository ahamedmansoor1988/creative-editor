/* Reed glass — a sheet of fluted glass refracting the layers BENEATH it.
 *
 * PROVENANCE. The fragment shader is carried across from the author's own
 * reed-glass/index.html ("Reed Glass — shader maker"), whose default preset was
 * measured off a reference video: 13.5 flutes across a 720px frame (53.3px
 * pitch), each flute an inverted ~3.3x compressed copy of the backdrop. The
 * optics are untouched — trace(), Snell in, arc height + slab, Snell out, the
 * air gap, three IORs for dispersion, Fresnel, the studio strip light, the
 * seam. What changed is only where a sample comes from, and that is the whole
 * point of the port:
 *
 *   - the standalone renders an animated thermal blob field into a texture and
 *     refracts THAT. Here uSrc is the editor's own canvas, so the subject is
 *     whatever the document already has under the panel. There is no source
 *     pass, no palette, and no time: a document is static and must export as
 *     what you see.
 *   - a sample that lands off the ARTBOARD answers with the page colour. The
 *     canvas is the whole stage and the app's surround lives out past the
 *     artboard; clamping to the canvas instead pulls that surround into the
 *     panel as dark bands. The artboard rect is a required input for that
 *     reason.
 *
 * WHAT IT IS, in one line, because it is easy to mistake for a filter: the
 * panel has no colour of its own. Put it over the shapes you want broken up,
 * and the parts of them that stick out past the panel stay whole — that
 * contrast is the effect.
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
uniform sampler2D uSrc;
uniform vec2  uScene;     // source canvas size, device px
uniform vec2  uBoxPos;    // panel origin in canvas px (top-left, y down)
uniform vec2  uRes;       // panel size, device px
uniform vec4  uArt;       // artboard rect in canvas px
uniform vec3  uPageBg;
uniform float uFluteW;    // flute pitch, device px
uniform float uPhase;     // seam offset, flute widths
uniform float uBulge;     // arc sagitta, half-widths (1 = semicircle)
uniform float uIor;
uniform float uDisp;      // IOR spread red..blue
uniform float uThick;     // slab under the arc, half-widths
uniform float uGap;       // air gap to the page, half-widths
uniform float uSeamW;     // seam line width, device px
uniform float uSeamDark;
uniform float uFresnel;
uniform float uSpec;
uniform float uLightAng;  // radians
uniform float uLightW;    // radians
uniform float uAmbient;
uniform float uAngle;      // flute direction, radians (0 = vertical flutes)
const int AA = 4;

float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

/* One ray through a flute. Returns (sample offset from the flute centre in
   half-widths, transmission 0/1). Total internal reflection kills the
   transmitted term and hands the whole weight to the reflection below. */
vec2 trace(float u, float ior, float R){
  float su = (u < 0.0) ? -1.0 : 1.0;
  /* Just short of 1. At bulge 1 the flute is a full semicircle and the surface
   * is vertical at the seam: sin(alpha) reaches 1, alpha reaches 90 degrees,
   * and tan(beta) runs away — the last pixel of every flute samples somewhere
   * arbitrary and comes back as a stray line down the panel. A hair off the
   * singularity keeps the whole range usable; it is a numerical guard, not a
   * change of look, and below bulge 1 nothing reaches it. */
  float sa = clamp(abs(u) / R, 0.0, 0.9975);         // sin(alpha): surface tilt
  float ca = sqrt(1.0 - sa * sa);
  float alpha = asin(sa);
  float sg = sa / ior;                               // Snell, air -> glass
  float beta = alpha - asin(sg);                     // ray tilt inside glass
  float h = ca * R - (R - uBulge) + uThick;          // arc height + slab
  float dx = h * tan(beta);
  float sair = ior * sin(beta);                      // Snell, glass -> air
  float trans = 1.0;
  if (sair >= 0.9995) { sair = 0.9995; trans = 0.0; }
  dx += uGap * tan(asin(sair));
  return vec2(u - su * dx, trans);
}

/* The page under the panel — whatever the document has painted there.
 *
 * Three bugs lived in these four lines, each one a bar down the panel, and
 * each found only after the one before it was fixed:
 *
 *   1. off the artboard it answered with the page colour. A boolean like that
 *      paints a hard-edged bar wherever a ray runs off the page — black, on a
 *      document whose frame background is dark. Clamping instead continues the
 *      page, which is what glass at the edge of a scene shows, and it makes the
 *      panel independent of the frame colour it had no business depending on.
 *   2. clamping to the ARTBOARD is not enough. The canvas holds only what is on
 *      screen; zoom in and the artboard runs well past it — measured at x -300
 *      to 2660 against a 1500px canvas. A sample pinned to the artboard is then
 *      still outside the TEXTURE, where CLAMP_TO_EDGE hands back whatever the
 *      canvas's outermost column holds. Hence the intersection of the two.
 *   3. the artboard's own outermost column is not page either: it is the
 *      artboard's border and the antialiasing under it. Measured off the live
 *      canvas, the edge column reads 219,221,223 where one pixel in reads
 *      255,255,255 — and since every off-page ray lands on that same column,
 *      it came back as a solid BAR of border grey, darker the smaller the
 *      artboard is drawn. Two device pixels in clears it.
 *
 * Only the third needs the editor's real artboard chrome to appear at all. A
 * synthetic scene paints the artboard as a plain rect, so its edge column IS
 * the page, and seven harness reproductions came back clean while the bug was
 * sitting in front of the user. What found it was reading the canvas itself at
 * those two columns instead of rendering another approximation.
 *
 * Where artboard and texture do not overlap there is nothing to sample and the
 * page colour is the honest answer. */
vec3 page(vec2 sp){
  vec2 lo = max(uArt.xy + 4.0, vec2(0.0));
  vec2 hi = min(uArt.xy + uArt.zw - 4.0, uScene - 1.0);
  if (hi.x < lo.x || hi.y < lo.y) return uPageBg;
  /* FOLD, do not clamp. A ray that runs off the artboard used to be pinned to
   * its edge column — so every off-page ray on a row landed on the SAME
   * texel, and since the ray's tilt grows without bound towards a seam
   * (tan of the exit angle, times the air gap), a whole band beside each seam
   * read one column of the page repeated across it: horizontal streaks that
   * varied only down the panel. Measured live: 40% of a row at flute width
   * 310 was the right edge column, to within 12 levels. Folding the point
   * back into the page (a triangle wave over its span) continues the page in
   * both directions and never lands two rays on one texel by construction;
   * a ray that has travelled many spans simply sees the page mirrored many
   * times, which reads as frosting, not a bar. Rule 1 above still holds: the
   * panel never answers with the frame colour. */
  vec2 span = max(hi - lo, vec2(1.0));
  vec2 tt = mod(sp - lo, 2.0 * span);
  sp = lo + (span - abs(tt - span));
  sp = clamp(sp, lo, hi);
  /* Composite over the page colour instead of reading .rgb straight.
   *
   * The editor canvas is TRANSPARENT wherever nothing has been painted, and a
   * transparent texel is (0,0,0,0) — so every ray that landed on empty page
   * came back black, and with the output alpha forced to 1 those blacks were
   * opaque. The standalone never hit this because its source pass filled every
   * pixel. Clear glass over an empty page has to read as the page. */
  vec4 t = texture(uSrc, sp / uScene);
  return mix(uPageBg, t.rgb, t.a);
}
/* The panel-local point, y measured top-down like the canvas. */
vec2 here(){ return vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y); }
/* A sample displaced along the ACROSS-FLUTE axis. With vertical flutes that
   is the x axis and this reduces to the old behaviour exactly; at any other
   angle the displacement has to follow the flutes, not the screen. */
vec3 srcAt(vec2 p, float d, vec2 dir){
  return page(uBoxPos + p + d * dir);
}

void main(){
  float fw = max(uFluteW, 2.0);
  float hw = 0.5 * fw;
  float R  = (1.0 + uBulge * uBulge) / (2.0 * uBulge);
  float F0 = (uIor - 1.0) / (uIor + 1.0); F0 *= F0;
  float sw = clamp(0.5 * uSeamW / hw, 0.0, 1.0);
  /* The flute direction. Everything downstream works in the ACROSS-flute
   * coordinate t, so the angle enters in exactly one place and the optics
   * never learn about it. */
  vec2 dir = vec2(cos(uAngle), sin(uAngle));
  vec2 p0 = here();
  float t0 = dot(p0, dir);
  vec3 acc = vec3(0.0);
  for (int j = 0; j < AA; j++) {
    /* The AA offset is along the rib axis too — jittering screen x would
     * stop antialiasing the edge as soon as the flutes turned. */
    float t  = t0 + (float(j) + 0.5) / float(AA) - 0.5;
    vec2  p  = p0 + ((float(j) + 0.5) / float(AA) - 0.5) * dir;
    float xf = t / fw - uPhase;
    float i  = floor(xf);
    float u  = (xf - i - 0.5) * 2.0;                 // -1..1 across the flute
    vec2 tr = trace(u, uIor - uDisp, R);
    vec2 tg = trace(u, uIor,         R);
    vec2 tb = trace(u, uIor + uDisp, R);
    /* trace returns where along the flute the ray came from; the displacement
     * from THIS pixel is the difference, carried along the rib axis. */
    vec3 col = vec3(srcAt(p, (tr.x - u) * hw, dir).r,
                    srcAt(p, (tg.x - u) * hw, dir).g,
                    srcAt(p, (tb.x - u) * hw, dir).b);
    vec3 trans = vec3(tr.y, tg.y, tb.y);
    vec3 mir = vec3(0.0);
    for (int k = -2; k <= 2; k++) mir += srcAt(p, float(k) * fw * 0.6, dir);
    mir /= 5.0;
    float sa = clamp(abs(u) / R, 0.0, 1.0);
    float ca = sqrt(1.0 - sa * sa);
    float F  = F0 + (1.0 - F0) * pow(1.0 - ca, 5.0);
    float Ft = clamp(F * uFresnel, 0.0, 1.0);
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
  c += (hash(gl_FragCoord.xy) - 0.5) / 255.0;        // dither
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

  const MAX_TILE = 4096;

  let gl = null,
    cv = null,
    prog = null,
    vao = null,
    tex = null,
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
      tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return true;
    } catch (e) {
      console.warn("reed glass engine disabled:", e.message);
      failed = true;
      gl = null;
      return false;
    }
  }

  const hex3 = (h) => {
    const s = /^#[0-9a-fA-F]{6}$/.test(h || "") ? h : "#ffffff";
    return [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
  };

  /**
   * Render the panel.
   * @param srcCanvas the editor canvas, i.e. everything painted so far
   * @param W,H       its size in device px
   * @param box       the panel in canvas px {x,y,w,h}
   * @param art       the artboard in canvas px {x,y,w,h}
   * @param P         the effect parameters; fluteW and seamW arrive in DEVICE px
   * @returns a box-sized canvas, or null if the engine is unavailable
   */
  function render(srcCanvas, W, H, box, art, P) {
    if (!init()) return null;
    const w = Math.max(2, Math.min(MAX_TILE, Math.round(box.w)));
    const h = Math.max(2, Math.min(MAX_TILE, Math.round(box.h)));
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog);
    gl.bindVertexArray(vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, srcCanvas);
    gl.uniform1i(loc("uSrc"), 0);
    gl.uniform2f(loc("uScene"), W, H);
    gl.uniform2f(loc("uBoxPos"), box.x, box.y);
    gl.uniform2f(loc("uRes"), w, h);
    const A = art || { x: 0, y: 0, w: W, h: H };
    gl.uniform4f(loc("uArt"), A.x, A.y, A.w, A.h);
    gl.uniform3fv(loc("uPageBg"), hex3(P.pageBg));
    gl.uniform1f(loc("uFluteW"), Math.max(2, +P.fluteW || 53));
    gl.uniform1f(loc("uPhase"), +P.phase || 0);
    gl.uniform1f(loc("uBulge"), P.bulge === undefined ? 0.45 : +P.bulge);
    gl.uniform1f(loc("uIor"), P.ior === undefined ? 1.5 : +P.ior);
    gl.uniform1f(loc("uDisp"), P.disp === undefined ? 0.008 : +P.disp);
    gl.uniform1f(loc("uThick"), P.thick === undefined ? 1 : +P.thick);
    gl.uniform1f(loc("uGap"), P.gap === undefined ? 10 : +P.gap);
    gl.uniform1f(loc("uSeamW"), P.seamW === undefined ? 1.6 : +P.seamW);
    gl.uniform1f(loc("uSeamDark"), P.seamDark === undefined ? 0.75 : +P.seamDark);
    gl.uniform1f(loc("uFresnel"), P.fresnel === undefined ? 1 : +P.fresnel);
    gl.uniform1f(loc("uSpec"), P.spec === undefined ? 0.5 : +P.spec);
    gl.uniform1f(loc("uLightAng"), ((+P.lightAng || 0) * Math.PI) / 180);
    gl.uniform1f(loc("uLightW"), P.lightW === undefined ? 0.25 : +P.lightW);
    gl.uniform1f(loc("uAmbient"), P.ambient === undefined ? 0.12 : +P.ambient);
    gl.uniform1f(loc("uAngle"), ((+P.angle || 0) * Math.PI) / 180);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return cv;
  }

  /* The standalone's presets, minus the ones that only meant anything to its
   * animated source. Flute width is in DOCUMENT px here, not a count across
   * the frame, because a panel in a document has no fixed width. */
  const PRESETS = {
    reference: {},
    magnify: { gap: 0, thick: 0.6, bulge: 0.6, disp: 0.012, fluteW: 65, spec: 1.2 },
    fine: { fluteW: 22, bulge: 0.5, gap: 5, seamW: 1.0, spec: 1.2 },
    crystal: { ior: 1.9, disp: 0.05, bulge: 0.8, gap: 5, spec: 2.0, lightW: 0.14, ambient: 0.08 },
    clear: { spec: 0, ambient: 0, fresnel: 0, seamDark: 0.35 },
  };

  window.ReedGlassEngine = {
    /* Stamped so "is this the build with the fix in it" is one line in the
       console rather than a round of screenshots: ReedGlassEngine.VERSION. */
    VERSION: "20260923-fold1",
    render,
    available: () => init(),
    PRESETS: Object.keys(PRESETS),
    presetValues: (k) => (PRESETS[k] ? Object.assign({}, PRESETS[k]) : null),
  };
})();
