// Offline analyzer: replay a recorded live session (ln-record.mjs events.jsonl) through
// the real main.js inside a DOM stub, then compare the LIVE judgement assignment against
// the EXACT replay reconstruction from the saved .osr actions.
//
//   node test/ln-analyze.mjs [--session ln-logs/session-ln3] [--helper http://127.0.0.1:24051]
//
// Live path reproduced here = the plugin's own live pipeline:
//   * v2 message          -> setTime(beatmap.time.live) only (map/mods/stats are static)
//   * precise message     -> api.onPrecise({ currentTime, keys, hitErrors })
//   * helper key message  -> the EventSource "key" branch of ensureLive():
//                            activate live, then api.applyLiveKey(col, hookSongTime(hookT), down)
//   * between messages    -> api.frame() at 60 Hz, which is what runs sweepMisses() in the browser
//
// The exact path uses api.fitExactOffset + api.applyExactTimeline on the .osr actions, i.e. the
// same thing the plugin does in Replay (exact) mode.
//
// Output: console report + <session>/analysis.json + <session>/analysis.md

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const mainCode = fs.readFileSync(path.join(root, "main.js"), "utf8");
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};

const logsDir = path.join(root, "ln-logs");
function pickSession() {
  const explicit = arg("session", "");
  if (explicit) return path.resolve(process.cwd(), explicit);
  const dirs = fs
    .readdirSync(logsDir)
    .filter((d) => fs.existsSync(path.join(logsDir, d, "events.jsonl")))
    .map((d) => ({ d, m: fs.statSync(path.join(logsDir, d, "events.jsonl")).mtimeMs }))
    .sort((a, b) => a.m - b.m);
  if (!dirs.length) throw new Error(`no recorded session under ${logsDir}`);
  return path.join(logsDir, dirs[dirs.length - 1].d);
}
const SESSION = pickSession();
const UNTIL = Number(arg("until", "0")) || 0;
const HELPER = String(arg("helper", "http://127.0.0.1:24051")).replace(/\/+$/, "");
const STEP = 1000 / 60;
const FORCE_OFFSET = arg("offset", "");
const OFFSET = FORCE_OFFSET === "" ? null : Number(FORCE_OFFSET);

const pct = (arr, p) => {
  if (!arr.length) return NaN;
  const a = arr.slice().sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.round((p / 100) * (a.length - 1))))];
};
const median = (arr) => pct(arr, 50);
const mean = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : NaN);
const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "-");

// recorderTime = songTime + offset. v2 is the only channel that carries beatmap.time.live (~100ms
// cadence) and its first sample after a state transition can still hold the previous song time, so
// take the median and then drop samples that are far away from it.
function songOffsetFrom(clocks) {
  if (!clocks.length) return NaN;
  const m = median(clocks);
  const kept = clocks.filter((v) => Math.abs(v - m) <= 1500);
  return kept.length ? median(kept) : m;
}

// ---------------------------------------------------------------- recorded events

function loadEvents(dir) {
  const evs = [];
  const raw = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    evs.push(e);
  }
  return evs;
}

const events = loadEvents(SESSION);

// play segments (meta events written by the recorder)
const playSegments = [];
let openSeg = null;
for (const ev of events) {
  if (ev.ch !== "meta") continue;
  if (ev.event === "play-start") openSeg = { checksum: ev.checksum, start: ev.t, end: null };
  else if (ev.event === "play-end" && openSeg) {
    openSeg.end = ev.t;
    openSeg.wall = ev.wall;
    openSeg.keys = ev.keys;
    openSeg.hitErrors = ev.hitErrors;
    playSegments.push(openSeg);
    openSeg = null;
  }
}
if (!playSegments.length && openSeg) {
  const last = events[events.length - 1];
  openSeg.end = last && Number.isFinite(last.t) ? last.t : openSeg.start;
  openSeg.wall = last && last.wall;
  openSeg.keys = openSeg.keys || 4;
  playSegments.push(openSeg);
  openSeg = null;
}
if (!playSegments.length) throw new Error("no play segment in recording");
playSegments.sort((a, b) => (b.end || b.start) - (b.start) - ((a.end || a.start) - a.start));
const seg = playSegments[0];
if (seg.end === null) {
  const last = events[events.length - 1];
  seg.end = last && Number.isFinite(last.t) ? last.t : seg.start;
  seg.wall = seg.wall || (last && last.wall);
}
const checksum = seg.checksum;
const keys = Number(seg.keys || 4);

const mapPath = path.join(SESSION, "maps", `${checksum}.osu`);
if (!fs.existsSync(mapPath)) throw new Error(`map file missing: ${mapPath}`);
const mapText = fs.readFileSync(mapPath, "utf8");

const settingsPath = path.join(SESSION, "plugin-settings.json");
const pluginSettings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, "utf8")) : {};

// ---------------------------------------------------------------- harness

function makeCtx() {
  return new Proxy(
    { globalAlpha: 1 },
    {
      get: (t, p) => (p in t ? t[p] : () => 0),
      set: (t, p, v) => {
        t[p] = v;
        return true;
      }
    }
  );
}
class El {
  constructor() {
    this.style = { setProperty() {} };
    this.classList = { add() {}, remove() {}, contains: () => false };
    this.children = [];
    this.textContent = "";
    this.width = 640;
    this.height = 480;
  }
  appendChild(n) {
    this.children.push(n);
    return n;
  }
  getContext() {
    return makeCtx();
  }
}

function makeHarness() {
  const clock = { now: 0 };
  const doc = {
    createElement: () => new El(),
    getElementById: (id) => {
      const c = new El();
      if (id === "preview") c.getContext = () => makeCtx();
      return c;
    },
    body: new El()
  };
  class WS {
    constructor(u) {
      this.url = u;
      this.readyState = 1;
    }
    send() {
      return false;
    }
    close() {}
  }
  const storage = new Map();
  const sb = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    Date,
    Math,
    JSON,
    Number,
    Object,
    Array,
    Map,
    Set,
    String,
    Boolean,
    Error,
    Promise,
    Float64Array,
    Float32Array,
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int32Array,
    parseInt,
    parseFloat,
    isNaN,
    setTimeout: () => 0,
    clearTimeout: () => 0,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => 0,
    performance: { now: () => clock.now },
    WebSocket: WS,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k)
    },
    fetch: async () => {
      throw new Error("network disabled");
    },
    location: { host: "127.0.0.1:24050" },
    document: doc,
    window: {
      self: {},
      top: {},
      COUNTER_PATH: "Mania Replay Master",
      innerWidth: 640,
      innerHeight: 480,
      devicePixelRatio: 1,
      addEventListener() {}
    }
  };
  sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(mainCode, sb, { filename: "main.js" });
  const api = sb.window.__maniaReplayMaster;
  for (const [k, v] of Object.entries(pluginSettings)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "object") continue;
    api.settings[k] = v;
  }
  return { api, clock };
}

function configure(api, md5, keysN, mods) {
  const s = api.state;
  const parsed = api.parseOsu(mapText);
  const od = Number(parsed.difficulty.OverallDifficulty);
  s.client = "stable";
  s.mapMode = "mania";
  s.gameState = "play";
  // mods come from the session itself, so V1 and ScoreV2 runs are told apart automatically
  const modNum = Number(mods && mods.number) || 0;
  const modArr = Array.isArray(mods && mods.array) ? mods.array : [];
  const hasV2 =
    (modNum & (1 << 29)) !== 0 ||
    modArr.some((m) => /^(v2|sv2)$/i.test(String((m && (m.acronym || m.name)) || m || "")));
  s.scoreV2 = hasV2;
  s.classicMod = true; // stable client -> V1 (classic) windows
  s.modsNumber = modNum;
  s.modsRate = Number(mods && mods.rate) || 1;
  s.checksum = md5;
  s.od = Number.isFinite(od) ? od : 8;
  s.odConverted = s.od;
  s.csConverted = keysN;
  s.beatmap = api.buildManiaNotes(parsed, keysN);
  api.buildPoints();
  api.updateWindows();
  return { parsed, od: s.od };
}

