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

  /* PER-NODE CHANNELS.
   *
   * A control point stops being {x, y, colour} and starts carrying its own
   * parameters, interpolated across the surface by the SAME bicubic machinery
   * that already carries colour. That is the whole idea: a value set on one
   * node fades into its neighbourhood instead of applying to the shape as a
   * whole, so "blur this corner" and "make that node metallic" are things the
   * net itself can express rather than effects stacked on top of it.
   *
   * Eight channels ride in two RGBA textures beside the colour texture. The
   * order below is the order the PANEL shows them in and nothing more — the
   * upload in render() names every channel explicitly, so this array can be
   * arranged for the reader rather than for the GPU. (An earlier note here
   * claimed the order was the channel layout. It was not, and a comment that
   * overstates a constraint costs someone a wasted hour later.)
   *
   * Every default is a no-op: a net that has never been touched here renders
   * exactly as it did before the channels existed. That is what makes this
   * safe to add to documents already saved. */
  const NODE_FX = [
    { key: "noise", label: "Noise", def: 0 },
    // grain size in pixels, 0 -> a single pixel, which is what the per-pixel
    // hash did before there was a control for it
    /* 1..16 DOCUMENT pixels, and the direction is the one that reads: up is
     * coarser. It was briefly capped at 6 because coarse grain looked like
     * pixelation — but that was the tile being rendered at document size and
     * then magnified, which is fixed, and capping the control was treating a
     * symptom by removing the feature. Sixteen document pixels is chunky
     * particulate grain at 1:1, which is what the range is for. */
    { key: "noiseSize", label: "Noise size", def: 0 },
    /* Pushes the grain distribution toward its extremes without touching its
     * amplitude: at 0 it stays the soft normal curve that grain3 produces, and
     * upward it thins the mid-values so the speckle reads as distinct
     * particles rather than as a haze. Amount is how much, size is how big,
     * this is how HARD. */
    { key: "noiseContrast", label: "Noise contrast", def: 0 },
    /* 0 is monochrome — one signed value on all three channels, grain that
     * does not tint — and 1 is independent per channel, the colour speckle a
     * sensor makes. The same choice Photoshop puts behind its "Monochromatic"
     * box, as a blend rather than a switch because every channel here is
     * interpolated across the net. Default 0 keeps what the mesh already did. */
    { key: "noiseColour", label: "Noise colour", def: 0 },
    { key: "blur", label: "Blur", def: 0 },
    { key: "falloff", label: "Falloff", def: 0.5 },
    { key: "smooth", label: "Smoothness", def: 1 },
    { key: "chromatic", label: "Chromatic", def: 0 },
    { key: "metallic", label: "Metallic", def: 0 },
    { key: "glow", label: "Glow", def: 0 },
  ];
  const FX_KEYS = NODE_FX.map((f) => f.key);
  const FX_DEF = {};
  NODE_FX.forEach((f) => (FX_DEF[f.key] = f.def));
  /** A channel off a point, falling back to its no-op default. Points arrive
   *  from saved files and from the model, and neither is obliged to carry
   *  channels it never set. */
  const fxOf = (p, k) => {
    const v = +(p && p[k]);
    return Number.isFinite(v) ? v : FX_DEF[k];
  };

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
uniform sampler2D uFx1;                  // noise, blur, falloff, smoothness
uniform sampler2D uFx2;                  // chromatic, metallic, glow, noiseSize
uniform sampler2D uFx3;                  // noiseContrast, -, -, -
uniform vec2 uGrid;
uniform vec2 uSize;                      // tile pixels: the blur steps grain in screen space
/* Tile pixels per DOCUMENT pixel. The tile is rendered at whatever resolution
 * the current zoom needs, so anything measured in pixels has to be scaled by
 * this or it changes size as you zoom — grain most of all. */
uniform float uScale;
/* Edge feather: x is the fade width in uv (0 disables it), y the taper
 * exponent. */
uniform vec3 uEdge;   // width (doc px), taper exponent, softness
/* x: how far the tile is grown OUTSIDE the shape, in document pixels.
 * y, z: how much of the fade lies inside the boundary and how much outside. */
uniform vec3 uBand;
out vec4 fragColor;
vec4 cr(vec4 p0,vec4 p1,vec4 p2,vec4 p3,float t){
  float t2=t*t,t3=t2*t;
  return 0.5*((2.0*p1)+(-p0+p2)*t+(2.0*p0-5.0*p1+4.0*p2-p3)*t2+(-p0+3.0*p1-3.0*p2+p3)*t3);
}
int cl(int v,int lo,int hi){ return v<lo?lo:(v>hi?hi:v); }
/* The reflecting fetch, now taking the sampler as a parameter: colour and the
 * two channel textures share one net, so they share its edge behaviour too. */
