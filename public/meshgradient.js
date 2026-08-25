/* Mesh gradient — a deformable colour surface (§4.7).
 *
 * PROVENANCE. The surface is the one worked out in public/lab-mesh.html and
 * carried across unchanged: one bicubic Catmull-Rom over the WHOLE control
 * net, position evaluated per vertex, colour per fragment. What changed for
 * the port is coordinates and lifetime, both documented at their site.
 *
 * WHY ONE SURFACE RATHER THAN A PATCH PER CELL. Catmull-Rom is C1 and
 * interpolating: it passes exactly through every control point and its
 * tangents already agree across every cell boundary. Seams are absent by
 * construction rather than blended away, so there is no boundary to hide and
 * no seam to reappear at a different zoom.
 *
 * WHY COLOUR IS EVALUATED PER FRAGMENT. As a vertex attribute the GPU would
 * interpolate colour LINEARLY across each triangle, and the bicubic would show
 * as faceting wherever the tessellation was coarse. In the fragment shader,
 * colour smoothness stops depending on geometry density — the tessellation
 * only has to be fine enough for the SHAPE.
 *
 * WHY POINTS ARE NORMALISED. In the lab a point lived at a pixel in an 800px
 * artwork. Here the same mesh has to sit on a shape of any size, and has to
 * survive that shape being resized, so a point is stored in 0..1 of the box
 * and multiplied out at render. A mesh authored on a small rect keeps its
 * proportions when the rect grows.
 *
 * THE EDGES REFLECT, THEY DO NOT CLAMP. Catmull-Rom needs a point beyond each
 * end. Clamping to the boundary duplicates the edge point, which flattens the
 * tangent there and — the reason it matters — propagates edge influence right
 * across the surface: moving one point changed the far corner nearly as much
 * as its own neighbourhood. Reflecting (a phantom at 2*p0 - p1) continues the
 * existing slope, which both keeps a uniform grid uniform and confines a
 * point's influence to where it belongs.
 */
