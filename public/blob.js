/* Blob + Glass 2 — SDF metaball blending.
 *
 * Implements the smooth boolean operators from Victor Baro's "SDF in Metal:
 * Adding the Liquid to the Glass" (the maths behind Apple's
 * glassEffectContainer): several shapes are evaluated in ONE pass and merged
 * with smoothUnion, so they fuse organically as they approach instead of
 * simply overlapping.
 *
 *   Blob    — the combined field rendered as an alpha mask. The editor then
 *             composites the object's own fill through it, so every existing
 *             fill type (solid / linear / radial, all stops) works unchanged.
 *   Glass 2 — the SAME combined field fed into the locked glass optics. The
 *             fragment source is taken from GlassEngine and only objectSdf()
 *             and edgeField() are swapped, so refraction, Fresnel, frost,
 *             dispersion and tint stay byte-identical to the shipped material.
 */
(function(){
"use strict";

const BLOB_MAX=64;   // uniform-array budget; layout callers clamp to this

/* Shared GLSL: shape array, smooth booleans, combined field. Depends on
 * roundedBoxSdf(), which both hosts define before this block is injected. */
const SDF_CHUNK=`
#define BLOB_MAX ${BLOB_MAX}
uniform vec4 uShapeA[BLOB_MAX];   // cx, cy, halfW, halfH   (px, y-up)
uniform vec4 uShapeB[BLOB_MAX];   // type(0 rect,1 ellipse), cornerRadiusPx
uniform int  uShapeCount;
uniform float uSmooth;            // blend width in px
uniform float uCombine;           // 0 union, 1 intersection, 2 difference
uniform float uRefPx;             // interior depth that maps to field 0
uniform int   uWeightIdx;         // >=0: output ONE shape's share of the blend

// iq's cheap ellipse approximation — exact for circles, close enough for the
// gradient work the optics do.
float sdEllipseApprox(vec2 p, vec2 r){
  r=max(r,vec2(0.5));
  float k1=length(p/r);
  if(k1<1e-5) return -min(r.x,r.y);
  float k2=length(p/(r*r));
  return k1*(k1-1.0)/max(k2,1e-6);
}
float blobShapeSdf(int i, vec2 p){
  vec4 A=uShapeA[i], B=uShapeB[i];
  vec2 local=p-A.xy;
  if(B.x<0.5) return roundedBoxSdf(local,A.zw,min(B.y,min(A.z,A.w)));
  return sdEllipseApprox(local,A.zw);
}
// The article's operators verbatim: h is the normalised overlap of the two
// fields inside the blend band; the quadratic term rounds the seam.
float smoothUnionSdf(float d1,float d2,float k){
  if(k<=0.001) return min(d1,d2);
  float h=max(k-abs(d1-d2),0.0)/k;
  return min(d1,d2)-h*h*k*0.25;
}
float smoothIntersectSdf(float d1,float d2,float k){
  if(k<=0.001) return max(d1,d2);
  float h=max(k-abs(d1-d2),0.0)/k;
  return max(d1,d2)+h*h*k*0.25;
}
float combinedSdf(vec2 p){
  float sd=1e9;
  for(int i=0;i<BLOB_MAX;i++){
    if(i>=uShapeCount) break;
    float di=blobShapeSdf(i,p);
    if(i==0){ sd=di; continue; }
    if(uCombine<0.5)      sd=smoothUnionSdf(sd,di,uSmooth);
    else if(uCombine<1.5) sd=smoothIntersectSdf(sd,di,uSmooth);
    else                  sd=smoothIntersectSdf(sd,-di,uSmooth);
  }
  return sd;
}
`;

/* Blob mask: combined field -> antialiased alpha. */
const MASK_FRAG=`#version 300 es
precision highp float;
in vec2 uv;
out vec4 fragColor;
uniform vec2 resolution;
float roundedBoxSdf(vec2 p, vec2 halfSize, float radius){
  vec2 q=abs(p)-halfSize+radius;
  return length(max(q,0.0))+min(max(q.x,q.y),0.0)-radius;
}
${SDF_CHUNK}
/* Each shape's share of the colour at this pixel. A softmax over the signed
 * distances using the SAME width as the blend, so colour crosses the neck on
 * exactly the geometry smoothUnion builds — that is what makes the join read
 * as one fluid body instead of two stamped shapes. */
float shapeWeight(vec2 p,int idx){
  float k=max(uSmooth,1.0);
  float wsum=0.0, wi=0.0;
  for(int i=0;i<BLOB_MAX;i++){
    if(i>=uShapeCount) break;
    float w=exp(clamp(-blobShapeSdf(i,p)/k,-30.0,30.0));
    wsum+=w;
    if(i==idx) wi=w;
  }
  return wsum>0.0 ? wi/wsum : 0.0;
}
void main(){
  vec2 frag=uv*resolution;
  float a=smoothstep(1.0,-1.0,combinedSdf(frag));
  fragColor=(uWeightIdx<0)
    ? vec4(1.0,1.0,1.0,a)
    : vec4(1.0,1.0,1.0,a*shapeWeight(frag,uWeightIdx));
}
`;

/* Build the liquid-glass fragment source: the locked glass shader with its
 * two field functions replaced. Everything downstream reads the field, so the
 * optics inherit the blob geometry without being edited. */
function buildLiquidFrag(src){
  const replaceFn=(text,signature,body)=>{
    const i=text.indexOf(signature);
    if(i<0) throw new Error('cannot find '+signature);
    let j=text.indexOf('{',i), depth=0, k=j;
    for(;k<text.length;k++){
      if(text[k]==='{') depth++;
      else if(text[k]==='}'){ depth--; if(depth===0){ k++; break; } }
    }
    return text.slice(0,i)+signature+body+text.slice(k);
  };
  // inject where every SDF helper it relies on already exists
  const anchor='float objectSdf(vec2 frag) {';
  const at=src.indexOf(anchor);
  if(at<0) throw new Error('glass source shape changed');
  let out=src.slice(0,at)+SDF_CHUNK+'\n'+src.slice(at);
  out=replaceFn(out,'float objectSdf(vec2 frag)','{ return combinedSdf(frag); }');
  // Field must be 0 deep inside and 1 at the surface, like the original.
  // smoothUnion is C1, so this stays kink-free across merged seams — which is
  // exactly the property the locked optics depend on.
  out=replaceFn(out,'float edgeField(vec2 fragPx)',
    '{ return 1.0 - clamp(-combinedSdf(fragPx)/max(uRefPx,1.0),0.0,1.0); }');
  return out;
}

let gl=null,cv=null,maskProg=null,liquidProg=null,maskLoc=null,liquidLoc=null;
let tex=null,vao=null,failed=false;

const GLASS_UNIFORMS=['backdrop','resolution','objectCenter','objectSize','objectRadius',
  'objectShape','fillA','fillB','hasGlass','depth','refraction','frost','reflection','light',
  'edgeMode','edgeGlow','edgeBlur','edgeBlurOffset','flutes','fluteWidth','fluteAngle',
  'fluteMode','fluteCount','fluteRandom','lightAngle','lightElevation','dispersion','tint',
  'opacity','debugView'];
const BLOB_UNIFORMS=['uShapeCount','uSmooth','uCombine','uRefPx','uWeightIdx'];

function init(){
  if(gl||failed) return !failed;
  try{
    if(!window.GlassEngine||!window.GlassEngine.__frag) throw new Error('glass engine missing');
    cv=document.createElement('canvas');
    gl=cv.getContext('webgl2',{premultipliedAlpha:false,antialias:false});
    if(!gl) throw new Error('WebGL2 unavailable');
    const compile=(t,s)=>{
      const sh=gl.createShader(t); gl.shaderSource(sh,s); gl.compileShader(sh);
      if(!gl.getShaderParameter(sh,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      return sh;
    };
    const link=(fragSrc)=>{
      const p=gl.createProgram();
      gl.attachShader(p,compile(gl.VERTEX_SHADER,window.GlassEngine.__vertex));
      gl.attachShader(p,compile(gl.FRAGMENT_SHADER,fragSrc));
      gl.linkProgram(p);
      if(!gl.getProgramParameter(p,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      return p;
    };
    maskProg=link(MASK_FRAG);
    liquidProg=link(buildLiquidFrag(window.GlassEngine.__frag));

    const locs=(prog,names)=>{
      const o={position:gl.getAttribLocation(prog,'position')};
      names.forEach(n=>o[n]=gl.getUniformLocation(prog,n));
      o.shapeA=gl.getUniformLocation(prog,'uShapeA');
      o.shapeB=gl.getUniformLocation(prog,'uShapeB');
      return o;
    };
    maskLoc=locs(maskProg,['resolution',...BLOB_UNIFORMS]);
    liquidLoc=locs(liquidProg,[...GLASS_UNIFORMS,...BLOB_UNIFORMS]);

    const buf=gl.createBuffer();
    vao=gl.createVertexArray(); gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER,buf);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1, 3,-1, -1,3]),gl.STATIC_DRAW);
    gl.enableVertexAttribArray(maskLoc.position);
    gl.vertexAttribPointer(maskLoc.position,2,gl.FLOAT,false,0,0);
    tex=gl.createTexture();
    return true;
  }catch(e){
    console.warn('blob engine disabled:',e.message);
    failed=true; gl=null;
    return false;
  }
}

/* shapes: [{cx,cy,w,h,ellipse,radius}] in FRAME px, cy y-DOWN (canvas). */
function packShapes(shapes,W,H,loc){
  const n=Math.min(shapes.length,BLOB_MAX);
  const A=new Float32Array(BLOB_MAX*4), B=new Float32Array(BLOB_MAX*4);
  let minDim=1e9;
  for(let i=0;i<n;i++){
    const s=shapes[i];
    A[i*4]=s.cx; A[i*4+1]=H-s.cy; A[i*4+2]=s.w/2; A[i*4+3]=s.h/2;
    B[i*4]=s.ellipse?1:0; B[i*4+1]=s.radius||0;
    minDim=Math.min(minDim,Math.min(s.w,s.h));
  }
  gl.uniform4fv(loc.shapeA,A);
  gl.uniform4fv(loc.shapeB,B);
  gl.uniform1i(loc.uShapeCount,n);
  return {n, refPx:Math.max(4,minDim*0.5)};
}

const hex01=h=>{
  const n=parseInt((h||'#ffffff').slice(1),16);
  return [((n>>16)&255)/255,((n>>8)&255)/255,(n&255)/255];
};
const COMBINE={union:0,intersect:1,difference:2};

/** Alpha mask of the merged shapes. Returns a canvas, or null if unavailable. */
function mask(W,H,shapes,P,weightIdx){
  if(!init()||!shapes.length) return null;
  cv.width=W; cv.height=H;
  gl.viewport(0,0,W,H);
  gl.useProgram(maskProg);
  gl.bindVertexArray(vao);
  gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.uniform2f(maskLoc.resolution,W,H);
  const {refPx}=packShapes(shapes,W,H,maskLoc);
  gl.uniform1f(maskLoc.uSmooth,P.smoothness||0);
  gl.uniform1f(maskLoc.uCombine,COMBINE[P.mode]||0);
  gl.uniform1f(maskLoc.uRefPx,refPx);
  gl.uniform1i(maskLoc.uWeightIdx, weightIdx===undefined?-1:weightIdx);
  gl.drawArrays(gl.TRIANGLES,0,3);
  return cv;
}

/** Liquid glass: merged field + the locked optics, composited onto frameCanvas. */
function liquid(frameCanvas,W,H,shapes,G,P){
  if(!init()||!shapes.length) return false;
  cv.width=W; cv.height=H;
  gl.viewport(0,0,W,H);
  gl.useProgram(liquidProg);
  gl.bindVertexArray(vao);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D,tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,frameCanvas);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.uniform1i(liquidLoc.backdrop,0);
  gl.uniform2f(liquidLoc.resolution,W,H);

  const {refPx}=packShapes(shapes,W,H,liquidLoc);
  gl.uniform1f(liquidLoc.uSmooth,P.smoothness||0);
  gl.uniform1f(liquidLoc.uCombine,COMBINE[P.mode]||0);
  gl.uniform1f(liquidLoc.uRefPx,refPx);
  gl.uniform1i(liquidLoc.uWeightIdx,-1);

  // objectCenter/Size still drive bevelPx() and the fill ramp: use the union's
  // bounding box so edge scale tracks the whole blob, not one member shape.
  let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
  shapes.forEach(s=>{
    x0=Math.min(x0,s.cx-s.w/2); x1=Math.max(x1,s.cx+s.w/2);
    y0=Math.min(y0,s.cy-s.h/2); y1=Math.max(y1,s.cy+s.h/2);
  });
  const bw=Math.max(1,x1-x0), bh=Math.max(1,y1-y0);
  gl.uniform2f(liquidLoc.objectCenter,(x0+bw/2)/W,1-((y0+bh/2)/H));
  gl.uniform2f(liquidLoc.objectSize,bw/W,bh/H);
  gl.uniform1f(liquidLoc.objectRadius,0.2);
  gl.uniform1f(liquidLoc.objectShape,0);

  gl.uniform3f(liquidLoc.fillA,0.9,0.9,0.9);
  gl.uniform3f(liquidLoc.fillB,0.7,0.7,0.7);
  gl.uniform1f(liquidLoc.hasGlass,1);
  gl.uniform1f(liquidLoc.edgeMode,0);
  gl.uniform1f(liquidLoc.edgeGlow,G.edgeGlow||0);
  gl.uniform1f(liquidLoc.edgeBlur,20);
  gl.uniform1f(liquidLoc.edgeBlurOffset,0);
  gl.uniform1f(liquidLoc.flutes,0);
  gl.uniform1f(liquidLoc.fluteWidth,26);
  gl.uniform1f(liquidLoc.fluteAngle,0);
  gl.uniform1f(liquidLoc.fluteMode,0);
  gl.uniform1f(liquidLoc.fluteCount,10);
  gl.uniform1f(liquidLoc.fluteRandom,0);
  gl.uniform1f(liquidLoc.lightAngle,45);
  gl.uniform1f(liquidLoc.lightElevation,30);
  gl.uniform1f(liquidLoc.debugView,0);

  gl.uniform1f(liquidLoc.depth,G.depth);
  gl.uniform1f(liquidLoc.refraction,G.refraction);
  gl.uniform1f(liquidLoc.frost,G.frost);
  gl.uniform1f(liquidLoc.reflection,G.reflection);
  gl.uniform1f(liquidLoc.light,G.light);
  gl.uniform1f(liquidLoc.dispersion,G.dispersion);
  const t=hex01(G.tint);
  gl.uniform3f(liquidLoc.tint,t[0],t[1],t[2]);
  gl.uniform1f(liquidLoc.opacity,G.opacity);

  gl.drawArrays(gl.TRIANGLES,0,3);
  const c2=frameCanvas.getContext('2d');
  c2.save();
  c2.setTransform(1,0,0,1,0,0);
  c2.globalAlpha=1; c2.globalCompositeOperation='source-over';
  c2.drawImage(cv,0,0,W,H);
  c2.restore();
  return true;
}

window.BlobEngine={mask,liquid,available:()=>init(),MAX:BLOB_MAX};
})();