vec4 rowT(sampler2D T,int r,int c){
  int mx=int(uGrid.x)-1;
  if(c>=0&&c<=mx) return texelFetch(T,ivec2(c,r),0);
  if(c<0) return 2.0*texelFetch(T,ivec2(0,r),0)-texelFetch(T,ivec2(1,r),0);
  return 2.0*texelFetch(T,ivec2(mx,r),0)-texelFetch(T,ivec2(mx-1,r),0);
}
vec4 fetchT(sampler2D T,int r,int c){
  int my=int(uGrid.y)-1;
  if(r>=0&&r<=my) return rowT(T,r,c);
  if(r<0) return 2.0*rowT(T,0,c)-rowT(T,1,c);
  return 2.0*rowT(T,my,c)-rowT(T,my-1,c);
}
/* CHANNELS CLAMP AT THE EDGE, COLOUR REFLECTS. Not an inconsistency — the two
 * are answering different questions beyond the boundary.
 *
 * Reflection continues the colour's SLOPE outward, which is what keeps a
 * uniform grid uniform and stops the corners flattening. Applied to a channel
 * it does the opposite of what is wanted: a corner node set to 1 beside a
 * neighbour at 0 extrapolates to 2 outside, the falloff aims at zero, and only
 * the inward quarter of the node's basis is ever on screen. Measured on a 4x4:
 * a corner node landed 74k of effect against an interior node's 616k, with its
 * centre of mass dragged a fifth of the way inside. The effect visibly refused
 * to touch the edges.
 *
 * Clamping asks instead "what does this node say out there", and the answer is
 * what it says everywhere: itself. A node's setting then reaches the edge it
 * sits on. */
vec4 rowC(sampler2D T,int r,int c){
  return texelFetch(T,ivec2(cl(c,0,int(uGrid.x)-1),r),0);
}
vec4 fetchC(sampler2D T,int r,int c){
  return rowC(T,cl(r,0,int(uGrid.y)-1),c);
}
vec4 patch4(sampler2D T,vec2 uv){
  float fx=uv.x*(uGrid.x-1.0), fy=uv.y*(uGrid.y-1.0);
  int ci=cl(int(floor(fx)),0,int(uGrid.x)-2), ri=cl(int(floor(fy)),0,int(uGrid.y)-2);
  float tu=clamp(fx-float(ci),0.0,1.0), tv=clamp(fy-float(ri),0.0,1.0);
  vec4 rv[4];
  for(int j=0;j<4;j++){
    int r=ri+j-1;
    rv[j]=cr(fetchC(T,r,ci-1),fetchC(T,r,ci),fetchC(T,r,ci+1),fetchC(T,r,ci+2),tu);
  }
  return cr(rv[0],rv[1],rv[2],rv[3],tv);
}
/* FALLOFF reshapes WHERE inside a cell the handover happens, symmetrically
 * about the midpoint — so the surface still passes exactly through every
 * control point, which is the property that makes this a mesh and not a blob
 * field. Above 0.5 the colour holds near its node and gives way late; below,
 * it spreads early. */
float shape(float t,float g){
  return t<0.5 ? 0.5*pow(max(2.0*t,0.0),g) : 1.0-0.5*pow(max(2.0*(1.0-t),0.0),g);
}
vec3 colourAt(vec2 uv,float fall,float smth){
  float fx=uv.x*(uGrid.x-1.0), fy=uv.y*(uGrid.y-1.0);
  int ci=cl(int(floor(fx)),0,int(uGrid.x)-2), ri=cl(int(floor(fy)),0,int(uGrid.y)-2);
  float tu=clamp(fx-float(ci),0.0,1.0), tv=clamp(fy-float(ri),0.0,1.0);
  float g=pow(2.0,(fall-0.5)*4.0);
  tu=shape(tu,g); tv=shape(tv,g);
  vec4 rv[4];
  for(int j=0;j<4;j++){
    int r=ri+j-1;
    rv[j]=cr(fetchT(uCol,r,ci-1),fetchT(uCol,r,ci),fetchT(uCol,r,ci+1),fetchT(uCol,r,ci+2),tu);
  }
  vec3 bic=cr(rv[0],rv[1],rv[2],rv[3],tv).rgb;
  /* SMOOTHNESS blends the C1 surface toward the C0 one. At 0 the cells meet
   * with a visible crease — a facet, which is a look and not a fault; the
   * default of 1 is the bicubic surface everything else here is built on. */
  vec3 a=mix(fetchT(uCol,ri,ci).rgb,   fetchT(uCol,ri,ci+1).rgb,   tu);
  vec3 b=mix(fetchT(uCol,ri+1,ci).rgb, fetchT(uCol,ri+1,ci+1).rgb, tu);
  return mix(mix(a,b,tv),bic,smth);
}
/* Declared here, defined below. Blur has to average the FINISHED material, so
 * it calls these before the file gets to them; a prototype says so without
 * shuffling the definitions into an order that reads worse. */
