/* Glass 3D — a path-traced glass object (§5.x material slot).
 *
 * PROVENANCE. Ported from the author's own standalone glass-objects.html. The
 * tracer — SDF, march, path loop, area-light env, Beer-Lambert, present pass —
 * is carried across essentially verbatim; what changed is the plumbing. The
 * standalone is a SCENE editor: eight objects, layer list, CPU picking, orbit
 * camera, presets. Here the document object IS the 3D object, so all of that
 * is gone and one solid renders into the shape's own box. See
 * SHADER-PROVENANCE.md. Deliberately omitted from the port: the gradient
 * background and its stop editor (solid or transparent only), depth of field
 * (aperture fixed at 0), and the multi-object uniform arrays are sized to 1.
 *
 * WHAT IT IS. One SDF — a circle with Extrude and Round — is the entire shape
 * library:  extrude 0, round 0 -> disc;  extrude >0 -> cylinder;
 * round 1, extrude 0 -> sphere;  both -> capsule. Round is a FRACTION of the
 * radius, which is what makes "round 1 = sphere" hold at any size. Colour
 * comes from the lights, not the material: glass has none of its own, so a
 * rotated object's gradient slides correctly where a painted-on gradient
 * would stay stuck to the surface.
 *
 * A REAL PATH, NOT A SURFACE EVENT. The exit ray carries on after leaving the
 * solid, so glass shows what is behind it in the scene — that is what makes
 * these read as glass rather than shiny shells.
 *
 * WHY IT IS A MATERIAL AND NOT A BACKDROP EFFECT. Its world is its own lights
 * and background; it never samples the page. So it caches like liquid and
 * flare — which matters more here than anywhere, because a path trace is the
 * most expensive render in the app and the cache means it runs once per
 * parameter change, not once per frame.
 *
 * DETERMINISTIC, NO CLOCK. The standalone converges progressively across
 * requestAnimationFrame. A document must export as what you see, so render()
 * accumulates a fixed number of samples in one call with a seed derived only
 * from pixel and sample index — the same parameters always produce the same
 * pixels.
 */