(function () {
  "use strict";

  const MIN_N = 2,
    MAX_N = 10;
  /* Geometry density only. Colour smoothness does not depend on it — see the
   * per-fragment note above — so this is chosen for how finely a dragged point
   * may bend the surface, not for gradient quality. */
  const TESS = 96;

  const VS = `#version 300 es
precision highp float;
precision highp int;
layout(location=0) in vec2 aUV;
uniform sampler2D uPos;
uniform vec2 uGrid;                      // cols, rows as floats: see note below
uniform vec2 uSize;
out vec2 vUV;
vec4 cr(vec4 p0,vec4 p1,vec4 p2,vec4 p3,float t){
  float t2=t*t,t3=t2*t;
  return 0.5*((2.0*p1)+(-p0+p2)*t+(2.0*p0-5.0*p1+4.0*p2-p3)*t2+(-p0+3.0*p1-3.0*p2+p3)*t3);
}
int cl(int v,int lo,int hi){ return v<lo?lo:(v>hi?hi:v); }
vec4 rowPos(int r,int c){
  int mx=int(uGrid.x)-1;
  if(c>=0&&c<=mx) return texelFetch(uPos,ivec2(c,r),0);
  if(c<0) return 2.0*texelFetch(uPos,ivec2(0,r),0)-texelFetch(uPos,ivec2(1,r),0);
  return 2.0*texelFetch(uPos,ivec2(mx,r),0)-texelFetch(uPos,ivec2(mx-1,r),0);
}
vec4 fetchPos(int r,int c){
  int my=int(uGrid.y)-1;
  if(r>=0&&r<=my) return rowPos(r,c);
  if(r<0) return 2.0*rowPos(0,c)-rowPos(1,c);
  return 2.0*rowPos(my,c)-rowPos(my-1,c);
}
void main(){
  vUV=aUV;
  float fx=aUV.x*(uGrid.x-1.0), fy=aUV.y*(uGrid.y-1.0);
  int ci=cl(int(floor(fx)),0,int(uGrid.x)-2), ri=cl(int(floor(fy)),0,int(uGrid.y)-2);
  float tu=fx-float(ci), tv=fy-float(ri);
  vec4 rv[4];
  for(int j=0;j<4;j++){
    int r=ri+j-1;
    rv[j]=cr(fetchPos(r,ci-1),fetchPos(r,ci),fetchPos(r,ci+1),fetchPos(r,ci+2),tu);
  }
  vec4 p=cr(rv[0],rv[1],rv[2],rv[3],tv);
  gl_Position=vec4(p.x/uSize.x*2.0-1.0, 1.0-p.y/uSize.y*2.0, 0.0, 1.0);
}`;

  const FS = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUV;
uniform sampler2D uCol;
uniform vec2 uGrid;
out vec4 fragColor;
vec4 cr(vec4 p0,vec4 p1,vec4 p2,vec4 p3,float t){
  float t2=t*t,t3=t2*t;
  return 0.5*((2.0*p1)+(-p0+p2)*t+(2.0*p0-5.0*p1+4.0*p2-p3)*t2+(-p0+3.0*p1-3.0*p2+p3)*t3);
}
int cl(int v,int lo,int hi){ return v<lo?lo:(v>hi?hi:v); }
vec4 rowCol(int r,int c){
  int mx=int(uGrid.x)-1;
  if(c>=0&&c<=mx) return texelFetch(uCol,ivec2(c,r),0);
  if(c<0) return 2.0*texelFetch(uCol,ivec2(0,r),0)-texelFetch(uCol,ivec2(1,r),0);
  return 2.0*texelFetch(uCol,ivec2(mx,r),0)-texelFetch(uCol,ivec2(mx-1,r),0);
}
vec4 fetchCol(int r,int c){
  int my=int(uGrid.y)-1;
  if(r>=0&&r<=my) return rowCol(r,c);
  if(r<0) return 2.0*rowCol(0,c)-rowCol(1,c);
  return 2.0*rowCol(my,c)-rowCol(my-1,c);
}
void main(){
  float fx=vUV.x*(uGrid.x-1.0), fy=vUV.y*(uGrid.y-1.0);
  int ci=cl(int(floor(fx)),0,int(uGrid.x)-2), ri=cl(int(floor(fy)),0,int(uGrid.y)-2);
  float tu=fx-float(ci), tv=fy-float(ri);
  vec4 rv[4];
  for(int j=0;j<4;j++){
    int r=ri+j-1;
    rv[j]=cr(fetchCol(r,ci-1),fetchCol(r,ci),fetchCol(r,ci+1),fetchCol(r,ci+2),tu);
  }
  vec4 c=cr(rv[0],rv[1],rv[2],rv[3],tv);
  fragColor=vec4(clamp(c.rgb,0.0,1.0),1.0);
}`;

  /* uGrid travels as a vec2 rather than an ivec2 because `highp int` is not
   * honoured in the fragment stage on every GPU: the two stages then disagree
   * on the precision of a shared uniform and the program refuses to link. */

  let gl = null,
    prog = null,
    vao = null,
    posTex = null,
    colTex = null,
    U = null,
    cv = null,
    failed = false;

  function init() {
    if (gl || failed) return !!gl;
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
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(prog));
      gl.useProgram(prog);
      U = {
        pos: gl.getUniformLocation(prog, "uPos"),
        col: gl.getUniformLocation(prog, "uCol"),
        grid: gl.getUniformLocation(prog, "uGrid"),
        size: gl.getUniformLocation(prog, "uSize"),
      };
      vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const verts = [];
      for (let r = 0; r < TESS; r++)
        for (let c = 0; c < TESS; c++) {
          const u0 = c / TESS,
            u1 = (c + 1) / TESS,
            v0 = r / TESS,
            v1 = (r + 1) / TESS;
          verts.push(u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1);
        }
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      const mk = (unit) => {
        const t = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, t);
        for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER])
          gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
        for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T])
          gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
        return t;
      };
      posTex = mk(0);
      colTex = mk(1);
      gl.uniform1i(U.pos, 0);
      gl.uniform1i(U.col, 1);
      return true;
    } catch (e) {
      failed = true;
      gl = null;
      return false;
    }
  }

  const VERT_COUNT = TESS * TESS * 6;

  /* A default net: an even grid carrying a deliberately strong palette. Pastels
   * would hide exactly the seams and facets this surface exists to avoid, so
   * the default has to make the interpolation obvious. */
  const PALETTE = ["#0b5cff", "#7b2fff", "#ff2fb0", "#ff8a00", "#00d3ff", "#fff2a8"];

  function defaultPoints(cols, rows) {
    const out = [];
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const h = PALETTE[(r * cols + c) % PALETTE.length];
        const n = parseInt(h.slice(1), 16);
        out.push({
          x: cols === 1 ? 0.5 : c / (cols - 1),
          y: rows === 1 ? 0.5 : r / (rows - 1),
          color: [(n >> 16) & 255, (n >> 8) & 255, n & 255],
        });
      }
    return out;
  }

  /* Resizing the net RESAMPLES it at the new uniform parameters, so the surface
   * carries across rather than resetting. The parameterisation is derived from
   * the index, so it is uniform by construction: a point cannot be inserted at
   * the old spacing and then re-derived at the new one without the whole grid
   * sliding. What is preserved is the SURFACE, not the control positions. */
  function resample(P, fromC, fromR, toC, toR) {
    const out = [];
    for (let r = 0; r < toR; r++)
      for (let c = 0; c < toC; c++) {
        const u = toC === 1 ? 0 : c / (toC - 1),
          v = toR === 1 ? 0 : r / (toR - 1);
        out.push(evalAt(P, fromC, fromR, u, v));
      }
    return out;
  }

  const clampi = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  function catmull(a, b, c, d, t) {
    const t2 = t * t,
      t3 = t2 * t;
    return (
      0.5 *
      (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
    );
  }

  /** The same surface the shader draws, on the CPU — used for resampling and
   *  for hit-testing a drag against what is actually on screen. */
  function evalAt(P, cols, rows, u, v) {
    const at = (r, c) => P[r * cols + c];
    const ext = (a, b) => ({
      x: 2 * a.x - b.x,
      y: 2 * a.y - b.y,
      color: [0, 1, 2].map((k) => 2 * a.color[k] - b.color[k]),
    });
    const inRow = (r, c) =>
      c >= 0 && c <= cols - 1
        ? at(r, c)
        : c < 0
          ? ext(at(r, 0), at(r, 1))
          : ext(at(r, cols - 1), at(r, cols - 2));
    const get = (r, c) => {
      if (r >= 0 && r <= rows - 1) return inRow(r, c);
      const e = r < 0 ? [0, 1] : [rows - 1, rows - 2];
      return ext(inRow(e[0], c), inRow(e[1], c));
    };
    const fx = u * (cols - 1),
      fy = v * (rows - 1);
    const ci = clampi(Math.floor(fx), 0, cols - 2),
      ri = clampi(Math.floor(fy), 0, rows - 2);
    const tu = fx - ci,
      tv = fy - ri;
    const rv = [];
    for (let j = -1; j <= 2; j++) {
      const a = get(ri + j, ci - 1),
        b = get(ri + j, ci),
        c2 = get(ri + j, ci + 1),
        d = get(ri + j, ci + 2);
      rv.push({
        x: catmull(a.x, b.x, c2.x, d.x, tu),
        y: catmull(a.y, b.y, c2.y, d.y, tu),
        color: [0, 1, 2].map((k) => catmull(a.color[k], b.color[k], c2.color[k], d.color[k], tu)),
      });
    }
    return {
      x: catmull(rv[0].x, rv[1].x, rv[2].x, rv[3].x, tv),
      y: catmull(rv[0].y, rv[1].y, rv[2].y, rv[3].y, tv),
      color: [0, 1, 2].map((k) =>
        clampi(
          Math.round(catmull(rv[0].color[k], rv[1].color[k], rv[2].color[k], rv[3].color[k], tv)),
          0,
          255,
        ),
      ),
    };
  }

  /* One tile per (size, parameters). The document is static, so a mesh that has
   * not changed is drawn from the same tile rather than re-traced — the same
   * bargain the other engines strike, and the reason a dragged point costs one
   * render rather than one per frame of the whole page. */
  const cache = new Map();
  const CACHE_MAX = 12;
  const keyOf = (W, H, P) => W + "x" + H + "|" + JSON.stringify(P);

  function render(W, H, P) {
    if (!init()) return null;
    const cols = clampi(P.cols | 0, MIN_N, MAX_N),
      rows = clampi(P.rows | 0, MIN_N, MAX_N);
    const pts = P.points && P.points.length === cols * rows ? P.points : defaultPoints(cols, rows);
    cv.width = Math.max(1, Math.round(W));
    cv.height = Math.max(1, Math.round(H));
    gl.viewport(0, 0, cv.width, cv.height);
    const Pos = new Float32Array(cols * rows * 4),
      Col = new Float32Array(cols * rows * 4);
    for (let i = 0; i < cols * rows; i++) {
      const p = pts[i];
      // normalised 0..1 -> the shape's own box
      Pos[i * 4] = p.x * W;
      Pos[i * 4 + 1] = p.y * H;
      Pos[i * 4 + 3] = 1;
      Col[i * 4] = p.color[0] / 255;
      Col[i * 4 + 1] = p.color[1] / 255;
      Col[i * 4 + 2] = p.color[2] / 255;
      Col[i * 4 + 3] = 1;
    }
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, posTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, cols, rows, 0, gl.RGBA, gl.FLOAT, Pos);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, colTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, cols, rows, 0, gl.RGBA, gl.FLOAT, Col);
    gl.uniform2f(U.grid, cols, rows);
    gl.uniform2f(U.size, cv.width, cv.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, VERT_COUNT);
    // copy off the shared context, which the next call will overwrite
    const out = document.createElement("canvas");
    out.width = cv.width;
    out.height = cv.height;
    out.getContext("2d").drawImage(cv, 0, 0);
    return out;
  }

  function get(W, H, P) {
    if (!init()) return null;
    const k = keyOf(Math.round(W), Math.round(H), P);
    const hit = cache.get(k);
    if (hit) return hit;
    const tile = render(W, H, P);
    if (!tile) return null;
    cache.set(k, tile);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return tile;
  }

  window.MeshGradient = {
    get,
    render,
    evalAt,
    resample,
    defaultPoints,
    MIN_N,
    MAX_N,
    PALETTE,
    available: () => init(),
  };
})();
