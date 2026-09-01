#!/usr/bin/env node
/* Creative Editor MCP server.
 *
 * Speaks MCP to a client (Claude Code, Claude Desktop) over stdin/stdout and
 * forwards each tool call to the running editor through mcp-relay.js.
 *
 * WHY NO SDK. MCP's stdio transport is newline-delimited JSON-RPC 2.0, which is
 * the whole protocol surface a server this size uses. Writing it out keeps the
 * project at zero dependencies — worth more here than the SDK's convenience,
 * since the alternative is an npm install in a tree that other work is live in.
 * Swapping in @modelcontextprotocol/sdk later changes this file and nothing
 * else; the tool definitions and the relay call below are the parts that carry
 * the actual behaviour.
 *
 * STDOUT IS THE PROTOCOL. Every diagnostic goes to stderr. A stray console.log
 * here is a parse error at the other end, and it presents as the server simply
 * not working.
 */
"use strict";

const BASE = process.env.CE_URL || "http://127.0.0.1:" + (process.env.PORT || 8470);
const NAME = "creative-editor";
const VERSION = "0.1.0";

/* The protocol revision this server was written against. The client states its
 * own in `initialize`; MCP expects the server to answer with a version it can
 * actually speak, so a client on a revision we know is echoed back and anything
 * unrecognised is answered with ours. */
const PROTOCOL = "2025-06-18";
const KNOWN = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);

/* One paint shape, reused by create_shape and set_fill. Described in the schema
 * rather than only in prose: a model that has the enum does not have to guess
 * the spelling of "linear". */
const FILL = {
  type: "object",
  description:
    'A paint. Solid: {"kind":"solid","color":"#5b8cff"}. ' +
    'Linear: {"kind":"linear","angle":135,"stops":[{"pos":0,"color":"#5b8cff"},{"pos":1,"color":"#c04cff"}]}. ' +
    "Radial takes the same stops without an angle. 2-8 stops.",
  properties: {
    kind: { type: "string", enum: ["solid", "linear", "radial"] },
    color: { type: "string", description: "#rrggbb — for kind 'solid'." },
    angle: { type: "number", description: "Degrees 0-360 — for kind 'linear'." },
    stops: {
      type: "array",
      description: "Gradient stops, 2-8, ordered by pos.",
      items: {
        type: "object",
        properties: {
          pos: { type: "number", description: "0 at the start, 1 at the end." },
          color: { type: "string", description: "#rrggbb" },
          opacity: { type: "number", description: "0-1, default 1." },
        },
        required: ["pos", "color"],
      },
    },
  },
  required: ["kind"],
};

const ID = { type: "string", description: "Object id, as returned by get_document." };

