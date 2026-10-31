import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const code = fs.readFileSync(path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "main.js"), "utf8");

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
  const target = { globalAlpha: 1 };
  return new Proxy(target, {
    get: (t, p) => {
      if (p in t) return t[p];
      if (p === "calls") return calls;
      return (...args) => { calls.push(p); };
    },
    set: (t, p, v) => { t[p] = v; return true; }
  });
}

const mainCtx = makeCtx();
const doc = {
  createElement: () => new E(),
  getElementById: (id) => {
    if (id === "preview") {
      const c = new E();
      c.getContext = () => mainCtx;
      return c;
    }
    return new E();
  },
  body: new E()
};

class WS { constructor(u) { this.url = u; this.readyState = 1; this.sent = []; } send(d) { this.sent.push(d); } close() {} }

const eventSources = [];
class FakeEventSource {
  constructor(url) { this.url = url; this.readyState = 1; this.onmessage = null; this.onerror = null; eventSources.push(this); }
  close() { this.readyState = 2; }
}

const clock = { now: 0 };
const fakePerformance = { now: () => clock.now };
const storage = new Map();
const sb = {
  console, Date, Math, JSON, Number, Object, Array, Map, Set, String, Boolean, Error, Promise, Float64Array, Uint8Array,
  parseInt, parseFloat, isNaN, setTimeout, clearTimeout,
  requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
  performance: fakePerformance,
  WebSocket: WS,
  EventSource: FakeEventSource,
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k)
  },
  fetch: async () => { throw new Error("network disabled"); },
  location: { host: "127.0.0.1:24050" },
  document: doc,
  window: { self: {}, top: {}, COUNTER_PATH: "Mania Replay Master", innerWidth: 640, innerHeight: 480, devicePixelRatio: 1, addEventListener() {} }
};
sb.__advance = (ms) => {
  clock.now += ms;
};
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(code, sb, { filename: "main.js" });

const api = sb.window.__maniaReplayMaster;
let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log("PASS ", name, extra === undefined ? "" : JSON.stringify(extra)); }
  else { fail += 1; console.log("FAIL ", name, extra === undefined ? "" : JSON.stringify(extra)); }
}
function close(a, b, eps = 1e-6) {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => close(v, b[i], eps));
  return Math.abs(a - b) <= eps;
}

console.log("== judgement windows ==");
api.state.client = "stable";
api.state.scoreV2 = false;
api.state.classicMod = true;
api.state.odConverted = 8.5;
api.state.beatmap = null;
ok("stable v1 OD8.5", close(api.localWindows(), [16.5, 38.5, 71.5, 101.5, 125.5, 162.5]), api.localWindows());

api.state.scoreV2 = true;
ok("stable v2 OD8.5", close(api.localWindows(), [15.5, 38.5, 71.5, 101.5, 125.5, 162.5]), api.localWindows());

api.state.client = "lazer";
api.state.scoreV2 = false;
api.state.classicMod = false;
api.state.modsRate = 1.5;
ok("lazer original OD8.5 DT scales windows with rate", close(api.localWindows(), [23.5, 57.5, 107.5, 152.5, 188.5, 243.5]), api.localWindows());

api.state.client = "stable";
api.state.scoreV2 = false;
api.state.classicMod = true;
api.state.modsRate = 1.5;
ok("stable v1 OD8.5 DT scales windows with rate", close(api.localWindows(), [24.5, 57.5, 107.5, 152.5, 188.5, 243.5]), api.localWindows());

api.state.client = "lazer";
api.state.classicMod = true;
api.state.modsRate = 1;
ok("lazer classic OD8.5", close(api.localWindows(), [16.5, 38.5, 71.5, 101.5, 125.5, 162.5]), api.localWindows());

console.log("== window alignment at other ODs ==");
api.state.client = "stable";
api.state.odConverted = 10;
api.state.scoreV2 = true;
ok("stable v2 OD10", close(api.localWindows(), [13.5, 34.5, 67.5, 97.5, 121.5, 158.5]), api.localWindows());
api.state.scoreV2 = false;
ok("stable v1 OD10", close(api.localWindows(), [16.5, 34.5, 67.5, 97.5, 121.5, 158.5]), api.localWindows());
api.state.odConverted = 0;
api.state.scoreV2 = true;
ok("stable v2 OD0", close(api.localWindows(), [22.5, 64.5, 97.5, 127.5, 151.5, 188.5]), api.localWindows());
api.state.scoreV2 = false;
ok("stable v1 OD0", close(api.localWindows(), [16.5, 64.5, 97.5, 127.5, 151.5, 188.5]), api.localWindows());
api.state.odConverted = 8.5;
api.state.hitWindow = null;
api.updateWindows();
ok("recorded hit never classifies as miss", api.classifyError(999) === 4 && api.classifyError(200) === 4 && api.classifyError(16) === 0, [api.classifyError(999), api.classifyError(200), api.classifyError(16)]);
api.state.client = "stable";
api.state.scoreV2 = true;
api.state.odConverted = 8.5;
api.state.beatmap = null;
api.state.hitWindow = { perfect: 1, great: 1, good: 1, ok: 1, meh: 1, miss: 1 };
api.updateWindows();
ok("stable windows use exact table, not tosu value", close(api.state.windows, [15.5, 38.5, 71.5, 101.5, 125.5, 162.5]), api.state.windows);
api.state.hitWindow = null;
api.state.scoreV2 = false;
api.state.odConverted = 8.5;
api.updateWindows();

api.state.client = "stable";
api.state.scoreV2 = false;
api.state.classicMod = true;
api.state.modsRate = 1;
api.state.odConverted = 4;

console.log("== fall speed / review time ==");
api.state.maniaScrollSpeed = 7;
api.settings.maniaScrollSpeedOverride = 0;
api.settings.hitPosition = 200;
api.settings.reviewTime = 1500;
const tr = api.effectiveTimeRange(200);
const postMs = (480 - 200) / (200 / tr);
ok("fast scroll clamped to 1500ms review", Math.abs(postMs - 1500) < 1, +postMs.toFixed(1));
api.state.maniaScrollSpeed = 2;
const trSlow = api.effectiveTimeRange(200);
const postSlow = (480 - 200) / (200 / trSlow);
ok("slow scroll keeps natural speed", postSlow >= 1500, +postSlow.toFixed(1));
api.settings.hitPosition = 80;
api.state.maniaScrollSpeed = 7;
const tr80 = api.effectiveTimeRange(80);
const post80 = (480 - 80) / (80 / tr80);
ok("line at 80 keeps review >= 1500ms", post80 >= 1500, +post80.toFixed(1));