vec3 metalAt(vec3 c,float m);
vec3 glowAt(vec3 c,float g);
/* Keyed off the fragment, so a tile of a given size is identical every time it
 * is rendered — the same reason the pixel-slot noise carries a seed. */
float hash21(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453123); }
/* Signed and roughly NORMAL, matching the pixel-slot grain: film grain and
 * sensor noise both cluster near zero and only rarely swing wide, which is
 * what stops grain reading as digital speckle. Three hashes summed is
 * Irwin-Hall n=3, sigma 0.5 over [-1.5, 1.5]. */
float grain3(vec2 p){
  return hash21(p)+hash21(p+vec2(17.3,7.1))+hash21(p+vec2(3.7,29.1))-1.5;
}
/* One node's channels, passed whole. Blur has to re-evaluate every one of
 * them per tap, so they travel together rather than as eight arguments. */
struct Node { float fall; float smth; float metl; float glw; float nAmt; float nsz; float ncol; float ncon; };
/* ORDER MATTERS, AND IT WAS WRONG. Blur used to run on the bare colour with
 * everything else painted on top of it, which made the control very nearly
 * inert: a mesh surface is locally near-LINEAR, and blurring a linear ramp
 * returns the same ramp. Measured with blur at 93%, the sharpest edge beside a
 * node did not move at all — 1.7 before and after on plain colour, 1.3 either
 * way across a smoothness crease, 3.3 either way through metallic banding,
 * whose hard contours blur never saw because they were added afterwards.
 *
 * The hard edges on a mesh are never the gradient itself; they are the
 * FEATURES — metallic's banding, a crease, chromatic fringing. Blur now
 * averages the finished material, which is the only arrangement in which it
 * softens anything at all.
 *
 * Noise stays outside it deliberately: in the layered reading this engine is
 * built around, grain is the layer ON TOP of the blur, and blurring it back
 * into mush would undo the layer above.
 *
 * Cost: metallic and glow are evaluated once per tap rather than once per
 * fragment. The tile is cached, so that is paid on edit, not per frame. */
vec3 materialAt(vec2 uv,Node n){
  vec3 c=colourAt(uv,n.fall,n.smth);
  c=metalAt(c,n.metl);
  return glowAt(c,n.glw);
}
/* GRAIN IS INSIDE THE BLUR, and that is the whole reason Blur does anything.
 *
 * It used to sit after it, on the argument that grain is the layer above the
 * blur. True of the object pipeline; fatal here. A mesh is locally LINEAR, and
 * a blur of a linear ramp is the same ramp — so with grain excluded, blur had
 * literally nothing left to act on. Measured at 100% on one node it moved the
 * image by 0.41 of 255, and 0.05 on a corner node. A control that does nothing
 * is not a defensible layer order.
 *
 * The offset is in PIXELS, not parameter space, so the grain stays a constant
 * size on screen instead of stretching with the warp. */
vec3 sampleAt(vec2 uv,vec2 pxOff,Node n){
  vec3 c=materialAt(uv,n);
  if(n.nAmt>0.001){
    float sz=max(1.0,mix(1.0,16.0,n.nsz)*uScale);
    vec2 cell=floor((gl_FragCoord.xy+pxOff)/sz);
    /* One draw for monochrome, three for colour, blended — so the grain can
     * be grey in one part of the net and speckled in another, which is what
     * every other channel here already does. */
    vec3 gv=mix(vec3(grain3(cell)),
                vec3(grain3(cell),grain3(cell+vec2(101.0,7.0)),grain3(cell+vec2(31.0,191.0))),
                n.ncol);
    /* Contrast thins the MIDS: an exponent below 1 on the normalised magnitude
     * pushes values away from zero, so the speckle reads as distinct particles
     * instead of a haze. Measured, the share of near-zero samples falls from
     * 0.353 to 0.007 across the range.
     *
     * It raises sigma as it does so — 23.9 to 45.8 — because that is what
     * moving values off zero means. The peak amplitude is unchanged and the
     * mean stays at zero; what changes is how the samples are spread inside
     * that range. Amount still sets the range. */
    if(n.ncon>0.001){
      float e=mix(1.0,0.32,n.ncon);
      gv=sign(gv)*pow(abs(gv)/1.5,vec3(e))*1.5;
    }
    c+=gv*n.nAmt*0.314;
  }
  return c;
}
/* A real blur, not a softening trick: the surface is analytic, so averaging it
 * over a disc IS blurring it. Twelve taps on a golden-angle spiral, which
 * spreads evenly without the banding a square kernel leaves. */