const TOOLS = [
  {
    name: "get_document",
    description:
      "Read the Creative Editor document that is currently open: frame size and background, " +
      "every layer with its position, size, fill and effect stack, and the current selection. " +
      "Call this before changing anything, to see what is actually on the canvas.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "create_shape",
    description:
      "Add a rectangle, ellipse, polygon or line to the open document. Coordinates are absolute " +
      "pixels inside the frame, with 0,0 at its top-left; get_document reports the frame size. " +
      "The result is an ordinary layer the person can then select, drag and restyle by hand. " +
      "Use create_text for text.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["rect", "ellipse", "polygon", "line"] },
        x: { type: "number", description: "Left edge (for a line, the start point)." },
        y: { type: "number", description: "Top edge (for a line, the start point)." },
        w: { type: "number", description: "Width, 1-8000. Not used by lines." },
        h: { type: "number", description: "Height, 1-8000. Not used by lines." },
        x2: { type: "number", description: "Line end point. Required when type is 'line'." },
        y2: { type: "number", description: "Line end point. Required when type is 'line'." },
        strokeWidth: { type: "number", description: "Line thickness, 1-60." },
        strokeColor: { type: "string", description: "Line colour, #rrggbb." },
        radius: { type: "number", description: "Corner radius, for rect and polygon." },
        sides: { type: "number", description: "Polygon sides, 3-24." },
        innerRatio: {
          type: "number",
          description: "Polygon: 1 is a regular polygon, below 1 makes a star. 0.1-1.",
        },
        opacity: { type: "number", description: "0-1." },
        name: { type: "string", description: "Layer name shown in the Artwork panel." },
        fill: FILL,
      },
      required: ["type", "x", "y"],
    },
  },
  {
    name: "create_text",
    description:
      "Add a text layer. Without w it is point text on one line; giving w makes it area text " +
      "that wraps inside a box. Check the result's w and h against your layout — a size that " +
      "overflows will not be corrected for you.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The words to set." },
        x: { type: "number" },
        y: { type: "number" },
        size: { type: "number", description: "Point size, 8-300." },
        weight: { type: "number", description: "100-900 in steps of 100. 400 normal, 800 bold." },
        color: { type: "string", description: "#rrggbb" },
        align: { type: "string", enum: ["left", "center", "right"] },
        lineHeight: { type: "number", description: "Multiple of the size, 0.7-3." },
        w: { type: "number", description: "Wrap width. Supplying it switches to area text." },
        h: { type: "number", description: "Box height for area text." },
        opacity: { type: "number", description: "0-1." },
        name: { type: "string" },
      },
      required: ["text", "x", "y"],
    },
  },
  {
    name: "set_fill",
    description:
      "Replace a layer's fill with a solid colour or a gradient. Leaves every effect on the " +
      "layer intact — a Glass or Mesh material still sits above this fill.",
    inputSchema: {
      type: "object",
      properties: { id: ID, fill: FILL },
      required: ["id", "fill"],
    },
  },
  {
    name: "move_object",
    description:
      "Move a layer. Give x and y for an absolute position, or dx and dy to nudge it from " +
      "where it is. Coordinates are the layer's top-left corner.",
    inputSchema: {
      type: "object",
      properties: {
        id: ID,
        x: { type: "number" },
        y: { type: "number" },
        dx: { type: "number", description: "Relative move; overrides x." },
        dy: { type: "number", description: "Relative move; overrides y." },
      },
      required: ["id"],
    },
  },
  {
    name: "resize_object",
    description:
      "Resize a layer, keeping its top-left corner fixed. Either dimension may be omitted to " +
      "leave it alone. Resizing point text changes its font size rather than its box.",
    inputSchema: {
      type: "object",
      properties: { id: ID, w: { type: "number" }, h: { type: "number" } },
      required: ["id"],
    },
  },
  {
    name: "delete_object",
    description: "Delete a layer. Reversible with undo in the editor.",
    inputSchema: { type: "object", properties: { id: ID }, required: ["id"] },
  },
  {
    name: "select_object",
    description:
      "Select one or more layers, which is what the person then sees highlighted in the editor. " +
      "Selection is not a document change and does not create an undo step.",
    inputSchema: {
      type: "object",
      properties: { id: ID, ids: { type: "array", items: { type: "string" } } },
    },
  },
  {
    name: "list_engines",
    description:
      "List every fill and effect this editor can apply right now, with what each can go on. " +
      "If a layer is selected, each entry also says whether it is usable on that layer and why " +
      "not. Call this when you are unsure of an engine's id, or before applying to an unusual " +
      "layer type — the list is the editor's own, so it stays correct as the product changes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "apply_effect",
    description:
      "Apply a fill or effect to a layer, and optionally set its parameters in the same call. " +
      "Applies through the editor's own engine picker, so the result is editable by hand in the " +
      "inspector exactly like one applied by clicking.\n" +
      "Common engine ids: 'glass' (refracting material), 'mesh' (mesh gradient), 'glow', " +
      "'shadow', 'innerShadow', 'bloom', 'blur', 'grain', 'noise', 'colorAdjust', " +
      "'colorMap' (gradient map / duotone), 'channelFx' (RGB split and CHROMATIC ABERRATION), " +
      "'stylize' (halftone, threshold), 'distortion', 'warp', 'displacement', 'backgroundBlur'. " +
      "For chromatic aberration use engine 'channelFx' with params {mode:'chromaticAberration'}. " +
      "Call list_engines for the full current set.",
    inputSchema: {
      type: "object",
      properties: {
        id: ID,
        engine: { type: "string", description: "Engine id, e.g. 'glass'." },
        params: {
          type: "object",
          description:
            "Optional parameter overrides applied straight after. Names must match the " +
            "engine's own; a wrong name is refused with the valid list.",
        },
      },
      required: ["id", "engine"],
    },
  },
  {
    name: "update_effect",
    description:
      "Change parameters of an effect already on a layer. Identify it by effectId (exact) or " +
      "by effect type name. get_document reports both, along with the current values. Only " +
      "parameters the effect actually has are accepted — a wrong name is refused with the real " +
      "list, so read the refusal rather than guessing again.",
    inputSchema: {
      type: "object",
      properties: {
        id: ID,
        effectId: { type: "string", description: "Exact effect id from get_document." },
        effect: { type: "string", description: "Effect type name, e.g. 'glass'. Used if effectId is absent." },
        params: { type: "object", description: "Parameter names to new values." },
      },
      required: ["id", "params"],
    },
  },
  {
    name: "remove_effect",
    description: "Remove an effect from a layer. Identify it by effectId or by effect type name.",
    inputSchema: {
      type: "object",
      properties: {
        id: ID,
        effectId: { type: "string" },
        effect: { type: "string", description: "Effect type name, e.g. 'blur'." },
      },
      required: ["id"],
    },
  },
  {
    name: "reorder_effect",
    description:
      "Move an effect up or down its layer's stack. Order matters most among pixel effects — " +
      "blur-then-warp does not look like warp-then-blur. 'up' is later in the stack, applied " +
      "over what came before.",
    inputSchema: {
      type: "object",
      properties: {
        id: ID,
        effectId: { type: "string" },
        effect: { type: "string" },
        direction: { type: "string", enum: ["up", "down"] },
      },
      required: ["id", "direction"],
    },
  },
  {
    name: "ping",
    description:
      "Check that a Creative Editor tab is connected and holding a document. Use this to " +
      "diagnose the connection when another tool reports that no tab is open.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

/* ---- the relay ------------------------------------------------------- */

async function callEditor(method, params) {
  let r;
  try {
    r = await fetch(BASE + "/mcp/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, params: params || {} }),
    });
  } catch (e) {
    /* The editor's own server is not running. Distinguished from "running but
     * no tab" because the two have different fixes and the message is the only
     * thing the person reads. */
    throw new Error(
      "Could not reach Creative Editor at " +
        BASE +
        ". Start it with `npm run dev` in the creative-editor folder.",
    );
  }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.message || body.error || "Editor returned HTTP " + r.status);
  if (body.ok === false) throw new Error(body.error || "The editor could not run that command.");
  return body.result;
}

