/* Shape Divider — cuts the object's OWN outline into pieces.
 *
 * Ported from the Shape Divider lab (public/shape-divider-tool.js), with the
 * one change that makes it an effect rather than a tool: the lab picks from
 * five analytic shapes, and here the body is whatever the user drew. A rect, a
 * star, a hand-made path — the editor can already build the outline, so the
 * effect has no business owning a shape list.
 *
 * WHY A DISTANCE FIELD AND NOT A MASK. The look rests on one line:
 *
 *     resultD = smax(shapeD, -cuts, k)
 *
 * a SMOOTH subtraction, and smooth needs a signed distance — the fillet where
 * a divider meets the silhouette is built out of how far away the edge is. Cut
 * a 0/1 alpha mask instead and every one of those joins goes hard, which is
 * precisely the thing worth keeping. So the silhouette is rasterised once,
 * turned into a signed distance field, and sampled. Everything downstream is
 * the lab's shader untouched.
 *
 * The field tracks the TILE, between a floor and a ceiling, and its edge is
 * placed from the silhouette's own sub-pixel coverage rather than from which
 * side of a pixel centre the boundary fell — see signedField. A fixed
 * resolution and a binary mask were, together, why a cleanly drawn curve came
 * back visibly rasterised. */
(function () {
  "use strict";

  const VERSION = "20260921-divider3";
  /* The field follows the TILE, within bounds. A fixed 256 was fine for a
   * thumbnail and four times undersampled on a shape drawn a thousand pixels
   * wide, which is the other half of why a curve came out rasterised. The
   * floor keeps a tiny shape from being measured on a grid too coarse to hold
   * its corners; the ceiling keeps the transform — two linear passes over the
   * grid, run on every draw — off the critical path on a huge one. */
  const FIELD_MIN = 128;
  const FIELD_MAX = 1024;
  function fieldResFor(w, h) {
    return Math.max(FIELD_MIN, Math.min(FIELD_MAX, Math.max(w, h)));
  }
  const MAX_DIVIDERS = 12;
  const KINDS = ["Straight lines", "Parabolic curves", "Wave lines", "Radial spokes"];

  const VERTEX = `#version 300 es
  in vec2 a_position;out vec2 v_uv;
  void main(){v_uv=a_position*.5+.5;gl_Position=vec4(a_position,0.,1.);}`;

  const FRAGMENT = `#version 300 es
  precision highp float;in vec2 v_uv;out vec4 fragColor;
  uniform sampler2D u_body;
  uniform vec2 u_resolution;
  uniform vec2 u_span;
  uniform float u_edgeSmooth,u_intersectionSmooth,u_fillAlpha;
  uniform vec3 u_fill;
  uniform float u_enabled[12],u_kind[12],u_angle[12],u_count[12],u_spacing[12],u_width[12],u_offset[12],u_curve[12],u_smooth[12];
  #define PI 3.14159265359
  mat2 rot(float a){float c=cos(a),s=sin(a);return mat2(c,-s,s,c);}
  float smin(float a,float b,float k){float h=clamp(.5+.5*(b-a)/max(k,.0001),0.,1.);return mix(b,a,h)-k*h*(1.-h);}
  float smax(float a,float b,float k){return -smin(-a,-b,k);}

  /* The user's outline, as a signed distance. Outside the field the value is
   * clamped to its edge, which reads as "far outside" and keeps a divider that
   * runs past the shape from wrapping back into it. */
  float body(vec2 p){
    vec2 uv=p/max(u_span,vec2(.0001))*.5+.5;
    return texture(u_body,clamp(uv,vec2(.001),vec2(.999))).r;
  }

  float divider(vec2 p,int index){
    float angle=0.,count=1.,spacing=.2,width=.03,offset=0.,curve=0.,joinSoftness=.01,kind=0.;
    for(int i=0;i<12;i++)if(i==index){angle=u_angle[i];count=u_count[i];spacing=u_spacing[i];width=u_width[i];offset=u_offset[i];curve=u_curve[i];joinSoftness=u_smooth[i];kind=u_kind[i];}
    vec2 q=rot(angle)*p;float d=10.;
    if(kind<2.5){
      for(int j=0;j<12;j++){
        float fj=float(j);if(fj>=count)continue;
        // Count always means visible divisions. Spacing is a normalized
        // spread control, distributed across the useful shape diameter.
        float fittedStep=count<=1.?0.:1.34/max(count-1.,1.);
        float actualSpacing=fittedStep*mix(.28,1.12,spacing);
        float center=(fj-(count-1.)*.5)*actualSpacing+offset;
        float bend=kind<.5?0.:curve*(q.x*q.x-.22);
        if(kind>1.5)bend=curve*sin(q.x*3.2);
        float line=abs(q.y-center-bend)-width;
        d=smin(d,line,joinSoftness);
      }
    }else{
      float a=atan(q.y,q.x)+offset;float stepA=PI/max(count,1.);
      d=abs(mod(a+stepA*.5,stepA)-stepA*.5)*length(q)-width;
    }
    return d;
  }

  void main(){
    /* p is measured in HALF THE OBJECT's height, whatever the tile around it
     * is — so a spacing or a width means the same thing however much margin
     * the field needed. u_span says how far the tile reaches in those units. */
    vec2 p=(v_uv*2.-1.)*u_span;
    float shapeD=body(p),cuts=10.;
    for(int i=0;i<12;i++){
      float layerOn=0.;for(int j=0;j<12;j++)if(j==i)layerOn=u_enabled[j];
      if(layerOn>.5)cuts=smin(cuts,divider(p,i),mix(.001,.16,u_intersectionSmooth));
    }
    // Smooth subtraction rounds every corner where a divider meets the
    // silhouette, while the cut-field smooth-min rounds divider crossings.
    float resultD=smax(shapeD,-cuts,mix(.002,.13,u_edgeSmooth));
    float aa=max(fwidth(resultD),.0005)*1.15;
    float mask=(1.-smoothstep(-aa,aa,resultD))*u_fillAlpha;
    // Premultiplied: the tile is composited over the page, so the gaps the
    // dividers cut have to be genuinely empty, not painted with a background.
    fragColor=vec4(u_fill*mask,mask);
  }`;

  /* ---- signed distance from a silhouette -------------------------------- */

  /** One axis of the exact Euclidean transform (Felzenszwalb & Huttenlocher):
   *  the lower envelope of the parabolas f(i) + (x-i)^2. Linear in n, and
   *  exact, which a chamfer pass is not — and the error a chamfer makes shows
   *  up precisely at the diagonal joins this effect is made of. */
  function edt1d(f, n, d, v, z) {
    let k = 0;
    v[0] = 0;
    z[0] = -Infinity;
    z[1] = Infinity;
    for (let q = 1; q < n; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      const dx = q - v[k];
      d[q] = dx * dx + f[v[k]];
    }
  }

  /** Squared distance to the nearest set pixel, over a boolean grid. */
  function edt2d(grid, w, h) {
    const INF = 1e20;
    const out = new Float64Array(w * h);
    const size = Math.max(w, h);
    const f = new Float64Array(size),
      d = new Float64Array(size);
    const v = new Int32Array(size + 1),
      z = new Float64Array(size + 1);
    for (let i = 0; i < w * h; i++) out[i] = grid[i] ? 0 : INF;
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) f[y] = out[y * w + x];
      edt1d(f, h, d, v, z);
      for (let y = 0; y < h; y++) out[y * w + x] = d[y];
    }
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) f[x] = out[row + x];
      edt1d(f, w, d, v, z);
      for (let x = 0; x < w; x++) out[row + x] = d[x];
    }
    return out;
  }

  /** A silhouette's SIGNED distance field, in the shader's own units: y spans
   *  -1..1 across the box, so one pixel is 2/h of it. Inside is negative,
   *  which is the convention every SDF in the lab's shader already uses.
   *
   *  THE EDGE IS PLACED SUB-PIXEL. A binary inside/outside grid puts every
   *  zero crossing at a pixel centre, so the exact distance transform then
   *  reproduces that grid's staircase faithfully — and bilinear filtering
   *  smooths BETWEEN samples that already have the steps baked in, which is
   *  why a curve came out visibly rasterised however cleanly it was drawn.
   *  The canvas has already computed sub-pixel coverage for us in the alpha;
   *  throwing it away was the mistake. Within one pixel of the boundary the
   *  distance is taken from that coverage — a pixel 30% covered has its edge
   *  0.2px past the centre, not at it — and the transform supplies everything
   *  further out, where a pixel of error is invisible anyway. */
  function signedField(alpha, w, h, unitsPerPx) {
    const n = w * h;
    const inside = new Uint8Array(n),
      outside = new Uint8Array(n);
    const cov = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = alpha[i * 4 + 3] / 255;
      cov[i] = a;
      if (a > 0.5) inside[i] = 1;
      else outside[i] = 1;
    }
    const dOut = edt2d(inside, w, h); // distance to the shape, for pixels outside
    const dIn = edt2d(outside, w, h); // distance to the outside, for pixels inside
    const scale = Number.isFinite(unitsPerPx) ? unitsPerPx : 2 / h;
    const field = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const px = inside[i] ? -Math.sqrt(dIn[i]) : Math.sqrt(dOut[i]);
      /* |px| <= 1 is the boundary band: the pixel touches the edge, so its
       * own coverage locates the edge far better than the grid does. Outside
       * the band the coverage is 0 or 1 and carries no information. */
      field[i] = (Math.abs(px) <= 1 ? 0.5 - cov[i] : px) * scale;
    }
    return field;
  }

  /* ---- the renderer ------------------------------------------------------ */

  let _gl = null,
    _cv = null,
    _prog = null,
    _vao = null,
    _tex = null,
    _u = null,
    _bad = false;

  function boot() {
    if (_gl || _bad) return _gl;
    try {
      _cv = document.createElement("canvas");
      const gl = _cv.getContext("webgl2", {
        antialias: false,
        premultipliedAlpha: true,
        alpha: true,
      });
      if (!gl) throw new Error("WebGL2 unavailable");
      /* A float texture is what carries a distance field; without this
       * extension the sampler clamps to 0..1 and every distance outside the
       * shape reads as the same value. */
      if (!gl.getExtension("EXT_color_buffer_float")) gl.getExtension("OES_texture_float_linear");
      gl.getExtension("OES_texture_float_linear");
      const compile = (t, s) => {
        const x = gl.createShader(t);
        gl.shaderSource(x, s);
        gl.compileShader(x);
        if (!gl.getShaderParameter(x, gl.COMPILE_STATUS))
          throw new Error(gl.getShaderInfoLog(x) || "shader");
        return x;
      };
      const p = gl.createProgram();
      gl.attachShader(p, compile(gl.VERTEX_SHADER, VERTEX));
      gl.attachShader(p, compile(gl.FRAGMENT_SHADER, FRAGMENT));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(p) || "link");
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const a = gl.getAttribLocation(p, "a_position");
      gl.enableVertexAttribArray(a);
      gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
      const names = [
        "resolution",
        "span",
        "edgeSmooth",
        "intersectionSmooth",
        "fill",
        "fillAlpha",
        "body",
        "enabled",
        "kind",
        "angle",
        "count",
        "spacing",
        "width",
        "offset",
        "curve",
        "smooth",
      ];
      const u = {};
      names.forEach((n) => (u[n] = gl.getUniformLocation(p, `u_${n}`)));
      _tex = gl.createTexture();
      _gl = gl;
      _prog = p;
      _vao = vao;
      _u = u;
      return _gl;
    } catch (e) {
      _bad = true;
      return null;
    }
  }

  function available() {
    return !!boot();
  }

  function rgb(h) {
    const n = parseInt(String(h || "#000000").slice(1), 16) || 0;
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  /**
   * @param {number} w  tile width in device pixels
   * @param {number} h  tile height
   * @param {HTMLCanvasElement} silhouette  the object's outline, drawn opaque
   * @param {object} s  effect state
   * @returns {HTMLCanvasElement|null}
   */
  /**
   * @param {number} w  tile width in device pixels, INCLUDING any margin
   * @param {number} h  tile height, including margin
   * @param {HTMLCanvasElement} silhouette  the outline drawn on that tile
   * @param {object} s  effect state
   * @param {number} [objH]  the object's own height within the tile. Every
   *   divider number is measured in half of THIS, so adding margin around the
   *   shape does not move the cuts. Defaults to the tile, which is what a
   *   caller with no margin means.
   */
  function render(w, h, silhouette, s, objH) {
    const gl = boot();
    if (!gl || !(w >= 1) || !(h >= 1) || !silhouette) return null;
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    const oh = Number.isFinite(objH) && objH > 0 ? objH : h;

    // the silhouette, at field resolution
    const R = fieldResFor(w, h);
    const fw = Math.max(8, Math.round(w >= h ? R : (R * w) / h));
    const fh = Math.max(8, Math.round(h >= w ? R : (R * h) / w));
    const mc = document.createElement("canvas");
    mc.width = fw;
    mc.height = fh;
    const mx = mc.getContext("2d", { willReadFrequently: true });
    /* High-quality downscale: the coverage read back IS the sub-pixel edge, so
     * a nearest-neighbour resample here would throw away the very thing the
     * field is about to be built from. */
    mx.imageSmoothingEnabled = true;
    mx.imageSmoothingQuality = "high";
    mx.drawImage(silhouette, 0, 0, fw, fh);
    /* Distance in field pixels -> the shader's units, which are half the
     * OBJECT's height. One field pixel spans h/fh tile pixels, and oh tile
     * pixels span 2 units. */
    const unitsPerPx = (2 * h) / (oh * fh);
    const field = signedField(mx.getImageData(0, 0, fw, fh).data, fw, fh, unitsPerPx);

    _cv.width = w;
    _cv.height = h;
    gl.viewport(0, 0, w, h);
    gl.useProgram(_prog);
    gl.bindVertexArray(_vao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, _tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, fw, fh, 0, gl.RED, gl.FLOAT, field);
    gl.uniform1i(_u.body, 0);

    gl.uniform2f(_u.resolution, w, h);
    // how far the tile reaches, in half-object-heights
    gl.uniform2f(_u.span, w / Math.max(1, oh / 2) / 2, h / Math.max(1, oh / 2) / 2);
    const smooth = clamp01(s.smoothness);
    gl.uniform1f(_u.edgeSmooth, smooth);
    gl.uniform1f(_u.intersectionSmooth, smooth);
    gl.uniform3fv(_u.fill, rgb(s.color));
    gl.uniform1f(_u.fillAlpha, s.fillAlpha == null ? 1 : clamp01(s.fillAlpha));

    const n = Math.max(1, Math.min(MAX_DIVIDERS, Math.round(+s.dividerCount || 1)));
    ["enabled", "kind", "angle", "count", "spacing", "width", "offset", "curve", "smooth"].forEach(
      (k) => {
        const vals = new Float32Array(MAX_DIVIDERS);
        for (let i = 0; i < MAX_DIVIDERS; i++) vals[i] = i < n ? +s[`${k}${i}`] || 0 : 0;
        gl.uniform1fv(_u[k], vals);
      },
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return _cv;
  }

  function clamp01(v) {
    const n = +v;
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
  }

  window.ShapeDividerEngine = {
    VERSION,
    MAX_DIVIDERS,
    KINDS,
    FIELD_MIN,
    FIELD_MAX,
    fieldResFor,
    available,
    render,
    // exported for the tests: the geometry is the part worth pinning
    signedField,
    edt2d,
  };
})();