vec3 blurAt(vec2 uv,Node n,float rad){
  vec3 s=sampleAt(uv,vec2(0.0),n);
  if(rad<=0.0005) return s;
  /* 20 taps on a FIXED golden-angle spiral. It was briefly rotated per
   * fragment — the usual stochastic-kernel trade — to chase concentric rings
   * around a blurred node. The rings turned out to be moire between coarse
   * grain and a downscaled screenshot, present in no render at all, and the
   * rotation cost real quality to fix nothing: neighbouring fragments then
   * averaged different sample sets, and the sharpest step near a node rose
   * from 1.7 to 3.3. A deterministic kernel measures better here, so the
   * jitter is gone and the reason is written down. */
  for(int i=0;i<20;i++){
    float a=float(i)*2.39996323;
    float rr=rad*sqrt((float(i)+0.5)/20.0);
    vec2 o=vec2(cos(a),sin(a))*rr;
    s+=sampleAt(uv+o,o*uSize,n);
  }
  return s/21.0;
}
/* CHROMATIC splits red and blue along the radius, growing toward the edges the
 * way a lens does rather than uniformly, which would read as a print
 * misregistration instead of glass. */
vec3 chromAt(vec2 uv,Node n,float rad,float amt){
  vec3 c=blurAt(uv,n,rad);
  if(amt<=0.001) return c;
  vec2 d=uv-vec2(0.5);
  float L=length(d);
  vec2 dir=L>1e-5?d/L:vec2(0.0);
  float o=amt*0.10*L;
  return vec3(blurAt(uv+dir*o,n,rad).r, c.g, blurAt(uv-dir*o,n,rad).b);
}
/* METALLIC desaturates toward luminance and rakes a periodic highlight across
 * the tonal range — metal reads as metal because its specular response is
 * narrow and its hue is weak, not because it is grey.
 *
 * REVERTED to this from a version that swept once with a specular shoulder.
 * That rewrite was made to kill concentric rings around a blurred node, and
 * those rings were moire between coarse grain and a downscaled screenshot —
 * they were in no render. It was kept anyway because it measured better on
 * edge sharpness, which is the mistake: one metric was checked and the other
 * was not. Against this version it cost 23% of the saturation on a green net
 * (0.333 -> 0.257), which is metal bleaching the colour out of the mesh. Do
 * not swap this back without measuring SATURATION as well as sharpness. */
vec3 metalAt(vec3 c,float m){
  if(m<=0.001) return c;
  float l=dot(c,vec3(0.2126,0.7152,0.0722));
  float band=0.5+0.5*sin(l*25.13274);
  /* The +0.10 floor is the difference between a control and a control that
   * works. Purely multiplying by the colour meant a node sitting in a dark
   * part of the net rendered its own setting as nothing: metal has to catch
   * SOME light or it is just paint. */
  vec3 met=mix(c,vec3(l),0.5)*(0.72+0.56*band)+vec3(0.10*band*m);
  return mix(c,clamp(met,0.0,1.0),m);
}
/* GLOW lifts by luminance, so a bright node blooms and a dark one stays put
 * rather than turning grey. */
vec3 glowAt(vec3 c,float g){
  if(g<=0.001) return c;
  float l=dot(c,vec3(0.2126,0.7152,0.0722));
  /* Weighted toward the colour so a bright node blooms hardest, but with a
   * floor, because c*g alone is exactly zero at black — a glow set to 92% on
   * a dark node did nothing at all, which is indistinguishable from the
   * slider being broken. */
  return c+(c*0.72+vec3(0.28))*g*(0.35+0.65*l);
}
/* EDGE FEATHER. A hard-edged rectangle of gradient reads as a sticker on the
 * page; softening the boundary is how a mesh is made to sit in a composition
 * rather than on top of one.
 *
 * TAPER is the shape of that fade, not its width. Below 0.5 the fade starts
 * early and trails off — a long, gentle vignette. Above, the fill holds opaque
 * and then leaves quickly, which is what an out-of-focus edge actually does.
 * A linear ramp, at 0.5, is the one profile that looks like neither. */
