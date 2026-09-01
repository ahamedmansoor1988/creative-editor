// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { loadEditor } from "./helpers/load-editor.js";

let editor;

function layer(type="rect", colorAdjust={}) {
  editor.doc={frame:{name:"Color",w:600,h:400,bg:"#fff",artboards:[],children:[{
    type,name:"Target",x:100,y:80,w:240,h:180,text:type==="text"?"Color":undefined,
    fill:{kind:"solid",color:"#6688aa"},effects:{colorAdjust},
  }]}};
  return editor.doc.frame.children[0];
}

function pixels(rgb, params) {
  const img={data:new Uint8ClampedArray([...rgb,255])};
  window.Filters.colorAdjustPixels(img,1,1,params);
  return [...img.data.slice(0,3)];
}
const lum=rgb=>.2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];

beforeAll(()=>{ ({editor}=loadEditor()); });

describe("shared Color Adjustments capability",()=>{
  it("normalizes and clamps one reusable parameter object",()=>{
    const o=layer("rect",{exposure:9,brightness:-5,contrast:4,saturation:-7,vibrance:3,highlights:2,shadows:-2});
    expect(o.effects.colorAdjust).toEqual({exposure:3,blackPoint:0,whitePoint:1,brightness:-1,contrast:1,
      brilliance:0,gamma:1,saturation:-1,vibrance:1,temperature:0,tint:0,highlights:1,shadows:-1,
      filterColor:'#ffffff',filterAmount:0,definition:0});
    expect(o.fx.find(e=>e.type==="colorAdjust").params).toBe(o.effects.colorAdjust);
  });

  it("is neutral at zero and active when any shared control changes",()=>{
    const p={exposure:0,brightness:0,contrast:0,saturation:0,vibrance:0,highlights:0,shadows:0};
    expect(pixels([70,130,210],p)).toEqual([70,130,210]);
    expect(window.FxStack.entryOn({type:"colorAdjust",on:true,params:p})).toBe(false);
    p.contrast=.1;
    expect(window.FxStack.entryOn({type:"colorAdjust",on:true,params:p})).toBe(true);
  });

  it("changes actual pixels and keeps alpha untouched",()=>{
    const original=[80,120,160];
    expect(pixels(original,{exposure:1})).not.toEqual(original);
    const gray=pixels(original,{saturation:-1});
    expect(Math.max(...gray)-Math.min(...gray)).toBeLessThanOrEqual(1);
  });

  it("keeps every tonal slider directionally correct",()=>{
    const neutral={exposure:0,brightness:0,contrast:0,saturation:0,vibrance:0,highlights:0,shadows:0};
    for(const key of ["exposure","brightness","highlights","shadows"]){
      const level=key==="highlights"?220:key==="shadows"?35:120;
      const base=lum(pixels([level,level,level],neutral));
      expect(lum(pixels([level,level,level],{...neutral,[key]:.5})),key+" positive").toBeGreaterThan(base);
      expect(lum(pixels([level,level,level],{...neutral,[key]:-.5})),key+" negative").toBeLessThan(base);
    }
  });

  it("targets highlights and shadows instead of shifting the whole image equally",()=>{
    const n={exposure:0,brightness:0,contrast:0,saturation:0,vibrance:0,highlights:0,shadows:0};
    const hiDark=lum(pixels([35,35,35],{...n,highlights:.7}))-35;
    const hiBright=lum(pixels([220,220,220],{...n,highlights:.7}))-220;
    const shDark=lum(pixels([35,35,35],{...n,shadows:.7}))-35;
    const shBright=lum(pixels([220,220,220],{...n,shadows:.7}))-220;
    expect(hiBright).toBeGreaterThan(hiDark);
    expect(shDark).toBeGreaterThan(shBright);
  });

  it("keeps saturation and vibrance neutral on grayscale, while contrast expands tones",()=>{
    const n={exposure:0,brightness:0,contrast:0,saturation:0,vibrance:0,highlights:0,shadows:0};
    expect(pixels([110,110,110],{...n,saturation:1})).toEqual([110,110,110]);
    expect(pixels([110,110,110],{...n,vibrance:1})).toEqual([110,110,110]);
    expect(lum(pixels([70,70,70],{...n,contrast:.5}))).toBeLessThan(70);
    expect(lum(pixels([190,190,190],{...n,contrast:.5}))).toBeGreaterThan(190);
  });

  it("moves saturation and vibrance in the expected chroma direction",()=>{
    const n={exposure:0,brightness:0,contrast:0,saturation:0,vibrance:0,highlights:0,shadows:0};
    const chroma=rgb=>Math.max(...rgb)-Math.min(...rgb);
    const source=[105,130,155];
    expect(chroma(pixels(source,{...n,saturation:.5}))).toBeGreaterThan(chroma(source));
    expect(chroma(pixels(source,{...n,saturation:-.5}))).toBeLessThan(chroma(source));
    expect(chroma(pixels(source,{...n,vibrance:.5}))).toBeGreaterThan(chroma(source));
    expect(chroma(pixels(source,{...n,vibrance:-.5}))).toBeLessThan(chroma(source));
  });

  it("makes Vibrance subtle on saturated colors and stronger on muted colors",()=>{
    const n={exposure:0,brightness:0,contrast:0,saturation:0,vibrance:1,highlights:0,shadows:0};
    const chroma=rgb=>Math.max(...rgb)-Math.min(...rgb);
    const muted=[105,130,155], saturated=[20,110,230];
    const mutedGain=chroma(pixels(muted,n))-chroma(muted);
    const saturatedGain=chroma(pixels(saturated,n))-chroma(saturated);
    expect(mutedGain).toBeGreaterThan(saturatedGain);
    expect(Math.max(...pixels(saturated,n))).toBeLessThan(255);
  });

  it("protects warm skin-like colors from the full Vibrance increase",()=>{
    const n={exposure:0,brightness:0,contrast:0,saturation:0,vibrance:1,highlights:0,shadows:0};
    const chroma=rgb=>Math.max(...rgb)-Math.min(...rgb);
    const warm=[178,132,105], cool=[105,142,178];
    const warmGain=chroma(pixels(warm,n))-chroma(warm);
    const coolGain=chroma(pixels(cool,n))-chroma(cool);
    expect(warmGain).toBeLessThan(coolGain);
  });

  it("supports Figma-style black/white points, brilliance, and gamma",()=>{
    const n={exposure:0,blackPoint:0,whitePoint:1,brightness:0,contrast:0,brilliance:0,gamma:1,
      saturation:0,vibrance:0,temperature:0,tint:0,highlights:0,shadows:0,filterAmount:0,definition:0};
    expect(lum(pixels([40,40,40],{...n,blackPoint:.25}))).toBeLessThan(40);
    expect(lum(pixels([210,210,210],{...n,whitePoint:.7}))).toBeGreaterThan(210);
    expect(lum(pixels([110,110,110],{...n,gamma:2}))).toBeGreaterThan(110);
    expect(lum(pixels([35,35,35],{...n,brilliance:.7}))).toBeGreaterThan(35);
    expect(lum(pixels([220,220,220],{...n,brilliance:.7}))).toBeLessThan(220);
  });

  it("supports temperature, tint, and a reusable color filter",()=>{
    const n={exposure:0,brightness:0,contrast:0,saturation:0,vibrance:0,highlights:0,shadows:0};
    const warm=pixels([128,128,128],{...n,temperature:1});
    expect(warm[0]).toBeGreaterThan(warm[2]);
    const magenta=pixels([128,128,128],{...n,tint:1});
    expect(magenta[0]).toBeGreaterThan(magenta[1]);
    expect(magenta[2]).toBeGreaterThan(magenta[1]);
    expect(pixels([20,80,140],{...n,filterColor:'#ff0000',filterAmount:1})).toEqual([255,0,0]);
  });

  it("Definition increases local edge contrast without changing flat color",()=>{
    const mk=vals=>({data:new Uint8ClampedArray(vals.flatMap(v=>[v,v,v,255]))});
    const flat=mk([100,100,100,100,100,100,100,100,100]);
    window.Filters.colorAdjustPixels(flat,3,3,{definition:1});
    expect(flat.data[16]).toBe(100);
    const edge=mk([40,40,200,40,40,200,40,40,200]);
    window.Filters.colorAdjustPixels(edge,3,3,{definition:1});
    expect(edge.data[4]).toBeLessThan(40);
    expect(edge.data[8]).toBeGreaterThan(200);
  });

  it("is available on shapes, text, and images through the same panel",()=>{
    for(const type of ["rect","text","image"]){
      const o=layer(type,{contrast:.2});
      expect(editor.FX_PAGES(o)).toContain("Color Adjustments");
      expect(o.fx.some(e=>e.type==="colorAdjust"&&window.FxStack.entryOn(e))).toBe(true);
    }
  });
});
