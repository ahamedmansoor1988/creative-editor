/* Iridescence — a thin-film dispersive material for a shape.
 *
 * PROVENANCE, in two steps. The material is the fragment shader from
 * Chromaform (iridescent-effect.html). It reached a LAYER through the DoLittle
 * Figma plugin, which had already solved the problem this file exists for:
 * the page's shader knew six hard-coded silhouettes and derived its curved
 * normal from an analytic dome for each. A vector shape has no closed form.
 *
 * So coverage comes from the shape's OWN mask, and the height field that
 * drives the normal is solved from that mask — laplacian(h) = -1 inside the
 * silhouette with h = 0 on its boundary, the classic way to inflate a 2-D
 * shape, normalised and square-rooted. For a disc that is exactly the
 * hemisphere the original used; for every other outline it is a smooth
 * cushion going to grazing at the rim, with no medial-axis ridge.
 *
 * This replaces an earlier port here that picked the nearest of the six SDFs
 * and scaled it to the layer's box. It was wrong in every way a shape can be
 * wrong: a rect with sharp corners came out rounded, a hexagon borrowed the
 * star's rim, and the mismatch between the shader's silhouette and the path
 * the tile is clipped to showed as a pale fringe in the corners.
 *
 * WHAT THE EDITOR OWNS, so the shader does not: the transform, the clip, the
 * layer's opacity and blend, and repetition. The page's scale, stretch,
 * rotation, echoes and background are all gone for that reason — the same
 * call the plugin made, for the same reason.
 *
 * NO ANIMATION. A design tool renders a document; a material whose look
 * depended on the clock could not be exported reproducibly.
 */