console.log("== playback rate estimation ==");
sb.__advance(150);
api.setTime(0);
for (let i = 1; i <= 10; i++) {
  sb.__advance(150);
  api.setTime(i * 750);
}
sb.__advance(75);
const est = api.renderTime();
ok("5x playback extrapolation", Math.abs(est - 7875) < 120, +est.toFixed(0));

console.log("== parsing / points ==");
const osu = [
  "osu file format v14",
  "",
  "[General]",
  "Mode: 3",
  "",
  "[Difficulty]",
  "CircleSize:4",
  "OverallDifficulty:8.5",
  "",
  "[TimingPoints]",
  "0,500,4,2,0,100,1,0",
  "",
  "[HitObjects]",
  "64,192,1000,1,0,0:0:0:0:",
  "192,192,1050,128,0,1500:0:0:0:0:",
  "320,192,1200,1,0,0:0:0:0:",
  "448,192,1000,1,0,0:0:0:0:"
].join("\n");
const parsed = api.parseOsu(osu);
ok("parse objects", parsed.objects.length === 4, parsed.objects.length);
const map = api.buildManiaNotes(parsed, 4);
ok("native notes", map.notes.length === 4, map.notes.length);
ok("hold flag", map.notes.find((n) => n.time === 1050).hold === true);
ok("hold end", map.notes.find((n) => n.time === 1050).endTime === 1500);
api.state.mapMode = "mania";
api.state.csConverted = 4;
api.state.beatmap = map;
api.state.hitWindow = null;
api.state.odConverted = 8.5;
api.updateWindows();
api.buildPoints();
ok("point count", api.state.points.length === 5, api.state.points.length);

console.log("== matching (scorev2) ==");
api.state.client = "stable";
api.state.scoreV2 = true;
api.updateWindows();
api.processError(-5, 1005);
ok("perfect on chord note 0", api.state.noteState[0].head === 0, api.state.noteState[0].head);
api.processError(0, 1005);
ok("chord note 1 matched", api.state.noteState[1].head === 0, api.state.noteState[1].head);
api.processError(50, 1090);
ok("good on LN head (note 2)", api.state.noteState[2].head === 2, api.state.noteState[2].head);
api.sweepMisses(1400);
ok("missed note 3", api.state.noteState[3].head === -1, api.state.noteState[3].head);
ok("LN tail not swept yet", api.state.noteState[2].tail === null, api.state.noteState[2].tail);

console.log("== matching (v1 LN release) ==");
api.state.scoreV2 = false;
api.updateWindows();
api.resetJudgements();
api.processError(120, 1600);
ok("v1 LN tail match (note 2)", api.state.noteState[2].tail === 4 && api.state.noteState[2].head === 4, {
  head: api.state.noteState[2].head,
  tail: api.state.noteState[2].tail
});
api.resetJudgements();
api.processError(-5, 1055);
ok("v1 LN head match colors whole note", api.state.noteState[2].head === 0 && api.state.noteState[2].tail === 0, {
  head: api.state.noteState[2].head,
  tail: api.state.noteState[2].tail
});
api.sweepMisses(2000);
ok("v1 judged LN not overridden to miss", api.state.noteState[2].head === 0 && api.state.noteState[2].tail === 0, {
  head: api.state.noteState[2].head,
  tail: api.state.noteState[2].tail
});
api.resetJudgements();
api.processError(-10, 1040);
api.processError(120, 1620);
ok("v1 combined LN judgement (head+tail)", api.state.noteState[2].head === 2 && api.state.noteState[2].tail === 2, {
  head: api.state.noteState[2].head,
  tail: api.state.noteState[2].tail
});

console.log("== v1 LN extra events (release + re-press) ==");
api.resetJudgements();
api.processError(-5, 1055);
ok("LN head judged", api.state.noteState[2].head === 0 && api.state.noteState[2].tail === 0, [api.state.noteState[2].head, api.state.noteState[2].tail]);
api.processError(300, 1360);
ok("extra event merges into the same LN as worst", api.state.noteState[2].head === 4 && api.state.noteState[2].tail === 4, [api.state.noteState[2].head, api.state.noteState[2].tail]);
ok("following note not corrupted by merge", api.state.noteState[3].head === null, api.state.noteState[3].head);
api.processError(0, 1205);
ok("following note still matches its own error", api.state.noteState[3].head === 0, api.state.noteState[3].head);

console.log("== run cache (prejudged replay timeline) ==");
api.state.checksum = "unit-map";
api.resetJudgements();
api.saveRun(true);
const runsSaved = api.loadRuns();
ok("no run stored when empty", runsSaved.length === 0, runsSaved.length);
api.processError(-5, 1005);
api.processError(0, 1005);
api.saveRun(true);
const runs = api.loadRuns();
ok("run saved", runs.length === 1 && runs[0].matches.length === 2, runs.length && runs[0].matches.length);
ok("key is map/mods scoped", api.runStorageKey().includes("stable"), api.runStorageKey());
api.resetJudgements();
ok("state reset before apply", api.state.noteState.every((s) => s.head === null));
api.state.replayUi = true;
const applied = api.applyRun(runs[0]);
ok("run applied", applied === true && api.state.cached === true);
ok("matched notes colored from timeline", api.state.noteState[0].head === 0 && api.state.noteState[1].head === 0, [api.state.noteState[0].head, api.state.noteState[1].head]);
ok("unmatched become misses", api.state.noteState[2].head === -1 && api.state.noteState[2].tail === -1 && api.state.noteState[3].head === -1, [api.state.noteState[2].head, api.state.noteState[2].tail, api.state.noteState[3].head]);
ok("action times prebuilt", api.state.notePoints[0].head.at === 1000 - 5, api.state.notePoints[0].head.at);
api.state.gameState = "play";
api.onPrecise({ hitErrors: [-5, 0] });
ok("prefix matches cached run", api.state.cached === true && api.state.cacheChecked === 2, [api.state.cached, api.state.cacheChecked]);
api.onPrecise({ hitErrors: [-5, 0, 33] });
ok("prefix mismatch falls back to live", api.state.cached === false && api.state.errorCount === 3, [api.state.cached, api.state.errorCount]);
api.state.cached = false;
api.state.runPrefix = [];
api.resetJudgements();
api.processError(-5, 1005);
api.processError(0, 1005);
const key = api.runStorageKey();
storage.delete(key);
ok("in-memory fallback survives storage loss", api.loadRuns().length === 1, api.loadRuns().length);
storage.set(key, JSON.stringify([{ v: 1, g: 1, matches: [[0, -5]] }]));
ok("stale run cache discarded", api.loadRuns().length === 0, api.loadRuns().length);

