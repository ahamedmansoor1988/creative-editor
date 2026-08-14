/* Light engine — funnel/cone light graphic.
 *
 * The fragment shader is carried over from the Funnel Light Figma plugin
 * (~/Documents/2026_Files/My-Scripts/funnel-light-plugin), ported from WebGL1
 * to GLSL ES 300 mechanically: the derivatives extension is core in 300,
 * gl_FragColor becomes an out, and one addition — uAlphaMode — lets the light
 * carry its own alpha so it composites over the layers beneath instead of
 * painting a solid background. The optics are otherwise untouched.
 *
 * It renders into the selected shape's BOX and the editor clips it to the
 * shape's outline, so a light cone can live inside a rounded rect or ellipse.
 */
(function(){
"use strict";

const VERT=`#version 300 es
in vec2 p;
void main(){ gl_Position=vec4(p,0.0,1.0); }`;

const FRAG=`#version 300 es
precision highp float;
out vec4 fragColor;
uniform vec2 res;
uniform float throat,mouth,curvePull,intensity,density,bloom,innerGlow;
uniform float meshMix,bandFlow,falloff,leftFullFade,time,beamGlow,beamLength;
uniform float shapeMode;
uniform float uAlphaMode;
uniform vec3 deepColor,coreColor,innerColor,meshColor,bgColor;
float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p),u=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),u.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x),u.y);}
float funnelW(float x){float span=max(.001,throat+1.36);float t=clamp((throat-x)/span,0.,1.);return .005+mouth*(pow(t,curvePull)+smoothstep(.74,1.,t)*.12);}
vec3 funnelLight(float ox,float oy){
  float x=ox,y=oy,w=funnelW(x),d=abs(y)/max(w,.001);
  float aa=max(fwidth(d),.0015);
  float ins=(1.-smoothstep(1.-aa*.72,1.+aa*.72,d))*(1.-smoothstep(throat+.018,throat+.055,x));
  float ef=smoothstep(-1.34,-.92+falloff*.08,x),wf=mix(1.,smoothstep(-1.34,throat-.06,x),leftFullFade);
  float lf=ef*wf,tb=smoothstep(-.98,throat-.06,x);
  float axial=exp(-pow(abs(y)/max(w*.36,.001),2.)*density*.08);
  float body=exp(-pow(d,2.)*density*.09),eDim=smoothstep(.76,1.08,d);
  float tg=exp(-pow((x-throat)/.145,2.))*exp(-pow(y/max(w*.68,.009),2.));
  float rib=exp(-pow(abs(y)/max(w*.24,.002),2.)*density*.06);
  float n1=noise(vec2(x*3.2+2.,y*4.2)),n2=noise(vec2(x*7.-1.7,y*8.+6.)),n3=noise(vec2(x*12.+y*2.4,y*11.-1.));
  float ma=clamp(meshMix/2.5,0.,1.),fl=time*bandFlow*.12;
  float tex=mix(.82,.72+.14*n1+.07*n2+.035*n3,ma);
  float xA=clamp((x+1.36)/(throat+1.36),0.,1.);
  float mWA=smoothstep(0.,.55,xA-fl*.18)*(1.-smoothstep(.55,1.,xA-fl*.18))*(1.-d*d);
  float mWB=smoothstep(.18,.78,xA-fl*.12)*(1.-smoothstep(.78,1.1,xA-fl*.12))*(1.-d*d*.9);
  float mWC=smoothstep(.38,.92,xA-fl*.24)*(1.-smoothstep(.92,1.3,xA-fl*.24))*(1.-pow(d,1.4));
  float tB=exp(-pow((d-.5+.06*fl)/max(.2,.014),2.))*smoothstep(-1.06,-.12,x+fl*.18)*(1.-smoothstep(throat-.18,throat+.02,x));
  float lB=exp(-pow((d-.48+.05*fl)/max(.24,.014),2.))*smoothstep(-1.08,-.14,x+fl*.16)*(1.-smoothstep(throat-.2,throat+.02,x));
  float dB=exp(-pow((d*.6+.17*xA-.05*fl)/max(.36,.02),2.))*smoothstep(-1.12,-.16,x+fl*.24)*(1.-smoothstep(throat-.1,throat+.04,x));
  float iB=exp(-pow((d-.5+.24*sin((xA*3.14+fl)*2.))/max(.26,.018),2.))*smoothstep(-1.15,-.2,x+fl*.16)*(1.-smoothstep(throat-.16,throat+.03,x));
  vec3 wC=mix(coreColor,innerColor,.78),lc=deepColor*.72;
  lc+=coreColor*body*lf*tex*(.2+tb*.78)+wC*axial*lf*innerGlow*(.08+tb*.38);
  lc+=meshColor*smoothstep(.15,.92,n2)*(1.-axial)*lf*.26*ma;
  lc+=mix(coreColor,meshColor,.45)*mWA*lf*.24*ma+mix(deepColor,coreColor,.5)*mWB*lf*.26*ma+mix(coreColor,innerColor,.58)*mWC*lf*.19*ma;
  lc+=mix(coreColor,meshColor,.34)*tB*lf*.33*ma+mix(coreColor,deepColor,.38)*lB*lf*.28*ma;
  lc+=mix(innerColor,coreColor,.46)*dB*lf*.34*ma+mix(coreColor,meshColor,.22)*iB*lf*.18*ma;
  lc*=1.-eDim*.18;lc+=wC*tg*bloom*.38+mix(coreColor,innerColor,.62)*rib*innerGlow*tb*lf*.28;
  float mg=exp(-pow((x+1.05)/.42,2.))*exp(-pow(y/.78,2.))*lf*(1.-tb*.45);
  lc+=(coreColor*.18+meshColor*.08)*mg*.34;
  float wT=funnelW(throat),xR=x-throat,rR=max(beamLength,.001),tR=clamp(xR/rR,0.,1.);
  float wC2=wT*pow(max(1.-tR,0.),curvePull*.55),dC=abs(y)/max(wC2,.0008),aaC=max(fwidth(dC),.002);
  float insC=(1.-smoothstep(1.-aaC,1.+aaC,dC))*step(throat,x)*(1.-smoothstep(rR*.85,rR*1.05,xR));
  float tf=pow(1.-tR,.45),axC=exp(-pow(abs(y)/max(wC2*.38,.0005),2.)*density*.09),bdC=exp(-pow(dC,2.)*density*.09);
  vec3 cL=mix(coreColor,innerColor,.7),contLight=cL*(bdC*.85+axC*innerGlow*.35)*tf;
  return lc*ins+contLight*insC;
}
vec2 rot(vec2 v,float a){float c=cos(a),s=sin(a);return vec2(v.x*c-v.y*s,v.x*s+v.y*c);}
vec3 dirFunnel(vec2 uv,float angle,float sc){
  vec2 r=rot(uv,-angle);
  float ox=mix(-1.36,1.42,(-r.x/sc+1.)/2.),oy=r.y/sc*1.82;
  return funnelLight(ox,oy);
}
void main(){
  vec2 st=gl_FragCoord.xy/res;
  float asp=res.x/res.y;
  vec2 uv=vec2((st.x-.5)*asp,(st.y-.5));
  float sc=0.5;
  int sm=int(shapeMode+.5);
  vec3 acc=vec3(0.);
  if(sm==0){float ox=mix(-1.36,1.42,st.x),oy=(st.y-.5)*1.82;acc=funnelLight(ox,oy);}
  else if(sm==1){float ax=abs(uv.x),t=ax/sc;acc=funnelLight(mix(throat,-1.36,t),uv.y/sc*0.91);}
  else if(sm==2){float ay=abs(uv.y),t=ay/sc;acc=funnelLight(mix(throat,-1.36,t),uv.x/sc*0.91);}
  else if(sm==7){vec2 r=rot(uv,-1.5708);float ox=mix(-1.36,1.42,(r.x/sc+1.)/2.),oy=r.y/sc*.91;acc=funnelLight(ox,oy);}
  else if(sm==8){float ox=mix(-1.36,1.42,1.-st.x),oy=(st.y-.5)*1.82;acc=funnelLight(ox,oy);}
  else if(sm==14){vec2 d=vec2(abs(uv.x)+abs(uv.y),uv.x-uv.y)*.7071;float t=abs(d.x)/sc;acc=funnelLight(mix(throat,-1.36,t),d.y/sc*.91);}
  else if(sm==18){float chevX=uv.x-abs(uv.y)*.5;float t=(chevX+sc)/(2.*sc);float ox=mix(-1.36,1.42,clamp(t,0.,1.));acc=funnelLight(ox,uv.y/sc*.91);}
  else if(sm==22){float ax=abs(uv.x),t=1.-ax/sc;acc=funnelLight(mix(throat,-1.36,t),uv.y/sc*.91);}
  else if(sm==33){for(int i=0;i<8;i++){float a=float(i)*0.7854;acc+=dirFunnel(uv,a,sc)*.75;}for(int i=0;i<8;i++){float a=float(i)*0.7854+0.3927;acc+=dirFunnel(uv,a,sc)*.4;}}
  else if(sm==34){for(int i=0;i<12;i++){float a=float(i)*0.5236;acc+=dirFunnel(uv,a,sc)*.6;}for(int i=0;i<12;i++){float a=float(i)*0.5236+0.2618;acc+=dirFunnel(uv,a,sc)*.3;}}
  vec3 lit=acc*intensity;
  vec3 col=clamp(bgColor+lit,0.,1.);
  // uAlphaMode>0.5: drop the flat background and let the light itself carry
  // alpha, so the cone glows over whatever sits beneath it in the document.
  float a=uAlphaMode>0.5 ? clamp(max(max(lit.r,lit.g),lit.b)*1.35,0.,1.) : 1.0;
  fragColor=vec4(uAlphaMode>0.5?clamp(lit,0.,1.):col, a);
}`;

const UNIFORMS=['res','throat','mouth','curvePull','intensity','density','bloom','innerGlow',
  'meshMix','bandFlow','falloff','leftFullFade','time','beamGlow','beamLength','shapeMode',
  'uAlphaMode','deepColor','coreColor','innerColor','meshColor','bgColor'];

// mode ids are the shader's own switch values, not indices
const MODES=[
  {id:0,label:'Single'},{id:1,label:'Mirror H'},{id:2,label:'Mirror V'},
  {id:7,label:'Rotate 90°'},{id:8,label:'Rotate 180°'},{id:14,label:'Diamond'},
  {id:18,label:'Chevron'},{id:22,label:'Bowtie'},{id:33,label:'Star 8'},{id:34,label:'Star 12'},
];

let gl=null,cv=null,prog=null,loc=null,vao=null,failed=false;

function init(){
  if(gl||failed) return !failed;
  try{
    cv=document.createElement('canvas');
    gl=cv.getContext('webgl2',{premultipliedAlpha:false,antialias:false});
    if(!gl) throw new Error('WebGL2 unavailable');
    const compile=(t,s)=>{
      const sh=gl.createShader(t); gl.shaderSource(sh,s); gl.compileShader(sh);
      if(!gl.getShaderParameter(sh,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      return sh;
    };
    prog=gl.createProgram();
    gl.attachShader(prog,compile(gl.VERTEX_SHADER,VERT));
    gl.attachShader(prog,compile(gl.FRAGMENT_SHADER,FRAG));
    gl.linkProgram(prog);
    if(!gl.getProgramParameter(prog,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    loc={position:gl.getAttribLocation(prog,'p')};
    UNIFORMS.forEach(n=>loc[n]=gl.getUniformLocation(prog,n));
    const buf=gl.createBuffer();
    vao=gl.createVertexArray(); gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER,buf);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1, 3,-1, -1,3]),gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc.position);
    gl.vertexAttribPointer(loc.position,2,gl.FLOAT,false,0,0);
    return true;
  }catch(e){
    console.warn('light engine disabled:',e.message);
    failed=true; gl=null; return false;
  }
}

const hex3=h=>{
  const n=parseInt((h||'#000000').slice(1),16);
  return [((n>>16)&255)/255,((n>>8)&255)/255,(n&255)/255];
};

/** Render the light into a w x h canvas. Returns it, or null if unavailable. */
function render(w,h,P){
  if(!init()) return null;
  w=Math.max(2,Math.round(w)); h=Math.max(2,Math.round(h));
  cv.width=w; cv.height=h;
  gl.viewport(0,0,w,h);
  gl.useProgram(prog);
  gl.bindVertexArray(vao);
  gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.uniform2f(loc.res,w,h);
  gl.uniform1f(loc.throat,P.throat);
  gl.uniform1f(loc.mouth,P.mouth);
  gl.uniform1f(loc.curvePull,P.curve);
  gl.uniform1f(loc.intensity,P.intensity);
  gl.uniform1f(loc.density,P.density);
  gl.uniform1f(loc.bloom,P.bloom);
  gl.uniform1f(loc.innerGlow,P.innerGlow);
  gl.uniform1f(loc.meshMix,P.meshMix);
  gl.uniform1f(loc.bandFlow,P.bandFlow);
  gl.uniform1f(loc.falloff,P.falloff);
  gl.uniform1f(loc.leftFullFade,P.leftFade);
  gl.uniform1f(loc.beamGlow,P.beamGlow);
  gl.uniform1f(loc.beamLength,P.beamLength);
  gl.uniform1f(loc.shapeMode,P.mode);
  gl.uniform1f(loc.uAlphaMode,P.transparent?1:0);
  // Static document: `time` is a phase, so Band Shift stays a normal
  // parameter rather than an animation the export could not capture.
  gl.uniform1f(loc.time,1.0);
  const c3=(n,hex)=>{ const c=hex3(hex); gl.uniform3f(loc[n],c[0],c[1],c[2]); };
  c3('deepColor',P.deep); c3('coreColor',P.core); c3('innerColor',P.inner);
  c3('meshColor',P.mesh); c3('bgColor',P.bg);
  gl.drawArrays(gl.TRIANGLES,0,3);
  return cv;
}

window.LightEngine={render,available:()=>init(),MODES};
})();