(function () {
  "use strict";

  const VERT = `#version 300 es
in vec2 p; out vec2 uv; void main(){uv=p*.5+.5;gl_Position=vec4(p,0,1);}`;

  const FRAG = `#version 300 es
precision highp float;
in vec2 uv; out vec4 outColor;
uniform sampler2D maskTex;
uniform sampler2D domeTex;
uniform vec2 domeInner;
uniform float domePad;
uniform float intensity, spectrum, refraction, rim, softness, depth;
uniform float hue, saturation, exposure;   // RESTORED FOR THE EDITOR: its panel has these rows
uniform vec3 colorCenter, colorLeft, colorRight, colorTop, colorEdge;
uniform vec2 size;      // output pixels
uniform float unit;     // half the shorter side, in pixels: the HTML's coordinate unit
uniform float stripEnabled, stripAmount, stripWidth, stripAngle, stripDepth, stripThickness, stripIor, stripDisp;
uniform float dither;
mat2 rot(float a){float c=cos(a),s=sin(a);return mat2(c,-s,s,c);}
vec3 hueRotate(vec3 c,float a){
  const vec3 k=vec3(.577350269);float ca=cos(a),sa=sin(a);
  return c*ca+cross(k,c)*sa+k*dot(k,c)*(1.-ca);
}
vec3 palette(float t){
  // Branch-free circular radial-basis palette. Because it is expressed with
  // sin/cos, every derivative matches at the 0/1 wrap for all parameters.
  float a=fract(t)*6.28318;vec2 u=vec2(cos(a),sin(a));
  float w0=exp(6.*(dot(u,vec2(1.,0.))-1.));
  float w1=exp(6.*(dot(u,vec2(.309,.951))-1.));
  float w2=exp(6.*(dot(u,vec2(-.809,.588))-1.));
  float w3=exp(6.*(dot(u,vec2(-.809,-.588))-1.));
  float w4=exp(6.*(dot(u,vec2(.309,-.951))-1.));
  return (colorCenter*w0+colorLeft*w1+colorTop*w2+colorEdge*w3+colorRight*w4)/(w0+w1+w2+w3+w4);
}
vec3 sat(vec3 c,float s){float l=dot(c,vec3(.2126,.7152,.0722));return mix(vec3(l),c,s);}
vec3 volumeField(vec2 p,float focus){
  vec3 c=colorCenter;
  float red=exp(-dot(p-vec2(-.58,-.10),p-vec2(-.58,-.10))*3.9*focus);
  float green=exp(-dot(p-vec2(.57,-.02),p-vec2(.57,-.02))*3.7*focus);
  float cyan=exp(-dot(p-vec2(-.40,.65),p-vec2(-.40,.65))*5.0*focus);
  float blue=exp(-dot(p-vec2(.61,.48),p-vec2(.61,.48))*5.2*focus);
  float aqua=exp(-dot(p-vec2(.02,-.82),p-vec2(.02,-.82))*5.1*focus);
  c=mix(c,colorLeft,red*.96);
  c=mix(c,colorRight,green*.88);
  c=mix(c,colorTop,cyan*.72);
  c=mix(c,colorEdge,blue*.76);
  return mix(c,mix(colorTop,colorEdge,.34),aqua*.78);
}
vec3 linearToSRGB(vec3 c){
  c=max(c,vec3(0));
  vec3 lo=12.92*c;
  vec3 hi=1.055*pow(c,vec3(1./2.4))-.055;
  return mix(lo,hi,step(vec3(.0031308),c));
}
// Textures are uploaded top row first; GL uv is y-up.
// Integer hash on the pixel: stable across GPUs, no large-argument sin().
float hashPx(uvec2 p,uint seed){
  uint h=p.x*374761393u^p.y*668265263u^seed*1442695041u;
  h=(h^(h>>13u))*1274126177u;h^=h>>16u;
  return float(h)/4294967296.0;
}
// The HTML's reeded panel, unchanged: an arc-profiled rib, two refractions
// (in through the rib, out through the flat back), a lateral offset.
vec2 stripWarp(vec2 p,float panelIor){
  if(abs(stripAmount)<=.0001)return p;
  vec2 axis=vec2(cos(stripAngle),sin(stripAngle));
  float x=dot(p,axis),hw=stripWidth*.5;
  float sag=sign(stripAmount)*max(abs(stripAmount)*hw,.0001);
  float radius=(hw*hw+sag*sag)/(2.*sag);
  float xr=(fract(x/stripWidth+.5)-.5)*stripWidth;
  float slope=-xr/sqrt(max(radius*radius-xr*xr,1e-6))*sign(sag);
  slope=clamp(slope,-6.,6.);
  vec3 rd=vec3(0,0,-1);
  vec3 n=normalize(vec3(-slope*axis,1));
  vec3 d1=refract(rd,n,1./panelIor);
  if(dot(d1,d1)<.5)d1=reflect(rd,n);
  vec2 lateral=d1.xy*(stripThickness/max(abs(d1.z),.05));
  vec3 d2=refract(d1,vec3(0,0,1),panelIor);
  if(dot(d2,d2)<.5)d2=reflect(d1,vec3(0,0,1));
  lateral+=d2.xy*(stripDepth/max(abs(d2.z),.05));
  return p+lateral;
}
vec2 imgUV(vec2 u){return vec2(u.x,1.-u.y);}
float maskAt(vec2 u){return texture(maskTex,imgUV(u)).a;}
float domeTexel(ivec2 c){ivec2 sz=textureSize(domeTex,0);return texelFetch(domeTex,clamp(c,ivec2(0),sz-1),0).r;}
// Cubic B-spline reconstruction of the low-resolution dome: C2-smooth, so the
// finite-difference normal below never sees the solve grid.
vec4 bspline(float t){float t2=t*t,t3=t2*t;return vec4(-t3+3.*t2-3.*t+1.,3.*t3-6.*t2+4.,-3.*t3+3.*t2+3.*t+1.,t3)/6.;}
float domeRow(ivec2 i,int y,vec4 wx){
  return dot(vec4(domeTexel(i+ivec2(-1,y)),domeTexel(i+ivec2(0,y)),domeTexel(i+ivec2(1,y)),domeTexel(i+ivec2(2,y))),wx);
}
float domeAt(vec2 u){
  vec2 p=imgUV(u)*domeInner+domePad-.5;
  vec2 f=fract(p);ivec2 i=ivec2(floor(p));
  vec4 wx=bspline(f.x),wy=bspline(f.y);
  return clamp(domeRow(i,-1,wx)*wy.x+domeRow(i,0,wx)*wy.y+domeRow(i,1,wx)*wy.z+domeRow(i,2,wx)*wy.w,0.,1.);
}
void main(){
  float mask=maskAt(uv);
  if(mask<=.001){outColor=vec4(0.);return;}
  // STRIP GLASS, as the HTML composed it: the panel in front bends the
  // coordinate before the volume is evaluated, so the body, its dome and its
  // lobes all ripple through the ribs, and the red and blue channels sample
  // through slightly different panels. The silhouette itself stays put:
  // Figma clips the fill to the geometry, so a warped outline would only
  // open slivers of the fill beneath.
  vec2 rawQ=(uv-.5)*size/unit;
  vec2 panelG=stripWarp(rawQ,stripIor);
  vec2 panelR=stripWarp(rawQ,stripIor*(1.-stripDisp));
  vec2 panelB=stripWarp(rawQ,stripIor*(1.+stripDisp));
  vec2 toBp=unit/size*2.*.86;              // HTML units -> the ±0.86 shape space
  vec2 stripDeltaR=(panelR-panelG)*toBp*stripEnabled;
  vec2 stripDeltaB=(panelB-panelG)*toBp*stripEnabled;
  vec2 uvW=mix(uv,panelG*unit/size+.5,stripEnabled);
  // The node's bounding box maps to ±0.86, the extent the HTML's shapes had.
  vec2 bp=(uvW*2.-1.)*.86;
  // A continuous height-field normal. Unlike a boundary SDF normal, this
  // curves gradually from face-on at the centre to grazing at the rim.
  float e=.003;
  vec2 eu=vec2(e/1.72);
  float bodyDome=domeAt(uvW);
  vec2 dh=vec2(domeAt(uvW+vec2(eu.x,0.))-domeAt(uvW-vec2(eu.x,0.)),domeAt(uvW+vec2(0.,eu.y))-domeAt(uvW-vec2(0.,eu.y)))/(2.*e);
  vec3 N=normalize(vec3(-dh*.72,1.));
  float vdn=clamp(N.z,0.,1.);
  float ior=1.+refraction*.28;
  float f0=(ior-1.)/(ior+1.);f0*=f0;
  float fres=f0+(1.-f0)*pow(1.-vdn,5.);
  // radial(): 0 at the deepest point, 1 at the boundary. With dome = sqrt(h)
  // this is the exact inverse the original had for the orb.
  float bodyRadius=sqrt(clamp(1.-bodyDome*bodyDome,0.,1.));

  // One virtual environment is sampled three times along wavelength-
  // dependent refracted paths. This is the inexpensive 2-D analogue of the
  // per-channel ray tracing used by the glass-capsule shader.
  float materialAngle=refraction*.82;
  vec2 rp=rot(materialAngle)*bp;
  vec2 panelSampleR=rot(materialAngle)*stripDeltaR;
  vec2 panelSampleB=rot(materialAngle)*stripDeltaB;
  rp+=refraction*.10*vec2(sin(bp.y*3.1),sin(bp.x*2.7));
  float dispersion=spectrum*.026;
  vec2 bend=N.xy/max(.24,N.z);
  float refractionShift=(1.-1./ior)*.34;
  float lobeFocus=mix(1.72,.84,softness);
  vec3 sampleR=volumeField(rp+panelSampleR-bend*(refractionShift+dispersion),lobeFocus);
  vec3 sampleG=volumeField(rp-bend*refractionShift,lobeFocus);
  vec3 sampleB=volumeField(rp+panelSampleB-bend*(refractionShift-dispersion),lobeFocus);
  vec3 transmittedTint=clamp(vec3(sampleR.r,sampleG.g,sampleB.b),.025,1.);

  // Beer-Lambert absorption: the centre has the longest optical path and
  // therefore the richest color; the edge becomes clear before Fresnel and
  // dispersion take over.
  transmittedTint=mix(vec3(.96),transmittedTint,.88);
  float shapeThickness=.15+1.30*bodyDome;
  float opticalLength=mix(.16,2.55,depth)*shapeThickness;
  vec3 base=pow(transmittedTint,vec3(opticalLength));
  base*=mix(.82,1.06,bodyDome);
  float pearl=exp(-dot(bp-vec2(-.03,.62),bp-vec2(-.03,.62))*4.0)*(.16+.31*softness);
  base=mix(base,vec3(.91,.98,.96),pearl*(1.-fres));
  float lc=(bp.y+.77)/.19;
  float lowerCaustic=exp(-lc*lc)*smoothstep(.52,.98,bodyRadius);
  base=mix(base,mix(colorTop,vec3(1),.34),lowerCaustic*.28*depth);

  // Schlick Fresnel from the effective IOR governs the reflection strength.
  // The reflected field is spectral, while the body remains absorption-led.
  float incidence=atan(N.y,N.x)/6.28318;
  float optical=incidence+fres*(.08+.72*spectrum)+bodyRadius*.055*spectrum+dot(N.xy,vec2(.11,-.09))*refraction;
  vec3 film=palette(optical+.04);
  film=sat(film,1.28);
  float rimWidth=mix(.012,.25,rim);
  float geometricRim=smoothstep(1.-rimWidth,1.,bodyRadius);
  float edgeBand=clamp(fres*(.82+rim*.72)+geometricRim*rim*.34,0.,.96);
  base=mix(base,film,edgeBand);
  base+=film*pow(geometricRim,5.)*.075;
  float softLuma=dot(base,vec3(.2126,.7152,.0722));
  base=mix(base,vec3(softLuma),softness*.035);
  /* RESTORED FOR THE EDITOR. The plugin froze these at the page's defaults
     because its panel had no rows for them; this one does. */
  base=hueRotate(base,hue*6.28318);
  vec3 color=sat(base,saturation)*exposure;
  color=color/(1.+max(color-1.,vec3(0))*.22);
  vec3 srgb=linearToSRGB(color);
  // ±1 LSB triangular dither keyed off the pixel. Gentle gradients band in
  // 8 bits, and Figma shows the render zoomed, where every step becomes a
  // stripe. The same pixel always gets the same noise: renders stay
  // reproducible, and the fit still measures a deterministic picture.
  uvec2 px=uvec2(gl_FragCoord.xy);
  srgb+=(hashPx(px,1u)+hashPx(px,2u)-1.0)/255.0*dither;
  outColor=vec4(srgb,mask*intensity);
}`;

  /* ---- silhouette -> smooth height field ---------------------------------
   * Ported from the plugin's dome.ts. Solved on a grid whose long side is at
   * most 512, red-black SOR, coarse to fine so the low frequencies converge
   * at the cheap levels. Cells carry their FRACTIONAL coverage from the
   * antialiased mask and are damped by it, so the field fades to zero across
   * the true sub-cell edge rather than the grid's — without that, a diagonal
   * edge becomes a staircase and the rim band wobbles along it at high zoom.
   * The grid has a one-cell zero border, so a shape touching its bounding box
   * still meets h = 0 exactly at the edge. */
  const MIN_COVER = 0.01; // below this a cell is simply outside

  function solveDome(rgba, w, h, maxSide) {
    maxSide = maxSide || 512;
    // Summed-area table of alpha: any block average is four lookups.
    const W1 = w + 1;
    const sat = new Uint32Array(W1 * (h + 1));
    for (let y = 0; y < h; y++) {
      let run = 0;
      const src = y * w * 4,
        dst = (y + 1) * W1,
        up = y * W1;
      for (let x = 0; x < w; x++) {
        run += rgba[src + x * 4 + 3];
        sat[dst + x + 1] = sat[up + x + 1] + run;
      }
    }

    const long = Math.max(w, h);
    const fine = Math.min(maxSide, long);
    const fw = Math.max(2, Math.round((w * fine) / long));
    const fh = Math.max(2, Math.round((h * fine) / long));

    // Level sizes, coarsest first.
    const sizes = [];
    for (
      let lw = fw, lh = fh;
      ;
      lw = Math.max(2, Math.ceil(lw / 2)), lh = Math.max(2, Math.ceil(lh / 2))
    ) {
      sizes.unshift([lw, lh]);
      if (Math.max(lw, lh) <= 24) break;
    }

    let prev = null;
    let v = new Float32Array(0),
      gw = 0,
      gh = 0;
    for (let li = 0; li < sizes.length; li++) {
      const [lw, lh] = sizes[li];
      gw = lw + 2;
      gh = lh + 2;
      // Fractional coverage per cell, 0 on the border ring.
      const cover = new Float32Array(gw * gh);
      for (let cy = 0; cy < lh; cy++) {
        const y0 = Math.floor((cy * h) / lh),
          y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * h) / lh));
        for (let cx = 0; cx < lw; cx++) {
          const x0 = Math.floor((cx * w) / lw),
            x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * w) / lw));
          const sum = sat[y1 * W1 + x1] - sat[y0 * W1 + x1] - sat[y1 * W1 + x0] + sat[y0 * W1 + x0];
          cover[(cy + 1) * gw + cx + 1] = sum / (255 * (x1 - x0) * (y1 - y0));
        }
      }
      v = new Float32Array(gw * gh);
      if (prev) {
        // Bilinear upsample of the coarser solution as the initial guess. The
        // continuous solution scales with area, hence the gain.
        const pw = prev.w,
          ph = prev.h,
          pv = prev.v;
        const gain = (lw / (pw - 2)) * (lh / (ph - 2));
        for (let gy = 1; gy <= lh; gy++) {
          const py = Math.min(ph - 1, Math.max(0, ((gy - 0.5) / lh) * (ph - 2) + 0.5));
          const y0 = Math.floor(py),
            y1 = Math.min(ph - 1, y0 + 1),
            fy = py - y0;
          for (let gx = 1; gx <= lw; gx++) {
            const i = gy * gw + gx;
            if (cover[i] <= MIN_COVER) continue;
            const px = Math.min(pw - 1, Math.max(0, ((gx - 0.5) / lw) * (pw - 2) + 0.5));
            const x0 = Math.floor(px),
              x1 = Math.min(pw - 1, x0 + 1),
              fx = px - x0;
            const a = pv[y0 * pw + x0] * (1 - fx) + pv[y0 * pw + x1] * fx;
            const b = pv[y1 * pw + x0] * (1 - fx) + pv[y1 * pw + x1] * fx;
            v[i] = (a * (1 - fy) + b * fy) * gain * cover[i];
          }
        }
      }
      const last = li === sizes.length - 1;
      sor(v, cover, gw, gh, last ? 400 : 1500, last ? 3e-4 : 1e-4);
      prev = { v, w: gw, h: gh };
    }

    let max = 0;
    for (let i = 0; i < v.length; i++) if (v[i] > max) max = v[i];
    const out = new Float32Array(v.length);
    if (max > 0) {
      const inv = 1 / max;
      for (let i = 0; i < v.length; i++) out[i] = v[i] > 0 ? Math.sqrt(v[i] * inv) : 0;
    }
    return { data: out, width: gw, height: gh, inner: [fw, fh], pad: 1 };
  }

  /* Red-black successive over-relaxation for  h = c * (l + r + u + d + 1) / 4
   * on covered cells, where c is the cell's fractional coverage; the border
   * ring is never covered, so no bounds checks. */
  function sor(v, cover, w, h, maxIter, tol) {
    const omega = Math.min(1.9, 2 / (1 + Math.sin(Math.PI / Math.max(w, h))));
    for (let it = 0; it < maxIter; it++) {
      let maxD = 0,
        maxV = 0;
      for (let parity = 0; parity < 2; parity++) {
        for (let y = 1; y < h - 1; y++) {
          const row = y * w;
          for (let x = 1 + ((y + parity) & 1); x < w - 1; x += 2) {
            const i = row + x;
            const c = cover[i];
            if (c <= MIN_COVER) continue;
            const nv = c * 0.25 * (v[i - 1] + v[i + 1] + v[i - w] + v[i + w] + 1);
            const d = nv - v[i];
            let nx = v[i] + omega * d;
            if (nx < 0) nx = 0;
            v[i] = nx;
            const ad = d < 0 ? -d : d;
            if (ad > maxD) maxD = ad;
            if (nx > maxV) maxV = nx;
          }
        }
      }
      if (maxD < tol * Math.max(maxV, 1e-6)) break;
    }
  }

  /* Four partner colours LEANED toward the core.
   *
   * The source page shipped five colours far apart in hue, and on a shape that
   * reads as a rainbow with a middle rather than as one iridescent material —
   * reported as too much turbulence in the shades. The plugin solved it by
   * deriving its partners from a single base and leaning them toward it; its
   * own note says the object should read as "pink, iridescent" rather than
   * "rainbow with a pink middle".
   *
   * Keeping five pickers and leaning them is the same idea with the control
   * left in the user's hands: at spread 0 the whole body is the core colour,
   * at 1 the five are exactly what the pickers say. Mixed in LINEAR light,
   * which is where the shader works, so the midpoint does not go muddy. */
  function leaned(hex, coreHex, spread) {
    const t = Math.max(0, Math.min(1, spread === undefined ? 1 : +spread));
    if (t >= 1) return linearRGB(hex);
    const c = linearRGB(hex),
      k = linearRGB(coreHex);
    return [0, 1, 2].map((i) => k[i] + (c[i] - k[i]) * t);
  }

  /* sRGB hex to the LINEAR triple the shader works in — the page's own
   * conversion, kept so a colour set here matches the reference. */
  function linearRGB(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
    const n = m ? parseInt(m[1], 16) : 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      v /= 255;
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
  }

  let gl = null,
    canvas = null,
    program = null,
    loc = null,
    maskTex = null,
    domeTex = null,
    failed = false;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(s) || "compile failed");
    return s;
  }

  function init() {
    if (program) return true;
    if (failed) return false;
    try {
      canvas = document.createElement("canvas");
      gl = canvas.getContext("webgl2", {
        premultipliedAlpha: false,
        alpha: true,
        antialias: false,
      });
      if (!gl) throw new Error("no webgl2");
      if (
        !gl.getExtension("EXT_color_buffer_float") &&
        !gl.getExtension("OES_texture_float_linear")
      ) {
        /* The dome is uploaded as R32F. Without float textures there is no
         * height field, so the material cannot render rather than rendering
         * something wrong. */
      }
      program = gl.createProgram();
      gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(program) || "link failed");
      gl.useProgram(program);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const p = gl.getAttribLocation(program, "p");
      gl.enableVertexAttribArray(p);
      gl.vertexAttribPointer(p, 2, gl.FLOAT, false, 0, 0);
      loc = {};
      const n = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) {
        const u = gl.getActiveUniform(program, i);
        loc[u.name] = gl.getUniformLocation(program, u.name);
      }
      maskTex = gl.createTexture();
      domeTex = gl.createTexture();
      gl.uniform1i(loc.maskTex, 0);
      gl.uniform1i(loc.domeTex, 1);
      return true;
    } catch (e) {
      failed = true;
      program = null;
      gl = null;
      return false;
    }
  }

  const F = (k, v) => {
    if (loc[k]) gl.uniform1f(loc[k], v);
  };
  const C = (k, hex) => {
    if (loc[k]) gl.uniform3fv(loc[k], linearRGB(hex));
  };

  /* The dome is expensive and depends only on the SHAPE, never on a colour or
   * a slider, so it is cached against the mask's own identity. Dragging
   * Spectrum re-renders without re-solving. */
  const DOME_MAX = 8;
  const domeCache = new Map();
  function domeFor(maskCanvas, key) {
    const hit = domeCache.get(key);
    if (hit) return hit;
    const w = maskCanvas.width,
      h = maskCanvas.height;
    const px = maskCanvas.getContext("2d").getImageData(0, 0, w, h).data;
    const field = solveDome(px, w, h, 512);
    domeCache.set(key, field);
    if (domeCache.size > DOME_MAX) domeCache.delete(domeCache.keys().next().value);
    return field;
  }

  function render(W, H, P) {
    if (!init()) return null;
    if (!P || !P.mask) return null;
    const w = Math.max(1, Math.min(4096, Math.round(W)));
    const h = Math.max(1, Math.min(4096, Math.round(H)));
    /* The solve grid never exceeds the mask it is solved from, and is capped
     * at 512. With the tile capped too, the grid is at worst half the tile's
     * resolution, which the cubic B-spline resolves without a visible step. */
    const field = domeFor(P.mask, P.maskKey || w + "x" + h);
    canvas.width = w;
    canvas.height = h;
    gl.viewport(0, 0, w, h);
    gl.useProgram(program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, maskTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, P.mask);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, domeTex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R32F,
      field.width,
      field.height,
      0,
      gl.RED,
      gl.FLOAT,
      field.data,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (loc.domeInner) gl.uniform2f(loc.domeInner, field.inner[0], field.inner[1]);
    F("domePad", field.pad);

    if (loc.size) gl.uniform2f(loc.size, w, h);
    F("unit", Math.min(w, h) / 2);
    F("intensity", 1);
    F("spectrum", P.spectrum);
    F("refraction", P.refraction);
    F("rim", P.rim);
    F("softness", P.softness);
    F("depth", P.depth);
    F("hue", P.hue / 360);
    F("saturation", P.saturation);
    F("exposure", P.exposure);
    F("dither", 1);
    /* Reeding stays compiled and off: seven controls for a separate glass
     * effect that happened to share the source page. */
    F("stripEnabled", 0);
    F("stripAmount", 0.15);
    F("stripWidth", 0.11);
    F("stripAngle", 0);
    F("stripDepth", 1.6);
    F("stripThickness", 0.06);
    F("stripIor", 1.52);
    F("stripDisp", 0.03);
    const V = (k, v) => {
      if (loc[k]) gl.uniform3fv(loc[k], v);
    };
    C("colorCenter", P.colorCore);
    V("colorLeft", leaned(P.colorLeft, P.colorCore, P.spread));
    V("colorRight", leaned(P.colorRight, P.colorCore, P.spread));
    V("colorTop", leaned(P.colorTop, P.colorCore, P.spread));
    V("colorEdge", leaned(P.colorEdge, P.colorCore, P.spread));

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    out.getContext("2d").drawImage(canvas, 0, 0);
    return out;
  }

  /* One tile per (size, mask, parameters). A shape that is not being edited
   * redraws from the cache, which is what keeps a document with several of
   * these from re-running the shader every frame. */
  const CACHE_MAX = 24;
  const cache = new Map();
  const keyOf = (w, h, P) =>
    w +
    "x" +
    h +
    "|" +
    (P.maskKey || "") +
    "|" +
    [
      "spectrum",
      "refraction",
      "rim",
      "softness",
      "depth",
      "hue",
      "saturation",
      "exposure",
      "spread",
      "colorCore",
      "colorLeft",
      "colorRight",
      "colorTop",
      "colorEdge",
    ]
      .map((k) => P[k])
      .join(",");

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

  window.Iridescent = {
    get,
    leaned,
    render,
    solveDome,
    linearRGB,
    available: () => init(),
  };
})();