(function () {
  "use strict";

  const VS = `#version 300 es
void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0,1);}`;

  const TRACE = `#version 300 es
precision highp float;
out vec4 fragColor;
uniform vec2 uRes; uniform float uSample; uniform sampler2D uPrev;
uniform vec4 uA;         // r, halfHeight, cornerRadius, enabled
uniform vec4 uB;         // scale.xyz, ior
uniform vec4 uC;         // pos.xyz, roughness
uniform vec4 uD;         // tint.rgb, transmission
uniform vec4 uE;         // absorb, emissive, --, --
uniform mat3 uRot;
uniform vec4 uLP[3]; uniform vec4 uLC[3]; uniform vec4 uLS[3];
uniform vec3 uBg; uniform float uAmb, uLSoft;
uniform vec3 uCamPos; uniform mat3 uCamB;
uniform float uFov;
uniform float uSceneR; uniform int uSteps, uBounces;

uint g_seed;
float rnd(){ g_seed=g_seed*747796405u+2891336453u;
  uint r=((g_seed>>((g_seed>>28)+4u))^g_seed)*277803737u; r=(r>>22)^r;
  return float(r)*2.3283064365386963e-10; }
vec3 jitter(vec3 d,float r){
  if(r<=0.0) return d;
  vec3 up=abs(d.y)<0.9?vec3(0,1,0):vec3(1,0,0);
  vec3 u=normalize(cross(up,d)), v=cross(d,u);
  float a=rnd()*6.2831853, s=r*r*sqrt(rnd())*2.0;
  return normalize(d+(u*cos(a)+v*sin(a))*s);
}

/* circle + extrude + round, all in one */
float sdRC(vec3 p,float r,float h,float cr){
  cr=min(cr,r);
  vec2 q=vec2(length(p.xz)-(r-cr), abs(p.y)-max(h-cr,0.0));
  return min(max(q.x,q.y),0.0)+length(max(q,0.0))-cr;
}
float map(vec3 p){
  vec3 s=max(uB.xyz,vec3(1e-3));
  vec3 q=(uRot*(p-uC.xyz))/s;
  return sdRC(q,uA.x,uA.y,uA.z)*min(s.x,min(s.y,s.z));
}
vec3 nrm(vec3 p){
  vec2 e=vec2(1,-1)*0.0006;
  return normalize(e.xyy*map(p+e.xyy)+e.yyx*map(p+e.yyx)+
                   e.yxy*map(p+e.yxy)+e.xxx*map(p+e.xxx));
}
/* Clip to a sphere around the scene before marching — background pixels cost
   one quadratic instead of the full step budget. */
float march(vec3 ro,vec3 rd){
  float b=dot(ro,rd), c=dot(ro,ro)-uSceneR*uSceneR;
  float h=b*b-c;
  if(h<0.0) return -1.0;
  h=sqrt(h);
  float t=max(-b-h,0.0), tmax=-b+h;
  if(tmax<=t) return -1.0;
  for(int i=0;i<220;i++){
    if(i>=uSteps) break;
    float d=map(ro+rd*t);
    if(d<0.0006) return t;
    t+=d; if(t>tmax) break;
  }
  return -1.0;
}
float marchIn(vec3 ro,vec3 rd){
  float t=0.003;
  for(int i=0;i<220;i++){
    if(i>=uSteps) break;
    float d=-map(ro+rd*t);
    if(d<0.0006) return t;
    t+=max(d,0.003); if(t>40.0) break;
  }
  return t;
}

/* The panels ARE the environment, so reflection and refraction pick them up
   for free. uLSoft feathers the panel border — a hard-edged rectangle prints
   a visibly rectangular highlight on anything smooth. */
vec3 env(vec3 ro,vec3 rd){
  vec3 c=uBg+vec3(uAmb);
  float best=1e9;
  for(int i=0;i<3;i++){
    if(uLP[i].w<0.5) continue;
    vec3 P=uLP[i].xyz, N=normalize(-P);
    float dn=dot(rd,N); if(abs(dn)<1e-5) continue;
    float t=dot(P-ro,N)/dn; if(t<=0.0||t>=best) continue;
    vec3 up=abs(N.y)<0.95?vec3(0,1,0):vec3(1,0,0);
    vec3 U=normalize(cross(up,N)), Vv=cross(N,U);
    vec3 hp=ro+rd*t-P;
    float a=abs(dot(hp,U))/uLS[i].x, b=abs(dot(hp,Vv))/uLS[i].y;
    float m=max(a,b);
    float e=max(uLSoft,1e-3);
    float w=1.0-smoothstep(1.0-e,1.0,m);
    if(w>0.0){ best=t; c=mix(uBg+vec3(uAmb), uLC[i].rgb*uLC[i].w, w); }
  }
  return c;
}
float schlick(float f0,float c){return f0+(1.0-f0)*pow(1.0-c,5.0);}

/* A real path, not a single surface event — the exit ray carries on. */
vec3 shade(vec3 ro,vec3 rd,out float cov){
  vec3 acc=vec3(0.0), thr=vec3(1.0);
  cov=0.0;
  for(int bnc=0;bnc<8;bnc++){
    if(bnc>=uBounces){ acc+=thr*env(ro,rd); break; }
    float t=march(ro,rd);
    if(t<0.0){ acc+=thr*env(ro,rd); break; }
    if(bnc==0) cov=1.0;

    vec3 p=ro+rd*t, n=nrm(p);
    float ior=uB.w, rough=uC.w, trans=uD.w, dens=uE.x;
    vec3 tint=uD.rgb;
    if(uE.y>0.5){ acc+=thr*tint*4.0; break; }

    float f0=(ior-1.0)/(ior+1.0); f0*=f0;
    float F=schlick(f0,clamp(dot(-rd,n),0.0,1.0));

    if(rnd()>trans){                              // opaque: terminate here
      vec3 refl=env(p+n*0.003, jitter(reflect(rd,n),rough));
      vec3 wide=env(p+n*0.003, jitter(n,0.55));
      acc+=thr*mix(tint*wide, refl, F);
      break;
    }
    if(rnd()<F){                                  // reflect off the surface
      ro=p+n*0.003; rd=jitter(reflect(rd,n),rough); continue;
    }
    vec3 d=refract(rd,n,1.0/ior);
    if(dot(d,d)<0.5){ ro=p+n*0.003; rd=jitter(reflect(rd,n),rough); continue; }
    d=jitter(d,rough);
    vec3 q=p-n*0.003;
    float ti=marchIn(q,d);
    vec3 pe=q+d*ti, ne=nrm(pe);
    thr*=exp(-dens*(1.0-tint)*ti);                // Beer-Lambert
    vec3 dout=refract(d,-ne,ior);
    if(dot(dout,dout)<0.5){ ro=pe-ne*0.003; rd=jitter(reflect(d,-ne),rough); continue; }
    ro=pe+ne*0.003; rd=jitter(dout,rough);
    if(max(thr.r,max(thr.g,thr.b))<0.01) break;
  }
  return acc;
}

void main(){
  ivec2 pc=ivec2(gl_FragCoord.xy);
  g_seed=uint(pc.x)*1973u+uint(pc.y)*9277u+uint(uSample)*26699u+1u;
  vec2 jit=vec2(rnd(),rnd())-0.5;
  vec2 uv=(2.0*(gl_FragCoord.xy+jit)-uRes)/uRes.y;
  float f=1.0/tan(radians(uFov)*0.5);
  vec3 rd=normalize(uCamB*vec3(uv,f)); vec3 ro=uCamPos;
  float cov;
  vec3 c=shade(ro,rd,cov);
  vec4 prev=texelFetch(uPrev,pc,0);
  float w=1.0/(uSample+1.0);
  fragColor=vec4(mix(prev.rgb,c,w), mix(prev.a,cov,w));
}`;

  const SHOW = `#version 300 es
precision highp float;
out vec4 fragColor;
uniform sampler2D uAccum; uniform float uExpo,uShoulder,uGrain; uniform int uAlphaMode;
float h21(vec2 p){vec3 v=fract(vec3(p.xyx)*0.1031);v+=dot(v,v.yzx+33.33);
  return fract((v.x+v.y)*v.z);}
void main(){
  vec4 acc=texelFetch(uAccum,ivec2(gl_FragCoord.xy),0);
  vec3 c=acc.rgb*uExpo;
  c=c/(1.0+uShoulder*c);
  c=pow(max(c,0.0),vec3(1.0/2.2));
  c+=(h21(gl_FragCoord.xy)-h21(gl_FragCoord.xy+71.7))*uGrain;
  c+=(h21(gl_FragCoord.xy+13.1)-0.5)/255.0;
  // Transparent mode keys off primary-ray coverage, so alpha is the object's
  // own silhouette — the glass sits on the page like an object.
  fragColor=vec4(c, uAlphaMode==1 ? clamp(acc.a,0.0,1.0) : 1.0);
}`;

  let gl = null,
    cv = null,
    pTrace = null,
    pShow = null,
    vao = null,
    failed = false;
  let tex = [null, null],
    fbo = [null, null],
    W = 0,
    H = 0;
  const U = {};
  const loc = (p, n) => {
    const k = (p === pTrace ? "t:" : "s:") + n;
    if (!(k in U)) U[k] = gl.getUniformLocation(p, n);
    return U[k];
  };

  function init() {
    if (gl) return true;
    if (failed) return false;
    try {
      cv = document.createElement("canvas");
      gl = cv.getContext("webgl2", {
        antialias: false,
        alpha: true,
        premultipliedAlpha: false,
        preserveDrawingBuffer: true,
      });
      if (!gl) throw new Error("WebGL2 unavailable");
      if (!gl.getExtension("EXT_color_buffer_float")) throw new Error("float buffers unavailable");
      const sh = (s, t) => {
        const x = gl.createShader(t);
        gl.shaderSource(x, s);
        gl.compileShader(x);
        if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x));
        return x;
      };
      const prg = (fs) => {
        const p = gl.createProgram();
        gl.attachShader(p, sh(VS, gl.VERTEX_SHADER));
        gl.attachShader(p, sh(fs, gl.FRAGMENT_SHADER));
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
        return p;
      };
      pTrace = prg(TRACE);
      pShow = prg(SHOW);
      vao = gl.createVertexArray();
      return true;
    } catch (e) {
      console.warn("glass 3d engine disabled:", e.message);
      failed = true;
      gl = null;
      return false;
    }
  }

  function alloc(w, h) {
    for (let i = 0; i < 2; i++) {
      if (tex[i]) {
        gl.deleteTexture(tex[i]);
        gl.deleteFramebuffer(fbo[i]);
      }
      tex[i] = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex[i]);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, w, h);
      for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER])
        gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
      for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T])
        gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
      fbo[i] = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo[i]);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex[i], 0);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    W = w;
    H = h;
  }

  const hex = (h) => [
    parseInt(h.slice(1, 3), 16) / 255,
    parseInt(h.slice(3, 5), 16) / 255,
    parseInt(h.slice(5, 7), 16) / 255,
  ];
  const lin = (h) =>
    hex(h).map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  const rad = (d) => (d * Math.PI) / 180;
  function eulT(yaw, pitch, roll) {
    const cy = Math.cos(yaw),
      sy = Math.sin(yaw),
      cp = Math.cos(pitch),
      sp = Math.sin(pitch),
      cr = Math.cos(roll),
      sr = Math.sin(roll);
    const m = [
      cy * cr + sy * sp * sr,
      cp * sr,
      -sy * cr + cy * sp * sr,
      -cy * sr + sy * sp * cr,
      cp * cr,
      sy * sr + cy * sp * cr,
      sy * cp,
      -sp,
      cy * cp,
    ];
    return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
  }

  /* Material presets set the physics; roughness/glassiness/absorb stay live
   * on top. Copied from the standalone's MATS table. */
  const MATS = {
    glass: { ior: 1.48, rough: 0.02, trans: 1.0, dens: 0.55, emit: 0 },
    frosted: { ior: 1.46, rough: 0.38, trans: 1.0, dens: 0.9, emit: 0 },
    gradient: { ior: 1.6, rough: 0.1, trans: 0.18, dens: 1.0, emit: 0 },
    metal: { ior: 2.4, rough: 0.09, trans: 0.0, dens: 0.0, emit: 0 },
    matte: { ior: 1.4, rough: 0.8, trans: 0.0, dens: 0.0, emit: 0 },
    glow: { ior: 1.4, rough: 0.5, trans: 0.0, dens: 0.0, emit: 1 },
  };
  /* The standalone's light-colour presets, same order. */
  const LIGHT_PRESETS = [
    { l0: "#3f6cff", l1: "#ff3d8b", l2: "#ffffff" }, // Blue / Pink
    { l0: "#4fa8ff", l1: "#ff9a3c", l2: "#ffe7c4" }, // Warm / Cool
    { l0: "#ffffff", l1: "#dfe8ff", l2: "#ffffff" }, // Studio
    { l0: "#ff5f3c", l1: "#ffc14d", l2: "#ff87c8" }, // Sunset
    { l0: "#6fe3ff", l1: "#9d7bff", l2: "#e6f7ff" }, // Ice
    { l0: "#7dff5a", l1: "#00e5ff", l2: "#ffe95a" }, // Acid
  ];

  /** Render one glass object into a w x h canvas. Returns it, or null. */
  function render(w, h, P) {
    if (!init()) return null;
    w = Math.max(2, Math.min(2048, Math.round(w)));
    h = Math.max(2, Math.min(2048, Math.round(h)));
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
    }
    if (w !== W || h !== H) alloc(w, h);

    const mat = MATS[P.mat] || MATS.glass;
    const r = P.size === undefined ? 0.62 : +P.size;
    const ext = +P.ext || 0;
    const round = P.round === undefined ? 0.18 : +P.round;
    const rough = P.rough === undefined ? mat.rough : +P.rough;
    const trans = P.trans === undefined ? mat.trans : +P.trans;
    const dens = P.dens === undefined ? mat.dens : +P.dens;

    gl.useProgram(pTrace);
    gl.bindVertexArray(vao);
    gl.viewport(0, 0, W, H);
    const u = (n) => loc(pTrace, n);
    gl.uniform2f(u("uRes"), W, H);
    gl.uniform4f(u("uA"), r, ext, round * r, 1);
    gl.uniform4f(u("uB"), 1, 1, 1, P.ior===undefined?mat.ior:+P.ior);
    gl.uniform4f(u("uC"), 0, 0, 0, rough);
    const tint = lin(P.tint || "#c8d8ff");
    gl.uniform4f(u("uD"), tint[0], tint[1], tint[2], trans);
    gl.uniform4f(u("uE"), dens, mat.emit, 0, 0);
    gl.uniformMatrix3fv(u("uRot"), false, eulT(rad(+P.ry || 0), rad(+P.rx || 0), rad(+P.rz || 0)));

    /* Lights: preset colours unless custom ones are given. Same rig geometry
     * as the standalone's defaults. */
    const pi = Math.max(0, Math.min(LIGHT_PRESETS.length - 1, P.lightPreset | 0));
    const pre = LIGHT_PRESETS[pi];
    const l0c = P.l0col || pre.l0,
      l1c = P.l1col || pre.l1,
      l2c = P.l2col || pre.l2;
    const rig = [
      {
        az: -52,
        el: 26,
        d: 5.5,
        w: 4.5,
        h: 4.5,
        col: l0c,
        int: P.l0int === undefined ? 9 : +P.l0int,
        on: true,
      },
      {
        az: 64,
        el: -14,
        d: 5,
        w: 4,
        h: 4,
        col: l1c,
        int: P.l1int === undefined ? 8 : +P.l1int,
        on: true,
      },
      {
        az: 160,
        el: 40,
        d: 6,
        w: 3,
        h: 3,
        col: l2c,
        int: P.l2int === undefined ? 4 : +P.l2int,
        on: !!P.l2on,
      },
    ];
    const LP = [],
      LC = [],
      LS = [];
    for (const L of rig) {
      const az = rad(L.az),
        el = rad(L.el);
      LP.push(
        L.d * Math.cos(el) * Math.sin(az),
        L.d * Math.sin(el),
        L.d * Math.cos(el) * Math.cos(az),
        L.on ? 1 : 0,
      );
      LC.push(...lin(L.col), L.int);
      LS.push(L.w * 0.5, L.h * 0.5, 0, 0);
    }
    gl.uniform4fv(u("uLP"), LP);
    gl.uniform4fv(u("uLC"), LC);
    gl.uniform4fv(u("uLS"), LS);
    gl.uniform3fv(u("uBg"), lin(P.bg || "#000000"));
    gl.uniform1f(u("uAmb"), P.amb === undefined ? 0.012 : +P.amb);
    gl.uniform1f(u("uLSoft"), P.soft === undefined ? 0.3 : +P.soft);

    /* Camera: the standalone's default framing, pulled back when the solid
     * grows so it cannot poke out of frame. */
    const reach = r + ext;
    const camD = 7.2 * Math.max(1, reach / 0.74);
    const yaw = 0,
      pit = rad(4);
    const pos = [
      camD * Math.cos(pit) * Math.sin(yaw),
      camD * Math.sin(pit),
      camD * Math.cos(pit) * Math.cos(yaw),
    ];
    let ww = [-pos[0], -pos[1], -pos[2]];
    const wl = Math.hypot(...ww) || 1;
    ww = ww.map((v) => v / wl);
    let uu = [ww[2], 0, -ww[0]];
    const ul = Math.hypot(uu[0], uu[2]) || 1;
    uu = [uu[0] / ul, 0, uu[2] / ul];
    const vv = [
      uu[1] * ww[2] - uu[2] * ww[1],
      uu[2] * ww[0] - uu[0] * ww[2],
      uu[0] * ww[1] - uu[1] * ww[0],
    ];
    gl.uniform3fv(u("uCamPos"), pos);
    gl.uniformMatrix3fv(u("uCamB"), false, [
      uu[0],
      uu[1],
      uu[2],
      vv[0],
      vv[1],
      vv[2],
      ww[0],
      ww[1],
      ww[2],
    ]);
    gl.uniform1f(u("uFov"), 26);
    gl.uniform1f(u("uSceneR"), reach * 1.05 + 0.05);
    gl.uniform1i(u("uSteps"), Math.max(24, Math.min(220, Math.round(P.steps || 110))));
    gl.uniform1i(u("uBounces"), Math.max(1, Math.min(8, Math.round(P.bounces || 3))));

    /* Accumulate a fixed sample count in one call — deterministic, no clock. */
    const S = Math.max(4, Math.min(128, Math.round(P.samples || 36)));
    let ping = 0;
    for (let s = 0; s < S; s++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo[ping ^ 1]);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex[ping]);
      gl.uniform1i(u("uPrev"), 0);
      gl.uniform1f(u("uSample"), s);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      ping ^= 1;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.useProgram(pShow);
    gl.bindVertexArray(vao);
    gl.viewport(0, 0, W, H);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex[ping]);
    const q = (n) => loc(pShow, n);
    gl.uniform1i(q("uAccum"), 0);
    gl.uniform1f(q("uExpo"), P.exposure === undefined ? 1.1 : +P.exposure);
    gl.uniform1f(q("uShoulder"), 0.22);
    gl.uniform1f(q("uGrain"), 0.004);
    gl.uniform1i(q("uAlphaMode"), P.transparent === false ? 0 : 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return cv;
  }

  window.GlassObjectEngine = {
    render,
    available: () => init(),
    MATS: Object.keys(MATS),
    LIGHT_PRESETS: LIGHT_PRESETS.length,
  };
})();
