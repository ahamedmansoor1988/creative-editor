/* Lens blur — what a camera does to something out of focus (the page Camera).
 *
 * WHY NOT A GAUSSIAN. A Gaussian is what a blurred photograph is NOT: it
 * dims a bright point into a grey smudge. A lens spreads every point into the
 * shape of its aperture — a disc, or a polygon when the iris has blades — and
 * a bright point stays bright, so highlights bloom into bokeh. This gathers
 * light over that shape, giving bright samples more weight than their share,
 * which is how highlights survive the spread.
 *
 * THE KERNEL. 112 samples on a Vogel (golden-angle) spiral fill the disc
 * evenly at any radius. For B blades each sample's radius is scaled by the
 * polygon's boundary at its angle, cos(pi/B) / cos(theta mod (2pi/B) - pi/B),
 * so the same samples fill a B-gon instead.
 *
 * THE LENS. cocPx() is the thin-lens circle of confusion: blur grows with the
 * aperture (1/f-number) and with |d - focus| / d, so something in front of
 * the focus softens far faster than something the same distance behind it.
 * Depth 0..1 is a distance from 0.5 to 5 (arbitrary units; only the ratio
 * matters), the same mapping the Light burst shader uses.
 *
 * Input and output are premultiplied canvases of the same size; the caller
 * pads the layer by the radius so the spread is not cut off.
 */
(function(){
"use strict";

const SAMPLES=112;

const VERT=`#version 300 es
in vec2 a_pos;
void main(){ gl_Position=vec4(a_pos,0.0,1.0); }`;

const FRAG=`#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform vec2 u_res;
uniform float u_radius, u_blades, u_rot, u_highlight;
out vec4 fragColor;
void main(){
  vec2 px=gl_FragCoord.xy;
  vec4 acc=vec4(0.0);
  float wsum=0.0;
  float n=u_blades;
  for(int i=0;i<${SAMPLES};i++){
    float fi=float(i);
    float rr=sqrt((fi+0.5)/${SAMPLES}.0);
    float th=fi*2.39996323+u_rot;
    if(n>=3.0){
      float seg=6.2831853/n;
      float a=mod(th-u_rot,seg)-seg*0.5;
      rr*=cos(3.14159265/n)/cos(a);
    }
    vec2 off=vec2(cos(th),sin(th))*rr*u_radius;
    vec4 c=texture(u_src,(px+off)/u_res);
    // bright samples weigh more: a highlight keeps its punch instead of
    // averaging away, which is what makes the disc read as bokeh
    // A screen's white is a lamp's dimmest: a real light is many times
    // brighter, so its bokeh stays bright. Near-white samples are treated as
    // that much brighter (up to ~30x at full Highlight bloom).
    float l=dot(c.rgb,vec3(0.299,0.587,0.114));
    float l3=l*l*l;
    float w=1.0+u_highlight*30.0*l3*l3;
    acc+=c*w; wsum+=w;
  }
  fragColor=acc/wsum;
}`;

let gl=null, cv=null, prog=null, vao=null, tex=null, loc=null, failed=false;

function init(){
  if(gl) return true;
  if(failed) return false;
  try{
    cv=document.createElement('canvas');
    gl=cv.getContext('webgl2',{preserveDrawingBuffer:true,antialias:false,alpha:true,premultipliedAlpha:true});
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
    gl.useProgram(prog);
    vao=gl.createVertexArray(); gl.bindVertexArray(vao);
    const buf=gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER,buf);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1, 3,-1, -1,3]),gl.STATIC_DRAW);
    const a=gl.getAttribLocation(prog,'a_pos');
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a,2,gl.FLOAT,false,0,0);
    tex=gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D,tex);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    // transparent outside the layer, not its edge pixels stretched
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    loc={src:gl.getUniformLocation(prog,'u_src'),res:gl.getUniformLocation(prog,'u_res'),
      radius:gl.getUniformLocation(prog,'u_radius'),blades:gl.getUniformLocation(prog,'u_blades'),
      rot:gl.getUniformLocation(prog,'u_rot'),highlight:gl.getUniformLocation(prog,'u_highlight')};
    return true;
  }catch(e){
    console.warn('lens blur disabled:',e.message);
    failed=true; gl=null; return false;
  }
}

/** Blur a premultiplied canvas through a lens. Returns a canvas of the same
 *  size (a 2D copy, since the GL canvas is shared), or the input unchanged. */
function blur(src,P){
  P=P||{};
  const r=Math.max(0,+P.radius||0);
  if(r<0.6||!init()) return src;
  const W=src.width, H=src.height;
  if(!(W>0&&H>0)) return src;
  if(cv.width!==W||cv.height!==H){ cv.width=W; cv.height=H; }
  gl.viewport(0,0,W,H);
  gl.useProgram(prog);
  gl.bindVertexArray(vao);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D,tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,true);
  // canvas rows run top-down, GL rows bottom-up; read and write the same way
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,src);
  gl.uniform1i(loc.src,0);
  gl.uniform2f(loc.res,W,H);
  gl.uniform1f(loc.radius,r);
  const b=Math.round(+P.blades||0);
  gl.uniform1f(loc.blades,b>=3?b:0);
  gl.uniform1f(loc.rot,(+P.rotation||0)*Math.PI/180);
  gl.uniform1f(loc.highlight,Math.max(0,+P.highlight||0));
  gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES,0,3);
  const out=document.createElement('canvas');
  out.width=W; out.height=H;
  out.getContext('2d').drawImage(cv,0,0);
  return out;
}

/** Thin-lens circle of confusion, as a fraction (0..~3) before scaling. */
function coc(depth,focus,fstop){
  const d=0.5+4.5*Math.min(1,Math.max(0,+depth||0));
  const df=0.5+4.5*Math.min(1,Math.max(0,+focus||0));
  return (1/Math.max(1,+fstop||2.8))*Math.abs(d-df)/d;
}

window.LensBlurEngine={blur,coc,available:()=>init(),SAMPLES};
})();
