// MRM Helper - local companion for Mania Replay Master
// Reads osu! Data\r replays (exact per-column key actions) and streams live key events.
// No npm dependencies. Usage:
//   node mrm-helper.mjs [--osu "D:\Games\osu!"] [--port 24051]
// Endpoints:
//   GET /status                      -> { ok, osuDir, replays }
//   GET /replay?md5=<beatmapMd5>     -> { found, actions, mods, counts, rate, ... }
//   GET /live?keys=4&client=stable   -> SSE stream of key events (spawns key-hook.ps1)
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function argValue(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const port = Number(argValue("port", 24051));
const osuDir = argValue("osu", "D:\\Games\\osu!");
const replayDir = path.join(osuDir, "Data", "r");

// ---------- osr parsing ----------
const lzmaCode = fs.readFileSync(path.join(__dirname, "lzma_worker.js"), "utf8");
const lzmaSandbox = {
  console, Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float64Array,
  Array, Object, String, Number, Boolean, Error, Math, Date, RegExp, isNaN, parseInt, parseFloat,
  setTimeout, clearTimeout, JSON, Promise
};
lzmaSandbox.self = lzmaSandbox;
lzmaSandbox.window = lzmaSandbox;
vm.createContext(lzmaSandbox);
vm.runInContext(lzmaCode, lzmaSandbox);
const LZMA = lzmaSandbox.LZMA;

function readString(buf, offset) {
  let shift = 0;
  let len = 0;
  let pos = offset + 1;
  while (true) {
    const b = buf[pos++];
    len |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return { value: buf.toString("utf8", pos, pos + len), offset: pos + len };
}

function rateFromMods(mods) {
  if (mods & 64 || mods & 512) return 1.5;
  if (mods & 256) return 0.75;
  return 1;
}

function parseOsr(filePath) {
  const buf = fs.readFileSync(filePath);
  let o = 0;
  o += 1;
  o += 4;
  const md5 = readString(buf, o);
  o = md5.offset;
  const player = readString(buf, o);
  o = player.offset;
  o = readString(buf, o).offset;
  const counts = [];
  for (let i = 0; i < 6; i++) {
    counts.push(buf.readUInt16LE(o));
    o += 2;
  }
  const score = buf.readInt32LE(o);
  o += 4;
  o += 2 + 1;
  const mods = buf.readInt32LE(o);
  o += 4;
  o = readString(buf, o).offset;
  o += 8;
  const replayLen = buf.readInt32LE(o);
  o += 4;
  const blob = new Uint8Array(buf.buffer, buf.byteOffset + o, replayLen);
  const text = String(LZMA.decompress(blob));
  return { md5: md5.value, player: player.value, counts, score, mods, text };
}

function extractActions(text, keys, pressOffset = 0) {
  const out = [];
  const holds = new Map();
  let time = 0;
  for (const frame of String(text).split(",")) {
    if (!frame) continue;
    const p = frame.split("|");
    if (p.length < 4) continue;
    const w = parseInt(p[0], 10);
    let x = parseInt(p[1], 10);
    const y = parseInt(p[2], 10);
    if (!Number.isFinite(w) || !Number.isFinite(x) || y < 0) continue;
    if (w < 0) {
      if (w === -12345) break;
      time = -w;
      continue;
    }
    time += w;
    for (let col = 0; col < keys; col++) {
      if ((x & 1) !== 0) {
        if (!holds.has(col)) holds.set(col, time + pressOffset);
      } else if (holds.has(col)) {
        out.push({ column: col, time: holds.get(col), endTime: time });
        holds.delete(col);
      }
      x >>= 1;
    }
  }
  for (const [col, t] of holds) out.push({ column: col, time: t, endTime: t });
  return out;
}

const osrCache = new Map();

function listReplays() {
  let names = [];
  try {
    names = fs.readdirSync(replayDir).filter((f) => f.endsWith(".osr"));
  } catch {
    return [];
  }
  return names;
}

function findReplayFile(md5) {
  const target = String(md5 || "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(target)) return "";
  let best = "";
  let bestMtime = -1;
  for (const name of listReplays()) {
    if (!name.toLowerCase().startsWith(target)) continue;
    const full = path.join(replayDir, name);
    try {
      const mtime = fs.statSync(full).mtimeMs;
      if (mtime > bestMtime) {
        bestMtime = mtime;
        best = full;
      }
    } catch {
    }
  }
  return best;
}

function loadReplay(md5) {
  const file = findReplayFile(md5);
  if (!file) return null;
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
  }
  const cached = osrCache.get(file);
  if (cached && cached.mtime === mtime) return cached.data;
  const osr = parseOsr(file);
  const data = {
    file: path.basename(file),
    md5: osr.md5,
    player: osr.player,
    score: osr.score,
    mods: osr.mods,
    rate: rateFromMods(osr.mods),
    counts: osr.counts,
    scoreV2: (osr.mods & (1 << 29)) !== 0,
    text: osr.text
  };
  osrCache.set(file, { mtime, data });
  return data;
}

// ---------- live key hook ----------
const VK_NAMES = {
  None: 0, Back: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18, CapsLock: 20, Escape: 27, Space: 32,
  PageUp: 33, PageDown: 34, End: 35, Home: 36, Left: 37, Up: 38, Right: 39, Down: 40, Insert: 45, Delete: 46,
  Multiply: 106, Add: 107, Subtract: 109, Decimal: 110, Divide: 111, NumLock: 144, Scroll: 145,
  LeftShift: 160, RightShift: 161, LeftControl: 162, RightControl: 163, LeftAlt: 164, RightAlt: 165,
  OemSemicolon: 186, OemPlus: 187, OemComma: 188, OemMinus: 189, OemPeriod: 190, OemQuestion: 191, OemTilde: 192,
  OemOpenBrackets: 219, OemPipe: 220, OemCloseBrackets: 221, OemQuotes: 222, Oem8: 223, OemBackslash: 226
};
for (let c = 65; c <= 90; c++) VK_NAMES[String.fromCharCode(c)] = c;
for (let d = 0; d <= 9; d++) VK_NAMES[`D${d}`] = 48 + d;
for (let n = 0; n <= 9; n++) VK_NAMES[`NumPad${n}`] = 96 + n;
for (let f = 1; f <= 24; f++) VK_NAMES[`F${f}`] = 111 + f;

const SYMBOL_NAMES = {
  ";": "OemSemicolon", "'": "OemQuotes", ",": "OemComma", ".": "OemPeriod", "/": "OemQuestion",
  "[": "OemOpenBrackets", "]": "OemCloseBrackets", "\\": "OemPipe", "-": "OemMinus", "=": "OemPlus", "`": "OemTilde"
};

const STABLE_LAYOUTS = {
  1: ["D"],
  2: ["D", "K"],
  3: ["D", "Space", "K"],
  4: ["D", "F", "J", "K"],
  5: ["D", "F", "Space", "J", "K"],
  6: ["S", "D", "F", "J", "K", "L"],
  7: ["S", "D", "F", "Space", "J", "K", "L"],
  8: ["A", "S", "D", "F", "J", "K", "L", ";"],
  9: ["A", "S", "D", "F", "Space", "J", "K", "L", ";"],
  10: ["A", "S", "D", "F", "G", "J", "K", "L", ";", "'"]
};

let cfgFiles = null;
function cfgCandidates() {
  if (cfgFiles) return cfgFiles;
  let names = [];
  try {
    names = fs.readdirSync(osuDir).filter((f) => /^osu!.*\.cfg$/i.test(f));
  } catch {
    names = [];
  }
  names.sort((a, b) => (a.toLowerCase() === "osu!.cfg" ? 1 : b.toLowerCase() === "osu!.cfg" ? -1 : a.localeCompare(b)));
  cfgFiles = names.map((n) => path.join(osuDir, n));
  return cfgFiles;
}

function readCfgLayout(keys) {
  for (const file of cfgCandidates()) {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const m = new RegExp(`^ManiaLayouts${keys}K\\s*=\\s*(.+)$`, "m").exec(text);
    if (!m) continue;
    const sel = new RegExp(`^ManiaLayoutSelected${keys}K\\s*=\\s*(\\d+)`, "m").exec(text);
    const layouts = String(m[1]).trim().split("|");
    const idx = sel ? Math.max(0, Math.min(layouts.length - 1, parseInt(sel[1], 10) || 0)) : 0;
    const names = (layouts[idx] || "").trim().split(/\s+/).filter(Boolean);
    if (names.length !== keys) continue;
    const vks = names.map((n) => (VK_NAMES[n] !== undefined ? VK_NAMES[n] : -1));
    if (vks.some((v) => v <= 0)) continue;
    return { names, vks, from: path.basename(file) };
  }
  return null;
}

function layoutFor(keys) {
  const cfg = readCfgLayout(keys);
  if (cfg) return cfg;
  const names = STABLE_LAYOUTS[keys];
  if (!names) return null;
  const vks = names.map((n) => {
    const key = SYMBOL_NAMES[n] || n;
    return VK_NAMES[key] !== undefined ? VK_NAMES[key] : -1;
  });
  if (vks.some((v) => v <= 0)) return null;
  return { names, vks, from: "default" };
}

let hookProc = null;
const sseClients = new Set();

function stopHook() {
  if (!hookProc) return;
  try {
    hookProc.proc.kill();
  } catch {
  }
  hookProc = null;
}

function ensureHook(keys) {
  const layout = layoutFor(keys);
  if (!layout) return { ok: false, error: `unsupported key count: ${keys}` };
  const spec = layout.vks.map((vk, col) => `${vk}:${col}`).join(",");
  const info = { ok: true, layout: layout.names.join(" "), from: layout.from };
  if (hookProc && hookProc.spec === spec) return info;
  stopHook();
  const ps1 = path.join(__dirname, "key-hook.ps1");
  if (!fs.existsSync(ps1)) return { ok: false, error: "key-hook.ps1 not found" };
  console.log(`[mrm-helper] hook layout (${layout.from}): ${layout.names.join(" ")} -> ${spec}`);
  const proc = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, "-Map", spec], {
    windowsHide: true
  });
  const state = { proc, spec, buffer: "" };
  proc.stdout.on("data", (chunk) => {
    state.buffer += chunk.toString("utf8");
    let idx;
    while ((idx = state.buffer.indexOf("\n")) >= 0) {
      const line = state.buffer.slice(0, idx).trim();
      state.buffer = state.buffer.slice(idx + 1);
      if (!line) continue;
      const parts = line.split("|");
      if (parts.length < 3) continue;
      const event = { type: "key", down: parts[0] === "down", column: Number(parts[1]), t: Number(parts[2]) };
      broadcast(event);
    }
  });
  proc.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8").trim();
    if (text) broadcast({ type: "error", message: text.slice(0, 300) });
  });
  proc.on("exit", (code) => {
    if (hookProc === state) hookProc = null;
    broadcast({ type: "hookexit", code });
  });
  hookProc = state;
  return info;
}