console.log("== replay stats timeline ==");
api.state.hits = null;
api.state.cached = false;
api.state.exactApplied = false;
api.applyRun(runs[0]);
ok("cached replay stats start at zero", api.panelStats(0).counts.every((c) => c === 0), api.panelStats(0).counts);
ok("cached replay stats count after note time", api.panelStats(1001).counts[0] === 2, api.panelStats(1001).counts);
ok("cached replay UR zero before first hits", api.unstableRate(999) === 0, api.unstableRate(999));
ok("cached replay stats complete at end", api.panelStats(5000).counts[0] === 2 && api.panelStats(5000).counts[5] === 2, api.panelStats(5000).counts);

console.log("== exact replay vs live input priority ==");
api.state.gameState = "play";
api.state.beatmap = map;
api.state.csConverted = 4;
api.state.mapMode = "mania";
api.state.hitWindow = null;
api.updateWindows();
api.buildPoints();
api.resetExactRun();
api.state.cached = false;
api.state.exactActions = [{ column: 0, time: 1000, endTime: 1000 }];
api.state.liveActive = true;
ok("old .osr ignored once live input seen", api.applyExactData() === false && api.state.exactApplied === false, api.state.exactApplied);
api.state.liveActive = false;
ok("old .osr applies when live channel stays silent", api.applyExactData() === true && api.state.exactApplied === true, api.state.exactApplied);
api.resetExactRun();
api.state.cached = false;

console.log("== analysis modes ==");
api.state.liveActive = false;
api.state.cached = false;
api.state.exactApplied = false;
api.state.exactActions = [{ column: 0, time: 1000, endTime: 1000 }];
api.settings.analysisMode = "Live";
ok("Live mode never pre-renders .osr", api.applyExactData() === false && api.state.exactApplied === false, api.state.exactApplied);
api.settings.analysisMode = "Replay";
ok("Replay mode pre-renders .osr", api.applyExactData() === true && api.state.exactApplied === true, api.state.exactApplied);
api.settings.analysisMode = "Auto";
api.resetExactRun();
api.state.cached = false;

console.log("== live note lock matching ==");
const denseMap = api.buildManiaNotes(
  api.parseOsu(
    [
      "osu file format v14",
      "",
      "[General]",
      "Mode: 3",
      "",
      "[Difficulty]",
      "CircleSize:4",
      "OverallDifficulty:8.5",
      "",
      "[TimingPoints]",
      "0,500,4,2,0,100,1,0",
      "",
      "[HitObjects]",
      "64,192,1000,1,0,0:0:0:0:",
      "64,192,1050,1,0,0:0:0:0:"
    ].join("\n")
  ),
  4
);
api.state.client = "stable";
api.state.scoreV2 = false;
api.state.modsRate = 1;
api.state.odConverted = 8.5;
api.state.hitWindow = null;
api.state.beatmap = denseMap;
api.state.csConverted = 4;
api.state.mapMode = "mania";
api.updateWindows();
api.buildPoints();
api.applyLiveKey(0, 1080, true);
ok("press hits earliest locked note, not nearest", api.state.noteState[0].head === 3 && api.state.noteState[1].head === null, [api.state.noteState[0].head, api.state.noteState[1].head]);
api.applyLiveKey(0, 1100, true);
ok("next press hits the following note", api.state.noteState[1].head === 2, api.state.noteState[1].head);

console.log("== live chord per-column ==");
const chordMap = api.buildManiaNotes(
  api.parseOsu(
    [
      "osu file format v14",
      "",
      "[General]",
      "Mode: 3",
      "",
      "[Difficulty]",
      "CircleSize:4",
      "OverallDifficulty:8.5",
      "",
      "[TimingPoints]",
      "0,500,4,2,0,100,1,0",
      "",
      "[HitObjects]",
      "64,192,1000,1,0,0:0:0:0:",
      "192,192,1000,1,0,0:0:0:0:",
      "320,192,1000,1,0,0:0:0:0:",
      "448,192,1000,1,0,0:0:0:0:"
    ].join("\n")
  ),
  4
);
api.state.beatmap = chordMap;
api.state.points = null;
api.buildPoints();
api.applyLiveKey(0, 995, true);
api.applyLiveKey(1, 1002, true);
api.applyLiveKey(2, 1000, true);
api.applyLiveKey(3, 998, true);
ok("chord maps every column to its own note", api.state.noteState.every((s) => s.head === 0), api.state.noteState.map((s) => s.head));

console.log("== precise clock & hook timing ==");
api.state.liveActive = true;
sb.__advance(50);
api.onPrecise({ currentTime: 12345, hitErrors: [] });
ok("precise currentTime compat branch drives the live clock", Math.abs(api.renderTime() - 12345) < 20, api.renderTime());
api.state.liveActive = false;
api.state.liveAnchorHook = null;
api.state.modsRate = 1;
const anchorA = api.hookSongTime(5000);
const anchorB = api.hookSongTime(5010);
ok("hook clock maps 1:1 at nomod", Math.abs(anchorB - anchorA - 10) < 1e-6, [anchorA, anchorB]);
api.state.liveAnchorHook = null;
api.state.modsRate = 1.5;
const rateA = api.hookSongTime(6000);
const rateB = api.hookSongTime(6010);
ok("hook clock scales with rate", Math.abs(rateB - rateA - 15) < 1e-6, [rateA, rateB]);
api.state.modsRate = 1;
const stallBase = api.hookSongTime(2000);
sb.__advance(2000);
const stallResync = api.hookSongTime(2001);
// After a 2s jump the hook anchor is dropped and the game clock is used directly, so the
// two must agree exactly (previously this compared two frozen samples with a 5ms slack).
// After a 2s jump the hook anchor is dropped and the game clock is used directly (only the
// accumulated live bias is subtracted), so the mapping must be exact, not just close.
// The 2s gap is larger than the anchor window, so the anchor is refreshed from the frozen
// game clock: the mapped song time may only advance by the 1ms hook delta, not by 2s.
ok("hook clock does not jump after a stall", Math.abs(stallResync - (stallBase + 1)) < 1e-6 && Math.abs(stallResync - api.renderTime()) < 5, [stallBase, stallResync, api.renderTime()]);