// ---------------------------------------------------------------- live replay

function modsFrom(evs) {
  for (const ev of evs) {
    const d = ev.ch === "v2" && ev.data;
    if (d && d.play && d.play.mods) return d.play.mods;
  }
  return null;
}

function replayLive(harness, evs, segment, md5, keysN) {
  const { api, clock } = harness;
  const s = api.state;
  const mods = modsFrom(evs);
  configure(api, md5, keysN, mods);
  const notes = s.beatmap.notes;
  const pts = s.points;
  const N = notes.length;
  const NP = pts.length;
  const headVal = new Int8Array(N).fill(127);
  const tailVal = new Int8Array(N).fill(127);
  const headAt = new Float64Array(N).fill(NaN);
  const tailAt = new Float64Array(N).fill(NaN);
  const pMatched = new Uint8Array(NP);
  const pAt = new Float64Array(NP).fill(NaN);
  const pE = new Float64Array(NP).fill(NaN);
  const pJ = new Int8Array(NP).fill(-2);
  let revertedPoints = 0;
  let revertedNotes = 0;

  let lastRevN = 0;
  const snap = (t) => {
    const ns = s.noteState;
    setTimeout(() => {}, 0);
    for (let i = 0; i < N; i++) {
      const st = ns[i];
      if (!st) continue;
      const h = st.head === null ? 127 : st.head;
      if (h === 127 && headVal[i] !== 127) revertedNotes += 1;
      if (h !== headVal[i]) {
        headVal[i] = h;
        headAt[i] = h !== 127 ? t : NaN;
      }
      const tl = st.tail === null ? 127 : st.tail;
      if (tl !== tailVal[i]) {
        tailVal[i] = tl;
        tailAt[i] = tl !== 127 ? t : NaN;
      }
    }
    for (let i = 0; i < NP; i++) {
      const p = pts[i];
      if (!p.matched) {
        // resetJudgements() (restart / stale v2 sample) puts points back into the unmatched state;
        // drop the snapshot too, otherwise a stale miss/match stays in the comparison forever.
        if (pMatched[i]) {
          if (revertedPoints < 5) console.log("REVERT pt", i, "at", Math.round(t), "was j", pJ[i], "e", pE[i]);
          revertedPoints += 1;
          pMatched[i] = 0;
          pAt[i] = NaN;
          pE[i] = NaN;
          pJ[i] = -2;
        }
        continue;
      }
      if (!pMatched[i]) {
        pMatched[i] = 1;
        pAt[i] = t;
        pJ[i] = p.j;
        if (p.e !== null) pE[i] = p.e;
      } else {
        pJ[i] = p.j;
        if (p.e !== null) pE[i] = p.e;
      }
    }
    if (revertedPoints - lastRevN > 50) { lastRevN = revertedPoints; console.log("BULK REVERT at", Math.round(t), "total", revertedPoints, "matched now", histSum(pMatched)); }
  };

  clock.now = segment.start;
  s.lastV2At = segment.start;
  s.lastPreciseAt = 0;
  snap(segment.start);

  let frameAt = segment.start;
  const tick = (until) => {
    while (frameAt <= until) {
      clock.now = frameAt;
      api.frame();
      snap(frameAt);
      frameAt += STEP;
    }
  };

  const liveEvents = evs.filter(
    (ev) => (ev.ch === "v2" || ev.ch === "precise" || ev.ch === "key") && ev.t >= segment.start && ev.t <= segment.end
  );

  const hit = [];
  let keyCount = 0;
  let hitLost = 0;
  let preciseCount = 0;
  let stalledPrecise = 0;
  let fastTime = 0;
  let speedMin = Infinity;
  let speedMax = -Infinity;
  const trackSpeed = () => {
    const sp = Number(s.timeSpeed);
    if (!Number.isFinite(sp)) return;
    if (sp < speedMin) speedMin = sp;
    if (sp > speedMax) speedMax = sp;
  };
  const preciseClock = [];
  const v2Clocks = [];
  const v2Anchors = [];
  let lastLive = NaN;
  let firstKeyT = NaN;
  let lastV2T = segment.start;
  const assigned = [];
  const prevMatched = new Uint8Array(NP);
  const resetPrev = () => prevMatched.fill(0);

  for (const ev of liveEvents) {
    tick(ev.t);
    clock.now = ev.t;
    if (ev.ch === "v2") {
      lastV2T = ev.t;
      s.lastV2At = ev.t;
      const live = ev.data && ev.data.beatmap && ev.data.beatmap.time ? Number(ev.data.beatmap.time.live) : NaN;
      if (Number.isFinite(live)) {
        const rewound = Number.isFinite(lastLive) && live < lastLive - 500;
        if (rewound) resetPrev();
        lastLive = live;
        v2Clocks.push(ev.t - live);
        if (!rewound) v2Anchors.push({ t: ev.t, live });
      }
      // Feed the recorded v2 payload through the real handler: applyPlayUpdate's restart
      // detection lives there, and that is where "all notes revert to unjudged" came from.
      try {
        api.onV2(ev.data);
      } catch (err) {
        console.log("onV2 threw:", (err && err.message) || err);
      }
      // onV2 already applies beatmap.time.live through setTime(). Calling setTime() again with the
      // same clock.now gives dt == 0, which pins timeSpeed to 1 and hides the timeSpeed>1.25 branch.
      // Only fall back when the handler did not move the clock (e.g. payload without time).
      if (Number.isFinite(live) && Math.abs(Number(s.time) - live) > 1e-6) api.setTime(live);
    } else if (ev.ch === "precise") {
      preciseCount += 1;
      if (ev.reset) hit.length = 0;
      if (Array.isArray(ev.hitErrors)) for (const e of ev.hitErrors) hit.push(e);
      // only ever trim: extending here would create holes and poison the multiset comparison
      if (hit.length > ev.hitErrorsLen) hit.length = ev.hitErrorsLen;
      if (hit.length < ev.hitErrorsLen) hitLost += ev.hitErrorsLen - hit.length;
      const cur = Number(ev.currentTime);
      if (Number.isFinite(cur) && Number.isFinite(ev.t)) preciseClock.push(ev.t - cur);
      api.onPrecise({ currentTime: ev.currentTime, keys: ev.keys, hitErrors: hit });
      if (Number(s.preciseStalledUntil) > ev.t) stalledPrecise += 1;
      if (Number(s.timeSpeed) > 1.25) fastTime += 1;
      trackSpeed();
    } else if (ev.ch === "key") {
      keyCount += 1;
      if (!Number.isFinite(firstKeyT)) firstKeyT = ev.t;
      if (s.gameState !== "play") continue;
      if (s.exactApplied) s.exactApplied = false;
      if (!s.liveActive) {
        s.liveActive = true;
        api.resetJudgements();
        resetPrev();
      }
      {
        const songT = api.hookSongTime(Number(ev.hookT));
        api.applyLiveKey(Number(ev.column), songT, !!ev.down);
        const claimed = [];
        for (let i = 0; i < NP; i++) {
          if (pts[i].matched && !prevMatched[i]) {
            claimed.push({ idx: i, time: pts[i].time, end: !!pts[i].end, note: pts[i].note, e: pts[i].e, j: pts[i].j });
          }
          prevMatched[i] = pts[i].matched ? 1 : 0;
        }
        assigned.push({ t: ev.t, songT, col: Number(ev.column), down: !!ev.down, claimed });
      }
    }
    snap(ev.t);
  }
  const lastEventT = liveEvents.length ? liveEvents[liveEvents.length - 1].t : segment.start;
  tick(segment.end);
  // With HT/DT the recorded wall clock advances faster/slower than song time, so a single
  // (t - live) offset is only valid at rate 1. Map recorder time to song time piecewise from
  // the v2 samples and the playback rate.
  const songRate = Number(mods && mods.rate) || Number(s.modsRate) || 1;
  const songAt = (t) => {
    if (!Number.isFinite(t)) return NaN;
    if (!v2Anchors.length) return t;
    if (t <= v2Anchors[0].t) return v2Anchors[0].live;
    let lo = 0;
    let hi = v2Anchors.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (v2Anchors[mid].t <= t) lo = mid;
      else hi = mid - 1;
    }
    const anchor = v2Anchors[lo];
    return anchor.live + (t - anchor.t) * songRate;
  };

  return {
    api,
    headVal,
    tailVal,
    headAt,
    tailAt,
    pMatched,
    pAt,
    pE,
    pJ,
    notes,
    pts,
    mods,
    scoreV2: !!s.scoreV2,
    assigned,
    revertedPoints,
    revertedNotes,
    hitLen: hit.length,
    hitLost,
    nEvents: liveEvents.length,
    keyCount,
    preciseCount,
    stalledPrecise,
    fastTime,
    timeSpeedRange: [speedMin, speedMax],
    lastEventT,
    lastV2T,
    songOffset: songOffsetFrom(v2Clocks), // recorderTime = songTime + songOffset (rate 1 only)
    songRate,
    songAt,
    songAnchors: v2Anchors.length,
    v2Samples: v2Clocks.length,
    missWindow: s.windows && s.windows.length ? s.windows[s.windows.length - 1] : NaN,
    hitErrors: hit.slice(),
    counts: histogram(pJ, pMatched)
  };
}

