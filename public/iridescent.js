/* Iridescence — a thin-film / dispersive material for a shape (§ material).
 *
 * PROVENANCE. The fragment shader is the one from Chromaform
 * (iridescent-effect.html, kept in the author's execution-agent folder),
 * carried across with three changes, each marked at its site in the GLSL:
 *
 *   - the page owned a whole viewport and painted an opaque background; a
 *     layer's tile is composited over artwork, so the silhouette's coverage
 *     is now the ALPHA and everything outside it is transparent;
 *   - the glow carries its own alpha rather than being added to a background;
 *   - `shape` is driven by the LAYER's type, so the shader's own silhouette
 *     agrees with the path the editor clips the tile to.
 *
 * The reeded-glass block (stripEnabled and its six parameters) is compiled but
 * never switched on: it is a separate glass effect that happened to share the
 * page, and shipping it would put seven more controls behind a switch for
 * something that is not iridescence. The uniforms stay so the port is a
 * faithful one and turning it on later is a panel change, not a shader change.
 *
 * WHY A TILE RATHER THAN A FILTER. Like the mesh gradient, this IS what the
 * shape shows — a material, not something composited over a fill. It renders
 * to an offscreen canvas the size the shape occupies on screen and the draw
 * path clips it to the real path, so it follows rotation, corner radius,
 * mirroring and every derived copy for free.
 *
 * NO ANIMATION. The `time` uniform is compiled and always zero. A design tool
 * renders a document, and a material whose look depended on the clock could
 * not be exported reproducibly.
 */