console.log("== live game-error correction ==");
hintSetup(["64,192,1000,1,0,0:0:0:0:"], 4);
api.state.liveActive = true;
api.state.livePending = [];
api.state.liveErrorCount = 0;
api.state.liveBias = 0;
api.setTime(1000);
api.applyLiveKey(0, 1050, true);
ok("tentative live match classified from hook time", api.state.noteState[0].head === 2, api.state.noteState[0].head);
api.onPrecise({ currentTime: 1000, hitErrors: [5] });
ok("game hitError corrects the live match", api.state.noteState[0].head === 0, api.state.noteState[0].head);
ok("correction keeps stats consistent", Math.abs(api.state.errorSum - 5) < 1e-9 && Math.abs(api.state.liveBias - 9) < 1e-9, [api.state.errorSum, api.state.liveBias]);
api.state.liveActive = true;
api.state.livePending.length = 0;
api.state.liveRecentErrors.length = 0;
api.state.liveBias = 0;
hintSetup(["64,192,2000,1,0,0:0:0:0:"], 4);
api.state.liveActive = true;
api.state.livePending.length = 0;
api.state.liveRecentErrors.length = 0;
api.state.liveErrorCount = 0;
api.state.liveBias = 0;
api.setTime(2000);
api.onPrecise({ currentTime: 2000, hitErrors: [7] });
api.applyLiveKey(0, 2050, true);
ok("game error arriving first still corrects the match", api.state.noteState[0].head === 0, api.state.noteState[0].head);
api.state.liveActive = false;
api.state.livePending.length = 0;
api.state.liveRecentErrors.length = 0;
api.state.liveErrorCount = 0;

console.log("== render cursor after small rewind ==");
const seekMap = api.buildManiaNotes(
  api.parseOsu(
    [
      "osu file format v14",
      "",
      "[General]",
      "Mode: 3",
      "",
      "[Difficulty]",
      "CircleSize:4",
      "OverallDifficulty:8.5",
      "",
      "[TimingPoints]",
      "0,500,4,2,0,100,1,0",
      "",
      "[HitObjects]",
      "64,192,2500,1,0,0:0:0:0:",
      "64,192,5000,1,0,0:0:0:0:"
    ].join("\n")
  ),
  4
);
api.state.beatmap = seekMap;
api.state.csConverted = 4;
api.state.mapMode = "mania";
api.state.gameState = "play";
api.state.hitWindow = null;
api.state.maniaScrollSpeed = 5;
api.settings.maniaScrollSpeedOverride = 0;
api.settings.hitPosition = 80;
api.updateWindows();
api.state.points = null;
api.buildPoints();
const prevShows = [api.settings.showActions, api.settings.showStats, api.settings.showHitLine];
api.settings.showActions = false;
api.settings.showStats = false;
api.settings.showHitLine = false;
api.renderScene(mainCtx, 5000);
const seekBefore = mainCtx.calls.length;
api.renderScene(mainCtx, 2500);
const seekStrokes = mainCtx.calls.slice(seekBefore).filter((c) => c === "stroke").length;
ok("notes render again after a small rewind", seekStrokes >= 1, seekStrokes);
api.settings.showActions = prevShows[0];
api.settings.showStats = prevShows[1];
api.settings.showHitLine = prevShows[2];

console.log("== live SSE chord attribution ==");
const sseMap = api.buildManiaNotes(
  api.parseOsu(
    [
      "osu file format v14",
      "",
      "[General]",
      "Mode: 3",
      "",
      "[Difficulty]",
      "CircleSize:4",
      "OverallDifficulty:8.5",
      "",
      "[TimingPoints]",
      "0,500,4,2,0,100,1,0",
      "",
      "[HitObjects]",
      "64,192,1000,1,0,0:0:0:0:",
      "192,192,1000,1,0,0:0:0:0:"
    ].join("\n")
  ),
  4
);
api.state.client = "stable";
api.state.scoreV2 = false;
api.state.modsRate = 1;
api.state.odConverted = 8.5;
api.state.hitWindow = null;
api.state.beatmap = sseMap;
api.state.csConverted = 4;
api.state.mapMode = "mania";
api.state.checksum = "sse-map";
api.state.gameState = "play";
api.updateWindows();
api.state.points = null;
api.buildPoints();
api.state.liveSource = null;
api.state.liveKey = "";
api.state.liveActive = false;
api.state.liveReady = false;
api.state.liveAnchorHook = null;
api.state.exactApplied = false;
api.settings.analysisMode = "Auto";
api.setTime(1000);
api.ensureLive();
const sse = eventSources[eventSources.length - 1];
sse.onmessage({ data: JSON.stringify({ type: "hello", hook: true, layout: "A S ; '" }) });
ok("helper hello reports ready + layout", api.state.helperState === "ready" && api.state.helperLayout === "A S ; '", [api.state.helperState, api.state.helperLayout]);
sse.onmessage({ data: JSON.stringify({ type: "key", down: true, column: 1, t: 5000 }) });
ok("SSE key down hits its own column head", api.state.noteState[1].head === 0 && api.state.noteState[0].head === null, api.state.noteState.map((s) => s.head));
sse.onmessage({ data: JSON.stringify({ type: "key", down: false, column: 1, t: 5100 }) });
ok("SSE key up does not re-judge a tap", api.state.noteState[1].head === 0 && api.state.noteState[0].head === null, api.state.noteState.map((s) => s.head));
api.sweepMisses(1300);
ok("unpressed column becomes MISS", api.state.noteState[0].head === -1 && api.state.noteState[1].head === 0, api.state.noteState.map((s) => s.head));
api.closeLive();
api.state.liveSource = null;

console.log("== live LN head on down / tail on up ==");
const lnMap = api.buildManiaNotes(
  api.parseOsu(
    [
      "osu file format v14",
      "",
      "[General]",
      "Mode: 3",
      "",
      "[Difficulty]",
      "CircleSize:4",
      "OverallDifficulty:8.5",
      "",
      "[TimingPoints]",
      "0,500,4,2,0,100,1,0",
      "",
      "[HitObjects]",
      "64,192,1000,128,0,1500:0:0:0:0:"
    ].join("\n")
  ),
  4
);
api.state.beatmap = lnMap;
api.state.csConverted = 4;
api.state.checksum = "sse-ln";
api.updateWindows();
api.state.points = null;
api.buildPoints();
api.state.liveKey = "";
api.state.liveActive = false;
api.state.liveReady = false;
api.state.liveAnchorHook = null;
api.setTime(1000);
api.ensureLive();
const sseLn = eventSources[eventSources.length - 1];
sseLn.onmessage({ data: JSON.stringify({ type: "hello", hook: true, layout: "A S ; '" }) });
sseLn.onmessage({ data: JSON.stringify({ type: "key", down: true, column: 0, t: 5000 }) });
ok("LN head judged on key down", api.state.noteState[0].head === 0, api.state.noteState.map((s) => s.head));
sseLn.onmessage({ data: JSON.stringify({ type: "key", down: false, column: 0, t: 5500 }) });
ok("LN tail judged on key up", api.state.noteState[0].tail === 0, api.state.noteState.map((s) => s.tail));
api.closeLive();
api.state.liveSource = null;

