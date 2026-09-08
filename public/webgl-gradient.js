(() => {
  "use strict";
  const canvas=document.querySelector("#canvas"),error=document.querySelector("#error");
  const gl=canvas.getContext("webgl",{antialias:false,alpha:false,preserveDrawingBuffer:true,powerPreference:"high-performance"});
  if(!gl){error.hidden=false;error.textContent="WebGL is unavailable in this browser.";return;}
  const vs=`attribute vec2 a_position;void main(){gl_Position=vec4(a_position,0.,1.);}`;
  const fs=`
  precision highp float;
  uniform vec2 u_resolution;uniform float u_time,u_animate;
  uniform float u_width,u_height,u_radius,u_count,u_widthOffset,u_heightOffset;
  uniform float u_taperOffset,u_scale,u_rotation,u_offsetX,u_offsetY;
  uniform float u_spectrum,u_refraction,u_rim,u_absorption,u_columnHueOffset,u_saturation,u_exposure;
  uniform float u_gradientAngle,u_gradientScale,u_gradientOffset,u_mirrorX,u_mirrorY;
  uniform float u_innerGlowAmount,u_innerGlowSize,u_glowColorMix,u_driftSpeed;
  uniform float u_paletteCount;
  uniform float u_pattern,u_bendAmount,u_waveCycles,u_bendPhase;
  uniform vec3 u_background,u_glowTint,u_palette[8];
  #define PI 3.14159265359
  mat2 rot(float a){float c=cos(a),s=sin(a);return mat2(c,-s,s,c);}
  float hash21(vec2 p){p=fract(p*vec2(123.34,345.45));p+=dot(p,p+117.345);return fract(p.x*p.y);}
  // A rigid reflected repeat has unit slope: circles retain their radius and shape.
  float rigidMirrorRepeat(float x,float span){float s=max(span,.001);return abs(mod(x,2.*s)-s)-s*.5;}
  float columnWidth(float w,float n);
  float columnWidth(float w,float n){
    float taperSide=mix(n,1.-n,step(0.,u_taperOffset));
    return max(.025,w*(1.-abs(u_taperOffset)*smoothstep(0.,1.,taperSide)));
  }
  float sdTaperedRound(float x,float y,float top,float bottom,float w,float cy,float h){
    float n=clamp((y-cy)/h+.5,0.,1.),halfW=columnWidth(w,n)*.5;
    float halfH=max(0.,(bottom-top)*.5),r=min(halfW*u_radius,halfH);
    vec2 q=vec2(abs(x)-halfW,abs(y-(top+bottom)*.5)-halfH)+r;
    return length(max(q,0.))+min(max(q.x,q.y),0.)-r;
  }
  vec3 paletteStop(float i){
    if(i<.5)return u_palette[0];if(i<1.5)return u_palette[1];if(i<2.5)return u_palette[2];if(i<3.5)return u_palette[3];
    if(i<4.5)return u_palette[4];if(i<5.5)return u_palette[5];if(i<6.5)return u_palette[6];return u_palette[7];
  }
  vec3 palette(float t){
    float count=clamp(floor(u_paletteCount+.5),2.,8.),x=fract(t)*count,index=floor(x),next=mod(index+1.,count);
    return mix(paletteStop(index),paletteStop(next),smoothstep(0.,1.,fract(x)));
  }
  void main(){
    vec2 uv=gl_FragCoord.xy/u_resolution,p=uv*2.-1.;p.x*=u_resolution.x/u_resolution.y;p=(rot(-u_rotation)*p)/u_scale-vec2(u_offsetX,u_offsetY);
    float maxW=0.;
    for(int k=0;k<25;k++){float kid=float(k),active=1.-step(u_count-.5,kid);maxW=max(maxW,max(.035,u_width+kid*u_widthOffset)*active);}
    float lastId=max(0.,u_count-1.),lastH=max(.08,u_height+lastId*u_heightOffset);
    float groupTop=-max(u_height,lastH)*.5,groupBottom=max(u_height,lastH)*.5;
    float groupH=groupBottom-groupTop,groupCenter=(groupTop+groupBottom)*.5;
    vec2 fieldP=p;
    bool continuousOpen=u_mirrorY>.5&&(u_pattern<.5||u_pattern>3.5);
    vec2 mirrorId=vec2(0.);
    if(u_mirrorY>.5&&!continuousOpen){float seamInset=min(groupH*.25,maxW*.5*u_radius),verticalSpan=max(.02,groupH-2.*seamInset);fieldP.y=rigidMirrorRepeat(p.y,verticalSpan)+groupCenter;}
    float bendY=fieldP.y/max(groupH,.08),bend=0.;
    if(u_pattern>.5&&u_pattern<1.5)bend=u_bendAmount*(cos(clamp(bendY,-.5,.5)*PI)-.5);
    if(u_pattern>1.5&&u_pattern<2.5)bend=u_bendAmount*sin(bendY*2.*PI);
    if(u_pattern>3.5)bend=u_bendAmount*sin(bendY*2.*PI*u_waveCycles+u_bendPhase);
    fieldP.x-=bend;
    float rowTotal=0.;
    for(int k=0;k<25;k++){float kid=float(k),active=1.-step(u_count-.5,kid),kw=max(.035,u_width+kid*u_widthOffset),kh=max(.08,u_height+kid*u_heightOffset);float kn=clamp(fieldP.y/kh+.5,0.,1.);rowTotal+=columnWidth(kw,kn)*active;}
    if(u_mirrorY>.5){float seamInset=min(groupH*.25,maxW*.5*u_radius);mirrorId.y=floor(p.y/max(.02,groupH-2.*seamInset));}
    if(u_mirrorX>.5){mirrorId.x=floor(fieldP.x/max(rowTotal,.001));fieldP.x=rigidMirrorRepeat(fieldP.x,rowTotal);}
    float cursor=-rowTotal*.5,minD=20.,chosenX=0.,chosenY=0.,chosenW=u_width,chosenH=u_height,chosenId=0.;
    for(int j=0;j<25;j++){
      float id=float(j),active=1.-step(u_count-.5,id);
      float w=max(.035,u_width+id*u_widthOffset),h=max(.08,u_height+id*u_heightOffset),cy=0.;
      float fullY=fieldP.y-cy,n=clamp(fullY/h+.5,0.,1.);
      float wAt=columnWidth(w,n),centerX=cursor+wAt*.5;
      cursor+=wAt*active;
      float localX=fieldP.x-centerX;
      float topY=cy-h*.5,bottomY=cy+h*.5;
      float d=continuousOpen?abs(localX)-wAt*.5:sdTaperedRound(localX,fieldP.y,topY,bottomY,w,cy,h);
      d=mix(20.,d,active);
      if(d<minD){minD=d;chosenX=localX;chosenY=fieldP.y-cy;chosenW=wAt;chosenH=h;chosenId=id;}
    }
    bool isC=false;
    if(isC||(u_pattern>2.5&&u_pattern<3.5)){
      float outerR=max(.025,u_height/(2.*PI));
      for(int j=0;j<25;j++){float id=float(j);if(id>=u_count)break;outerR+=max(.035,u_width+id*u_widthOffset);}
      vec2 ringP=p;
      if(isC)ringP.x-=outerR*.5;
      float ringSpan=max(.02,outerR*1.4);
      if(u_mirrorX>.5){mirrorId.x=floor(p.x/ringSpan);ringP.x=rigidMirrorRepeat(p.x,ringSpan);}
      if(u_mirrorY>.5){mirrorId.y=floor(p.y/ringSpan);ringP.y=rigidMirrorRepeat(p.y,ringSpan);}
      minD=20.;float ringCursor=max(.025,u_height/(2.*PI)),rr=length(ringP);
      for(int j=0;j<25;j++){
        float id=float(j);if(id>=u_count)break;
        float w=max(.035,u_width+id*u_widthOffset),center=ringCursor+w*.5;
        float d=abs(rr-center)-w*.5;
        // Distance to the left semicircle, including circular endpoint caps.
        if(isC&&ringP.x>0.)d=length(vec2(ringP.x,abs(ringP.y)-center))-w*.5;
        if(d<minD){minD=d;chosenX=rr-center;chosenW=w;chosenH=2.;chosenY=atan(ringP.y,ringP.x)/PI;chosenId=id;}
        ringCursor+=w;
      }
    }
    float aa=1.2/min(u_resolution.x,u_resolution.y),mask=1.-smoothstep(-aa,aa,minD);
    vec2 bp=vec2(chosenX/max(chosenW*.5,.001),chosenY/max(chosenH*.5,.001));
    if(continuousOpen&&u_pattern>3.5)bp.y=sin((p.y/max(groupH,.08))*2.*PI*u_waveCycles+u_bendPhase);
    float radial=clamp(max(abs(bp.x),abs(bp.y)),0.,1.);
    if(continuousOpen)radial=clamp(abs(bp.x),0.,1.);
    if(isC||(u_pattern>2.5&&u_pattern<3.5))radial=clamp(abs(bp.x),0.,1.);
    float dome=sqrt(clamp(1.-radial*radial,0.,1.));
    float drift=u_animate*sin(u_time*.55)*u_driftSpeed;
    float columnHue=chosenId*u_columnHueOffset;
    vec2 gp=rot(-u_gradientAngle)*bp;
    if(isC||(u_pattern>2.5&&u_pattern<3.5))gp=vec2(bp.x,sin(chosenY*PI+u_gradientAngle));
    float gx=gp.x*.5+.5,gy=gp.y*.5+.5;
    float gradientT=(gy+(gx-.5)*.22)*u_gradientScale+u_gradientOffset+columnHue+drift;
    if(isC||(u_pattern>2.5&&u_pattern<3.5))gradientT=(.5+.5*sin(chosenY*PI+u_gradientAngle))*u_gradientScale+(gx-.5)*.22+u_gradientOffset+columnHue+drift;
    vec3 base=palette(gradientT);
    float viewBend=(1.-dome)*u_refraction;
    float optical=gradientT+u_spectrum*(dome*.18+gp.x*.035);
    vec3 film=palette(optical);
    float fresnel=pow(clamp(1.-dome,0.,1.),mix(4.5,.55,u_rim));
    vec3 color=mix(base,film,clamp(u_spectrum*.72,0.,1.));
    color=mix(color,palette(optical+viewBend+.16),fresnel*u_rim*.92);
    color*=mix(1.-u_absorption*.58,1.12,dome);
    color+=fresnel*palette(optical-.12)*u_rim*.48;
    float lum=dot(color,vec3(.2126,.7152,.0722));color=mix(vec3(lum),color,u_saturation)*u_exposure;
    float inside=max(-minD,0.);
    float innerGlow=exp(-inside/max(.002,mix(.008,.18,u_innerGlowSize)))*u_innerGlowAmount*mask;
    color+=mix(u_glowTint,palette(optical+.08),1.-u_glowColorMix)*innerGlow*.48;
    vec3 finalColor=mix(u_background,color,mask);
    finalColor+=(hash21(gl_FragCoord.xy+fract(u_time)*51.)-.5)*.008;
    gl_FragColor=vec4(pow(max(finalColor,0.),vec3(.94)),1.);
  }`;
  function compile(type,source){const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s;}
  let program;try{program=gl.createProgram();gl.attachShader(program,compile(gl.VERTEX_SHADER,vs));gl.attachShader(program,compile(gl.FRAGMENT_SHADER,fs));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));}catch(e){error.hidden=false;error.textContent=`Shader error: ${e.message}`;return;}
  const groups={
    column:[["width","Width",.06,.34,.001,.15],["height","Height",.2,3.5,.01,2.55],["radius","Rounded corners",0,1,.01,1]],
    repeat:[["count","Number of columns",1,25,1,7]],
    pattern:[["bendAmount","Bend amount",0,.65,.005,.25],["waveCycles","Wave cycles",.5,5,.05,2],["bendPhase","Wave phase",-3.1416,3.1416,.001,0,"rad"]],
    variation:[["widthOffset","Width offset per column",-.025,.025,.001,0],["heightOffset","Height offset per column",-.16,.16,.001,0],["taperOffset","Width taper offset",-.85,.85,.01,0]],
    colour:[["columnHueOffset","Colour offset per column",0,.5,.001,.16],["saturation","Saturation",0,1.5,.01,1.35],["exposure","Exposure",.3,1.6,.01,1.04]],
    gradient:[["gradientAngle","Gradient angle",-3.1416,3.1416,.001,0,"rad"],["gradientScale","Gradient scale",.25,4,.01,.72],["gradientOffset","Gradient position",-1,1,.001,0]],
    material:[["spectrum","Dispersion",0,2,.01,.78],["refraction","IOR / refraction",0,2,.01,1.4],["rim","Fresnel rim",0,1,.01,.62],["absorption","Absorption",0,1,.01,.72]],
    glow:[["innerGlowAmount","Inner glow intensity",0,2,.01,.2],["innerGlowSize","Inner glow size",0,1,.01,.24],["glowColorMix","Inner glow colour",0,1,.01,.25]],
    frame:[["scale","Scale",.35,1.25,.01,.78],["rotation","Rotation",-3.1416,3.1416,.001,0,"rad"],["offsetX","Horizontal position",-.8,.8,.001,0],["offsetY","Vertical position",-.8,.8,.001,0],["driftSpeed","Drift amount",0,.3,.001,.04]]
  };
  const state={values:{mirrorX:0,mirrorY:0,pattern:0},colors:["#8bd49d","#28cde3","#1846c7","#cb1238","#ff4e16","#fff08a"],background:"#4f80cb",glowTint:"#fff3b5",animate:false};
  Object.values(groups).flat().forEach(d=>state.values[d[0]]=d[5]);
  const params=new URLSearchParams(location.search);
  ["mirrorX","mirrorY","pattern",...Object.values(groups).flat().map(d=>d[0])].forEach(k=>{if(params.has(k)&&Number.isFinite(Number(params.get(k))))state.values[k]=Number(params.get(k));});
  const defaults=JSON.parse(JSON.stringify(state)),refs=new Map();let undo=[],redo=[],timer;
  const snap=()=>JSON.stringify(state),fill=i=>i.style.setProperty("--fill",`${(i.value-i.min)/(i.max-i.min)*100}%`);
  function remember(before){clearTimeout(timer);timer=setTimeout(()=>{if(before!==snap()){undo.push(before);redo=[];history();}},180);}
  function add(root,d){const[k,label,min,max,step,value,unit=""]=d,w=document.createElement("div"),l=document.createElement("label"),row=document.createElement("div"),r=document.createElement("input"),n=document.createElement("input"),u=document.createElement("span");w.className="control";w.dataset.control=k;l.textContent=label;l.htmlFor=`field-${k}`;row.className="control-row";r.type="range";r.id=`field-${k}`;Object.assign(r,{min,max,step,value});n.type="number";n.className="number";Object.assign(n,{min,max,step,value});n.setAttribute("aria-label",`${label} value`);u.className="unit";u.textContent=unit;const update=(raw,save=true)=>{const before=snap(),v=Math.max(min,Math.min(max,Number(raw)));state.values[k]=v;r.value=v;n.value=Number(v.toFixed(4));fill(r);if(save)remember(before);};r.oninput=()=>update(r.value);n.onchange=()=>update(n.value);update(value,false);row.append(r,n,u);w.append(l,row);root.append(w);refs.set(k,{update});}
  Object.entries(groups).forEach(([g,list])=>list.forEach(d=>add(document.querySelector(`[data-group="${g}"]`),d)));
  const palette=document.querySelector("#palette"),addColour=document.querySelector("#addColour"),MAX_COLOURS=8,MIN_COLOURS=2;
  function mixedHex(a,b){const av=rgb(a),bv=rgb(b);return `#${av.map((v,i)=>Math.round((v+bv[i])*.5*255).toString(16).padStart(2,"0")).join("")}`;}
  function buildPalette(){palette.innerHTML="";state.colors.forEach((c,i)=>{const label=document.createElement("label"),input=document.createElement("input"),remove=document.createElement("button");label.className="swatch";label.title=`Palette stop ${i+1}`;input.type="color";input.value=c;input.setAttribute("aria-label",`Palette stop ${i+1}`);input.oninput=()=>{const before=snap();state.colors[i]=input.value;remember(before);};remove.type="button";remove.className="remove-colour";remove.textContent="×";remove.title=`Delete palette stop ${i+1}`;remove.setAttribute("aria-label",`Delete palette stop ${i+1}`);remove.disabled=state.colors.length<=MIN_COLOURS;remove.onclick=e=>{e.preventDefault();const before=snap();state.colors.splice(i,1);buildPalette();remember(before);};label.append(input,remove);palette.append(label);});addColour.disabled=state.colors.length>=MAX_COLOURS;}
  addColour.onclick=()=>{if(state.colors.length>=MAX_COLOURS)return;const before=snap(),last=state.colors[state.colors.length-1],first=state.colors[0];state.colors.push(mixedHex(last,first));buildPalette();remember(before);};buildPalette();
  const background=document.querySelector("#background"),animate=document.querySelector("#animate");background.value=state.background;background.oninput=()=>{const before=snap();state.background=background.value;remember(before);};animate.checked=state.animate;animate.onchange=()=>{const before=snap();state.animate=animate.checked;remember(before);};
  function updatePatternControls(){
    const isO=state.values.pattern===3;
    document.querySelector('[data-group="pattern"]').hidden=state.values.pattern!==4;
    ["radius","heightOffset","taperOffset"].forEach(k=>{document.querySelector(`[data-control="${k}"]`).hidden=isO;});
  }
  const choices=["mirrorX","mirrorY","pattern"];choices.forEach(k=>{const el=document.querySelector(`#${k}`);el.value=state.values[k];el.onchange=()=>{const before=snap();state.values[k]=Number(el.value);if(k==="pattern")updatePatternControls();remember(before);};});updatePatternControls();
  function apply(s,save=false){const before=snap();Object.assign(state.values,s.values);state.colors=s.colors.slice();state.background=s.background;state.glowTint=s.glowTint;state.animate=s.animate;refs.forEach((r,k)=>r.update(state.values[k],false));choices.forEach(k=>document.querySelector(`#${k}`).value=state.values[k]);background.value=state.background;animate.checked=state.animate;buildPalette();updatePatternControls();if(save){undo.push(before);redo=[];history();}}
  function history(){document.querySelector("#undo").disabled=!undo.length;document.querySelector("#redo").disabled=!redo.length;}function travel(a,b){if(!a.length)return;b.push(snap());apply(JSON.parse(a.pop()));history();}document.querySelector("#undo").onclick=()=>travel(undo,redo);document.querySelector("#redo").onclick=()=>travel(redo,undo);document.querySelector("#reset").onclick=()=>apply(defaults,true);history();
  const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);gl.useProgram(program);const pos=gl.getAttribLocation(program,"a_position");gl.enableVertexAttribArray(pos);gl.vertexAttribPointer(pos,2,gl.FLOAT,false,0,0);const locs=new Map(),loc=k=>{if(!locs.has(k))locs.set(k,gl.getUniformLocation(program,`u_${k}`));return locs.get(k);},rgb=h=>{const n=parseInt(h.slice(1),16);return[(n>>16)/255,((n>>8)&255)/255,(n&255)/255];};let started=performance.now(),exportScale=1;
  function resize(){
    const stage=canvas.parentElement;
    const displayH=Math.max(1,Math.min(stage.clientHeight-56,(stage.clientWidth-44)*4/3));
    const displayW=displayH*3/4;
    canvas.style.width=`${displayW}px`;canvas.style.height=`${displayH}px`;
    const d=Math.min(devicePixelRatio||1,2)*exportScale,w=Math.max(1,Math.round(displayW*d)),h=Math.max(1,Math.round(displayH*d));
    if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
    document.querySelector("#size").textContent=`${w} × ${h}`;
  }
  function draw(now){resize();gl.viewport(0,0,canvas.width,canvas.height);gl.uniform2f(loc("resolution"),canvas.width,canvas.height);gl.uniform1f(loc("time"),(now-started)/1000);gl.uniform1f(loc("animate"),state.animate?1:0);Object.entries(state.values).forEach(([k,v])=>gl.uniform1f(loc(k),v));const packed=new Float32Array(MAX_COLOURS*3);state.colors.forEach((c,i)=>packed.set(rgb(c),i*3));gl.uniform3fv(loc("palette[0]"),packed);gl.uniform1f(loc("paletteCount"),state.colors.length);gl.uniform3fv(loc("background"),rgb(state.background));gl.uniform3fv(loc("glowTint"),rgb(state.glowTint));gl.drawArrays(gl.TRIANGLES,0,6);requestAnimationFrame(draw);}requestAnimationFrame(draw);
  const toggle=document.querySelector("#exportToggle"),menu=document.querySelector("#exportMenu");toggle.onclick=e=>{e.stopPropagation();menu.hidden=!menu.hidden;};menu.onclick=e=>e.stopPropagation();document.onclick=()=>menu.hidden=true;document.querySelectorAll("[data-scale]").forEach(b=>b.onclick=()=>{exportScale=+b.dataset.scale;resize();draw(performance.now());canvas.toBlob(blob=>{const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=`iridescent-columns-${exportScale}x.png`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);exportScale=1;},"image/png");});window.onkeydown=e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==="z"){e.preventDefault();e.shiftKey?travel(redo,undo):travel(undo,redo);}};
})();