(function () {
  "use strict";

  const VERT = `#version 300 es
  in vec2 p; out vec2 uv; void main(){uv=p*.5+.5;gl_Position=vec4(p,0,1);}`;

  const FRAG = `#version 300 es
  precision highp float;
  in vec2 uv; out vec4 outColor;
  uniform vec2 resolution;
  uniform float time, shape, enabled, scale, stretch, rotation, echoes, spacing, squash;
  uniform float stripEnabled, stripAmount, stripWidth, stripAngle, stripDepth, stripThickness, stripIor, stripDisp;
  uniform float spectrum, refraction, rim, glowEnabled, glowAmount, glowSize, glowColorMix, softness, depth, hue, saturation, exposure;
  uniform float echoRotation, echoJitter, echoSeed;   // ADDED FOR THE EDITOR
  uniform float boxRadius;                            // ADDED FOR THE EDITOR
  uniform vec3 background;
  uniform vec3 glowTint;
  uniform vec3 colorCenter, colorLeft, colorRight, colorTop, colorEdge;
  #define PI 3.14159265359
  mat2 rot(float a){float c=cos(a),s=sin(a);return mat2(c,-s,s,c);}
  float sdRoundBox(vec2 p,vec2 b,float r){vec2 q=abs(p)-b+r;return min(max(q.x,q.y),0.)+length(max(q,0.))-r;}
  float sdHex(vec2 p){p=abs(p);return max(dot(p,normalize(vec2(1.,1.732))),p.x)-.86;}
  float sdStar(vec2 p){
    const vec2 k1=vec2(.809016994375,-.587785252292);
    const vec2 k2=vec2(-.809016994375,-.587785252292);
    float r=.92,rf=.43;p.x=abs(p.x);
    p-=2.*max(dot(k1,p),0.)*k1;p-=2.*max(dot(k2,p),0.)*k2;
    p.x=abs(p.x);p.y-=r;
    vec2 ba=rf*vec2(-k1.y,k1.x)-vec2(0,1);
    float h=clamp(dot(p,ba)/dot(ba,ba),0.,r);
    return length(p-ba*h)*sign(p.y*ba.x-p.x*ba.y);
  }
  float starBoundary(vec2 p){
    float outer=.92,inner=.43,delta=PI/5.;
    float a=abs(mod(atan(p.y,p.x)-PI*.5+delta,2.*delta)-delta);
    return outer*inner*sin(delta)/(outer*sin(a)+inner*sin(delta-a));
  }
  float sdf(vec2 p){
    if(shape<.5)return length(p)-.86;
    if(shape<1.5){float taper=1.-.21*(p.y+.05);return length(vec2(p.x/max(.58,taper),p.y*.88+.11))-.79;}
    if(shape<2.5)return (length(p/vec2(1.,.48))-1.)*.48;
    /* ADDED FOR THE EDITOR: the corner radius is the LAYER's, not a constant.
       The page drew one rounded rectangle and .24 was tuned for it; a rect
       with sharp corners was still coming out rounded. */
    if(shape<3.5)return sdRoundBox(p,vec2(.82,.78),boxRadius);
    if(shape<4.5)return sdHex(p);
    return sdStar(p);
  }
  float radial(vec2 p){
    if(shape<.5)return length(p)/.86;
    if(shape<1.5){float taper=1.-.21*(p.y+.05);return length(vec2(p.x/max(.58,taper),p.y*.88+.11))/.79;}
    if(shape<2.5)return length(p/vec2(1.,.48));
    if(shape<3.5){vec2 a=abs(p)/vec2(.82,.78);return pow(pow(a.x,6.)+pow(a.y,6.),1./6.);}
    if(shape<4.5){p=abs(p);return max(dot(p,normalize(vec2(1.,1.732))),p.x)/.86;}
    return length(p)/starBoundary(p);
  }
  float dome(vec2 p){
    float r=radial(p);return sqrt(clamp(1.-r*r,0.,1.));
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
  vec3 hueRotate(vec3 c,float a){
    const vec3 k=vec3(.577350269);float ca=cos(a),sa=sin(a);
    return c*ca+cross(k,c)*sa+k*dot(k,c)*(1.-ca);
  }
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
  void main(){
    vec2 rawQ=(uv*2.-1.);rawQ.x*=resolution.x/resolution.y;
    vec2 panelG=stripWarp(rawQ,stripIor);
    vec2 panelR=stripWarp(rawQ,stripIor*(1.-stripDisp));
    vec2 panelB=stripWarp(rawQ,stripIor*(1.+stripDisp));
    vec2 stripDeltaR=(panelR-panelG)*stripEnabled;
    vec2 stripDeltaB=(panelB-panelG)*stripEnabled;
    vec2 q=mix(rawQ,panelG,stripEnabled);
    float stackMode=smoothstep(.5,1.5,echoes);
    float displayScale=scale*mix(1.,.48,stackMode);
    float inverseScale=1./max(.15,displayScale);
    q*=inverseScale;stripDeltaR*=inverseScale;stripDeltaB*=inverseScale;
    mat2 objectRotation=rot(-rotation);
    q=objectRotation*q;stripDeltaR=objectRotation*stripDeltaR;stripDeltaB=objectRotation*stripDeltaB;
    q.y/=stretch;stripDeltaR.y/=stretch;stripDeltaB.y/=stretch;
    float stackLift=stackMode*.72;
    float best=1e4;vec2 bp=vec2(0);float item=0.;
    for(int i=0;i<7;i++){
      float fi=float(i);if(fi>echoes)continue;
      float isEcho=step(.5,fi);float sy=mix(1.,pow(squash,fi),isEcho);
      float previousSum=.86*squash*(1.-pow(squash,max(fi-1.,0.)))/max(.05,1.-squash);
      float drop=.86+.86*pow(squash,fi)+2.*previousSum+fi*spacing*.35;
      float yoff=mix(stackLift,stackLift-drop,isEcho);
      vec2 lp=q-vec2(0.,yoff);
      /* ADDED FOR THE EDITOR: each copy may be turned, and scattered by a
         seeded amount. Both are multiplied by isEcho so the ORIGINAL never
         moves — it is the layer you selected and its handles are on screen.
         Turn happens before the flatten, so a turned copy still lies in the
         stack's plane rather than tumbling out of it. */
      float h1=fract(sin(fi*12.9898+echoSeed)*43758.5453);
      float h2=fract(sin(fi*78.2330+echoSeed)*43758.5453);
      float h3=fract(sin(fi*39.4251+echoSeed)*24634.6345);
      lp-=isEcho*echoJitter*vec2(h1-.5,h2-.5)*1.2;
      lp=rot(echoRotation*fi*isEcho)*lp;
      float sy2=sy*(1.-isEcho*echoJitter*h3*.45);
      lp.y/=sy2;
      float d=sdf(lp)*sy2;
      if(d<best){best=d;bp=lp;item=fi;}
    }
    // The warped SDF can change by several pixels at steep rib slopes.
    // Screen-space derivatives give each edge the correct local AA width,
    // removing the fine sawtooth without flattening the glass silhouette.
    float baseAA=2.2/resolution.y/max(.15,scale);
    float aa=max(baseAA,min(fwidth(best)*.82,baseAA*3.0));
    float mask=1.-smoothstep(-aa,aa,best);
    float outside=max(best,0.);
    float glowRadius=mix(.012,.50,glowSize);
    float wideGlow=exp(-pow(outside/max(.002,glowRadius),1.18))*glowAmount;
    float edgeGlow=exp(-outside/max(.002,glowRadius*.12))*glowAmount;
    float glowAngle=atan(q.y,q.x)/6.28318;
    vec3 glowColor=mix(palette(glowAngle+hue-.30),glowTint,glowColorMix);
    /* PORTED FOR THE EDITOR: the source page painted an opaque background
       because it owned the whole viewport. Here the tile is clipped to a
       layer's path and composited over the artwork, so everything outside the
       silhouette must be TRANSPARENT and the glow has to carry its own
       alpha rather than being added to a background colour. */
    float glowE=glowEnabled*enabled*(wideGlow*.48+edgeGlow*.62);
    vec3 glowRGB=mix(glowColor,mix(glowColor,vec3(1),.62),clamp(edgeGlow,0.,1.));
    if(mask<=.001){
      float ga=clamp(glowE,0.,1.);
      if(ga<=.002){outColor=vec4(0);return;}
      outColor=vec4(linearToSRGB(glowRGB),ga);
      return;
    }
    // A continuous height-field normal.  Unlike a boundary SDF normal, this
    // curves gradually from face-on at the centre to grazing at the rim.
    float e=.003;
    vec2 dh=vec2(dome(bp+vec2(e,0))-dome(bp-vec2(e,0)),dome(bp+vec2(0,e))-dome(bp-vec2(0,e)))/(2.*e);
    vec3 curvedN=normalize(vec3(-dh*.72,1.));
    if(shape<.5){
      vec2 sphereXY=bp/.86;
      curvedN=normalize(vec3(sphereXY,sqrt(max(0.,1.-dot(sphereXY,sphereXY)))));
    }
    vec3 N=curvedN;
    float vdn=clamp(N.z,0.,1.);
    float ior=1.+refraction*.28;
    float f0=(ior-1.)/(ior+1.);f0*=f0;
    float fres=f0+(1.-f0)*pow(1.-vdn,5.);
    float bodyRadius=clamp(radial(bp),0.,1.);
    float bodyDome=dome(bp);

    // One virtual environment is sampled three times along wavelength-
    // dependent refracted paths. This is the inexpensive 2-D analogue of the
    // per-channel ray tracing used by the glass-capsule shader.
    float itemScaleY=mix(1.,pow(squash,item),step(.5,item));
    vec2 localDeltaR=stripDeltaR/vec2(1,itemScaleY);
    vec2 localDeltaB=stripDeltaB/vec2(1,itemScaleY);
    float materialAngle=item*.34+refraction*.82;
    vec2 rp=rot(materialAngle)*bp;
    vec2 panelSampleR=rot(materialAngle)*localDeltaR;
    vec2 panelSampleB=rot(materialAngle)*localDeltaB;
    rp+=refraction*.10*vec2(sin(bp.y*3.1+item),sin(bp.x*2.7-item));
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
    float lowerCaustic=exp(-pow((bp.y+.77)/.19,2.))*smoothstep(.52,.98,bodyRadius);
    base=mix(base,mix(colorTop,vec3(1),.34),lowerCaustic*.28*depth);

    // Schlick Fresnel from the effective IOR governs the reflection strength.
    // The reflected field is spectral, while the body remains absorption-led.
    float incidence=atan(N.y,N.x)/6.28318;
    float optical=incidence+fres*(.08+.72*spectrum)+bodyRadius*.055*spectrum+dot(N.xy,vec2(.11,-.09))*refraction;
    vec3 film=palette(optical+hue+.04);
    film=sat(film,1.28);
    float rimWidth=mix(.012,.25,rim);
    float geometricRim=smoothstep(1.-rimWidth,1.,bodyRadius);
    float edgeBand=clamp(fres*(.82+rim*.72)+geometricRim*rim*.34,0.,.96);
    base=mix(base,film,edgeBand);
    base+=film*pow(geometricRim,5.)*.075;
    float softLuma=dot(base,vec3(.2126,.7152,.0722));
    base=mix(base,vec3(softLuma),softness*.035);
    base=hueRotate(base,hue*6.28318);
    // Echo mode changes composition only. The source object must preserve the
    // same exposure and material it has when rendered alone.
    base*=mix(1.,.78,pow(float(item)/6.,.7));
    vec3 plain=vec3(.54+.30*dome(bp));
    vec3 color=mix(plain,base,enabled);
    color=sat(color,saturation)*exposure;
    color=color/(1.+max(color-1.,vec3(0))*.22);
    /* "mask" is the antialiased silhouette, so it is exactly the coverage the
       compositor wants. The layer's own path clips the tile as well; the two
       agree because "shape" is chosen to match the layer's type. */
    outColor=vec4(linearToSRGB(color),clamp(mask,0.,1.));
  }`;

  /* Which of the shader's silhouettes matches a layer. The tile is clipped to
   * the layer's real path either way; choosing the nearest one keeps the
   * shader's rim and dome normal where the clip's edge actually falls. */
  const SHAPE_FOR = {
    ellipse: 0,
    rect: 3,
    polygon: 4,
    path: 3,
    line: 3,
    image: 3,
    frame: 3,
    group: 3,
  };
  const HEX = 4,
    STAR = 5,
    CIRCLE = 0,
    ROUNDBOX = 3;
  function shapeIndex(type, sides, innerRatio) {
    if (type === "polygon") {
      /* The editor's polygon is a STAR when its inner ratio drops below 1 and
       * a regular polygon otherwise — the rule its own Shape panel states.
       * Reading only the side count sent every regular polygon to the star
       * silhouette, so a hexagon's rim ran along points it does not have. */
      if (Number.isFinite(+innerRatio) && +innerRatio < 0.95) return STAR;
      return +sides >= 7 ? CIRCLE : HEX;
    }
    const s = SHAPE_FOR[type];
    return s === undefined ? ROUNDBOX : s;
  }

  /* HOW FAR EACH SILHOUETTE REACHES, in the shader's own coordinates, along x
   * and along y. The circle's sdf is length(p)-.86, so it stops at .86; the
   * rounded box stops at .82 and .78; the hexagon reaches .86 across its flats
   * and .993 to a vertex; the star .92 to a point.
   *
   * These exist because the reference page floated its object in a viewport
   * with room around it, so its silhouette filled about two thirds of the
   * frame. A LAYER has no room around it: the tile is the layer's box, and a
   * shape that stops short leaves empty space inside its own selection — the
   * iridescent circle came out visibly smaller than a plain circle of the same
   * size. Fitting the silhouette to the tile is what makes Scale 100% mean
   * "fills the layer", which is the only thing it can honestly mean here. */
  const EXTENT = { 0: [0.86, 0.86], 3: [0.82, 0.78], 4: [0.86, 0.993], 5: [0.92, 0.92] };

  /** The scale and stretch that put the silhouette exactly on the tile's edge.
   *  The shader maps q.x = rawQ.x / s and q.y = rawQ.y / (s * t), and rawQ
   *  spans ±aspect by ±1, so the silhouette's semi-axes are extX·s and
   *  extY·s·t. Setting those to aspect and 1 gives the pair below. */
  function fitToBox(shape, w, h) {
    const [ex, ey] = EXTENT[shape] || EXTENT[0];
    const aspect = Math.max(0.01, w / Math.max(1, h));
    const s = aspect / ex;
    return { scale: s, stretch: ex / (ey * aspect) };
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

  function render(W, H, P) {
    if (!init()) return null;
    const w = Math.max(1, Math.min(4096, Math.round(W)));
    const h = Math.max(1, Math.min(4096, Math.round(H)));
    canvas.width = w;
    canvas.height = h;
    gl.viewport(0, 0, w, h);
    gl.useProgram(program);
    if (loc.resolution) gl.uniform2f(loc.resolution, w, h);
    F("time", 0);
    F("enabled", 1);
    const shape = shapeIndex(P.layerType, P.sides, P.innerRatio);
    const fit = fitToBox(shape, w, h);
    /* The layer's corner radius, in the shader's units. sdRoundBox subtracts
     * its radius from the half-extent .82, so one page pixel across a box of
     * width W is 2 * .82 / W here. A radius of half the width therefore lands
     * exactly on .82, which is the stadium — the same place the editor's own
     * clamp puts it. The SMALLEST of a rect's four radii is used: the shader's
     * silhouette must never be rounder than the path it is clipped to, or a
     * sharper corner would be left unpainted. */
    const pw = Math.max(1, P.boxW || w),
      ph = Math.max(1, P.boxH || h);
    const radii = Array.isArray(P.radii) && P.radii.length ? P.radii : [P.radius || 0];
    const rmin = Math.max(
      0,
      Math.min.apply(
        null,
        radii.map((v) => +v || 0),
      ),
    );
    const cap = Math.min(pw, ph) / 2;
    const boxRadius = (Math.min(rmin, cap) * 2 * 0.82) / pw;
    F("shape", shape);
    F("boxRadius", Math.max(0, Math.min(0.78, boxRadius)));
    /* The user's Scale and Stretch MULTIPLY the fit, so 100% fills the layer
     * and anything less deliberately floats the form inside it. */
    F("scale", fit.scale * P.scale);
    F("stretch", fit.stretch * P.stretch);
    F("rotation", (P.rotation * Math.PI) / 180);
    /* Echoes stack INSIDE the tile and flatten as they recede, which is the
     * perspective look the reference page had and the repeater cannot make:
     * the repeater keeps every copy whole and outside the box. The two are
     * different effects that happen to both repeat. */
    F("echoes", P.echoes);
    F("echoRotation", ((P.echoRotation || 0) * Math.PI) / 180);
    F("echoJitter", P.echoJitter || 0);
    F("echoSeed", P.echoSeed || 0);
    F("spacing", P.spacing);
    F("squash", P.squash);
    F("spectrum", P.spectrum);
    F("refraction", P.refraction);
    F("rim", P.rim);
    F("softness", P.softness);
    F("depth", P.depth);
    F("hue", P.hue / 360);
    F("saturation", P.saturation);
    F("exposure", P.exposure);
    F("glowEnabled", P.glow ? 1 : 0);
    F("glowAmount", P.glowAmount);
    F("glowSize", P.glowSize);
    F("glowColorMix", P.glowMix);
    C("glowTint", P.glowTint);
    /* The reeded block stays off — see the note at the top of this file. */
    F("stripEnabled", 0);
    F("stripAmount", 0.15);
    F("stripWidth", 0.11);
    F("stripAngle", 0);
    F("stripDepth", 1.6);
    F("stripThickness", 0.06);
    F("stripIor", 1.52);
    F("stripDisp", 0.03);
    C("background", "#000000");
    C("colorCenter", P.colorCore);
    C("colorLeft", P.colorLeft);
    C("colorRight", P.colorRight);
    C("colorTop", P.colorTop);
    C("colorEdge", P.colorEdge);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    out.getContext("2d").drawImage(canvas, 0, 0);
    return out;
  }

  /* One tile per (size, parameters). A shape that is not being edited redraws
   * from the cache, which is what keeps a document with several of these
   * from re-running the shader every frame. */
  const CACHE_MAX = 24;
  const cache = new Map();
  const keyOf = (w, h, P) =>
    w +
    "x" +
    h +
    "|" +
    P.layerType +
    "|" +
    (P.sides || 0) +
    "|" +
    (P.innerRatio === undefined ? 1 : P.innerRatio) +
    "|" +
    [
      "scale",
      "stretch",
      "rotation",
      "radius",
      "echoes",
      "echoRotation",
      "echoJitter",
      "echoSeed",
      "spacing",
      "squash",
      "spectrum",
      "refraction",
      "rim",
      "softness",
      "depth",
      "hue",
      "saturation",
      "exposure",
      "glow",
      "glowAmount",
      "glowSize",
      "glowMix",
      "glowTint",
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
    render,
    shapeIndex,
    fitToBox,
    linearRGB,
    available: () => init(),
  };
})();
