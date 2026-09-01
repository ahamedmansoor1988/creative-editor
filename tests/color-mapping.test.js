// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { loadEditor } from "./helpers/load-editor.js";

let editor;
const px=(rgb,p)=>{
  const img={data:new Uint8ClampedArray([...rgb,255])};
  window.Filters.colorMapPixels(img,1,1,p);
  return [...img.data.slice(0,3)];
};
function layer(type="rect",colorMap={}){
  editor.doc={frame:{name:"Map",w:500,h:400,bg:"#fff",artboards:[],children:[{
    type,name:"Target",x:80,y:60,w:240,h:180,text:type==="text"?"Map":undefined,
    fill:{kind:"solid",color:"#8090a0"},effects:{colorMap},
  }]}};
  return editor.doc.frame.children[0];
}
beforeAll(()=>{({editor}=loadEditor());});

describe("shared Color Mapping capability",()=>{
  it("normalizes mode, colors, amount, and preserves the live stack alias",()=>{
    const o=layer("rect",{mode:"bad",shadow:"no",highlight:"#abcdef",overlay:"bad",amount:9});
    expect(o.effects.colorMap).toEqual({mode:"gradientMap",shadow:"#1b103d",highlight:"#abcdef",overlay:"#3b6df0",amount:1,
      mapOffset:0,darkStrength:1,lightStrength:.55,darkGamma:1.25,lightGamma:.65});
    expect(o.fx.find(e=>e.type==="colorMap").params).toBe(o.effects.colorMap);
  });

  it("is a true no-op at zero strength",()=>{
    const p={mode:"gradientMap",shadow:"#000000",highlight:"#ffffff",overlay:"#ff0000",amount:0};
    expect(px([25,100,220],p)).toEqual([25,100,220]);
    expect(window.FxStack.entryOn({type:"colorMap",on:true,params:p})).toBe(false);
  });

  it("supports Gradient Map, Duotone, and Color Overlay as modes of one filter",()=>{
    const base={shadow:"#251040",highlight:"#f0b832",overlay:"#ff0000",amount:1,
      mapOffset:0,darkStrength:1,lightStrength:.55,darkGamma:1.25,lightGamma:.65};
    const gradient=px([40,120,220],{...base,mode:"gradientMap"});
    const duotone=px([40,120,220],{...base,mode:"duotone"});
    const overlay=px([40,120,220],{...base,mode:"overlay"});
    expect(gradient).not.toEqual([40,120,220]);
    expect(duotone).not.toEqual(gradient);
    expect(overlay).toEqual([255,0,0]);
  });

  it("uses two independently adjustable ink curves for Duotone",()=>{
    const base={mode:"duotone",shadow:"#24103d",highlight:"#e7a82c",overlay:"#000000",amount:1,
      darkStrength:1,lightStrength:.55,darkGamma:1.25,lightGamma:.65};
    const normal=px([100,100,100],base);
    const noDark=px([100,100,100],{...base,darkStrength:0});
    const noLight=px([100,100,100],{...base,lightStrength:0});
    expect(normal).not.toEqual(noDark);
    expect(normal).not.toEqual(noLight);
    expect(noDark).not.toEqual(noLight);
  });

  it("uses the same editable panel on shapes, text, and images",()=>{
    for(const type of ["rect","text","image"]){
      const o=layer(type,{mode:"overlay",overlay:"#ff0000",amount:.5});
      expect(editor.FX_PAGES(o)).toContain("Color Mapping");
      expect(o.fx.some(e=>e.type==="colorMap"&&window.FxStack.entryOn(e))).toBe(true);
    }
  });
});