function histogram(pJ, pMatched) {
  const h = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < pJ.length; i++) {
    if (!pMatched[i]) continue;
    if (pJ[i] < 0) h[5] += 1;
    else h[Math.min(5, pJ[i])] += 1;
  }
  return h;
}

// ---------------------------------------------------------------- exact replay

async function helperStatus() {
  try {
    const res = await fetch(`${HELPER}/status`, { headers: { Origin: "http://127.0.0.1:24050" } });
    return await res.json();
  } catch {
    return null;
  }
}

// The replay of this attempt lands in Data\r when the results screen is saved: usually seconds to a
// minute after the plugin saw the state leave "play". Several .osr files can share the beatmap md5
// (one per attempt), so prefer the one written just after THIS segment's play-end instead of the
// newest file (helper /replay without &file= returns the newest one, i.e. possibly another attempt).
function pickReplayFile(dir, md5) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.toLowerCase().startsWith(md5) && f.toLowerCase().endsWith(".osr"));
  } catch {
    return null;
  }
  if (!names.length) return null;
  const wall = Number(seg.wall);
  const explicit = arg("replay-file", "");
  if (explicit) {
    const hit = names.find((n) => n === explicit);
    if (hit) {
      try {
        return { file: hit, mtime: fs.statSync(path.join(dir, hit)).mtimeMs, dir };
      } catch {
      }
    }
    console.log(`[ln-analyze] --replay-file ${explicit} not found in ${dir}`);
  }
  let best = null;
  for (const name of names) {
    let mtime = 0;
    try {
      mtime = fs.statSync(path.join(dir, name)).mtimeMs;
    } catch {
      continue;
    }
    let score = -mtime;
    let after = NaN;
    if (Number.isFinite(wall)) {
      after = mtime - wall;
      // 0..120s after play-end is the normal window; anything else only wins if nothing fits.
      score = after >= -2000 && after <= 120000 ? after : 1e9 + Math.abs(after);
    }
    if (!best || score < best.score) best = { file: name, mtime, dir, score, after };
  }
  return best;
}

async function resolveActions() {
  const cachePath = path.join(SESSION, "actions.json");
  let cached = null;
  try {
    cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  } catch {
  }
  const status = await helperStatus();
  const dir = status && status.replayDir ? status.replayDir : "";
  const pick = dir ? pickReplayFile(dir, checksum) : null;
  if (pick) {
    const rel = Number.isFinite(pick.after) ? `${Math.round(pick.after)}ms after play-end` : "play-end wall unknown";
    console.log(`[ln-analyze] replay file ${pick.file} (${rel}, mtime ${new Date(pick.mtime).toISOString()})`);
  } else if (dir) {
    console.log(`[ln-analyze] no .osr for ${checksum} under ${dir}`);
  }
  if (cached && Array.isArray(cached.actions) && (!pick ? true : cached.file === pick.file)) {
    return { ...cached, fromCache: true };
  }
  if (!HELPER) return cached && Array.isArray(cached.actions) ? cached : null;
  const url = `${HELPER}/replay?md5=${checksum}&keys=${keys}${pick ? `&file=${encodeURIComponent(pick.file)}` : ""}`;
  try {
    const res = await fetch(url, { headers: { Origin: "http://127.0.0.1:24050" } });
    const data = await res.json();
    if (data && data.found && Array.isArray(data.actions)) {
      const rec = { file: data.file, score: data.score, counts: data.counts, actions: data.actions };
      fs.writeFileSync(cachePath, JSON.stringify(rec));
      return rec;
    }
    console.log("[ln-analyze] helper /replay not found for", checksum, pick ? `(file ${pick.file})` : "");
  } catch (err) {
    console.log("[ln-analyze] helper /replay failed:", String((err && err.message) || err));
  }
  if (cached && Array.isArray(cached.actions)) {
    console.log("[ln-analyze] WARNING: falling back to cached actions.json, its file may not match this session");
    return cached;
  }
  return null;
}

function replayExact(harness, actions, md5, keysN, mods, counts) {
  const { api } = harness;
  configure(api, md5, keysN, mods);
  const s = api.state;
  const notes = s.beatmap.notes;
  s.exactCounts = Array.isArray(counts) ? counts : null;
  const offset = Number.isFinite(OFFSET) ? OFFSET : api.exactOffsetFor(actions);
  const applied = api.applyExactTimeline(actions, offset);
  const pts = s.points;
  const pMatched = new Uint8Array(pts.length);
  const pE = new Float64Array(pts.length).fill(NaN);
  const pJ = new Int8Array(pts.length).fill(-2);
  for (let i = 0; i < pts.length; i++) {
    pMatched[i] = pts[i].matched ? 1 : 0;
    if (pts[i].matched) {
      pJ[i] = pts[i].j;
      if (pts[i].e !== null) pE[i] = pts[i].e;
    }
  }
  return { offset, applied, pMatched, pE, pJ, counts: histogram(pJ, pMatched), api };
}

// ---------------------------------------------------------------- compare

