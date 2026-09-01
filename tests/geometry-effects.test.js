// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { loadEditor } from "./helpers/load-editor.js";

let editor;
const image=(w,h,fn)=>{
  const data=new Uint8ClampedArray(w*h*4);
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    const i=(y*w+x)*4, p=fn(x,y);
    data.set([p[0],p[1],p[2],p[3]??255],i);
  }
  return {data};
};
const changed=(a,b)=>a.some((v,i)=>v!==b[i]);
function layer(type="rect",effects={}){
  editor.doc={frame:{name:"Geometry",w:500,h:400,bg:"#fff",artboards:[],children:[{
    type,name:"Target",x:20,y:20,w:200,h:160,text:type==="text"?"Warp":undefined,
    fill:{kind:"solid",color:"#8090a0"},effects,
  }]}};
  return editor.doc.frame.children[0];
}
beforeAll(()=>{({editor}=loadEditor());});

describe("Batch 8 geometry effects",()=>{
  it("normalizes all three capabilities and preserves stack aliases",()=>{
    const o=layer("rect",{
      distortion:{mode:"bad",amount:999,radius:0,edge:"bad"},
      warp:{envelope:"bad",strength:-999,axis:"bad",edge:"bad"},
      displacement:{scaleX:999,scaleY:-999,mapScale:0,seed:999999,edge:"bad"},
    });
    expect(o.effects.distortion).toMatchObject({mode:"wave",amount:200,radius:.05,edge:"clamp"});
    expect(o.effects.warp).toMatchObject({envelope:"arc",strength:-100,axis:"horizontal",edge:"clamp"});
    expect(o.effects.displacement).toMatchObject({scaleX:300,scaleY:-300,mapScale:.05,seed:99999,edge:"clamp"});
    for(const key of ["distortion","warp","displacement"])
      expect(o.fx.find(e=>e.type===key).params).toBe(o.effects[key]);
  });

  it("keeps zero-strength geometry passes out of the active stack",()=>{
    expect(window.FxStack.entryOn({type:"distortion",params:{amount:0}})).toBe(false);
    expect(window.FxStack.entryOn({type:"warp",params:{strength:0}})).toBe(false);
    expect(window.FxStack.entryOn({type:"displacement",params:{scaleX:0,scaleY:0}})).toBe(false);
  });

  it("renders Distortion modes as real pixel remaps",()=>{
    for(const mode of ["wave","twirl","bulge","ripple"]){
      const img=image(24,24,(x,y)=>[x*10,y*10,(x+y)*5,255]), before=[...img.data];
      window.Filters.distortionPixels(img,24,24,{mode,amount:40,wavelength:.2,phase:20,axis:"both",radius:1,cx:0,cy:0,edge:"clamp"},{});
      expect(changed([...img.data],before),mode).toBe(true);
    }
  });

  it("renders every Warp envelope",()=>{
    for(const envelope of window.Filters.ENVELOPES){
      const img=image(24,24,(x,y)=>[x*10,y*10,80,255]), before=[...img.data];
      window.Filters.warpPixels(img,24,24,{envelope,strength:45,axis:"horizontal",edge:"clamp"},{});
      expect(changed([...img.data],before),envelope).toBe(true);
    }
  });

  it("uses procedural displacement when renderer options contain no map",()=>{
    const p={scaleX:20,scaleY:12,channel:"luminance",mapScale:1,seed:42,edge:"clamp"};
    const a=image(24,24,(x,y)=>[x*10,y*10,100,255]), before=[...a.data];
    const b=image(24,24,(x,y)=>[x*10,y*10,100,255]);
    window.Filters.displacementPixels(a,24,24,p,{draft:false});
    window.Filters.displacementPixels(b,24,24,p,{draft:false});
    expect(changed([...a.data],before)).toBe(true);
    expect([...a.data]).toEqual([...b.data]);
  });

  it("does not create dark RGB fringes at transformed transparent edges",()=>{
    const img=image(32,32,(x,y)=>x>=8&&x<24&&y>=8&&y<24?[255,30,20,255]:[0,0,0,0]);
    window.Filters.warpPixels(img,32,32,{envelope:"arc",strength:35,axis:"horizontal",edge:"clamp"},{});
    const semis=[];
    for(let i=0;i<img.data.length;i+=4) if(img.data[i+3]>0&&img.data[i+3]<255) semis.push(img.data[i]);
    expect(semis.length).toBeGreaterThan(0);
    expect(Math.min(...semis)).toBeGreaterThanOrEqual(254);
  });

  it("offers all three on shapes, text, and images",()=>{
    for(const type of ["rect","text","image"]){
      const o=layer(type,{distortion:{amount:10},warp:{strength:10},displacement:{scaleX:10}});
      expect(editor.FX_PAGES(o)).toEqual(expect.arrayContaining(["Distortion","Warp","Displacement"]));
    }
  });
});