console.log("== precise key hints (no helper) ==");
function hintSetup(objects, keys = 4) {
  const map = api.buildManiaNotes(
    api.parseOsu(
      [
        "osu file format v14",
        "",
        "[General]",
        "Mode: 3",
        "",
        "[Difficulty]",
        `CircleSize:${keys}`,
        "OverallDifficulty:8.5",
        "",
        "[TimingPoints]",
        "0,500,4,2,0,100,1,0",
        "",
        "[HitObjects]",
        ...objects
      ].join("\n")
    ),
    keys
  );
  api.state.client = "stable";
  api.state.scoreV2 = false;
  api.state.modsRate = 1;
  api.state.odConverted = 8.5;
  api.state.hitWindow = null;
  api.state.beatmap = map;
  api.state.csConverted = 4;
  api.state.mapMode = "mania";
  api.state.checksum = "hint-map";
  api.state.gameState = "play";
  api.updateWindows();
  api.state.points = null;
  api.buildPoints();
  api.state.hits = null;
  api.state.cached = false;
  api.state.exactApplied = false;
  api.state.liveActive = false;
  api.state.errorCount = 0;
  api.state.runPrefix = [];
  api.state.keyHints.length = 0;
  api.state.keyHintPressed = [false, false, false, false];
  api.state.keyHintCounts = [0, 0, 0, 0];
  api.state.keyHintSlotCount = 0;
  api.state.keyHintExposed = [];
  api.setTime(1000);
  return map;
}
function hintKeys(pressed) {
  const s = [0, 1, 2, 3].map((i) => ({ isPressed: pressed === i, count: 0 }));
  return { k1: s[0], k2: s[1], m1: s[2], m2: s[3] };
}
hintSetup(["64,192,1000,1,0,0:0:0:0:", "192,192,1000,1,0,0:0:0:0:"]);
api.onPrecise({ currentTime: 1000, keys: hintKeys(1), hitErrors: [] });
api.onPrecise({ currentTime: 1000, keys: hintKeys(1), hitErrors: [8] });
ok("key hint attributes hit to pressed column", api.state.noteState[1].head === 0 && api.state.noteState[0].head === null, api.state.noteState.map((s) => s.head));
hintSetup(["64,192,1000,1,0,0:0:0:0:", "448,192,1000,1,0,0:0:0:0:"]);
api.onPrecise({ currentTime: 1000, keys: hintKeys(-1), hitErrors: [5] });
ok("unexposed column matched by elimination", api.state.noteState[1].head === 0 && api.state.noteState[0].head === null, api.state.noteState.map((s) => s.head));
hintSetup(["64,192,1000,1,0,0:0:0:0:", "448,192,1000,1,0,0:0:0:0:"]);
api.onPrecise({ currentTime: 1000, keys: hintKeys(0), hitErrors: [] });
api.onPrecise({ currentTime: 1000, keys: hintKeys(0), hitErrors: [3, 7] });
ok("chord pairs hint + elimination", api.state.noteState[0].head === 0 && api.state.noteState[1].head === 0, api.state.noteState.map((s) => s.head));
hintSetup(["160,192,1000,1,0,0:0:0:0:", "470,192,1000,1,0,0:0:0:0:"], 7);
const slots7 = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ isPressed: i === 6, count: 0 }));
api.onPrecise({ currentTime: 1000, keys: { maniaKeys: slots7 }, hitErrors: [] });
api.onPrecise({ currentTime: 1000, keys: { maniaKeys: slots7 }, hitErrors: [4] });
ok("full column array unlocks multi-key attribution", api.state.noteState[1].head === 0 && api.state.noteState[0].head === null, api.state.noteState.map((s) => s.head));

console.log("== retry reset ==");
api.state.gameState = "play";
api.state.cached = false;
api.state.runPrefix = [];
api.resetJudgements();
api.state.lastHitsTotal = null;
api.onV2({ play: { hits: { geki: 5, "300": 3, katu: 1, "100": 1, "50": 0, "0": 0 }, score: 12000, accuracy: 99, failed: false } });
api.processError(-5, 1005);
ok("stats accumulated before retry", api.state.statCount === 1, api.state.statCount);
api.onV2({ play: { hits: { geki: 1, "300": 0, katu: 0, "100": 0, "50": 0, "0": 0 }, score: 150, accuracy: 100, failed: false } });
ok("retry clears UR/judgements", api.state.statCount === 0 && api.state.errorCount === 0, [api.state.statCount, api.state.errorCount]);

console.log("== miss budget ==");
api.state.scoreV2 = false;
api.state.cached = false;
api.state.hits = { geki: 5, "300": 0, katu: 0, "100": 0, "50": 0, "0": 0 };
api.state.beatmap = map;
api.state.csConverted = 4;
api.state.mapMode = "mania";
api.buildPoints();
api.sweepMisses(2000);
const blockedMisses = api.state.noteState.filter((s) => s.head === -1 || s.tail === -1).length;
ok("no misses marked while game miss count is 0", blockedMisses === 0, blockedMisses);
api.state.hits["0"] = 1;
api.sweepMisses(2000);
const allowedMisses = api.state.noteState.filter((s) => s.head === -1 || s.tail === -1).length;
ok("miss marked once budget allows", allowedMisses === 1 && api.state.noteState[0].head === -1, allowedMisses);
api.state.hits = null;