function compare(live, exact) {
  const noteCount = live.notes.length;
  const NP = live.pE.length;
  const eLive = [];
  const eExact = [];
  const dE = [];
  const latency = [];
  const mismatchedNotes = [];
  const classDiff = {};
  let both = 0;
  let eIdentical = 0;
  let eWithin5 = 0;
  let eWithin20 = 0;
  let eBig = 0;
  let bigHeadAll = 0;
  let bigTailAll = 0;
  const bigAll = [];
  const bigSamples = [];
  let headDiff = 0;
  let tailDiff = 0;
  let onlyLive = 0;
  let onlyExact = 0;
  let eMissing = 0;
  // where did a live-rendered error actually belong, according to the exact replay?
  let attrOk = 0;
  let attrSelfOff = 0;
  let attrHeadTailSwap = 0;
  let attrSameColumn = 0;
  let attrOtherPoint = 0;
  let attrNoCounterpart = 0;
  const attrSamples = [];

  for (let i = 0; i < NP; i++) {
    if (UNTIL && live.pts[i].time > UNTIL) continue;
    if (live.pMatched[i] && exact.pMatched[i]) {
      both += 1;
      const eL = live.pE[i];
      const eX = exact.pE[i];
      if (!Number.isFinite(eL) || !Number.isFinite(eX)) {
        eMissing += 1;
        continue;
      }
      eLive.push(eL);
      eExact.push(eX);
      const d = Math.abs(eL - eX);
      dE.push(d);
      if (d < 0.5) eIdentical += 1;
      if (d <= 5) eWithin5 += 1;
      if (d <= 20) eWithin20 += 1;
      if (d > 50) {
        eBig += 1;
        if (live.pts[i].end) bigTailAll += 1;
        else bigHeadAll += 1;
        bigAll.push(i);
        if (bigSamples.length < 40) bigSamples.push(i);
      }
      if (live.pJ[i] !== exact.pJ[i]) {
        const k = `${exact.pJ[i]}->${live.pJ[i]}`;
        classDiff[k] = (classDiff[k] || 0) + 1;
      }
    } else if (live.pMatched[i] && !exact.pMatched[i]) onlyLive += 1;
    else if (!live.pMatched[i] && exact.pMatched[i]) onlyExact += 1;
  }

  // Attribution: does the live error fit the point it was assigned to? Errors repeat a lot (lots of
  // +0 / +1ms values), so searching for "the point that owns this error" is meaningless unless the
  // assigned point itself is rejected first.
  const exactFinite = [];
  for (let j = 0; j < NP; j++) if (exact.pMatched[j] && Number.isFinite(exact.pE[j])) exactFinite.push(j);
  for (let i = 0; i < NP; i++) {
    if (!live.pMatched[i] || !Number.isFinite(live.pE[i])) continue;
    const eL = live.pE[i];
    const selfD = Number.isFinite(exact.pE[i]) ? Math.abs(exact.pE[i] - eL) : Infinity;
    if (selfD <= 5) {
      attrOk += 1;
      continue;
    }
    if (selfD <= 20) {
      attrSelfOff += 1;
      continue;
    }
    const a = live.pts[i];
    let bestJ = -1;
    let bestD = Infinity;
    let bestDt = Infinity;
    for (const j of exactFinite) {
      if (j === i) continue;
      const d = Math.abs(exact.pE[j] - eL);
      if (d > 5) continue;
      const dt = Math.abs(live.pts[j].time - a.time);
      if (d < bestD - 1 || (d <= bestD + 1 && dt < bestDt)) {
        bestD = d;
        bestDt = dt;
        bestJ = j;
      }
    }
    if (bestJ >= 0) {
      const b = live.pts[bestJ];
      let kind = "other-column";
      if (a.note === b.note) {
        kind = "head/tail";
        attrHeadTailSwap += 1;
      } else if (a.column === b.column) {
        kind = "same-column";
        attrSameColumn += 1;
      } else {
        attrOtherPoint += 1;
      }
      if (attrSamples.length < 80) {
        attrSamples.push({
          livePoint: i,
          exactPoint: bestJ,
          kind,
          live: { note: a.note, column: a.column, end: !!a.end, time: Math.round(a.time), e: round1(eL) },
          exact: { note: b.note, column: b.column, end: !!b.end, time: Math.round(b.time), e: round1(exact.pE[bestJ]) },
          songDelta: Math.round(a.time - b.time)
        });
      }
    } else {
      attrNoCounterpart += 1;
    }
  }

  // For every strongly disagreeing point, look for a *nearby* point (within 1.5s of song time) that
  // carries exactly the live error. The same error value repeats across the whole map, so a global
  // lookup is meaningless; a repeat sitting next to the point in time — usually in the same column or
  // on the same note — is what a mis-assignment looks like. When the reverse also holds, the two
  // points swapped errors: the live pipeline coloured A with B's error and B with A's.
  let bigNeighbour = 0;
  let bigNeighbourSwap = 0;
  let bigIsolated = 0;
  const bigKind = { headTail: 0, sameColumn: 0, otherColumn: 0 };
  const bigDt = [];
  for (const i of bigAll) {
    const a = live.pts[i];
    const eL = live.pE[i];
    if (!Number.isFinite(eL)) continue;
    let bestJ = -1;
    let bestT = Infinity;
    for (let j = 0; j < NP; j++) {
      if (j === i) continue;
      if (!exact.pMatched[j] || !Number.isFinite(exact.pE[j])) continue;
      if (Math.abs(exact.pE[j] - eL) > 5) continue;
      const dt = Math.abs(live.pts[j].time - a.time);
      if (dt > 1500 || dt >= bestT) continue;
      bestT = dt;
      bestJ = j;
    }
    if (bestJ < 0) {
      bigIsolated += 1;
      continue;
    }
    bigNeighbour += 1;
    const b = live.pts[bestJ];
    bigDt.push(b.time - a.time);
    if (a.note === b.note) bigKind.headTail += 1;
    else if (a.column === b.column) bigKind.sameColumn += 1;
    else bigKind.otherColumn += 1;
    const eJLive = live.pE[bestJ];
    const eIExact = exact.pE[i];
    if (Number.isFinite(eJLive) && Number.isFinite(eIExact) && Math.abs(eJLive - eIExact) <= 10) {
      bigNeighbourSwap += 1;
    }
  }
  const bigHead = bigHeadAll;
  const bigTail = bigTailAll;
  // sanity control: the same "nearby point carries my error" test applied to points that are already
  // correct, to see how much of the 319 is just dense-chart collision noise.
  const okSample = [];
  for (let i = 0; i < NP && okSample.length < 326; i += 8) {
    if (live.pMatched[i] && exact.pMatched[i] && Number.isFinite(live.pE[i]) && Number.isFinite(exact.pE[i]) && Math.abs(live.pE[i] - exact.pE[i]) <= 5) {
      okSample.push(i);
    }
  }
  let okNeighbour = 0;
  for (const i of okSample) {
    const a = live.pts[i];
    const eL = live.pE[i];
    for (let j = 0; j < NP; j++) {
      if (j === i) continue;
      if (!exact.pMatched[j] || !Number.isFinite(exact.pE[j])) continue;
      if (Math.abs(exact.pE[j] - eL) > 5) continue;
      if (Math.abs(live.pts[j].time - a.time) > 1500) continue;
      okNeighbour += 1;
      break;
    }
  }

  // Miss colouring latency: a miss is only known once its judgement window has fully elapsed.
  const missLatency = [];
  const missWindow = live.missWindow;
  for (let i = 0; i < NP; i++) {
    if (!live.pMatched[i] || live.pJ[i] !== -1 || !Number.isFinite(live.pAt[i])) continue;
    const p = live.pts[i];
    const expected = p.time + (Number.isFinite(missWindow) ? missWindow : 0);
    missLatency.push(live.songAt(live.pAt[i]) - expected);
  }

  for (let n = 0; n < noteCount; n++) {
    const note = live.notes[n];
    if (UNTIL && Math.max(note.time, note.endTime || note.time) > UNTIL) continue;
    const lh = live.headVal[n];
    const eh = exact.noteState ? exact.noteState[n] : null;
    const lHead = lh === 127 ? null : lh;
    const lTail = live.tailVal[n] === 127 ? null : live.tailVal[n];
    const eHead = eh ? eh.head : null;
    const eTail = eh ? eh.tail : null;
    const headMismatch = lHead !== eHead;
    const tailMismatch = lTail !== eTail;
    if (headMismatch) headDiff += 1;
    if (tailMismatch) tailDiff += 1;
    if ((headMismatch || tailMismatch) && mismatchedNotes.length < 200) {
      const headIdx = indexOfPoint(live.pts, n, false);
      const tailIdx = indexOfPoint(live.pts, n, true);
      mismatchedNotes.push({
        note: n,
        column: note.column,
        hold: !!note.hold,
        time: Math.round(note.time),
        endTime: Math.round(note.endTime),
        live: { head: lHead, tail: lTail },
        exact: { head: eHead, tail: eTail },
        liveE: {
          head: headIdx >= 0 ? round1(live.pE[headIdx]) : null,
          tail: tailIdx >= 0 ? round1(live.pE[tailIdx]) : null
        },
        exactE: {
          head: headIdx >= 0 ? round1(exact.pE[headIdx]) : null,
          tail: tailIdx >= 0 ? round1(exact.pE[tailIdx]) : null
        },
        liveAt: {
          head: headIdx >= 0 ? Math.round(live.headAt[n]) : null,
          tail: tailIdx >= 0 ? Math.round(live.tailAt[n]) : null
        }
      });
    }
    // color latency for the judged slots (only once per slot)
    const headIdx = indexOfPoint(live.pts, n, false);
    const tailIdx = indexOfPoint(live.pts, n, true);
    if (headIdx >= 0 && live.pMatched[headIdx] && Number.isFinite(live.headAt[n])) {
      latency.push(live.songAt(live.headAt[n]) - pointExpected(live, headIdx));
    }
    if (tailIdx >= 0 && live.pMatched[tailIdx] && Number.isFinite(live.tailAt[n])) {
      latency.push(live.songAt(live.tailAt[n]) - pointExpected(live, tailIdx));
    }
  }

  return {
    both,
    onlyLive,
    onlyExact,
    eMissing,
    eIdentical,
    eWithin5,
    eWithin20,
    eBig,
    dE,
    classDiff,
    headDiff,
    tailDiff,
    mismatchedNotes,
    latency,
    missLatency,
    bigSamples,
    bigHead,
    bigTail,
    bigNear: { found: bigNeighbour, swap: bigNeighbourSwap, isolated: bigIsolated, kind: bigKind, dt: bigDt },
    bigNearControl: { n: okSample.length, found: okNeighbour },
    bigRows: bigSamples.map((i) => ({
      point: i,
      note: live.pts[i].note,
      column: live.pts[i].column,
      end: !!live.pts[i].end,
      time: Math.round(live.pts[i].time),
      liveE: live.pE[i],
      exactE: exact.pE[i]
    })),
    attest: {
      ok: attrOk,
      selfOff: attrSelfOff,
      headTailSwap: attrHeadTailSwap,
      sameColumn: attrSameColumn,
      otherPoint: attrOtherPoint,
      noCounterpart: attrNoCounterpart,
      samples: attrSamples
    }
  };
}

