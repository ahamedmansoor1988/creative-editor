/* Shape Divider Tool — editable analytic shape + stackable divider layers. */
(function () {
  "use strict";
  const VERTEX=`#version 300 es
  in vec2 a_position;out vec2 v_uv;void main(){v_uv=a_position*.5+.5;gl_Position=vec4(a_position,0.,1.);}`;
  const FRAGMENT=`#version 300 es
  precision highp float;in vec2 v_uv;out vec4 fragColor;
  uniform vec2 u_resolution;
  uniform float u_shape,u_size,u_aspect,u_roundness,u_sides,u_edgeSmooth,u_intersectionSmooth;
  uniform vec3 u_fill,u_background;
  uniform float u_enabled[12],u_kind[12],u_angle[12],u_count[12],u_spacing[12],u_width[12],u_offset[12],u_curve[12],u_smooth[12];
  #define PI 3.14159265359
  mat2 rot(float a){float c=cos(a),s=sin(a);return mat2(c,-s,s,c);}
  float sdBox(vec2 p,vec2 b,float r){vec2 q=abs(p)-b+r;return length(max(q,0.))+min(max(q.x,q.y),0.)-r;}
  float sdStar(vec2 p){
    const vec2 k1=vec2(.809016994,-.587785252),k2=vec2(-k1.x,k1.y);p.x=abs(p.x);
    p-=2.*max(dot(k1,p),0.)*k1;p-=2.*max(dot(k2,p),0.)*k2;p.x=abs(p.x);p.y-=.72;
    vec2 ba=.48*vec2(-k1.y,k1.x)-vec2(0.,1.);float h=clamp(dot(p,ba)/dot(ba,ba),0.,.72);
    return length(p-ba*h)*sign(p.y*ba.x-p.x*ba.y);
  }
  float sdPolygon(vec2 p,float n,float r){float a=atan(p.y,p.x)+PI;float sector=2.*PI/n;return cos(floor(.5+a/sector)*sector-a)*length(p)-r;}
  float body(vec2 p){
    p.x/=max(u_aspect,.1);
    if(u_shape<.5)return length(p)-.72;
    if(u_shape<1.5)return sdBox(p,vec2(.66,.58),mix(.01,.34,u_roundness));
    if(u_shape<2.5)return sdPolygon(p,max(u_sides,3.),.72);
    if(u_shape<3.5)return sdStar(p);
    return abs(length(p)-.52)-mix(.08,.25,u_roundness);
  }
  float smin(float a,float b,float k){float h=clamp(.5+.5*(b-a)/max(k,.0001),0.,1.);return mix(b,a,h)-k*h*(1.-h);}
  float smax(float a,float b,float k){return -smin(-a,-b,k);}
  float divider(vec2 p,int index){
    float angle=0.,count=1.,spacing=.2,width=.03,offset=0.,curve=0.,joinSoftness=.01,kind=0.;
    for(int i=0;i<12;i++)if(i==index){angle=u_angle[i];count=u_count[i];spacing=u_spacing[i];width=u_width[i];offset=u_offset[i];curve=u_curve[i];joinSoftness=u_smooth[i];kind=u_kind[i];}
    vec2 q=rot(angle)*p;float d=10.;
    if(kind<2.5){
      for(int j=0;j<12;j++){
        float fj=float(j);if(fj>=count)continue;
        // Count always means visible divisions. Spacing is a normalized
        // spread control, distributed across the useful shape diameter.
        float fittedStep=count<=1.?0.:1.34/max(count-1.,1.);
        float actualSpacing=fittedStep*mix(.28,1.12,spacing);
        float center=(fj-(count-1.)*.5)*actualSpacing+offset;
        float bend=kind<.5?0.:curve*(q.x*q.x-.22);
        if(kind>1.5)bend=curve*sin(q.x*3.2);
        float line=abs(q.y-center-bend)-width;
        d=smin(d,line,joinSoftness);
      }
    }else{
      float a=atan(q.y,q.x)+offset;float stepA=PI/max(count,1.);float spoke=abs(mod(a+stepA*.5,stepA)-stepA*.5)*length(q)-width;
      d=spoke;
    }
    return d;
  }
  void main(){
    vec2 p=v_uv*2.-1.;p.x*=u_resolution.x/max(u_resolution.y,1.);p/=max(u_size,.05);
    float shapeD=body(p),cuts=10.;
    for(int i=0;i<12;i++){
      float layerOn=0.;for(int j=0;j<12;j++)if(j==i)layerOn=u_enabled[j];
      if(layerOn>.5)cuts=smin(cuts,divider(p,i),mix(.001,.16,u_intersectionSmooth));
    }
    // Smooth subtraction rounds every corner where a divider meets the
    // silhouette, while the cut-field smooth-min rounds divider crossings.
    float resultD=smax(shapeD,-cuts,mix(.002,.13,u_edgeSmooth));
    float aa=max(fwidth(resultD),.0005)*1.15;
    float mask=1.-smoothstep(-aa,aa,resultD);
    fragColor=vec4(mix(u_background,u_fill,mask),1.);
  }`;

  const SHAPES=["Circle","Rounded rectangle","Polygon","Star","Ring"];
  const KINDS=["Straight lines","Parabolic curves","Wave lines","Radial spokes"];
  const MAX_DIVIDERS=12;
  const DEFAULTS={shape:0,size:.82,aspect:1,roundness:.45,sides:6,intersectionSmooth:.3,fill:"#5b88e5",background:"#ffffff",dividerCount:1,
    enabled0:1,kind0:0,angle0:0,count0:1,spacing0:.75,width0:.035,offset0:0,curve0:.3,smooth0:.025,
    enabled1:0,kind1:0,angle1:1.5708,count1:1,spacing1:.75,width1:.035,offset1:0,curve1:.3,smooth1:.025,
    enabled2:0,kind2:1,angle2:.3,count2:3,spacing2:.72,width2:.026,offset2:0,curve2:.35,smooth2:.025};
  for(let i=3;i<MAX_DIVIDERS;i++){
    DEFAULTS[`enabled${i}`]=0;DEFAULTS[`kind${i}`]=0;DEFAULTS[`angle${i}`]=(i%2)*1.5708;
    DEFAULTS[`count${i}`]=1;DEFAULTS[`spacing${i}`]=.75;DEFAULTS[`width${i}`]=.035;
    DEFAULTS[`offset${i}`]=0;DEFAULTS[`curve${i}`]=.3;DEFAULTS[`smooth${i}`]=.025;
  }
  const PRESETS={
    "Single split":{},
    "Cross":{dividerCount:2,enabled1:1},
    "Parallel bands":{count0:4,spacing0:.76,width0:.026},
    "Curved bands":{kind0:1,count0:3,spacing0:.78,width0:.025,curve0:.5},
    "Soft lattice":{dividerCount:2,enabled1:1,count0:3,count1:3,spacing0:.72,spacing1:.72,width0:.024,width1:.024,smooth0:.07,smooth1:.07},
    "Radial flower":{kind0:3,count0:4,width0:.028,roundness:.7},
    "Mixed field":{dividerCount:2,kind0:1,count0:3,spacing0:.7,curve0:.42,enabled1:1,kind1:0,count1:2,spacing1:.75,angle1:1.5708},
  };
  function rgb(h){const n=parseInt(String(h).slice(1),16)||0;return [((n>>16)&255)/255,((n>>8)&255)/255,(n&255)/255];}
  function create(canvas){
    const gl=canvas.getContext("webgl2",{antialias:false,preserveDrawingBuffer:true});if(!gl)throw new Error("WebGL2 unavailable");
    const compile=(t,s)=>{const x=gl.createShader(t);gl.shaderSource(x,s);gl.compileShader(x);if(!gl.getShaderParameter(x,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(x));return x;};
    const program=gl.createProgram();gl.attachShader(program,compile(gl.VERTEX_SHADER,VERTEX));gl.attachShader(program,compile(gl.FRAGMENT_SHADER,FRAGMENT));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));
    const vao=gl.createVertexArray();gl.bindVertexArray(vao);const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);const a=gl.getAttribLocation(program,"a_position");gl.enableVertexAttribArray(a);gl.vertexAttribPointer(a,2,gl.FLOAT,false,0,0);
    const names=["resolution","shape","size","aspect","roundness","sides","edgeSmooth","intersectionSmooth","fill","background","enabled","kind","angle","count","spacing","width","offset","curve","smooth"],u={};names.forEach(n=>u[n]=gl.getUniformLocation(program,`u_${n}`));
    function resize(w,h){const d=Math.min(devicePixelRatio||1,2);canvas.width=Math.max(2,Math.round(w*d));canvas.height=Math.max(2,Math.round(h*d));gl.viewport(0,0,canvas.width,canvas.height);}
    function draw(s){gl.useProgram(program);gl.bindVertexArray(vao);gl.uniform2f(u.resolution,canvas.width,canvas.height);["shape","size","aspect","roundness","sides","intersectionSmooth"].forEach(k=>gl.uniform1f(u[k],+s[k]));gl.uniform1f(u.edgeSmooth,+s.intersectionSmooth);gl.uniform3fv(u.fill,rgb(s.fill));gl.uniform3fv(u.background,rgb(s.background));["enabled","kind","angle","count","spacing","width","offset","curve","smooth"].forEach(k=>{const values=new Float32Array(MAX_DIVIDERS);for(let i=0;i<MAX_DIVIDERS;i++)values[i]=i<s.dividerCount?+s[`${k}${i}`]:0;gl.uniform1fv(u[k],values);});gl.drawArrays(gl.TRIANGLES,0,3);}
    return {draw,resize,canvas,vertexSource:VERTEX,fragmentSource:FRAGMENT};
  }
  const baseGroups=[
    ["Shape",[["shape","Shape","select",SHAPES],["size","Size","range",.25,1.1,.01],["aspect","Width / height","range",.45,1.8,.01],["roundness","Roundness","range",0,1,.01],["sides","Polygon sides","range",3,12,1],["intersectionSmooth","Smoothness","range",0,1,.01],["fill","Color","color"],["background","Background","color"]]],
  ];
  const dividerItems=i=>[[`enabled${i}`,"Enabled","checkbox"],[`kind${i}`,"Style","select",KINDS],[`angle${i}`,"Rotate","range",-3.1416,3.1416,.01],[`count${i}`,"Lines","range",1,12,1],[`spacing${i}`,"Spread","range",.1,1,.01],[`width${i}`,"Width","range",.004,.14,.001],[`offset${i}`,"Position","range",-.7,.7,.01],[`curve${i}`,"Curve","range",-.6,.6,.01],[`smooth${i}`,"Layer smoothing","range",.001,.15,.001]];
  function mount(root){
    const canvas=root.querySelector("canvas"),renderer=create(canvas),panel=root.querySelector("[data-controls]"),storage="creative-editor.shape-divider-tool.v3";let state={...DEFAULTS};try{state=Object.assign(state,JSON.parse(localStorage.getItem(storage)||"{}"));}catch(_){}
    const save=()=>localStorage.setItem(storage,JSON.stringify(state));const groups=baseGroups.concat(Array.from({length:MAX_DIVIDERS},(_,i)=>[i===0?"Main divider":`Divider ${i+1}`,dividerItems(i)]));
    const advancedKeys=new Set(["aspect","sides","background","enabled0","offset0","offset1","offset2","smooth0","smooth1","smooth2"]);
    for(let i=3;i<MAX_DIVIDERS;i++){advancedKeys.add(`offset${i}`);advancedKeys.add(`smooth${i}`);}
    const display=(k,v)=>k==="shape"?SHAPES[v]:k.startsWith("kind")?KINDS[v]:k.startsWith("angle")?`${Math.round(v*180/Math.PI)}°`:typeof v==="number"?v.toFixed(Number.isInteger(v)?0:3):v;
    let presetSelect=null;
    groups.forEach(([title,items],gi)=>{const section=document.createElement("details");section.open=gi<2;if(gi>0)section.dataset.dividerIndex=gi-1;section.innerHTML=`<summary>${title}<span>⌄</span></summary><div class="sc-grid"></div>`;const grid=section.querySelector("div");items.forEach(([key,label,type,x,y,z])=>{const row=document.createElement("label");row.className=`sc-control sc-${type}${advancedKeys.has(key)?" is-advanced":""}`;row.dataset.controlKey=key;const out=document.createElement("output");out.textContent=display(key,state[key]);const input=document.createElement(type==="select"?"select":"input");input.dataset.key=key;if(type==="select")x.forEach((n,i)=>input.add(new Option(n,i)));else{input.type=type;if(type==="range"){input.min=x;input.max=y;input.step=z;}}if(type==="checkbox")input.checked=!!state[key];else input.value=state[key];row.append(Object.assign(document.createElement("span"),{textContent:label}),out,input);grid.append(row);input.addEventListener("input",()=>{state[key]=type==="checkbox"?(input.checked?1:0):type==="range"||type==="select"?+input.value:input.value;out.textContent=display(key,state[key]);if(presetSelect)presetSelect.value="Custom";refreshRelevant();save();renderer.draw(state);});});panel.append(section);});
    const addDivider=document.createElement("button");addDivider.type="button";addDivider.className="sc-add-divider";addDivider.textContent="＋ Add divider";panel.append(addDivider);
    function refreshRelevant(){
      const toggle=(key,show)=>{const row=panel.querySelector(`[data-control-key="${key}"]`);if(row)row.classList.toggle("is-irrelevant",!show);};
      toggle("roundness",state.shape===1||state.shape===4);
      for(let i=0;i<MAX_DIVIDERS;i++){
        const kind=+state[`kind${i}`];
        toggle(`curve${i}`,kind===1||kind===2);
        toggle(`spacing${i}`,kind!==3);
      }
      panel.querySelectorAll("details[data-divider-index]").forEach(section=>{section.hidden=+section.dataset.dividerIndex>=state.dividerCount;});
      addDivider.disabled=state.dividerCount>=MAX_DIVIDERS;
      addDivider.textContent=addDivider.disabled?"Maximum 12 dividers":"＋ Add divider";
    }
    const sync=()=>panel.querySelectorAll("[data-key]").forEach(i=>{const v=state[i.dataset.key];if(i.type==="checkbox")i.checked=!!v;else i.value=v;i.parentElement.querySelector("output").textContent=display(i.dataset.key,v);});const apply=v=>{state=Object.assign({},DEFAULTS,v);sync();refreshRelevant();save();renderer.draw(state);};
    presetSelect=root.querySelector("[data-preset]");presetSelect.add(new Option("Custom","Custom"));Object.keys(PRESETS).forEach(n=>presetSelect.add(new Option(n,n)));presetSelect.value="Single split";presetSelect.addEventListener("change",()=>{if(presetSelect.value!=="Custom")apply(PRESETS[presetSelect.value]);});root.querySelector("[data-reset]").addEventListener("click",()=>{apply({});presetSelect.value="Single split";});addDivider.addEventListener("click",()=>{if(state.dividerCount>=MAX_DIVIDERS)return;const index=state.dividerCount++;["kind","angle","count","spacing","width","offset","curve","smooth"].forEach(key=>{state[`${key}${index}`]=DEFAULTS[`${key}${index}`];});state[`enabled${index}`]=1;presetSelect.value="Custom";sync();refreshRelevant();const section=panel.querySelector(`details[data-divider-index="${index}"]`);if(section)section.open=true;save();renderer.draw(state);});root.querySelector("[data-play]").hidden=true;const advanced=root.querySelector("[data-advanced]");advanced.addEventListener("click",()=>{const shown=root.classList.toggle("show-advanced");advanced.textContent=shown?"Fewer controls":"More controls";});root.querySelectorAll("[data-collapse]").forEach(b=>b.addEventListener("click",()=>root.classList.toggle("panel-hidden")));root.querySelector("[data-export]").addEventListener("click",()=>{const a=document.createElement("a");a.download=`divided-shape-${Date.now()}.png`;a.href=canvas.toDataURL("image/png");a.click();});refreshRelevant();new ResizeObserver(()=>{const b=canvas.getBoundingClientRect();renderer.resize(b.width,b.height);renderer.draw(state);}).observe(canvas);renderer.draw(state);return {renderer,getState:()=>({...state}),setState:apply};
  }
  window.ShapeDividerTool={create,mount,defaults:DEFAULTS,presets:PRESETS,shapes:SHAPES,kinds:KINDS};
})();