console.log("== miss skip alignment ==");
api.state.scoreV2 = false;
api.state.cached = false;
api.state.beatmap = map;
api.state.csConverted = 4;
api.state.mapMode = "mania";
api.updateWindows();
api.state.hits = { geki: 0, "300": 0, katu: 0, "100": 0, "50": 0, "0": 1 };
api.buildPoints();
api.consumeMissSkips();
ok("miss skip marks one tap judgement", api.state.markedMiss === 1 && api.state.noteState[0].head === -1, [api.state.markedMiss, api.state.noteState[0].head]);
const holdMap = api.buildManiaNotes(
  api.parseOsu(
    [
      "osu file format v14",
      "",
      "[General]",
      "Mode: 3",
      "",
      "[Difficulty]",
      "CircleSize:4",
      "OverallDifficulty:8.5",
      "",
      "[TimingPoints]",
      "0,500,4,2,0,100,1,0",
      "",
      "[HitObjects]",
      "64,192,1000,128,0,1500:0:0:0:0:",
      "320,192,2000,1,0,0:0:0:0:"
    ].join("\n")
  ),
  4
);
api.state.beatmap = holdMap;
api.buildPoints();
api.state.hits = { geki: 0, "300": 0, katu: 0, "100": 0, "50": 0, "0": 1 };
api.consumeMissSkips();
ok(
  "miss skip consumes whole V1 hold as one judgement",
  api.state.markedMiss === 1 && api.state.noteState[0].head === -1 && api.state.noteState[0].tail === -1 && api.state.noteState[1].head === null,
  [api.state.markedMiss, api.state.noteState[0].head, api.state.noteState[0].tail, api.state.noteState[1].head]
);
api.state.beatmap = map;
api.buildPoints();
api.state.hits = null;

console.log("== sweep cursor & budget tolerance ==");
api.state.scoreV2 = false;
api.state.cached = false;
api.state.beatmap = map;
api.state.csConverted = 4;
api.state.mapMode = "mania";
api.updateWindows();
api.state.hits = { geki: 3, "300": 0, katu: 0, "100": 0, "50": 0, "0": 3 };
api.buildPoints();
api.processError(250, 1750);
ok("matcher cursor skipped earlier points", api.state.searchFrom > 3, api.state.searchFrom);
api.sweepMisses(2000);
ok(
  "skipped past notes still marked miss",
  api.state.noteState[0].head === -1 && api.state.noteState[1].head === -1 && api.state.noteState[3].head === -1,
  [api.state.noteState[0].head, api.state.noteState[1].head, api.state.noteState[3].head]
);
api.state.beatmap = map;
api.buildPoints();
api.state.hits = { geki: 0, "300": 0, katu: 0, "100": 0, "50": 0, "0": 0 };
api.processError(-5, 1005);
api.sweepMisses(2000);
ok(
  "sweep marks misses when game hits unavailable",
  api.state.noteState[1].head === -1 && api.state.noteState[2].head === -1 && api.state.noteState[3].head === -1,
  [api.state.noteState[1].head, api.state.noteState[2].head, api.state.noteState[3].head]
);
api.state.beatmap = map;
api.buildPoints();
api.state.hits = null;

console.log("== stats panel fallback ==");
api.state.scoreV2 = false;
api.state.beatmap = map;
api.state.csConverted = 4;
api.state.mapMode = "mania";
api.updateWindows();
api.state.hits = { geki: 0, "300": 0, katu: 0, "100": 0, "50": 0, "0": 0 };
api.buildPoints();
api.processError(-5, 1005);
api.processError(0, 1005);
const ps = api.panelStats();
ok("panel falls back to computed counts", ps.counts[0] === 2 && ps.counts[5] === 0, ps.counts);
ok("panel computes accuracy from counts", Math.abs(ps.accuracy - 100) < 0.01, ps.accuracy);
api.state.hits = { geki: 5, "300": 1, katu: 0, "100": 0, "50": 0, "0": 0 };
const ps2 = api.panelStats();
ok("panel prefers valid game counts", ps2.counts[0] === 5 && ps2.counts[1] === 1, ps2.counts);
api.state.beatmap = holdMap;
api.buildPoints();
api.state.hits = { geki: 0, "300": 0, katu: 0, "100": 0, "50": 0, "0": 0 };
api.processError(-5, 1005);
const ps3 = api.panelStats();
ok("v1 hold counts once in fallback", ps3.counts[0] === 1, ps3.counts);
api.state.beatmap = map;
api.buildPoints();
api.state.hits = null;

console.log("== reset ==");
api.resetJudgements();
ok("errors reset", api.state.errorCount === 0 && api.state.noteState.every((s) => s.head === null && s.tail === null));