// expected recorder time (minus song offset) at which the live renderer should have coloured idx
function pointExpected(live, idx) {
  const p = live.pts[idx];
  if (Number.isFinite(live.pE[idx])) return p.time + live.pE[idx];
  if (live.pJ[idx] === -1 && Number.isFinite(live.missWindow)) return p.time + live.missWindow;
  return p.time;
}

function indexOfPoint(pts, note, end) {
  for (let i = 0; i < pts.length; i++) {
    if (pts[i].note === note && !!pts[i].end === !!end) return i;
  }
  return -1;
}
const round1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

// ---------------------------------------------------------------- main

const liveH = makeHarness();
const live = replayLive(liveH, events, seg, checksum, keys);

// ------------------------------------------------------- live assignment diagnostics
function diagAssignments(live, gameCounts) {
  const a = live.assigned || [];
  const pts = live.pts;
  let press = 0;
  let pressHead = 0;
  let pressFuture = 0;
  let pressLate20 = 0;
  let pressLate50 = 0;
  let pressLate100 = 0;
  let pressLate150 = 0;
  let rel = 0;
  let relTail = 0;
  let relTailFuture = 0;
  let relTailHeadNotYet = 0;
  let relTailHeadPast = 0;
  const leadBuckets = new Map();
  let leadMax = -Infinity;
  let leadMin = Infinity;
  let claims = 0;
  for (const ev of a) {
    for (const c of ev.claimed) {
      claims += 1;
      const lead = c.time - ev.songT;
      if (ev.down) {
        press += 1;
        if (!c.end) pressHead += 1;
        if (lead > 1) pressFuture += 1;
        if (lead > 20) pressLate20 += 1;
        if (lead > 50) pressLate50 += 1;
        if (lead > 100) pressLate100 += 1;
        if (lead > 150) pressLate150 += 1;
      } else {
        rel += 1;
        if (c.end) {
          relTail += 1;
          if (lead > 1) {
            relTailFuture += 1;
            if (lead > leadMax) leadMax = lead;
            if (lead < leadMin) leadMin = lead;
            const b = Math.round(lead / 10) * 10;
            leadBuckets.set(b, (leadBuckets.get(b) || 0) + 1);
          }
          const np = liveH.api.state.notePoints[c.note];
          if (np && np.head && np.head.time > ev.songT + 1) relTailHeadNotYet += 1;
          if (np && np.head && np.head.matched) relTailHeadPast += 1;
        }
      }
    }
  }
  const buckets = [...leadBuckets.entries()].sort((x, y) => x[0] - y[0]).map(([k, v]) => `${k}ms:${v}`).join(" ");
  console.log("\n--- live assignment diagnostics ---");
  console.log(`key events ${a.length}, claims ${claims}`);
  console.log(`presses ${press} -> head claims ${pressHead}, future-head (>1ms early) ${pressFuture}`);
  console.log(`  head claims LATE vs note time: >20ms ${pressLate20}, >50ms ${pressLate50}, >100ms ${pressLate100}, >150ms ${pressLate150}`);
  console.log(`releases ${rel} -> tail claims ${relTail}; of them FUTURE tail (>1ms before its time) ${relTailFuture}` +
    (relTailFuture ? ` lead ${leadMin}..${leadMax}ms [${buckets}]` : ""));
  console.log(`  of those future-tail claims: hold head not pressed yet ${relTailHeadNotYet}, head already matched ${relTailHeadPast}`);

  // per-column claim order: a claim that skips over still-unmatched points in the same column is
  // exactly the "train derailment" the player sees (everything after it is one note too far).
  const colList = (wantEnd) => {
    const idx = [];
    for (let i = 0; i < pts.length; i++) if (!!pts[i].end === wantEnd) idx.push(i);
    return idx;
  };
  const posOf = new Map();
  for (const wantEnd of [false, true]) {
    const list = colList(wantEnd);
    const perCol = new Map();
    for (let i = 0; i < list.length; i++) {
      const p = pts[list[i]];
      if (!perCol.has(p.column)) perCol.set(p.column, []);
      perCol.get(p.column).push(list[i]);
    }
    for (const [, arr] of perCol) for (let i = 0; i < arr.length; i++) posOf.set(arr[i], { list: arr, pos: i });
  }
  const lastPos = new Map();
  const gapHist = new Map();
  let gapClaims = 0;
  let gapTotal = 0;
  for (const ev of a) {
    for (const c of ev.claimed) {
      const inf = posOf.get(c.idx);
      if (!inf) continue;
      const key = `${ev.col}:${c.end ? "tail" : "head"}`;
      const prev = lastPos.has(key) ? lastPos.get(key) : -1;
      const gap = inf.pos - prev - 1;
      if (gap > 0) {
        gapClaims += 1;
        gapTotal += gap;
        gapHist.set(gap, (gapHist.get(gap) || 0) + 1);
      }
      if (!lastPos.has(key) || inf.pos > prev) lastPos.set(key, inf.pos);
    }
  }
  const gapStr = [...gapHist.entries()].sort((x, y) => x[0] - y[0]).map(([k, v]) => `+${k}:${v}`).join(" ");
  console.log(`claims that JUMPED OVER unmatched same-column points: ${gapClaims} (skipped total ${gapTotal}) [${gapStr}]`);
  let unclaimedHeads = 0;
  let unclaimedTails = 0;
  for (let i = 0; i < pts.length; i++) if (!pts[i].matched) (pts[i].end ? (unclaimedTails += 1) : (unclaimedHeads += 1));
  console.log(`unmatched at end: heads ${unclaimedHeads}, tails ${unclaimedTails}`);

  // raw per-point class histograms (V1: materialised head class may already be the settled one)
  for (const wantEnd of [false, true]) {
    const c = [0, 0, 0, 0, 0, 0];
    let unmatched = 0;
    for (let i = 0; i < pts.length; i++) {
      if (!!pts[i].end !== wantEnd) continue;
      if (!live.pMatched[i]) {
        unmatched += 1;
        continue;
      }
      const j = live.pJ[i];
      if (j === -1) c[5] += 1;
      else if (j >= 0 && j <= 4) c[j] += 1;
      else unmatched += 1;
    }
    console.log(`point-level live ${wantEnd ? "tails" : "heads"}: [${c.join(", ")}] unmatched ${unmatched}`);
  }
  if (gameCounts) {
    const N = live.notes.length;
    const agg = {
      "head-only": (i) => (live.headVal[i] === 127 ? null : live.headVal[i]),
      "tail-first": (i) => (live.tailVal[i] !== 127 ? live.tailVal[i] : live.headVal[i] === 127 ? null : live.headVal[i]),
      "worst": (i) => {
        const h = live.headVal[i] === 127 ? null : live.headVal[i];
        const t = live.tailVal[i] === 127 ? null : live.tailVal[i];
        if (h === null && t === null) return null;
        if (h === null) return t;
        if (t === null) return h;
        return Math.max(h, t);
      },
      "best": (i) => {
        const h = live.headVal[i] === 127 ? null : live.headVal[i];
        const t = live.tailVal[i] === 127 ? null : live.tailVal[i];
        if (h === null) return t;
        if (t === null) return h;
        return Math.min(h, t);
      }
    };
    for (const [name, f] of Object.entries(agg)) {
      const c = [0, 0, 0, 0, 0, 0];
      let unjudged = 0;
      for (let i = 0; i < N; i++) {
        const v = f(i);
        if (v === null || v === 127) unjudged += 1;
        else if (v === -1) c[5] += 1;
        else c[v] += 1;
      }
      const sum = c.reduce((x, y) => x + y, 0);
      const l1 = c.reduce((x, y, k) => x + Math.abs(y - gameCounts[k]), 0);
      console.log(`note-level ${name.padEnd(10)} : [${c.join(", ")}] sum ${sum} unjudged ${unjudged}  L1 vs game ${l1}`);
    }
    console.log(`game V1 counts (per note)  : [${gameCounts.join(", ")}] sum ${gameCounts.reduce((x, y) => x + y, 0)}`);
    console.log(`live hitErrors kept ${live.hitLen}, game hitErrors ${live.gameHitErrorsLen}`);
  }
  return { press, pressHead, pressFuture, rel, relTail, relTailFuture, relTailHeadNotYet, relTailHeadPast, leadMax };
}

