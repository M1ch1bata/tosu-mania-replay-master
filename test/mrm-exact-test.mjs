import fs from "node:fs";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const code = fs.readFileSync(`${root}\\main.js`, "utf8");

class E {
  constructor() {
    this.style = { setProperty() {} };
    this.classList = { add() {}, remove() {}, contains() { return false; } };
    this.children = [];
    this.textContent = "";
    this.width = 640;
    this.height = 480;
  }
  appendChild(n) { this.children.push(n); return n; }
  getContext() { return makeCtx(); }
}
function makeCtx() {
  const calls = [];
  return new Proxy({ globalAlpha: 1 }, {
    get: (t, p) => (p in t ? t[p] : (...args) => { calls.push(p); }),
    set: (t, p, v) => { t[p] = v; return true; }
  });
}
const mainCtx = makeCtx();
const doc = {
  createElement: () => new E(),
  getElementById: (id) => {
    if (id === "preview") { const c = new E(); c.getContext = () => mainCtx; return c; }
    return new E();
  },
  body: new E()
};
class WS { constructor(u) { this.url = u; this.readyState = 1; } send() {} close() {} }
const clock = { now: 0 };
const storage = new Map();
const sb = {
  console, Date, Math, JSON, Number, Object, Array, Map, Set, String, Boolean, Error, Promise, Float64Array, Uint8Array,
  parseInt, parseFloat, isNaN, setTimeout, clearTimeout,
  requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
  performance: { now: () => clock.now },
  WebSocket: WS,
  localStorage: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) },
  fetch: async () => { throw new Error("network disabled"); },
  location: { host: "127.0.0.1:24050" },
  document: doc,
  window: { self: {}, top: {}, COUNTER_PATH: "Mania Replay Master", innerWidth: 640, innerHeight: 480, devicePixelRatio: 1, addEventListener() {} }
};
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(code, sb, { filename: "main.js" });
const api = sb.window.__maniaReplayMaster;

const helper = spawn("node", [`${root}\\tools\\mrm-helper.mjs`], { windowsHide: true, stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log("PASS ", name, extra === undefined ? "" : JSON.stringify(extra)); }
  else { fail += 1; console.log("FAIL ", name, extra === undefined ? "" : JSON.stringify(extra)); }
};

try {
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    await sleep(250);
    try {
      const r = await fetch("http://127.0.0.1:24051/status");
      ready = r.ok;
    } catch {
    }
  }
  ok("helper up", ready);
  const md5 = process.env.MRM_TEST_MD5 || "0092e13ec401d11a9b053b92e0e9093e";
  const mapIndexPath = process.env.MRM_MAP_INDEX || "C:\\Users\\96549\\AppData\\Local\\Temp\\opencode\\mma-test\\map-index.json";
  if (!fs.existsSync(mapIndexPath)) { console.log("SKIP: map index not found (set MRM_MAP_INDEX)"); process.exit(0); }
  const mapIndex = JSON.parse(fs.readFileSync(mapIndexPath, "utf8"));
  const parsed = api.parseOsu(fs.readFileSync(mapIndex[md5], "utf8"));
  const keys = 4;
  const s = api.state;
  s.client = "stable";
  s.mapMode = "mania";
  s.gameState = "play";
  s.scoreV2 = false;
  s.classicMod = true;
  s.checksum = md5;
  s.od = parseFloat(parsed.difficulty.OverallDifficulty);
  s.odConverted = s.od;
  s.csConverted = keys;
  s.beatmap = api.buildManiaNotes(parsed, keys);
  api.buildPoints();
  api.updateWindows();

  const res = await fetch(`http://127.0.0.1:24051/replay?md5=${md5}&keys=4`);
  const data = await res.json();
  ok("replay found", data.found && data.actions.length > 2000, data.actions ? data.actions.length : 0);
  const offset = api.fitExactOffset(s.beatmap.notes, keys, data.actions);
  const wantOffset = Number(process.env.MRM_TEST_OFFSET || "-3160");
  ok("offset aligned", Math.abs(offset - wantOffset) <= 30, offset);
  const applied = api.applyExactTimeline(data.actions, offset);
  ok("timeline applied", applied === true);
  const counts = api.panelStats().counts;
  const expected = (process.env.MRM_TEST_COUNTS || "2241,432,4,2,2,0").split(",").map(Number);
  let diff = 0;
  for (let i = 0; i < 6; i++) diff += Math.abs(counts[i] - expected[i]);
  ok("counts close to game", diff <= 120, { counts, expected, diff });
  const ur = api.unstableRate();
  ok("UR computed", Number.isFinite(ur) && ur > 0, Math.round(ur));
} catch (err) {
  fail += 1;
  console.log("FAIL ", String(err && err.stack || err));
} finally {
  helper.kill();
}
console.log(`Summary: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