console.log("== exact judgement model (0.5.4 regression) ==");
{
  const w = [16, 40, 73, 103, 127, 164];
  const note = (time, column, endTime) => ({ time, column, endTime: endTime === undefined ? time : endTime, hold: endTime !== undefined && endTime > time });
  const act = (column, time, endTime) => ({ column, time, endTime: endTime === undefined ? time : endTime, index: 0, related: -1 });
  const run = (notes, actions, sv2) => {
    const acts = actions.map((a, i) => ({ ...a, index: i, related: -1 }));
    const res = api.judgeReplayNotes(notes, acts, w, sv2, true);
    return { res, counts: api.replayJudgementCounts(notes, res, sv2) };
  };
  ok("exact class boundaries", [0, 16, 17, 40, 41, 103, 104, 127, 128].map((d) => api.getJudgementClass(d, w)).join() === "0,0,1,1,2,3,4,4,-1", [0, 16, 17, 40, 41, 103, 104, 127, 128].map((d) => api.getJudgementClass(d, w)));

  {
    const odBefore = api.state.od;
    const odcBefore = api.state.odConverted;
    const rateBefore = api.state.modsRate;
    const modsBefore = api.state.modsNumber;
    api.state.od = 8;
    api.state.odConverted = 0;
    api.state.modsRate = 1;
    api.state.modsNumber = 0;
    const wV1 = api.replayWindowTable(false);
    const wV2 = api.replayWindowTable(true);
    api.state.modsNumber = 256; // HT
    api.state.modsRate = 0.75;
    const htV1 = api.replayWindowTable(false);
    const htV2 = api.replayWindowTable(true);
    ok("exact v1 replay window table (OD8)", wV1.join() === "16,40,73,103,127,164", wV1);
    ok("ht scales v1 replay windows by rate", htV1.every((v, i) => Math.abs(v - wV1[i] * 0.75) < 1e-9), htV1);
    ok("ht scales v2 replay windows by rate", htV2.every((v, i) => Math.abs(v - wV2[i] * 0.75) < 1e-9), htV2);
    api.state.od = odBefore;
    api.state.odConverted = odcBefore;
    api.state.modsRate = rateBefore;
    api.state.modsNumber = modsBefore;
  }

  let r = run([note(1000, 0)], [act(0, 1005)], false);
  ok("exact tap perfect", r.res[0].start === 0 && r.res[0].startErr === 5, r.res[0].start);
  r = run([note(1000, 0)], [act(0, 1500)], false);
  ok("exact tap outside miss window is a miss", r.res[0].start === -1 && r.counts[5] === 1, r.counts);
  r = run([note(1000, 0)], [act(0, 700)], false);
  ok("exact tap too early is not consumed", r.res[0].start === -1 && r.counts[5] === 1, r.counts);

  r = run([note(1000, 0)], [act(0, 1000), act(0, 1110)], false);
  ok("exact first action claims the note", r.res.length === 1 && r.res[0].start === 0, r.res[0].start);
  r = run([note(1000, 0)], [act(0, 1060)], false);
  ok("exact tap class follows window", r.res[0].start === 2, r.res[0].start);

  const hold = [note(1000, 0, 3000)];
  r = run(hold, [act(0, 1005, 3005)], false);
  ok("exact v1 hold merges into one judgement", r.res[0].start === 0 && r.res[0].end === 0 && r.counts.join() === "1,0,0,0,0,0", r.counts);
  r = run(hold, [act(0, 1005, 3005)], true);
  ok("exact v2 hold keeps head and tail", r.res[0].start === 0 && r.res[0].end === 0 && r.counts.join() === "2,0,0,0,0,0", r.counts);
  r = run(hold, [act(0, 1005, 2700)], false);
  ok("exact v1 hold released far early is a miss", r.res[0].start === -1 && r.counts[5] === 1, r.counts);
  r = run(hold, [act(0, 1005, 3300)], true);
  ok("exact v2 late release loses only the tail", r.res[0].start === 0 && r.res[0].end === -1 && r.counts.join() === "1,0,0,0,0,1", r.counts);
  r = run([note(1000, 0), note(1000, 1)], [act(0, 1005)], false);
  ok("exact chord note without action is a miss", r.counts.join() === "1,0,0,0,0,1", r.counts);
  r = run([note(1000, 0), note(1000, 1)], [act(0, 1005), act(1, 1000)], false);
  ok("exact chord columns judged independently", r.counts.join() === "2,0,0,0,0,0", r.counts);

  api.state.beatmap = holdMap;
  api.state.csConverted = 4;
  api.state.mapMode = "mania";
  api.state.hitWindow = null;
  api.state.odConverted = 8;
  api.state.scoreV2 = false;
  api.updateWindows();
  api.buildPoints();
  api.state.exactCounts = [0, 0, 0, 2, 0, 0];
  const actions = [act(0, 1000, 1500), act(2, 2000)];
  const offset = api.exactOffsetFor(actions);
  ok("exact offset search returns finite offset", Number.isFinite(offset), offset);
  api.state.exactCounts = null;
  ok("exact timeline applies and counts", api.applyExactTimeline(actions, offset) === true && api.state.exactApplied === true && api.panelStats(5000).counts.join() === "2,0,0,0,0,0", api.panelStats(5000).counts);
  ok("exact timeline marks hold head and tail", api.state.noteState[0].head === 0 && api.state.noteState[0].tail === 0, [api.state.noteState[0].head, api.state.noteState[0].tail]);
  api.state.exactApplied = false;
  api.state.exactCounts = null;
  api.state.cached = false;
  api.settings.analysisMode = "Auto";
  api.state.scoreV2 = false;
  api.state.beatmap = map;
  api.state.csConverted = 4;
  api.state.odConverted = 8.5;
  api.state.hitWindow = null;
  api.state.hits = null;
  api.buildPoints();
  api.updateWindows();
  api.buildPoints();
}

console.log("== playback clock extrapolation ==");
{
  sb.__advance(500);
  api.setTime(0);
  ok("clock starts at speed 1", api.state.timeSpeed === 1, api.state.timeSpeed);
  for (let i = 1; i <= 8; i++) {
    sb.__advance(100);
    api.setTime(i * 150);
  }
  ok("DT playback raises timeSpeed above 1.25", api.state.timeSpeed > 1.25, +api.state.timeSpeed.toFixed(3));
  sb.__advance(50);
  const extrapolated = api.renderTime();
  ok("renderTime extrapolates song time", extrapolated > api.state.time, +extrapolated.toFixed(1));
  sb.__advance(400);
  ok("stale v2 sample freezes the clock", api.renderTime() === api.state.time, api.renderTime());
  ok("timeSpeed kept the DT estimate", api.state.timeSpeed > 1.25, +api.state.timeSpeed.toFixed(3));
  api.setTime(0);
  api.state.timeSpeed = 1;
}

console.log("== mirror mod ==");
{
  api.state.mirror = false;
  const plain = api.buildManiaNotes(parsed, 4);
  api.state.mirror = true;
  const flipped = api.buildManiaNotes(parsed, 4);
  ok(
    "mirror flips every column",
    plain.notes.length === flipped.notes.length && flipped.notes.every((n, i) => n.column === 3 - plain.notes[i].column),
    [plain.notes.map((n) => n.column).join(","), flipped.notes.map((n) => n.column).join(",")]
  );
  api.state.mapMode = "mania";
  api.state.csConverted = 4;
  api.state.odConverted = 8.5;
  api.state.hitWindow = null;
  api.state.client = "stable";
  api.state.scoreV2 = false;
  api.state.beatmap = flipped;
  api.updateWindows();
  api.buildPoints();
  api.resetJudgements();
  // The chart is drawn mirrored, so the note is displayed in column 3 and physical key 3 hits it.
  api.applyLiveKey(3, 1000, true);
  ok("mirror live key matches the flipped column", api.state.noteState[0].head === 0, api.state.noteState[0].head);
  api.resetJudgements();
  const mirrorExact = api.applyExactTimeline([{ column: 3, time: 1000, endTime: 1000 }], 0);
  ok("mirror exact action matches the flipped column", mirrorExact === true && api.state.noteState[0].head === 0, [mirrorExact, api.state.noteState[0].head]);
  api.state.mirror = false;
  api.applyMods({ number: 0, rate: 1, array: [{ acronym: "MR" }] });
  ok("mirror detected from the MR acronym", api.state.mirror === true);
  api.applyMods({ number: 1 << 30, rate: 1, array: [] });
  ok("mirror detected from the stable bitmask", api.state.mirror === true);
  api.applyMods({ number: 0, rate: 1, array: [] });
  ok("mirror cleared without MR", api.state.mirror === false);
  api.state.beatmap = map;
  api.state.scoreV2 = true;
  api.state.client = "stable";
  api.state.odConverted = 8.5;
  api.updateWindows();
  api.buildPoints();
  api.resetJudgements();
}