function gameCountsFrom(events, endT) {
  let hits = null;
  for (const ev of events) {
    if (ev.ch !== "v2" || !ev.data || !ev.data.play || !ev.data.play.hits) continue;
    if (ev.t > endT) break;
    if (ev.data.play.hits.geki !== undefined) hits = ev.data.play.hits;
  }
  if (!hits) return null;
  return [hits.geki || 0, hits["300"] || 0, hits.katu || 0, hits["100"] || 0, hits["50"] || 0, hits["0"] || 0];
}
live.gameHitErrorsLen = (() => {
  let n = 0;
  for (const ev of events) if (ev.ch === "precise" && Number.isFinite(ev.hitErrorsLen) && ev.t <= seg.end) n = Math.max(n, ev.hitErrorsLen);
  return n;
})();
const gameCounts = gameCountsFrom(events, seg.end + 2000);
diagAssignments(live, gameCounts);
const actionInfo = await resolveActions();
const actions = actionInfo ? actionInfo.actions : null;
let exact = null;
if (actions) {
  const exactH = makeHarness();
  exact = replayExact(exactH, actions, checksum, keys, live.mods, actionInfo && actionInfo.counts);
  exact.noteState = Array.from({ length: live.notes.length }, (_, n) => {
    const np = exactH.api.state.notePoints[n];
    return np ? { head: np.head.matched ? np.head.j : null, tail: np.tail ? np.tail.j : null } : null;
  });
  {
    const c = [0, 0, 0, 0, 0, 0];
    let un = 0;
    for (const st of exact.noteState) {
      const v = st ? (st.head === null || st.head === undefined ? 127 : st.head) : 127;
      if (v === 127) un += 1;
      else if (v === -1) c[5] += 1;
      else c[v] += 1;
    }
    const l1 = gameCounts ? c.reduce((x, y, k) => x + Math.abs(y - gameCounts[k]), 0) : -1;
    console.log(`note-level exact      : [${c.join(", ")}] sum ${c.reduce((x, y) => x + y, 0)} unjudged ${un}  L1 vs game ${l1}`);
  }
  {
    const ep = exactH.api.state.points;
    for (const wantEnd of [false, true]) {
      const c = [0, 0, 0, 0, 0, 0];
      let unmatched = 0;
      for (let i = 0; i < ep.length; i++) {
        if (!!ep[i].end !== wantEnd) continue;
        if (!exact.pMatched[i]) {
          unmatched += 1;
          continue;
        }
        const j = exact.pJ[i];
        if (j === -1) c[5] += 1;
        else if (j >= 0 && j <= 4) c[j] += 1;
        else unmatched += 1;
      }
      console.log(`point-level exact ${wantEnd ? "tails" : "heads"}: [${c.join(", ")}] unmatched ${unmatched}`);
    }
  }
  {
    // which per-note rule reproduces the game's V1 counts? (stable counts a hold ONCE)
    const ep = exactH.api.state.points;
    const idxOf = new Map();
    ep.forEach((p, i) => idxOf.set(p, i));
    const np = exactH.api.state.notePoints;
    const cls = (p) => {
      if (!p) return null;
      const i = idxOf.get(p);
      if (i === undefined || !exact.pMatched[i]) return null;
      return exact.pJ[i] === -1 ? 5 : exact.pJ[i];
    };
    const rules = {
      "head-only": (n) => cls(np[n] && np[n].head),
      "tail-only": (n) => cls(np[n] && np[n].tail) ?? cls(np[n] && np[n].head),
      "worst": (n) => {
        const h = cls(np[n] && np[n].head);
        const t = cls(np[n] && np[n].tail);
        return h === null ? t : t === null ? h : Math.max(h, t);
      },
      "best": (n) => {
        const h = cls(np[n] && np[n].head);
        const t = cls(np[n] && np[n].tail);
        return h === null ? t : t === null ? h : Math.min(h, t);
      }
    };
    for (const [name, f] of Object.entries(rules)) {
      const c = [0, 0, 0, 0, 0, 0];
      for (let n = 0; n < np.length; n++) {
        const v = f(n);
        if (v === null) continue;
        c[v] += 1;
      }
      const l1 = gameCounts ? c.reduce((x, y, k) => x + Math.abs(y - gameCounts[k]), 0) : -1;
      console.log(`V1 rule ${name.padEnd(10)} (exact): [${c.join(", ")}]  L1 vs game ${l1}`);
    }
  }
} else {
  console.log("[ln-analyze] no actions -> exact comparison skipped (write <session>/actions.json or start helper)");
}

// game hitErrors multiset, for a sanity check against the live assignment
const hitSorted = live.hitErrors.slice().sort((a, b) => a - b);
function multisetMatch(sortedA, sortedB) {
  let same = 0;
  let maxDiff = 0;
  if (sortedA.length === sortedB.length && sortedA.length) {
    for (let i = 0; i < sortedA.length; i++) {
      const d = Math.abs(sortedA[i] - sortedB[i]);
      if (d < 0.5) same += 1;
      if (d > maxDiff) maxDiff = d;
    }
  }
  return { same, maxDiff, n: sortedA.length };
}
const exactESorted = [];
for (let i = 0; i < exact?.pE?.length; i++) {
  if (exact.pMatched[i] && Number.isFinite(exact.pE[i])) exactESorted.push(exact.pE[i]);
}
exactESorted.sort((a, b) => a - b);
const liveESorted = [];
{
  const qtl = (arr) => {
    const a = arr.filter((v) => Number.isFinite(v)).map((v) => Math.abs(v)).sort((x, y) => x - y);
    if (!a.length) return "n/a";
    const q = (f) => a[Math.min(a.length - 1, Math.floor(f * a.length))];
    return `p50 ${q(0.5).toFixed(1)} p90 ${q(0.9).toFixed(1)} p99 ${q(0.99).toFixed(1)} max ${a[a.length - 1].toFixed(1)} n ${a.length}`;
  };
  console.log(`|e| live   : ${qtl(Array.from(live.pE))}`);
  console.log(`|e| exact  : ${exact ? qtl(Array.from(exact.pE)) : "n/a"}`);
  console.log(`|e| game   : ${qtl(hitSorted)}`);
}for (let i = 0; i < live.pE.length; i++) if (live.pMatched[i] && Number.isFinite(live.pE[i])) liveESorted.push(live.pE[i]);
liveESorted.sort((a, b) => a - b);
let hitMatchSame = 0;
let hitMatchMaxDiff = 0;
{
  // coverage: how many live point errors are *exactly* one of the game hitErrors
  const has = (v) => {
    let lo = 0;
    let hi = hitSorted.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (hitSorted[mid] < v - 0.4) lo = mid + 1;
      else if (hitSorted[mid] > v + 0.4) hi = mid - 1;
      else return true;
    }
    return false;
  };
  for (const e of liveESorted) if (has(e)) hitMatchSame += 1;
  hitMatchMaxDiff = 0;
}

