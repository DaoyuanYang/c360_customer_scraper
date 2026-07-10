#!/usr/bin/env node
// cdp.mjs — Self-contained Chrome DevTools Protocol client for Node 20+.
// Subcommands: targets, new, navigate, eval, close, browser-eval.
//
// Talks directly to a Chromium-based browser (Microsoft Edge in this skill)
// launched with --remote-debugging-port. No external npm deps.
//
// Usage:
//   node cdp.mjs targets
//   node cdp.mjs new <url>
//   node cdp.mjs navigate <targetId> <url>
//   node cdp.mjs eval <targetId> <jsCode>
//   node cdp.mjs close <targetId>
//   node cdp.mjs browser-eval <jsCode>          # browser-level WS (for Target.* calls)
//
// Env:
//   CDP_PORT  — debug port (default 18800)
//   CDP_HOST  — debug host (default 127.0.0.1)

import { argv, exit } from 'node:process';
// Node 22+ has WebSocket as a global; Node 20.14 doesn't, so import from `ws`.
// `ws` is a small, well-maintained client; the only runtime dep of this skill.
import WebSocket from 'ws';

const HOST = process.env.CDP_HOST ?? '127.0.0.1';
const PORT = Number(process.env.CDP_PORT ?? 18800);
const BASE = `http://${HOST}:${PORT}`;

const log = (...a) => process.stderr.write(a.join(' ') + '\n');

function usage() {
  log(`Usage: node cdp.mjs <subcommand> [args...]

Subcommands:
  targets                                    List all open tabs
  new <url>                                  Open a new tab
  navigate <targetId> <url>                  Navigate a tab
  eval <targetId> <jsCode>                   Evaluate JS in a tab
  close <targetId>                           Close a tab
  browser-eval <jsCode>                      Eval on the browser-level WS`);
  exit(2);
}

async function fetchJson(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}: ${await res.text()}`);
  return res.json();
}

// Open a WS, return { ws, call(method, params), close() }.
// Auto-assigns ids, demuxes responses, throws on `error` or `exceptionDetails`.
function openWs(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map(); // id -> { resolve, reject, method }
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject, method } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) {
        reject(new Error(`CDP ${method} failed: ${msg.error.message} (${msg.error.code})`));
      } else if (msg.result?.exceptionDetails) {
        const ed = msg.result.exceptionDetails;
        const text = ed.exception?.description ?? ed.text ?? JSON.stringify(ed);
        reject(new Error(`JS exception: ${text}`));
      } else {
        resolve(msg.result);
      }
    }
  });
  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject, method });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  return new Promise((resolve, reject) =>
    ready.then(() => resolve({ ws, call, close: () => ws.close() }), reject));
}

// CDP eval — wraps Runtime.evaluate with returnByValue, throws on exceptionDetails.
async function cdpEval(cdp, expression) {
  const r = await cdp.call('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    const text = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text;
    throw new Error(`JS exception: ${text}`);
  }
  return r.result?.value;
}

// Subcommand handlers

async function cmdTargets() {
  const targets = await fetchJson('/json');
  console.log(JSON.stringify(targets, null, 2));
}

async function cmdNew(url) {
  if (!url) usage();
  // PUT /json/new?url=... — modern CDP. Returns the new target.
  const res = await fetch(`${BASE}/json/new?url=${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const t = await res.json();
  console.log(JSON.stringify(t, null, 2));
}

async function cmdNavigate(targetId, url) {
  if (!targetId || !url) usage();
  const targets = await fetchJson('/json');
  const t = targets.find((x) => x.id === targetId);
  if (!t) throw new Error(`target ${targetId} not found`);
  const cdp = await openWs(t.webSocketDebuggerUrl);
  try {
    const r = await cdp.call('Page.navigate', { url });
    console.log(JSON.stringify(r, null, 2));
  } finally {
    cdp.close();
  }
}

async function cmdEval(targetId, code) {
  if (!targetId || code == null) usage();
  const targets = await fetchJson('/json');
  const t = targets.find((x) => x.id === targetId);
  if (!t) throw new Error(`target ${targetId} not found`);
  const cdp = await openWs(t.webSocketDebuggerUrl);
  try {
    const value = await cdpEval(cdp, code);
    // Output a structured wrapper so the caller can reliably distinguish
    // "JS returned a string" from "JS returned an object" and avoid the
    // double-encode trap of `JSON.stringify(value)` on a string value.
    // Caller reads `parsed.value`; for type 'string', the caller may need
    // to JSON.parse(parsed.value) to get the actual data the JS code
    // wrapped in JSON.stringify(...).
    const type = value === null ? 'null' : typeof value;
    const out = value === undefined ? null : value;
    console.log(JSON.stringify({ type, value: out }));
  } finally {
    cdp.close();
  }
}

async function cmdClose(targetId) {
  if (!targetId) usage();
  const res = await fetch(`${BASE}/json/close/${targetId}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  log(`closed ${targetId}`);
}

async function cmdBrowserEval(code) {
  if (code == null) usage();
  // The browser-level WS is exposed at /json/version's webSocketDebuggerUrl.
  const v = await fetchJson('/json/version');
  const cdp = await openWs(v.webSocketDebuggerUrl);
  try {
    const value = await cdpEval(cdp, code);
    console.log(JSON.stringify(value));
  } finally {
    cdp.close();
  }
}

// Entry

const [sub, ...rest] = argv.slice(2);

(async () => {
  try {
    switch (sub) {
      case 'targets':       return await cmdTargets();
      case 'new':           return await cmdNew(rest[0]);
      case 'navigate':      return await cmdNavigate(rest[0], rest[1]);
      case 'eval':          return await cmdEval(rest[0], rest[1]);
      case 'close':         return await cmdClose(rest[0]);
      case 'browser-eval':  return await cmdBrowserEval(rest[0]);
      default:              return usage();
    }
  } catch (err) {
    log(`error: ${err.message}`);
    exit(1);
  }
})();