function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
    }
  }
}

// ---------- http server ----------
const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${port}`);
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*"
  };
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  if (u.pathname === "/status") {
    res.writeHead(200, { ...cors, "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, osuDir, replayDir, replays: listReplays().length, hook: !!hookProc }));
    return;
  }
  if (u.pathname === "/replay") {
    const md5 = u.searchParams.get("md5") || "";
    let data = null;
    try {
      data = loadReplay(md5);
    } catch (err) {
      res.writeHead(500, { ...cors, "Content-Type": "application/json" });
      res.end(JSON.stringify({ found: false, error: String(err && err.message) }));
      return;
    }
    if (!data) {
      res.writeHead(200, { ...cors, "Content-Type": "application/json" });
      res.end(JSON.stringify({ found: false, md5 }));
      return;
    }
    const keys = Math.max(1, Math.min(18, parseInt(u.searchParams.get("keys") || "4", 10) || 4));
    const actions = extractActions(data.text, keys);
    res.writeHead(200, { ...cors, "Content-Type": "application/json" });
    res.end(JSON.stringify({
      found: true,
      file: data.file,
      md5: data.md5,
      player: data.player,
      score: data.score,
      mods: data.mods,
      rate: data.rate,
      counts: data.counts,
      scoreV2: data.scoreV2,
      keys,
      actions
    }));
    return;
  }
  if (u.pathname === "/live") {
    const keys = parseInt(u.searchParams.get("keys") || "4", 10) || 4;
    const info = ensureHook(keys);
    res.writeHead(200, {
      ...cors,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive"
    });
    res.write(`data: ${JSON.stringify({ type: "hello", keys, hook: info.ok, error: info.error || "", layout: info.layout || "", from: info.from || "" })}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }
  res.writeHead(404, cors);
  res.end("not found");
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[mrm-helper] listening on http://127.0.0.1:${port}`);
  console.log(`[mrm-helper] osu dir: ${osuDir} (replays: ${listReplays().length})`);
});

function shutdown() {
  stopHook();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", stopHook);