const result = {
  session: path.relative(root, SESSION),
  checksum,
  keys,
  map: mapPath,
  segment: { start: seg.start, end: seg.end, seconds: Math.round((seg.end - seg.start) / 100) / 10 },
  stream: { events: live.nEvents, keys: live.keyCount, precise: live.preciseCount, songOffset: live.songOffset },
  liveCounts: live.counts,
  gameHitErrors: { count: hitSorted.length, lastHitsTotal: seg.hitErrors }
};
const out = { ...result };
if (exact) {
  const cmp = compare(live, exact);
  const lat = (arr) => ({
    n: arr.length,
    median: median(arr),
    p95: pct(arr, 95),
    p99: pct(arr, 99),
    min: arr.length ? Math.min(...arr) : NaN,
    max: arr.length ? Math.max(...arr) : NaN
  });
  out.exact = {
    replayFile: actionInfo.file,
    replayScore: actionInfo.score,
    replayCounts: actionInfo.counts,
    replayFromCache: !!actionInfo.fromCache,
    counts: exact.counts,
    offset: exact.offset,
    applied: exact.applied,
    bothMatched: cmp.both,
    onlyLiveMatched: cmp.onlyLive,
    onlyExactMatched: cmp.onlyExact,
    eMissing: cmp.eMissing,
    eIdentical: cmp.eIdentical,
    eWithin5: cmp.eWithin5,
    eWithin20: cmp.eWithin20,
    eOver50: cmp.eBig,
    eOver50Head: cmp.bigHead,
    eOver50Tail: cmp.bigTail,
    bigNear: {
      found: cmp.bigNear.found,
      swap: cmp.bigNear.swap,
      isolated: cmp.bigNear.isolated,
      kind: cmp.bigNear.kind,
      dtMedian: median(cmp.bigNear.dt),
      dtP95: pct(cmp.bigNear.dt, 95),
      control: cmp.bigNearControl
    },
    dEMedian: median(cmp.dE),
    dEP95: pct(cmp.dE, 95),
    classDiff: cmp.classDiff,
    notesHeadDiff: cmp.headDiff,
    notesTailDiff: cmp.tailDiff,
    latency: lat(cmp.latency),
    missLatency: lat(cmp.missLatency),
    attribution: {
      ok: cmp.attest.ok,
      selfOff: cmp.attest.selfOff,
      headTailSwap: cmp.attest.headTailSwap,
      sameColumn: cmp.attest.sameColumn,
      otherPoint: cmp.attest.otherPoint,
      noCounterpart: cmp.attest.noCounterpart,
      samples: cmp.attest.samples.slice(0, 40)
    },
    eMultisetVsGame: {
      count: hitSorted.length,
      identical: hitMatchSame,
      maxDiff: hitMatchMaxDiff
    },
    exactEMultisetVsGame: multisetMatch(exactESorted, hitSorted),
  };
  out.mismatchedNotes = cmp.mismatchedNotes;

  fs.writeFileSync(path.join(SESSION, "analysis.json"), JSON.stringify(out, null, 2));

  console.log("");
  console.log(`session        : ${path.relative(root, SESSION)}`);
  console.log(`map            : ${checksum}  ${live.notes.length} notes / ${live.pts.length} points, ${keys}K`);
  console.log(`play segment   : ${out.segment.start}..${out.segment.end} ms (${out.segment.seconds}s)`);
  console.log(`stream         : ${live.nEvents} events (${live.preciseCount} precise, ${live.keyCount} hook keys), song offset ${fmt(live.songOffset, 0)}ms (${live.v2Samples} v2 clocks)`);
  console.log(`replay file    : ${actionInfo.file} (score ${actionInfo.score}, ${actionInfo.fromCache ? "cached" : "fetched"})`);
  console.log(`reverts        : points ${live.revertedPoints || 0}, notes ${live.revertedNotes || 0} (judged -> unjudged during the run)`);
  console.log(`clock states   : stalled precise ${live.stalledPrecise || 0}, timeSpeed>1.25 ${live.fastTime || 0} (DT/5x extrapolation path)`);
  console.log(`timeSpeed range: ${(live.timeSpeedRange || []).map((v) => (Number.isFinite(v) ? v.toFixed(3) : "n/a")).join(" .. ")} (pinned exactly at 1 before the analyzer fix)`);
  {
    const traces = (live.api && live.api.state && live.api.state.resetTraces) || [];
    const groups = new Map();
    for (const tr of traces) {
      const key = tr.replace(/ @d+$/, "");
      groups.set(key, (groups.get(key) || 0) + 1);
    }
    if (groups.size) {
      console.log("reset sites    :");
      for (const [k, v] of [...groups.entries()].sort((x, y) => y[1] - x[1])) console.log("  " + v + "x  " + k);
    }
  }
  {
    const traces = (live.api && live.api.state && live.api.state.resetTraces) || [];
    const groups = new Map();
    for (const tr of traces) {
      const key = tr.replace(/ @d+$/, "");
      groups.set(key, (groups.get(key) || 0) + 1);
    }
    if (groups.size) {
      console.log("reset sites    :");
      for (const [k, v] of [...groups.entries()].sort((x, y) => y[1] - x[1])) console.log("  " + v + "x  " + k);
    }
  }
  console.log("");
  console.log(`counts  live   : ${live.counts.join(", ")}  (sum ${live.counts.reduce((a, b) => a + b, 0)})`);
  console.log(`counts  exact  : ${exact.counts.join(", ")}  (sum ${exact.counts.reduce((a, b) => a + b, 0)})`);
  console.log("");
  console.log(`points matched live/exact/both : ${histSum(live.pMatched)} / ${histSum(exact.pMatched)} / ${cmp.both}`);
  console.log(`point error identical (<0.5ms) : ${cmp.eIdentical} (${pctStr(cmp.eIdentical, cmp.both)})`);
  console.log(`|dE| <= 5ms                    : ${cmp.eWithin5} (${pctStr(cmp.eWithin5, cmp.both)})`);
  console.log(`|dE| <= 20ms                   : ${cmp.eWithin20} (${pctStr(cmp.eWithin20, cmp.both)})`);
  console.log(`|dE| > 50ms (suspect)          : ${cmp.eBig} (${pctStr(cmp.eBig, cmp.both)}) = heads ${cmp.bigHead} / tails ${cmp.bigTail}`);
  console.log(`dE median / p95                : ${fmt(out.exact.dEMedian)} / ${fmt(out.exact.dEP95)} ms`);
  console.log(`notes with different head class: ${cmp.headDiff}`);
  console.log(`notes with different tail class: ${cmp.tailDiff}`);
  console.log(`only-live / only-exact matched : ${cmp.onlyLive} / ${cmp.onlyExact}`);
  console.log(`live errors taken from the game : ${hitMatchSame}/${liveESorted.length} points (${pctStr(hitMatchSame, liveESorted.length)}), game hitErrors ${hitSorted.length}`);
  if (live.api && live.api.state) console.log(`live error pairs              : fifo ${live.api.state.livePairFifo || 0}, scored ${live.api.state.livePairScored || 0}`);
  const exm = out.exact.exactEMultisetVsGame;
  console.log(`exact e vs game hitErrors      : ${exm.same}/${exm.n} identical, maxDiff ${fmt(exm.maxDiff, 0)}ms`);
  console.log(`color latency (song ms)        : median ${fmt(out.exact.latency.median)} / p95 ${fmt(out.exact.latency.p95)} / p99 ${fmt(out.exact.latency.p99)} (n=${out.exact.latency.n})`);
  console.log(`miss  latency (song ms)        : median ${fmt(out.exact.missLatency.median)} / p95 ${fmt(out.exact.missLatency.p95)} / p99 ${fmt(out.exact.missLatency.p99)} (n=${out.exact.missLatency.n})`);
  const at = out.exact.attribution;
  console.log(`attribution    : ok ${at.ok}, self-off ${at.selfOff}, head/tail swap ${at.headTailSwap}, same-column ${at.sameColumn}, other-point ${at.otherPoint}, no counterpart ${at.noCounterpart}`);
  const sh = out.exact.bigNear;
  console.log(`|dE| > 50ms neighbours       : ${sh.found} found / ${sh.swap} mutual swaps / ${sh.isolated} isolated  (head/tail ${sh.kind.headTail}, same-column ${sh.kind.sameColumn}, other-column ${sh.kind.otherColumn}; dt median ${fmt(sh.dtMedian)} / p95 ${fmt(sh.dtP95)}ms)`);
  console.log(`  control (already-correct pts): ${sh.control.found}/${sh.control.n} also find a nearby owner -> collision noise ${pctStr(sh.control.found, sh.control.n)}`);
  console.log(`class mismatches exact->live   : ${JSON.stringify(out.exact.classDiff)}`);
  console.log("");
  console.log(`analysis written: ${path.join(SESSION, "analysis.json")}`);
  writeMarkdown(out, cmp, SESSION);
  console.log(`report  written: ${path.join(SESSION, "analysis.md")}`);
} else {
  console.log(`counts live: ${live.counts.join(", ")}`);
  fs.writeFileSync(
    path.join(SESSION, "analysis-live-only.json"),
    JSON.stringify({ ...out, latencyNote: "exact skipped" }, null, 2)
  );
}

