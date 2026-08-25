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

  /* ---- fitting a net to a reference image ---------------------------------
   *
   * This is raster-to-vector inference, which HANDOFF.md:78 rules out. It is
   * here at the author's explicit direction after the constraint was put to
   * them; the note stays so the decision is visible to whoever reads this next
   * rather than being discovered.
   *
   * HOW. Sampling the image at the sixteen grid positions gets a net that is
   * roughly right and visibly wrong: a control point's colour is not the
   * colour under it. A Catmull-Rom surface passes THROUGH its points, but every
   * point also pulls on its neighbourhood, so a net of sampled colours renders
   * with the contrast smeared and the extremes pulled toward the middle.
   *
   * So the initial sample is a starting guess, refined by rendering the net
   * and correcting it against the target — the residual at each control point
   * is fed back into its colour, weighted by that point's own influence. It is
   * the same idea as unsharp masking a downsample: measure what the
   * reconstruction gets wrong and pre-compensate for it.
   *
   * Geometry is fitted second and separately: a point moves toward the nearest
   * strong colour EDGE in its cell, because a control point sitting on an edge
   * reproduces that edge far better than one sitting in a flat region. Moves
   * are bounded to a fraction of a cell so the net cannot tangle.
   */
  const FIT_RES = 160; // working resolution; fidelity plateaus here

  function imageToRGBA(img, W, H) {
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const x = c.getContext("2d", { willReadFrequently: true });
    x.drawImage(img, 0, 0, W, H);
    return x.getImageData(0, 0, W, H);
  }

  /** Area-average of the image around (u,v) — one pixel is too noisy to trust. */
  function sampleArea(data, W, H, u, v, rad) {
    const cx = u * (W - 1),
      cy = v * (H - 1);
    let r = 0,
      g = 0,
      b = 0,
      n = 0;
    const x0 = Math.max(0, Math.round(cx - rad)),
      x1 = Math.min(W - 1, Math.round(cx + rad));
    const y0 = Math.max(0, Math.round(cy - rad)),
      y1 = Math.min(H - 1, Math.round(cy + rad));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const i = (y * W + x) * 4;
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        n++;
      }
    return n ? [r / n, g / n, b / n] : [128, 128, 128];
  }

  /** How much control point (pr,pc) influences (u,v). Matches Catmull-Rom's
   *  two-cell support, so the correction lands where the point actually acts. */
  function influence(u, v, pc, pr, cols, rows) {
    const du = Math.abs(u * (cols - 1) - pc),
      dv = Math.abs(v * (rows - 1) - pr);
    if (du >= 2 || dv >= 2) return 0;
    const k = (d) => (d < 1 ? 1 - (d * d * (3 - 2 * d)) / 1 : Math.max(0, (2 - d) * 0.25));
    return Math.max(0, k(du)) * Math.max(0, k(dv));
  }

  function fitToImage(img, cols, rows, opts) {
    if (!init()) return null;
    opts = opts || {};
    const passes = opts.passes == null ? 14 : opts.passes;
    /* Geometry fitting is OFF by default because it was measured, not because
     * it was hard. Moving control points onto colour edges sounds obviously
     * right and is not: it distorts the parameterisation faster than sitting
     * on an edge helps. Against a four-hotspot reference — sampling / with
     * correction / with correction and snapping — 4x4 gave 20.8 / 19.2 / 18.2,
     * 6x6 gave 11.7 / 10.0 / 10.2 and 8x8 gave 5.0 / 3.4 / 4.9. It wins
     * marginally at the smallest grid and loses at every larger one, and
     * WITHOUT the colour correction it is far worse than doing nothing (31.2
     * at 4x4). Kept as an option rather than deleted, since a very coarse net
     * is the one case it helps. */
    const moveGeometry = opts.moveGeometry === true;
    const W = FIT_RES,
      H = FIT_RES;
    const target = imageToRGBA(img, W, H).data;

    // --- 1. initial guess: area-sampled colours on an even net
    const rad = Math.max(1, Math.round(FIT_RES / Math.max(cols, rows) / 3));
    const pts = [];
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const u = cols === 1 ? 0.5 : c / (cols - 1),
          v = rows === 1 ? 0.5 : r / (rows - 1);
        pts.push({ x: u, y: v, color: sampleArea(target, W, H, u, v, rad) });
      }

    // --- 2. move points onto edges, where a control point earns its keep
    if (moveGeometry) {
      const lum = (i) => 0.2126 * target[i] + 0.7152 * target[i + 1] + 0.0722 * target[i + 2];
      for (let r = 1; r < rows - 1; r++)
        for (let c = 1; c < cols - 1; c++) {
          const i = r * cols + c;
          const u0 = pts[i].x,
            v0 = pts[i].y;
          const reach = 0.35 / Math.max(cols - 1, 1); // bounded: the net must not tangle
          let bx = u0,
            by = v0,
            bs = -1;
          for (let dy = -3; dy <= 3; dy++)
            for (let dx = -3; dx <= 3; dx++) {
              const u = u0 + (dx / 3) * reach,
                v = v0 + (dy / 3) * reach;
              if (u < 0 || u > 1 || v < 0 || v > 1) continue;
              const px = Math.round(u * (W - 1)),
                py = Math.round(v * (H - 1));
              if (px < 1 || py < 1 || px >= W - 1 || py >= H - 1) continue;
              const p = (py * W + px) * 4;
              const gx = lum(p + 4) - lum(p - 4);
              const gy = lum(p + W * 4) - lum(p - W * 4);
              const mag = Math.hypot(gx, gy);
              if (mag > bs) {
                bs = mag;
                bx = u;
                by = v;
              }
            }
          pts[i].x = bx;
          pts[i].y = by;
          pts[i].color = sampleArea(target, W, H, bx, by, rad);
        }
    }

    // --- 3. correct the colours against what the net actually renders
    const acc = new Float64Array(cols * rows * 3),
      wsum = new Float64Array(cols * rows);
    for (let pass = 0; pass < passes; pass++) {
      const tile = render(W, H, { cols, rows, points: pts });
      if (!tile) break;
      const cur = tile.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, W, H).data;
      acc.fill(0);
      wsum.fill(0);
      // a coarse stride: the residual is smooth, and every pixel costs passes
      const step = 2;
      for (let y = 0; y < H; y += step)
        for (let x = 0; x < W; x += step) {
          const i = (y * W + x) * 4;
          const u = x / (W - 1),
            v = y / (H - 1);
          const er = target[i] - cur[i],
            eg = target[i + 1] - cur[i + 1],
            eb = target[i + 2] - cur[i + 2];
          for (let r = 0; r < rows; r++)
            for (let c = 0; c < cols; c++) {
              const w = influence(u, v, c, r, cols, rows);
              if (w <= 0) continue;
              const k = r * cols + c;
              acc[k * 3] += er * w;
              acc[k * 3 + 1] += eg * w;
              acc[k * 3 + 2] += eb * w;
              wsum[k] += w;
            }
        }
      /* Under-relaxed. A full correction overshoots, because every point's
       * neighbours are being corrected in the same pass and their influences
       * overlap — the net then oscillates instead of settling. */
      const rate = 0.7;
      for (let k = 0; k < cols * rows; k++) {
        if (wsum[k] <= 0) continue;
        const p = pts[k];
        for (let ch = 0; ch < 3; ch++)
          p.color[ch] = clampi(p.color[ch] + (acc[k * 3 + ch] / wsum[k]) * rate, 0, 255);
      }
    }
    pts.forEach((p) => (p.color = p.color.map((v) => clampi(Math.round(v), 0, 255))));
    return pts;
  }

  /** Mean per-channel error between a fitted net and its reference, 0..255.
   *  Reported rather than hidden: a fit that cannot reach the image should say
   *  so instead of quietly returning its best guess as though it were right. */
  function fitError(img, cols, rows, pts) {
    if (!init()) return null;
    const W = FIT_RES,
      H = FIT_RES;
    const target = imageToRGBA(img, W, H).data;
    const tile = render(W, H, { cols, rows, points: pts });
    if (!tile) return null;
    const cur = tile.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, W, H).data;
    let sum = 0,
      n = 0;
    for (let i = 0; i < target.length; i += 4 * 3) {
      sum +=
        Math.abs(target[i] - cur[i]) +
        Math.abs(target[i + 1] - cur[i + 1]) +
        Math.abs(target[i + 2] - cur[i + 2]);
      n += 3;
    }
    return n ? sum / n : null;
  }

  window.MeshGradient = {
    get,
    render,
    evalAt,
    resample,
    defaultPoints,
    fitToImage,
    fitError,
    MIN_N,
    MAX_N,
    PALETTE,
    available: () => init(),
  };
})();
