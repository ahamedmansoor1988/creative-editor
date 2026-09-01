/* MCP relay — the cable between an MCP server process and the open editor tab.
 *
 * WHY THIS EXISTS. The document model lives in the browser: rendering needs a
 * canvas and a WebGL2 context, so no Node process can hold the real document
 * without reimplementing every shader. The tab is therefore the authority, and
 * anything that wants to drive the editor has to reach INTO it.
 *
 * WHY NOT A WEBSOCKET. This project carries no runtime dependencies and Node
 * has no built-in WebSocket server, so a socket would mean either a package or
 * ~80 lines of RFC 6455 framing. Plain HTTP already does what is needed: the
 * tab holds a Server-Sent Events stream to receive commands, and POSTs each
 * answer back on an ordinary request. Both directions are stdlib.
 *
 *   mcp-server.js  --POST /mcp/call-->  [ here ]  --SSE-->     tab
 *   mcp-server.js  <--- HTTP reply ---  [ here ]  <--POST---   tab
 *
 * The call is held open until the tab answers, so the MCP server sees one
 * ordinary request/response and needs to know nothing about how it was served.
 *
 * LOOPBACK ONLY, ALWAYS. server.js binds 127.0.0.1 by default but HOST can
 * override that, and these routes drive the editor — they can create, delete
 * and overwrite a person's work. So the check here is on the PEER ADDRESS and
 * is not configurable: exposing the editor over the network must never expose
 * its remote control.
 */
"use strict";

const MAX_BODY = 4e6; // a command is small; a document reply is not sent this way
const CALL_TIMEOUT_MS = Number(process.env.MCP_TIMEOUT_MS || 20000);
const HEARTBEAT_MS = 25000;

/* Connected editor tabs, oldest first. Commands go to the LAST one only.
 * Broadcasting instead would have every open tab answer the same id, so the
 * first reply would win and the others would arrive for a request already
 * settled — and, worse, two tabs would both act on a create. */
const tabs = [];
const pending = new Map(); // id -> { res, timer }
let nextId = 1;

function isLocal(req) {
  const a = String(req.socket.remoteAddress || "");
  return a === "::1" || a === "127.0.0.1" || a.startsWith("::ffff:127.");
}

function json(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(s),
  });
  res.end(s);
}

function readBody(req, res, cb) {
  let raw = "";
  req.on("data", (c) => {
    raw += c;
    if (raw.length > MAX_BODY) req.destroy();
  });
  req.on("end", () => {
    let body;
    try {
      body = JSON.parse(raw || "{}");
    } catch (_) {
      json(res, 400, { error: "bad_request", message: "Body was not valid JSON." });
      return;
    }
    cb(body);
  });
}

function target() {
  return tabs.length ? tabs[tabs.length - 1] : null;
}

/* ---- routes ---------------------------------------------------------- */

function openStream(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    /* Named for nginx, harmless elsewhere. Without it a proxy in front of the
     * dev server will buffer the stream and every command arrives late, or in
     * a batch when the connection finally closes. */
    "X-Accel-Buffering": "no",
  });
  /* The browser's own reconnect delay. EventSource reconnects on its own, so
   * restarting the server does not require reloading the editor. */
  res.write("retry: 2000\n\n");

  const entry = { res, beat: null };
  entry.beat = setInterval(() => {
    /* A comment line. Keeps the socket from being reaped by an idle timeout
     * without the client seeing an event. */
    try {
      res.write(": ping\n\n");
    } catch (_) {
      /* the close handler below does the cleanup */
    }
  }, HEARTBEAT_MS);
  if (entry.beat.unref) entry.beat.unref();

  tabs.push(entry);

  const drop = () => {
    clearInterval(entry.beat);
    const i = tabs.indexOf(entry);
    if (i >= 0) tabs.splice(i, 1);
  };
  req.on("close", drop);
  req.on("error", drop);
}

function dispatch(req, res) {
  readBody(req, res, (body) => {
    const tab = target();
    if (!tab) {
      /* Not an error in the editor — an error in the SETUP, and the person
       * reading it can fix it in one action. Saying which one matters more
       * than the status code. */
      json(res, 409, {
        error: "no_tab",
        message:
          "No Creative Editor tab is connected. Open http://127.0.0.1:" +
          (process.env.PORT || 8470) +
          " and leave it open.",
      });
      return;
    }
    const method = String(body.method || "");
    if (!method) {
      json(res, 400, { error: "bad_request", message: "A command needs a method." });
      return;
    }

    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      json(res, 504, {
        error: "timeout",
        message:
          "The editor did not answer " + method + " within " + CALL_TIMEOUT_MS + "ms.",
      });
    }, CALL_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    pending.set(id, { res, timer });

    const payload = JSON.stringify({ id, method, params: body.params || {} });
    try {
      tab.res.write("event: cmd\ndata: " + payload + "\n\n");
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      json(res, 502, { error: "tab_write_failed", message: "Lost the editor tab mid-command." });
    }
  });
}

function result(req, res) {
  readBody(req, res, (body) => {
    const p = pending.get(body.id);
    /* Acknowledge an unknown id with 200 rather than an error. The usual cause
     * is a reply that lost a race with its own timeout, and the tab can do
     * nothing useful with a failure for work it already finished. */
    if (!p) {
      json(res, 200, { ok: true, note: "no pending call for that id" });
      return;
    }
    pending.delete(body.id);
    clearTimeout(p.timer);
    json(p.res, 200, body.ok ? { ok: true, result: body.result } : { ok: false, error: body.error });
    json(res, 200, { ok: true });
  });
}

/** Returns true when the request was one of ours and has been answered. */
function handle(req, res) {
  const url = String(req.url || "").split("?")[0];
  if (url !== "/mcp/events" && url !== "/mcp/call" && url !== "/mcp/result" && url !== "/mcp/status")
    return false;

  if (!isLocal(req)) {
    json(res, 403, { error: "forbidden", message: "The MCP relay is loopback-only." });
    return true;
  }

  if (req.method === "GET" && url === "/mcp/events") {
    openStream(req, res);
    return true;
  }
  if (req.method === "GET" && url === "/mcp/status") {
    json(res, 200, { tabs: tabs.length, pending: pending.size });
    return true;
  }
  if (req.method === "POST" && url === "/mcp/call") {
    dispatch(req, res);
    return true;
  }
  if (req.method === "POST" && url === "/mcp/result") {
    result(req, res);
    return true;
  }

  json(res, 405, { error: "method_not_allowed" });
  return true;
}

module.exports = { handle, _state: { tabs, pending } };