function histSum(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] ? 1 : 0;
  return s;
}
function pctStr(n, d) {
  return d ? `${((n / d) * 100).toFixed(1)}%` : "-";
}

function writeMarkdown(out, cmp, dir) {
  const L = [];
  L.push(`# Live vs exact judgement comparison`);
  L.push("");
  L.push(`- session: \`${out.session}\``);
  L.push(`- map: \`${out.checksum}\`, ${out.keys}K`);
  L.push(`- play segment: ${out.segment.start}..${out.segment.end} ms (${out.segment.seconds}s)`);
  L.push(`- live stream: ${out.stream.events} events, ${out.stream.precise} precise, ${out.stream.keys} hook keys`);
  L.push("");
  L.push(`## counts (perfect, great, good, ok, meh, miss)`);
  L.push("");
  L.push(`| source | 0 | 1 | 2 | 3 | 4 | 5 | sum |`);
  L.push(`| --- | --- | --- | --- | --- | --- | --- | --- |`);
  L.push(`| live  | ${out.liveCounts.join(" | ")} | ${out.liveCounts.reduce((a, b) => a + b, 0)} |`);
  L.push(`| exact | ${out.exact.counts.join(" | ")} | ${out.exact.counts.reduce((a, b) => a + b, 0)} |`);
  L.push("");
  L.push(`## per-point error comparison (${cmp.both} points matched in both)`);
  L.push("");
  L.push(`| metric | value |`);
  L.push(`| --- | --- |`);
  L.push(`| identical e (<0.5ms) | ${cmp.eIdentical} (${pctStr(cmp.eIdentical, cmp.both)}) |`);
  L.push(`| \|dE\| <= 5ms | ${cmp.eWithin5} (${pctStr(cmp.eWithin5, cmp.both)}) |`);
  L.push(`| \|dE\| <= 20ms | ${cmp.eWithin20} (${pctStr(cmp.eWithin20, cmp.both)}) |`);
  L.push(`| \|dE\| > 50ms | ${cmp.eBig} (${pctStr(cmp.eBig, cmp.both)}) = heads ${cmp.bigHead} / tails ${cmp.bigTail} |`);
  L.push(`| \|dE\| > 50ms: nearby owner / mutual swap / isolated | ${out.exact.bigNear.found} / ${out.exact.bigNear.swap} / ${out.exact.bigNear.isolated} |`);
  L.push(`| \|dE\| > 50ms: nearby-owner control rate (correct points) | ${out.exact.bigNear.control.found}/${out.exact.bigNear.control.n} (${pctStr(out.exact.bigNear.control.found, out.exact.bigNear.control.n)}) |`);
  L.push(`| dE median / p95 | ${fmt(out.exact.dEMedian)} / ${fmt(out.exact.dEP95)} ms |`);
  L.push(`| notes: different head class | ${cmp.headDiff} |`);
  L.push(`| notes: different tail class | ${cmp.tailDiff} |`);
  L.push(`| only live matched / only exact matched | ${cmp.onlyLive} / ${cmp.onlyExact} |`);
  L.push(`| live e multiset vs game hitErrors | ${out.exact.eMultisetVsGame.identical}/${out.exact.eMultisetVsGame.count} identical |`);
  L.push(`| color latency median / p95 / p99 | ${fmt(out.exact.latency.median)} / ${fmt(out.exact.latency.p95)} / ${fmt(out.exact.latency.p99)} ms |`);
  L.push(`| miss latency median / p95 / p99 | ${fmt(out.exact.missLatency.median)} / ${fmt(out.exact.missLatency.p95)} / ${fmt(out.exact.missLatency.p99)} ms |`);
  L.push(`| attribution: ok / self-off / head-tail swap / same-column / other-point / no counterpart | ${out.exact.attribution.ok} / ${out.exact.attribution.selfOff} / ${out.exact.attribution.headTailSwap} / ${out.exact.attribution.sameColumn} / ${out.exact.attribution.otherPoint} / ${out.exact.attribution.noCounterpart} |`);
  L.push("");
  L.push(`## error attribution samples (live error matched to a different exact point)`);
  L.push("");
  L.push(`| kind | live note/col/end/time/e | exact note/col/end/time/e | dt (ms) |`);
  L.push(`| --- | --- | --- | --- |`);
  for (const s of out.exact.attribution.samples.slice(0, 30)) {
    L.push(
      `| ${s.kind} | ${s.live.note}/${s.live.column}/${s.live.end ? "tail" : "head"}/${s.live.time}/${fmt(s.live.e)} | ${s.exact.note}/${s.exact.column}/${s.exact.end ? "tail" : "head"}/${s.exact.time}/${fmt(s.exact.e)} | ${s.songDelta} |`
    );
  }
  L.push("");
  L.push(`## first 40 notes with a differing head/tail class`);
  L.push("");
  L.push(`| note | col | hold | time | end | live head/tail | exact head/tail | live e h/t | exact e h/t | live colorAt h/t |`);
  L.push(`| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
  for (const m of cmp.mismatchedNotes.slice(0, 40)) {
    L.push(
      `| ${m.note} | ${m.column} | ${m.hold ? "LN" : "-"} | ${m.time} | ${m.endTime} | ${show(m.live.head)}/${show(m.live.tail)} | ${show(m.exact.head)}/${show(m.exact.tail)} | ${show(m.liveE.head)}/${show(m.liveE.tail)} | ${show(m.exactE.head)}/${show(m.exactE.tail)} | ${show(m.liveAt.head)}/${show(m.liveAt.tail)} |`
    );
  }
  L.push("");
  L.push(`## largest |dE| points`);
  L.push("");
  L.push(`| point | note | col | end | live e | exact e | dE |`);
  L.push(`| --- | --- | --- | --- | --- | --- | --- |`);
  for (const b of cmp.bigRows.slice(0, 30)) {
    L.push(`| ${b.point} | ${b.note} | ${b.column} | ${b.end ? "tail" : "head"} | ${round1(b.liveE)} | ${round1(b.exactE)} | ${fmt(Math.abs(b.liveE - b.exactE))} |`);
  }
  L.push("");
  fs.writeFileSync(path.join(dir, "analysis.md"), L.join("\n"));
}
function show(v) {
  return v === null || v === undefined ? "-" : String(v);
}
