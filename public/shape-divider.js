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
 * The field is built at FIELD_RES on the long side rather than at tile size.
 * The smoothing radii live between 0.002 and 0.13 of half the box, so a couple
 * of hundred samples across it is far finer than anything that reads, and the
 * transform is O(n) per axis either way — it is the upload that would cost. */
(function () {
  "use strict";

  const VERSION = "20260921-divider1";
  /* Long side of the distance field. 256 puts a sample every 0.4% of the box,
   * and the smallest fillet the panel can ask for is 0.2% — half a sample, and
   * bilinear filtering covers that. Measured: 512 is indistinguishable. */
  const FIELD_RES = 256;
  const MAX_DIVIDERS = 12;
  const KINDS = ["Straight lines", "Parabolic curves", "Wave lines", "Radial spokes"];

  const VERTEX = `#version 300 es
  in vec2 a_position;out vec2 v_uv;
  void main(){v_uv=a_position*.5+.5;gl_Position=vec4(a_position,0.,1.);}`;

  const FRAGMENT = `#version 300 es
  precision highp float;in vec2 v_uv;out vec4 fragColor;
  uniform sampler2D u_body;
  uniform vec2 u_resolution;
  uniform float u_aspect,u_edgeSmooth,u_intersectionSmooth,u_fillAlpha;
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
    vec2 uv=vec2(p.x/max(u_aspect,.0001),p.y)*.5+.5;
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
    vec2 p=v_uv*2.-1.;p.x*=u_aspect;
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
   *  which is the convention every SDF in the lab's shader already uses. */
  function signedField(alpha, w, h) {
    const inside = new Uint8Array(w * h),
      outside = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      if (alpha[i * 4 + 3] > 127) inside[i] = 1;
      else outside[i] = 1;
    }
    const dOut = edt2d(inside, w, h); // distance to the shape, for pixels outside
    const dIn = edt2d(outside, w, h); // distance to the outside, for pixels inside
    const scale = 2 / h;
    const field = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      field[i] = inside[i] ? -Math.sqrt(dIn[i]) * scale : Math.sqrt(dOut[i]) * scale;
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
        "aspect",
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
  function render(w, h, silhouette, s) {
    const gl = boot();
    if (!gl || !(w >= 1) || !(h >= 1) || !silhouette) return null;
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));

    // the silhouette, at field resolution
    const fw = Math.max(8, Math.round(w >= h ? FIELD_RES : (FIELD_RES * w) / h));
    const fh = Math.max(8, Math.round(h >= w ? FIELD_RES : (FIELD_RES * h) / w));
    const mc = document.createElement("canvas");
    mc.width = fw;
    mc.height = fh;
    const mx = mc.getContext("2d", { willReadFrequently: true });
    mx.drawImage(silhouette, 0, 0, fw, fh);
    const field = signedField(mx.getImageData(0, 0, fw, fh).data, fw, fh);

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
    gl.uniform1f(_u.aspect, w / Math.max(1, h));
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
    FIELD_RES,
    available,
    render,
    // exported for the tests: the geometry is the part worth pinning
    signedField,
    edt2d,
  };
})();