console.log("== random mod (RD) ==");
{
  const vectors = [
    [0, "2301"],
    [30745429, "0132"],
    [30840347, "2301"],
    [34973272, "1302"],
  ];
  for (const [seed, expected] of vectors) {
    const got = api.rdShuffledColumns(seed, 4).join("");
    ok(`rd shuffle for seed ${seed}`, got === expected, [got, expected]);
  }

  // osu!lazer never writes the seed into the legacy frame, but scores exported from lazer
  // carry it in the appended LegacyReplaySoloScoreInfo block. Its shuffle is
  // Enumerable.Range(0, n).OrderBy(_ => rng.Next()) - a stable sort by random key.
  // Expected values below were produced by .NET Framework itself (LINQ OrderBy + Random).
  const lazerVectors = [
    [0, "3021"],
    [1, "1023"],
    [42, "2130"],
    [30745429, "3102"],
    [34973272, "3021"]
  ];
  for (const [seed, expected] of lazerVectors) {
    const got = api.lazerShuffledColumns(seed, 4).join("");
    ok(`lazer rd shuffle for seed ${seed}`, got === expected, [got, expected]);
  }
  ok(
    "lazer and stable shuffles differ",
    api.lazerShuffledColumns(30745429, 4).join("") !== api.rdShuffledColumns(30745429, 4).join("")
  );

  api.state.mirror = false;
  api.state.random = true;
  api.state.seed = 30745429;
  api.rebuildColumnMap(4);
  ok(
    "rd maps beatmap columns to displayed columns",
    [0, 1, 2, 3].map((c) => api.displayColumn(c)).join("") === "0132",
    [0, 1, 2, 3].map((c) => api.displayColumn(c)).join("")
  );
  ok("rd maps a displayed column back to its beatmap column", api.sourceColumn(3) === 2 && api.sourceColumn(1) === 1);

  const rdNotes = api.buildManiaNotes(parsed, 4);
  ok(
    "rd chart is drawn in shuffled columns",
    rdNotes.notes.every((n) => n.column === api.displayColumn(n.raw)),
    rdNotes.notes.map((n) => n.column).join(",")
  );
  const first = rdNotes.notes[0];
  api.state.beatmap = rdNotes;
  api.state.mapMode = "mania";
  api.state.csConverted = 4;
  api.state.odConverted = 8.5;
  api.state.hitWindow = null;
  api.state.client = "stable";
  api.state.scoreV2 = false;
  api.updateWindows();
  api.buildPoints();
  api.resetJudgements();
  api.applyLiveKey(first.column, first.time, true);
  ok("rd live key matches the shuffled column", api.state.noteState[0].head === 0, api.state.noteState[0].head);
  api.resetJudgements();
  const rdExact = api.applyExactTimeline([{ column: first.column, time: first.time, endTime: first.time }], 0);
  ok(
    "rd exact action matches the shuffled column",
    rdExact === true && api.state.noteState[0].head === 0,
    [rdExact, api.state.noteState[0].head]
  );
  api.state.seedKind = "stable";
  ok("rd beatmap identity includes the seed", api.columnMapKey() === "rdstable30745429", api.columnMapKey());
  api.state.seedKind = "lazer";
  ok("rd beatmap identity includes the seed source", api.columnMapKey() === "rdlazer30745429", api.columnMapKey());
  api.state.seedKind = null;
  api.state.random = false;
  api.state.seed = null;
  api.state.mirror = false;
  api.rebuildColumnMap(4);
  ok("plain beatmap identity after clearing mods", api.columnMapKey() === "plain", api.columnMapKey());
  api.state.random = true;
  api.state.seed = 30745429;
  api.rebuildColumnMap(4);

  api.state.random = false;
  api.state.seed = null;
  api.rebuildColumnMap(4);
  api.applyMods({ number: 1 << 21, rate: 1, array: [] });
  ok("rd detected from the stable bitmask", api.state.random === true);
  api.applyMods({ number: 0, rate: 1, array: [{ acronym: "RD" }] });
  ok("rd detected from the RD acronym", api.state.random === true);
  api.applyMods({ number: 0, rate: 1, array: [] });
  ok("rd cleared without RD", api.state.random === false);
  api.state.beatmap = map;
  api.state.scoreV2 = true;
  api.state.client = "stable";
  api.state.odConverted = 8.5;
  api.updateWindows();
  api.buildPoints();
  api.resetJudgements();
}

console.log("== RD column inference (no seed in .osr) ==");

// osu!lazer's legacy exporter writes `-12345|0|0|0`, so replay seeds have to be
// reconstructed from the recorded presses.
const inferNotes = [];
for (let c = 0; c < 4; c++) for (let i = 0; i < 10; i++) inferNotes.push({ time: 1000 + i * 200 + c * 37, column: c, raw: c, endTime: 0 });
const inferPerm = [2, 0, 3, 1];
const inferInverse = new Array(4);
for (let d = 0; d < 4; d++) inferInverse[inferPerm[d]] = d;
const inferActions = inferNotes.map((n) => ({ column: inferInverse[n.column], time: n.time + 25, endTime: 0 }));
const inferredPerm = api.inferColumnPermutation(inferNotes, inferActions, 4);
ok("inferColumnPermutation recovers a shuffle", Array.isArray(inferredPerm) && inferredPerm.join("") === "2031", inferredPerm && inferredPerm.join(""));
const scrambledPerm = api.inferColumnPermutation(inferNotes, inferActions.map((a, i) => ({ column: (a.column + 1) % 4, time: a.time + i * 53, endTime: 0 })), 4);
ok("inference rejects ambiguous input", scrambledPerm === null, scrambledPerm && scrambledPerm.join(""));

console.log("== rendering ==");
api.state.gameState = "play";
api.state.mapMode = "mania";
api.state.beatmap = map;
api.buildPoints();
api.processError(-5, 1010);
const before = mainCtx.calls.length;
api.renderScene(mainCtx, 1200, 1);
ok("render produced draws", mainCtx.calls.length > before, mainCtx.calls.length - before);
ok("allowed in play mania", api.allowedState() === true);
api.state.gameState = "selectPlay";
ok("hidden in select", api.allowedState() === false);

console.log(`Summary: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
