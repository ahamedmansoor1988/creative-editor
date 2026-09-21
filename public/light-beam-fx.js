/* Spectral Light Beam — a volumetric emitter, as an effect.
 *
 * Ported from the Spectral Light Beam lab (public/light-beam.html). The optics
 * are carried across untouched; two things changed, and both follow from it
 * being a light rather than a picture.
 *
 * IT HAS NO BACKGROUND. The lab renders `bg + light` and tone-maps the pair,
 * because a lab page has nothing underneath it and has to supply its own
 * night. An effect has the document underneath it, and a light that paints its
 * own black ground would blot that out — the one thing a light must never do.
 * So u_background is gone, the ambient haze that used to be added to the
 * ground is added to the light instead, and the tone-map runs on the light
 * alone.
 *
 * IT COMPOSITES ADDITIVELY. The output is premultiplied, with alpha taken from
 * the light's own strength, so drawing it with 'lighter' adds exactly the
 * light and nothing where there is none. That is what a beam does to a scene;
 * painting it over with normal alpha would darken the parts it misses.
 *
 * The source stays in 0..1 of the object's box, which is what lets it be a
 * handle you drag rather than two sliders you guess at. */
(function () {
  "use strict";

  const VERSION = "20260921-beam1";

  const VERT = `#version 300 es
  in vec2 a_position;out vec2 v_uv;
  void main(){v_uv=a_position*.5+.5;gl_Position=vec4(a_position,0.,1.);}`;

  const FRAG = `#version 300 es
precision highp float;in vec2 v_uv;out vec4 fragColor;
uniform vec2 u_resolution,u_source;
uniform float u_direction,u_fan,u_beams,u_intensity,u_falloff,u_sharpness,u_dispersion,u_haze,u_starburst,u_coreSize,u_edgeGlow,u_streaks,u_streakDensity;
#define PI 3.14159265359
float angleDelta(float a,float b){return atan(sin(a-b),cos(a-b));}
float hash(float n){return fract(sin(n)*43758.5453123);}
vec3 spectrum(float t){
  vec3 c=.5+.5*cos(6.28318*(vec3(t)+vec3(.00,.33,.67)));
  return pow(max(c,0.),vec3(.62));
}
float band(float x,float center,float width){float d=(x-center)/width;return exp(-d*d);}
vec3 prismMaterial(float x,float along){
  vec3 color=vec3(.055,.10,.17);
  color+=vec3(1.55,.98,.18)*band(x,.10,.15);
  color+=vec3(.12,1.08,1.42)*band(x,.31,.19);
  color+=vec3(.78,.24,1.45)*band(x,.53,.20);
  color+=vec3(1.55,.10,.18)*band(x,.73,.17);
  color+=vec3(1.18,.66,.08)*band(x,.94,.14);
  float depth=.82+.18*cos(along*1.45+x*5.2);
  return color*depth;
}
void main(){
  vec2 p=v_uv*2.-1.;p.x*=u_resolution.x/max(u_resolution.y,1.);
  vec2 s=vec2((u_source.x*2.-1.)*u_resolution.x/max(u_resolution.y,1.),u_source.y*2.-1.);
  vec2 q=p-s;float r=length(q);float a=atan(q.y,q.x);float forward=max(dot(normalize(q+1e-5),vec2(cos(u_direction),sin(u_direction))),0.);
  vec3 light=vec3(0.);
  // The lab added this to its own night sky. There is a document here, so the
  // haze is light like everything else.
  float ambient=exp(-r*1.42)*(.04+.17*u_haze);
  light+=vec3(.015,.095,.125)*ambient;
  float n=clamp(u_beams,1.,6.);
  // Every beam reuses one finished prismatic material; count only duplicates it.
  for(int i=0;i<6;i++){
    float fi=float(i);if(fi>=n)continue;
    float t=n<=1.?.5:fi/(n-1.);
    float center=n<1.5?u_direction:u_direction+(t-.5)*u_fan;
    float halfWidth=n<1.5?u_fan*.31:u_fan/max(n,1.)*.56;
    float delta=abs(angleDelta(a,center));
    float edge=max(.0012,mix(.020,.0022,u_sharpness));
    float cone=smoothstep(halfWidth+edge,halfWidth-edge,delta)*step(.003,r);
    float crossBand=clamp(.5+.5*angleDelta(a,center)/max(halfWidth,.001),0.,1.);
    float longFade=exp(-r*mix(1.55,.30,u_falloff));
    longFade*=smoothstep(.015,.17,r);
    vec3 body=prismMaterial(crossBand,r);
    float glass=smoothstep(0.,.16,crossBand)*smoothstep(1.,.84,crossBand);
    float depth=mix(.58,1.,pow(1.-crossBand,.65));
    light+=body*cone*longFade*(depth+.20*glass)*u_intensity*.035*u_haze;
    float harmonic=.48+.27*sin(crossBand*6.283*u_streakDensity+1.7)
      +.18*sin(crossBand*13.7*u_streakDensity+4.1)
      +.11*sin(crossBand*29.3*u_streakDensity+.6)
      +.06*sin(crossBand*61.7*u_streakDensity+2.4);
    float spikes=0.;
    for(int j=0;j<10;j++){
      float fj=float(j),pos=hash(fj*19.31+4.2);
      float width=mix(.003,.020,hash(fj*7.73+2.1));
      float d=(crossBand-pos)/width;
      spikes+=exp(-d*d)*mix(.35,1.,hash(fj*11.1));
    }
    float ridges=smoothstep(.54,.84,harmonic);
    float streakMask=clamp(ridges+spikes*1.25,0.,2.)*cone*longFade*forward;
    float radialPulse=.68+.32*sin(r*(5.2+u_streakDensity*1.4)+crossBand*3.);
    vec3 streakColor=mix(prismMaterial(crossBand,r),vec3(1.35,1.05,.78),.24);
    light+=streakColor*streakMask*radialPulse*u_streaks*u_intensity*.62;
    float rim=exp(-abs(delta-halfWidth)/max(.0012,edge*.62))*forward;
    vec3 rimColor=mix(vec3(1.35,.35,.16),vec3(.24,1.15,1.45),step(.5,crossBand));
    light+=rimColor*rim*exp(-r*.30)*u_edgeGlow*.24;
    float innerA=exp(-abs(angleDelta(a,center-halfWidth*.52))/max(.004,halfWidth*.045))*forward;
    float innerB=exp(-abs(angleDelta(a,center+halfWidth*.16))/max(.004,halfWidth*.07))*forward;
    light+=vec3(1.40,.82,.18)*innerA*exp(-r*.48)*u_dispersion*.13;
    light+=vec3(.22,.86,1.42)*innerB*exp(-r*.62)*u_dispersion*.10;
  }
  float mainDelta=abs(angleDelta(a,u_direction));
  float broad=smoothstep(u_fan*.55,u_fan*.08,mainDelta)*exp(-r*.62)*forward;
  light+=mix(vec3(.12,.62,.80),vec3(.92,.42,.16),smoothstep(-u_fan*.35,u_fan*.35,angleDelta(a,u_direction)))*broad*u_haze*.045;
  float core=exp(-r*r/max(.00008,u_coreSize*u_coreSize*.007));
  float bloom=exp(-r/max(.012,u_coreSize*.105));
  float spikeA=pow(abs(cos(a*6.+.17)),mix(120.,36.,u_starburst))*exp(-r*8.5);
  float spikeB=pow(abs(cos(a*11.-.4)),mix(160.,52.,u_starburst))*exp(-r*12.);
  light+=vec3(1.35,1.23,1.02)*(core*4.8+bloom*.58+(spikeA*.38+spikeB*.22)*u_starburst);
  light+=spectrum(a/6.28318+.15)*exp(-r*16.)*u_dispersion*.22;
  // Tone-mapped on its OWN, with no ground mixed in — the lab folded the two
  // together because it had to supply its own night.
  vec3 color=1.-exp(-light);color=pow(max(color,0.),vec3(.92));
  // PREMULTIPLIED, alpha from the light's own strength, so 'lighter' adds
  // exactly the light and nothing at all where there is none.
  float alpha=clamp(max(color.r,max(color.g,color.b)),0.,1.);
  fragColor=vec4(color*alpha,alpha);
}`;

  let _gl = null,
    _cv = null,
    _prog = null,
    _vao = null,
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
      const compile = (t, src) => {
        const x = gl.createShader(t);
        gl.shaderSource(x, src);
        gl.compileShader(x);
        if (!gl.getShaderParameter(x, gl.COMPILE_STATUS))
          throw new Error(gl.getShaderInfoLog(x) || "shader");
        return x;
      };
      const p = gl.createProgram();
      gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT));
      gl.attachShader(p, compile(gl.FRAGMENT_SHADER, FRAG));
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
        "source",
        "direction",
        "fan",
        "beams",
        "intensity",
        "falloff",
        "sharpness",
        "dispersion",
        "haze",
        "starburst",
        "coreSize",
        "edgeGlow",
        "streaks",
        "streakDensity",
      ];
      const u = {};
      names.forEach((n) => (u[n] = gl.getUniformLocation(p, `u_${n}`)));
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

  /** @returns {HTMLCanvasElement|null} premultiplied light, to draw with 'lighter' */
  function render(w, h, s) {
    const gl = boot();
    if (!gl || !(w >= 1) || !(h >= 1)) return null;
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    _cv.width = w;
    _cv.height = h;
    gl.viewport(0, 0, w, h);
    gl.useProgram(_prog);
    gl.bindVertexArray(_vao);
    gl.uniform2f(_u.resolution, w, h);
    /* y is flipped: the document counts down from the top and the shader's
     * clip space counts up, so a source dragged to the top of the box has to
     * arrive at the top of the render. */
    gl.uniform2f(_u.source, num(s.sourceX, 0.17), 1 - num(s.sourceY, 0.245));
    const set = (k, d) => gl.uniform1f(_u[k], num(s[k], d));
    set("direction", -0.42);
    set("fan", 1.28);
    set("beams", 5);
    set("intensity", 2.24);
    set("falloff", 0.64);
    set("sharpness", 0.92);
    set("dispersion", 0.98);
    set("haze", 0.58);
    set("starburst", 0.72);
    set("coreSize", 0.42);
    set("edgeGlow", 1.55);
    set("streaks", 1.08);
    set("streakDensity", 1.58);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return _cv;
  }

  function num(v, d) {
    const n = +v;
    return Number.isFinite(n) ? n : d;
  }

  const PRESETS = {
    "Complete spectrum": {},
    "Hero beam": { fan: 0.78, beams: 1, intensity: 2.3, streakDensity: 1.35, edgeGlow: 1.72 },
    "Three beams": { fan: 1.12, beams: 3, dispersion: 1, haze: 0.62, falloff: 0.58 },
    "Soft atmosphere": {
      fan: 1.18,
      beams: 5,
      sharpness: 0.55,
      dispersion: 0.72,
      haze: 1,
      falloff: 0.7,
    },
    "White burst": {
      fan: 0.92,
      beams: 6,
      dispersion: 0.18,
      starburst: 1,
      coreSize: 0.65,
      edgeGlow: 1.1,
    },
  };

  window.LightBeamEngine = { VERSION, available, render, PRESETS };
})();