/* MEASURED IN DOCUMENT PIXELS, not in uv. A uv distance is not a distance:
 * on a 900x300 shape the same uv step is three times further across than it
 * is down, so a feather specified in uv would be visibly thicker on the short
 * sides. Working in document units makes the band the same width all the way
 * round, which is the only thing that reads as a feather. */
float edgeAlpha(vec2 pd,vec2 ext){
  float inW=uBand.y, outW=uBand.z;
  if(inW+outW<=0.0005) return 1.0;
  float m=uBand.x;
  // signed distance to the ORIGINAL boundary: positive inside, negative out
  float dx=min(pd.x-m,(ext.x-m)-pd.x);
  float dy=min(pd.y-m,(ext.y-m)-pd.y);
  float t=clamp((min(dx,dy)+outW)/(inW+outW),0.0,1.0);
  /* SOFTNESS is the CURVE of the fade, where width is its extent and taper is
   * its bias. A raw ramp has corners at both ends — it arrives at full opacity
   * abruptly, which is visible as a faint contour line however wide the band
   * is. smoothstep removes both corners; blending toward it is what makes the
   * fade read as gentle rather than merely long. */
  float ramp=mix(t,t*t*(3.0-2.0*t),uEdge.z);
  return pow(ramp,uEdge.y);
}
void main(){
  /* The tile may be GROWN beyond the shape so an outward feather has somewhere
   * to land. The colour field still belongs to the shape, so it is addressed
   * through cuv — the original box remapped into the grown tile — and the skirt
   * outside it takes the edge colour, since the surface clamps past its own
   * net. Without this the whole gradient would stretch the moment a feather
   * was turned on, which is a change to the artwork rather than to its edge. */
  vec2 ext=uSize/max(uScale,1e-4);
  vec2 pd=vUV*ext;
  vec2 inner=max(ext-2.0*uBand.x,vec2(1e-4));
  vec2 cuv=(pd-vec2(uBand.x))/inner;
  vec4 f1=patch4(uFx1,cuv);
  vec4 f2=patch4(uFx2,cuv);
  /* Catmull-Rom overshoots between control values, so every channel is
   * clamped after interpolation: a node at 0 beside a node at 1 would
   * otherwise dip below zero and take pow() with it. */
  float nAmt=clamp(f1.r,0.0,1.0), bAmt=clamp(f1.g,0.0,1.0);
  float fall=clamp(f1.b,0.0,1.0), smth=clamp(f1.a,0.0,1.0);
  float chrm=clamp(f2.r,0.0,1.0), metl=clamp(f2.g,0.0,1.0), glw=clamp(f2.b,0.0,1.0);
  float nsz=clamp(f2.a,0.0,1.0);
  /* Grain size is in whole PIXELS, so the speckle is square and stable rather
   * than resampled. At 0 the block is one pixel. */
  // the ninth channel rides in the colour texture's otherwise unused alpha
  float ncol=clamp(patch4(uCol,cuv).a,0.0,1.0);
  float ncon=clamp(patch4(uFx3,cuv).r,0.0,1.0);
  Node n=Node(fall,smth,metl,glw,nAmt,nsz,ncol,ncon);
  vec3 c=chromAt(cuv,n,bAmt*0.18,chrm);
  /* Straight alpha, not premultiplied — the context is created with
   * premultipliedAlpha:false, so the colour must NOT be scaled by it here. */
  fragColor=vec4(clamp(c,0.0,1.0),edgeAlpha(pd,ext));
}`;

  /* uGrid travels as a vec2 rather than an ivec2 because `highp int` is not
   * honoured in the fragment stage on every GPU: the two stages then disagree
   * on the precision of a shared uniform and the program refuses to link. */

  let fx1Tex = null,
    fx2Tex = null,
    fx3Tex = null;
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
        fx1: gl.getUniformLocation(prog, "uFx1"),
        fx2: gl.getUniformLocation(prog, "uFx2"),
        grid: gl.getUniformLocation(prog, "uGrid"),
        scale: gl.getUniformLocation(prog, "uScale"),
        edge: gl.getUniformLocation(prog, "uEdge"),
        band: gl.getUniformLocation(prog, "uBand"),
        fx3: gl.getUniformLocation(prog, "uFx3"),
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
      fx1Tex = mk(2);
      fx2Tex = mk(3);
      fx3Tex = mk(4);
      gl.uniform1i(U.pos, 0);
      gl.uniform1i(U.col, 1);
      gl.uniform1i(U.fx1, 2);
      gl.uniform1i(U.fx2, 3);
      gl.uniform1i(U.fx3, 4);
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
          ...FX_DEF,
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
  const clampf = (v, lo, hi) => (!Number.isFinite(v) ? lo : v < lo ? lo : v > hi ? hi : v);
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
    /* The channels ride along through every step below rather than being
     * bolted on at the end. resample() IS evalAt at new parameters, so a net
     * resized from 4x4 to 6x6 keeps its per-node work only if the surface
     * being resampled includes it — otherwise adding a row silently wipes
     * every channel on the net. */
    const ext = (a, b) => {
      const o = {
        x: 2 * a.x - b.x,
        y: 2 * a.y - b.y,
        color: [0, 1, 2].map((k) => 2 * a.color[k] - b.color[k]),
      };
      /* Geometry and colour REFLECT; channels CLAMP — `a` is the edge value,
       * and taking it unchanged is the clamp. The shader draws them the same
       * two ways for the reason given beside its fetchC, and this is the CPU
       * half of that surface: resample() is evalAt at new parameters, so if
       * the two disagreed, resizing a net would move channels the shader had
       * drawn somewhere else. */
      for (const k of FX_KEYS) o[k] = fxOf(a, k);
      return o;
    };
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
      const row = {
        x: catmull(a.x, b.x, c2.x, d.x, tu),
        y: catmull(a.y, b.y, c2.y, d.y, tu),
        color: [0, 1, 2].map((k) => catmull(a.color[k], b.color[k], c2.color[k], d.color[k], tu)),
      };
      for (const k of FX_KEYS)
        row[k] = catmull(fxOf(a, k), fxOf(b, k), fxOf(c2, k), fxOf(d, k), tu);
      rv.push(row);
    }
    const out = {
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
    for (const k of FX_KEYS)
      out[k] = clampf(catmull(rv[0][k], rv[1][k], rv[2][k], rv[3][k], tv), 0, 1);
    return out;
  }

  /** Sample a whole net curve at once — a row (along "u") or a column ("v").
   *
   * WHY THIS EXISTS RATHER THAN A LOOP OVER evalAt. The overlay needs hundreds
   * of points per curve to stay smooth when zoomed, and evalAt re-derives the
   * entire bicubic for every one of them: 512 points across the eight curves
   * of a 4x4 net measured 32.3ms per frame, which is a third of a second of
   * stutter for every drag.
   *
   * For a curve, one parameter is FIXED. Collapsing that axis first turns the
   * 4x4 net into a 1D control polygon — paid once — after which each sample is
   * a single Catmull-Rom rather than twenty. Same curve, same points, about a
   * twentieth of the work.
   *
   * Returns a flat [x0,y0,x1,y1,...] in the net's own 0..1 space. */
  function sampleCurve(P, cols, rows, along, at, steps) {
    const n = Math.max(2, steps | 0);
    const horiz = along !== "v";
    const nMaj = horiz ? cols : rows; // the axis being walked
    const nMin = horiz ? rows : cols; // the axis being collapsed
    /* Index by (major, minor) so one body serves both directions; the net
     * itself is always stored row-major. */
    const cell = (maj, min) => (horiz ? P[min * cols + maj] : P[maj * cols + min]);
    const ext = (a, b) => ({ x: 2 * a.x - b.x, y: 2 * a.y - b.y });
    const inMin = (maj, min) =>
      min >= 0 && min <= nMin - 1
        ? cell(clampi(maj, 0, nMaj - 1), min)
        : min < 0
          ? ext(cell(clampi(maj, 0, nMaj - 1), 0), cell(clampi(maj, 0, nMaj - 1), 1))
          : ext(cell(clampi(maj, 0, nMaj - 1), nMin - 1), cell(clampi(maj, 0, nMaj - 1), nMin - 2));
    const get = (maj, min) => {
      if (maj >= 0 && maj <= nMaj - 1) return inMin(maj, min);
      const e = maj < 0 ? [0, 1] : [nMaj - 1, nMaj - 2];
      const a = inMin(e[0], min),
        b = inMin(e[1], min);
      return ext(a, b);
    };

    // collapse the fixed axis into a control polygon spanning -1 .. nMaj
    const f = at * (nMin - 1);
    const mi = clampi(Math.floor(f), 0, nMin - 2);
    const tm = f - mi;
    const poly = [];
    for (let k = -1; k <= nMaj; k++) {
      const a = get(k, mi - 1),
        b = get(k, mi),
        c = get(k, mi + 1),
        d = get(k, mi + 2);
      poly.push({
        x: catmull(a.x, b.x, c.x, d.x, tm),
        y: catmull(a.y, b.y, c.y, d.y, tm),
      });
    }

    const out = new Float32Array((n + 1) * 2);
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const fx = u * (nMaj - 1);
      const ci = clampi(Math.floor(fx), 0, nMaj - 2);
      const tu = fx - ci;
      const p0 = poly[ci],
        p1 = poly[ci + 1],
        p2 = poly[ci + 2],
        p3 = poly[ci + 3];
      out[i * 2] = catmull(p0.x, p1.x, p2.x, p3.x, tu);
      out[i * 2 + 1] = catmull(p0.y, p1.y, p2.y, p3.y, tu);
    }
    return out;
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
      Col = new Float32Array(cols * rows * 4),
      Fx1 = new Float32Array(cols * rows * 4),
      Fx2 = new Float32Array(cols * rows * 4),
      Fx3 = new Float32Array(cols * rows * 4);
    for (let i = 0; i < cols * rows; i++) {
      const p = pts[i];
      // normalised 0..1 -> the shape's own box
      Pos[i * 4] = p.x * W;
      Pos[i * 4 + 1] = p.y * H;
      Pos[i * 4 + 3] = 1;
      Col[i * 4] = p.color[0] / 255;
      Col[i * 4 + 1] = p.color[1] / 255;
      Col[i * 4 + 2] = p.color[2] / 255;
      /* The surface reads uCol.rgb and writes alpha 1, so this channel was
       * dead weight. Carrying noiseColour here avoids a third channel texture
       * for one scalar. */
      Col[i * 4 + 3] = fxOf(p, "noiseColour");
      // THIS is the channel layout — named, not positional, so NODE_FX can be
      // ordered for the panel. uFx1 is (noise, blur, falloff, smooth) and
      // uFx2 (chromatic, metallic, glow, noiseSize); the shader reads them in
      // exactly that order.
      Fx1[i * 4] = fxOf(p, "noise");
      Fx1[i * 4 + 1] = fxOf(p, "blur");
      Fx1[i * 4 + 2] = fxOf(p, "falloff");
      Fx1[i * 4 + 3] = fxOf(p, "smooth");
      Fx2[i * 4] = fxOf(p, "chromatic");
      Fx2[i * 4 + 1] = fxOf(p, "metallic");
      Fx2[i * 4 + 2] = fxOf(p, "glow");
      Fx2[i * 4 + 3] = fxOf(p, "noiseSize");
      Fx3[i * 4] = fxOf(p, "noiseContrast");
    }
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, posTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, cols, rows, 0, gl.RGBA, gl.FLOAT, Pos);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, colTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, cols, rows, 0, gl.RGBA, gl.FLOAT, Col);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, fx1Tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, cols, rows, 0, gl.RGBA, gl.FLOAT, Fx1);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, fx2Tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, cols, rows, 0, gl.RGBA, gl.FLOAT, Fx2);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, fx3Tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, cols, rows, 0, gl.RGBA, gl.FLOAT, Fx3);
    gl.uniform2f(U.grid, cols, rows);
    gl.uniform2f(U.size, cv.width, cv.height);
    gl.uniform1f(U.scale, Math.max(0.05, +P.scale || 1));
    /* Half the shorter side is the widest a feather can be before the two
     * sides meet in the middle and the fill has no opaque core left. Taper
     * rides an exponential so 0.5 is exactly linear. */
    const taper = Math.pow(2, (clampf(+P.taper, 0, 1) - 0.5) * 4);
    const soft = clampf(+P.softness, 0, 1);
    gl.uniform3f(U.edge, 0, taper, soft);
    /* The caller has already grown the tile by `margin`, because only it knows
     * the shape's clip; the split between inward and outward comes with it. */
    gl.uniform3f(
      U.band,
      Math.max(0, +P.margin || 0),
      Math.max(0, +P.inWidth || 0),
      Math.max(0, +P.outWidth || 0),
    );
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
    /* Geometry fitting is ON, and the history is worth keeping because it is
     * the same lesson twice.
     *
     * First attempt: snap each interior point to the nearest strong colour
     * edge. Measured, it made things worse at every grid above the coarsest,
     * so it was turned off. Second attempt: coordinate descent on real
     * reconstruction error — right idea, still worse, because it ran BEFORE
     * the colours were fitted and so minimised error against a net whose
     * colours were still a first guess. 6x6 went from 11.5 to 19.3.
     *
     * Both failures were the same mistake in different clothes: optimising
     * something other than the thing that matters. Correcting colours first,
     * then moving points against the true rendered error, then correcting the
     * colours again for the net's new shape, improves every size measured —
     * 4x4 17.9 to 14.9, 5x5 10.5 to 8.2, 6x6 11.5 to 8.4. It costs about half
     * a second, which is a fit-once operation, not a per-frame one. */
    const moveGeometry = opts.moveGeometry !== false;
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

    /* --- 2/3. colour and geometry, ALTERNATED -------------------------
     *
     * These two are coupled, and the order is the whole difference between a
     * fit that improves and one that degrades. Twice now I moved the points
     * first: the optimiser then measures error against colours that have not
     * been fitted yet, so it is minimising the wrong quantity. The tell was
     * that every point travelled the maximum offset in one direction every
     * round — a search walking downhill on a surface that was not the one it
     * cared about. Measured, that made a 6x6 fit go from 11.5 to 19.3.
     *
     * So: correct the colours, THEN ask whether moving a point helps, then
     * correct the colours again for the net's new shape. A move is kept only
     * when the rendered result genuinely improves, which is a measurement
     * rather than a heuristic about where edges are.
     */
    const correctColours = (P, passes2) => {
      const acc = new Float64Array(cols * rows * 3),
        wsum = new Float64Array(cols * rows);
      for (let pass = 0; pass < passes2; pass++) {
        const tile = render(W, H, { cols, rows, points: P });
        if (!tile) break;
        const cur = tile
          .getContext("2d", { willReadFrequently: true })
          .getImageData(0, 0, W, H).data;
        acc.fill(0);
        wsum.fill(0);
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
        /* Under-relaxed: neighbouring influences overlap, so a full correction
         * overshoots and the net oscillates instead of settling. */
        for (let k = 0; k < cols * rows; k++) {
          if (wsum[k] <= 0) continue;
          for (let ch = 0; ch < 3; ch++)
            P[k].color[ch] = clampi(P[k].color[ch] + (acc[k * 3 + ch] / wsum[k]) * 0.7, 0, 255);
        }
      }
      return P;
    };

    /** True reconstruction error, at a reduced resolution for search speed. */
    const errorOf = (P, res) => {
      const t = render(res, res, { cols, rows, points: P });
      if (!t) return Infinity;
      const cur = t
        .getContext("2d", { willReadFrequently: true })
        .getImageData(0, 0, res, res).data;
      // the target at FIT_RES is resampled by index; res divides it evenly
      const k = W / res;
      let sum = 0;
      for (let y = 0; y < res; y += 2)
        for (let x = 0; x < res; x += 2) {
          const i = (y * res + x) * 4;
          const j = (Math.round(y * k) * W + Math.round(x * k)) * 4;
          sum +=
            Math.abs(target[j] - cur[i]) +
            Math.abs(target[j + 1] - cur[i + 1]) +
            Math.abs(target[j + 2] - cur[i + 2]);
        }
      return sum;
    };

    correctColours(pts, passes);

    if (moveGeometry && cols > 2 && rows > 2) {
      const RES = 80;
      let best = errorOf(pts, RES);
      for (const step of [0.07, 0.035]) {
        for (let r = 1; r < rows - 1; r++)
          for (let c = 1; c < cols - 1; c++) {
            const i = r * cols + c,
              p = pts[i];
            const ox = p.x,
              oy = p.y;
            let bx = ox,
              by = oy,
              bv = best;
            for (const [dx, dy] of [
              [step, 0],
              [-step, 0],
              [0, step],
              [0, -step],
            ]) {
              p.x = clampi(ox + dx, 0.08, 0.92);
              p.y = clampi(oy + dy, 0.08, 0.92);
              const v = errorOf(pts, RES);
              if (v < bv) {
                bv = v;
                bx = p.x;
                by = p.y;
              }
            }
            p.x = bx;
            p.y = by;
            best = bv;
          }
        // the net changed shape, so the colours that suited the old one no longer do
        correctColours(pts, 6);
        best = errorOf(pts, RES);
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
    sampleCurve,
    NODE_FX,
    defaultPoints,
    fitToImage,
    fitError,
    MIN_N,
    MAX_N,
    PALETTE,
    available: () => init(),
  };
})();