/* ---- JSON-RPC over stdio --------------------------------------------- */

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function reply(id, result) {
  write({ jsonrpc: "2.0", id, result });
}
function fail(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

/* A failed TOOL is not a failed request: the model should read the reason and
 * decide what to do, which it cannot do with a protocol-level error. */
function toolError(id, message) {
  reply(id, { content: [{ type: "text", text: message }], isError: true });
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  if (method === "initialize") {
    const want = params && params.protocolVersion;
    reply(id, {
      protocolVersion: KNOWN.has(want) ? want : PROTOCOL,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: NAME, version: VERSION },
    });
    return;
  }
  if (method === "notifications/initialized" || (method || "").startsWith("notifications/")) return;
  if (method === "ping") {
    reply(id, {});
    return;
  }
  if (method === "tools/list") {
    reply(id, { tools: TOOLS });
    return;
  }
  if (method === "tools/call") {
    const name = params && params.name;
    if (!TOOLS.some((t) => t.name === name)) {
      toolError(id, "No such tool: " + name);
      return;
    }
    try {
      const out = await callEditor(name, (params && params.arguments) || {});
      reply(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
    } catch (e) {
      toolError(id, (e && e.message) || String(e));
    }
    return;
  }

  if (!isNotification) fail(id, -32601, "Method not found: " + method);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      /* Cannot answer a message whose id we never parsed. Logging it is the
       * only honest response. */
      console.error("[mcp] unparseable line:", line.slice(0, 200));
      continue;
    }
    Promise.resolve(handle(msg)).catch((e) => {
      console.error("[mcp]", e);
      if (msg && msg.id != null) fail(msg.id, -32603, "Internal error: " + ((e && e.message) || e));
    });
  }
});
process.stdin.on("end", () => process.exit(0));

console.error("[mcp] creative-editor server ready (editor at " + BASE + ")");
