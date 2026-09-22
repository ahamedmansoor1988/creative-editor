/* Spectral Light Beam — analytic WebGL2 volumetric fan and emitter. */
(function(){
"use strict";
const VERT=`#version 300 es
in vec2 a_position;out vec2 v_uv;void main(){v_uv=a_position*.5+.5;gl_Position=vec4(a_position,0.,1.);}`;
const FRAG=`#version 300 es
precision highp float;in vec2 v_uv;out vec4 fragColor;
uniform vec2 u_resolution,u_source;
uniform float u_direction,u_fan,u_beams,u_intensity,u_falloff,u_sharpness,u_dispersion,u_haze,u_starburst,u_coreSize,u_edgeGlow,u_streaks,u_streakDensity;
uniform vec3 u_background;
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
  vec3 bg=u_background;
  float ambient=exp(-r*1.42)*(.04+.17*u_haze);
  bg+=vec3(.015,.095,.125)*ambient;
  vec3 light=vec3(0.);float n=clamp(u_beams,1.,6.);
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
    // Only a faint haze remains from the old solid wedge.
    light+=body*cone*longFade*(depth+.20*glass)*u_intensity*.035*u_haze;
    // Aurora-style bands replace the solid beam body.
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
    // A few brighter streaks provide hierarchy inside the field.
    float innerA=exp(-abs(angleDelta(a,center-halfWidth*.52))/max(.004,halfWidth*.045))*forward;
    float innerB=exp(-abs(angleDelta(a,center+halfWidth*.16))/max(.004,halfWidth*.07))*forward;
    light+=vec3(1.40,.82,.18)*innerA*exp(-r*.48)*u_dispersion*.13;
    light+=vec3(.22,.86,1.42)*innerB*exp(-r*.62)*u_dispersion*.10;
  }
  // Pale atmospheric volume binds the slabs without washing out their colors.
  float mainDelta=abs(angleDelta(a,u_direction));
  float broad=smoothstep(u_fan*.55,u_fan*.08,mainDelta)*exp(-r*.62)*forward;
  light+=mix(vec3(.12,.62,.80),vec3(.92,.42,.16),smoothstep(-u_fan*.35,u_fan*.35,angleDelta(a,u_direction)))*broad*u_haze*.045;
  // Compact white-hot emitter; sparkle supports the beam instead of dominating it.
  float core=exp(-r*r/max(.00008,u_coreSize*u_coreSize*.007));
  float bloom=exp(-r/max(.012,u_coreSize*.105));
  float spikeA=pow(abs(cos(a*6.+.17)),mix(120.,36.,u_starburst))*exp(-r*8.5);
  float spikeB=pow(abs(cos(a*11.-.4)),mix(160.,52.,u_starburst))*exp(-r*12.);
  light+=vec3(1.35,1.23,1.02)*(core*4.8+bloom*.58+(spikeA*.38+spikeB*.22)*u_starburst);
  light+=spectrum(a/6.28318+.15)*exp(-r*16.)*u_dispersion*.22;
  vec3 color=bg+light;
  color=1.-exp(-color);color=pow(max(color,0.),vec3(.92));
  float grain=(hash(gl_FragCoord.x+gl_FragCoord.y*4096.)-.5)/255.;
  fragColor=vec4(clamp(color+grain,0.,1.),1.);
}`;
const DEFAULTS={sourceX:.17,sourceY:.755,direction:-.42,fan:1.28,beams:5,intensity:2.24,falloff:.64,sharpness:.92,dispersion:.98,haze:.58,starburst:.72,coreSize:.42,edgeGlow:1.55,streaks:1.08,streakDensity:1.58,background:"#01050a"};
const PRESETS={"Complete spectrum":{},"Hero beam":{fan:.78,beams:1,intensity:2.3,streakDensity:1.35,edgeGlow:1.72},"Three beams":{fan:1.12,beams:3,dispersion:1,haze:.62,falloff:.58},"Soft atmosphere":{fan:1.18,beams:5,sharpness:.55,dispersion:.72,haze:1,falloff:.70},"White burst":{fan:.92,beams:6,dispersion:.18,starburst:1,coreSize:.65,edgeGlow:1.1}};
const GROUPS=[["Light source",[["sourceX","Horizontal","range",0,1,.001],["sourceY","Vertical","range",0,1,.001],["direction","Direction","range",-3.1416,3.1416,.01],["coreSize","Core size","range",.08,1,.01],["starburst","Sparkle","range",0,1,.01]]],["Beam",[["fan","Fan angle","range",.15,2.6,.01],["beams","Beam count","range",1,8,1],["intensity","Intensity","range",0,3,.01],["sharpness","Sharpness","range",0,1,.01],["edgeGlow","Edge glow","range",0,2.5,.01],["streaks","Streaks","range",0,1.5,.01],["streakDensity","Streak detail","range",.4,3,.01]]],["Color & depth",[["dispersion","Color spread","range",0,1,.01],["falloff","Falloff","range",0,1,.01],["haze","Atmosphere","range",0,1.5,.01],["background","Background","color"]]]];
function rgb(h){const n=parseInt(String(h).slice(1),16)||0;return [((n>>16)&255)/255,((n>>8)&255)/255,(n&255)/255];}
function create(canvas){const gl=canvas.getContext("webgl2",{antialias:false,preserveDrawingBuffer:true});if(!gl)throw new Error("WebGL2 unavailable");const compile=(t,s)=>{const x=gl.createShader(t);gl.shaderSource(x,s);gl.compileShader(x);if(!gl.getShaderParameter(x,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(x));return x;};const program=gl.createProgram();gl.attachShader(program,compile(gl.VERTEX_SHADER,VERT));gl.attachShader(program,compile(gl.FRAGMENT_SHADER,FRAG));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));const vao=gl.createVertexArray();gl.bindVertexArray(vao);const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);const a=gl.getAttribLocation(program,"a_position");gl.enableVertexAttribArray(a);gl.vertexAttribPointer(a,2,gl.FLOAT,false,0,0);const names=["resolution","source","direction","fan","beams","intensity","falloff","sharpness","dispersion","haze","starburst","coreSize","edgeGlow","streaks","streakDensity","background"],u={};names.forEach(n=>u[n]=gl.getUniformLocation(program,`u_${n}`));function resize(w,h){const d=Math.min(devicePixelRatio||1,2);canvas.width=Math.max(2,Math.round(w*d));canvas.height=Math.max(2,Math.round(h*d));gl.viewport(0,0,canvas.width,canvas.height);}function draw(s){gl.useProgram(program);gl.bindVertexArray(vao);gl.uniform2f(u.resolution,canvas.width,canvas.height);gl.uniform2f(u.source,s.sourceX,s.sourceY);["direction","fan","beams","intensity","falloff","sharpness","dispersion","haze","starburst","coreSize","edgeGlow","streaks","streakDensity"].forEach(k=>gl.uniform1f(u[k],+s[k]));gl.uniform3fv(u.background,rgb(s.background));gl.drawArrays(gl.TRIANGLES,0,3);}return{draw,resize,canvas,vertexSource:VERT,fragmentSource:FRAG};}
function mount(root){const canvas=root.querySelector("canvas"),renderer=create(canvas),panel=root.querySelector("[data-controls]"),storage="creative-editor.light-beam.v4";let state={...DEFAULTS};try{state=Object.assign(state,JSON.parse(localStorage.getItem(storage)||"{}"));}catch(_){}const save=()=>localStorage.setItem(storage,JSON.stringify(state));let preset=null;const display=(k,v)=>k==="direction"?`${Math.round(v*180/Math.PI)}°`:typeof v==="number"?v.toFixed(Number.isInteger(v)?0:2):v;GROUPS.forEach(([title,items],gi)=>{const section=document.createElement("details");section.open=gi<2;section.innerHTML=`<summary>${title}<span>⌄</span></summary><div class="sc-grid"></div>`;const grid=section.querySelector("div");items.forEach(([key,label,type,x,y,z])=>{const row=document.createElement("label");row.className=`sc-control sc-${type}`;const out=document.createElement("output");out.textContent=display(key,state[key]);const input=document.createElement("input");input.type=type;input.dataset.key=key;if(type==="range"){input.min=x;input.max=y;input.step=z;}input.value=state[key];row.append(Object.assign(document.createElement("span"),{textContent:label}),out,input);grid.append(row);input.addEventListener("input",()=>{state[key]=type==="range"?+input.value:input.value;out.textContent=display(key,state[key]);if(preset)preset.value="Custom";save();renderer.draw(state);});});panel.append(section);});const sync=()=>panel.querySelectorAll("[data-key]").forEach(i=>{i.value=state[i.dataset.key];i.parentElement.querySelector("output").textContent=display(i.dataset.key,state[i.dataset.key]);});const apply=v=>{state=Object.assign({},DEFAULTS,v);sync();save();renderer.draw(state);};preset=root.querySelector("[data-preset]");preset.add(new Option("Custom","Custom"));Object.keys(PRESETS).forEach(n=>preset.add(new Option(n,n)));preset.value="Hero beam";preset.addEventListener("change",()=>{if(preset.value!=="Custom")apply(PRESETS[preset.value]);});root.querySelector("[data-reset]").addEventListener("click",()=>{apply({});preset.value="Hero beam";});root.querySelector("[data-play]").hidden=true;root.querySelector("[data-advanced]").hidden=true;root.querySelectorAll("[data-collapse]").forEach(b=>b.addEventListener("click",()=>root.classList.toggle("panel-hidden")));root.querySelector("[data-export]").addEventListener("click",()=>{const a=document.createElement("a");a.download=`spectral-light-${Date.now()}.png`;a.href=canvas.toDataURL("image/png");a.click();});new ResizeObserver(()=>{const b=canvas.getBoundingClientRect();renderer.resize(b.width,b.height);renderer.draw(state);}).observe(canvas);renderer.draw(state);return{renderer,getState:()=>({...state}),setState:apply};}
window.LightBeamTool={create,mount,defaults:DEFAULTS,presets:PRESETS};
})();
