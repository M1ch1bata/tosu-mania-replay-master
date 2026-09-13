const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v, d) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : d;
};
const findLastLE = (arr, x, key) => {
  let lo = 0;
  let hi = arr.length - 1;
  let res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (key(arr[mid]) <= x) {
      res = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return res;
};
const findFirstGE = (arr, x, key) => {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(arr[mid]) < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

const WINDOW_KEYS = ["perfect", "great", "good", "ok", "meh", "miss"];
const STAT_LABELS = ["MAX", "300", "200", "100", "50", "MISS"];
const COLOR_KEYS = ["colorPerfect", "colorGreat", "colorGood", "colorOk", "colorMeh", "colorMiss"];

const settings = {
  colorPerfect: "#ffffff",
  colorGreat: "#ffd237",
  colorGood: "#79d020",
  colorOk: "#1e68c5",
  colorMeh: "#e1349b",
  colorMiss: "#ff3b3b",
  colorUnjudged: "#8fa3c8",
  colorLongNote: "#9aa7bd",
  noteHeight: 22,
  noteStroke: 2,
  actionHeight: 7,
  hitPosition: 80,
  hitLineWidth: 4,
  reviewTime: 1500,
  statsScale: 1.4,
  maniaScrollSpeedOverride: 0,
  showActions: true,
  showStats: true,
  showHitLine: true,
  playfieldOpacity: 1,
  backgroundColor: "#000000",
  backgroundOpacity: 0,
  renderScale: 100,
  fpsLimit: 0
};

const state = {
  client: "stable",
  gameState: "",
  mapMode: "osu",
  checksum: "",
  beatmapFolder: "",
  beatmapFileName: "",
  beatmap: null,
  loadError: "",
  loadedKey: "",
  pendingKey: "",
  retryKey: "",
  retryAt: 0,
  loadToken: 0,
  csConverted: 4,
  od: 0,
  odConverted: 0,
  scoreV2: false,
  classicMod: true,
  modsRate: 1,
  hitWindow: null,
  windows: null,
  windowSig: "",
  points: null,
  notePoints: null,
  noteState: null,
  errorCount: 0,
  statCount: 0,
  errorSum: 0,
  errorSq: 0,
  searchFrom: 0,
  backfillFloor: -Infinity,
  hits: null,
  accuracy: 100,
  markedMiss: 0,
  lastHitsTotal: null,
  lastScore: 0,
  maniaScrollSpeed: 0,
  lastLive: 0,
  time: 0,
  timeLocal: 0,
  timeSpeed: 1,
  replayUi: false,
  failed: false,
  modsNumber: 0,
  pendingApply: false,
  cached: false,
  cachedErrors: null,
  cacheChecked: 0,
  runPrefix: [],
  nextSaveAt: 0
};

const renderCache = {
  cols: null,
  colsKeys: -1,
  scroll: null,
  scrollMap: null,
  scrollRange: 0,
  cursorMap: null,
  cursorTime: -Infinity,
  cursor: 0
};

function hexToRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return `rgba(0,0,0,${alpha})`;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

class SocketManager {
  constructor(host) {
    this.host = host;
    this.sockets = {};
  }
  open(path, onMessage, filters) {
    if (this.sockets[path]) return;
    const url = `ws://${this.host}${path}?l=${encodeURIComponent(window.COUNTER_PATH || "")}`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      setTimeout(() => this.open(path, onMessage, filters), 1000);
      return;
    }
    this.sockets[path] = ws;
    ws.onopen = () => {
      if (filters) ws.send(`applyFilters:${JSON.stringify(filters)}`);
    };
    ws.onclose = () => {
      delete this.sockets[path];
      setTimeout(() => this.open(path, onMessage, filters), 1000);
    };
    ws.onerror = () => {};
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data && typeof data === "object" && "error" in data) return;
        onMessage(data);
      } catch (err) {
        console.error("[ManiaReplayMaster]", err);
      }
    };
  }
  send(path, text) {
    const ws = this.sockets[path];
    if (ws && ws.readyState === 1) {
      ws.send(text);
      return true;
    }
    return false;
  }
}

function setTime(t) {
  if (!Number.isFinite(t)) return;
  const now = performance.now();
  const dt = now - state.timeLocal;
  if (dt > 0 && dt < 1000) {
    const inst = (t - state.time) / dt;
    if (inst >= 0 && inst < 12) state.timeSpeed = state.timeSpeed * 0.75 + inst * 0.25;
    else if (inst < -0.01) state.timeSpeed = 1;
  } else {
    state.timeSpeed = 1;
  }
  state.time = t;
  state.timeLocal = now;
}

function renderTime() {
  const now = performance.now();
  const dt = clamp(now - state.timeLocal, 0, 300);
  return state.time + dt * clamp(state.timeSpeed, 0, 12);
}

function parseTiming(lines) {
  const raw = [];
  for (const line of lines) {
    const p = line.split(",");
    if (p.length < 2) continue;
    const time = parseFloat(p[0]);
    const beatLength = parseFloat(p[1]);
    if (!Number.isFinite(time) || !Number.isFinite(beatLength)) continue;
    raw.push({
      time,
      beatLength,
      uninherited: p[6] === undefined ? 1 : parseInt(p[6]) ? 1 : 0
    });
  }
  raw.sort((a, b) => a.time - b.time);
  const cps = [];
  let lastTime = null;
  let curBeat = 500;
  let curSv = 1;
  let outBeat = 500;
  let outSv = 1;
  for (const p of raw) {
    if (p.uninherited && p.beatLength > 0) curBeat = p.beatLength;
    if (p.uninherited) curSv = 1;
    else if (p.beatLength < 0) curSv = clamp(-100 / p.beatLength, 0.1, 10);
    if (lastTime === null || p.time !== lastTime) {
      if (lastTime !== null) cps.push({ time: lastTime, beatLength: outBeat, sv: outSv });
      lastTime = p.time;
      outBeat = curBeat;
      outSv = curSv;
    } else {
      outBeat = curBeat;
      outSv = curSv;
    }
  }
  if (lastTime !== null) cps.push({ time: lastTime, beatLength: outBeat, sv: outSv });
  return { raw, cps };
}

function computeMostCommonBeatLength(raw, lastTime) {
  const reds = raw.filter((p) => p.uninherited && p.beatLength > 0);
  if (!reds.length) return 500;
  const totals = new Map();
  for (let i = 0; i < reds.length; i++) {
    const end = i + 1 < reds.length ? reds[i + 1].time : Math.max(lastTime, reds[i].time + 1);
    const duration = Math.max(0, end - reds[i].time);
    totals.set(reds[i].beatLength, (totals.get(reds[i].beatLength) || 0) + duration);
  }
  let best = reds[0].beatLength;
  let bestDuration = -1;
  totals.forEach((duration, beatLength) => {
    if (duration > bestDuration) {
      bestDuration = duration;
      best = beatLength;
    }
  });
  return best;
}

function parseHitObject(line) {
  const p = line.split(",");
  if (p.length < 4) return null;
  const x = parseFloat(p[0]);
  const y = parseFloat(p[1]);
  const time = parseFloat(p[2]);
  const type = parseInt(p[3]) || 0;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(time)) return null;
  const o = {
    x,
    time,
    spinner: (type & 8) !== 0,
    hold: (type & 128) !== 0
  };
  if (o.spinner && p.length >= 6) {
    o.endTime = num(p[5], time);
  } else if (o.hold && p.length >= 6) {
    o.endTime = num(String(p[5]).split(":")[0], time);
  }
  return o;
}

function parseOsu(text) {
  const sections = {};
  let current = "";
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//")) continue;
    if (line[0] === "[" && line.endsWith("]")) {
      current = line.slice(1, -1);
      continue;
    }
    (sections[current] = sections[current] || []).push(line);
  }
  const toKV = (lines) => {
    const o = {};
    for (const line of lines || []) {
      const i = line.indexOf(":");
      if (i < 0) continue;
      o[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return o;
  };
  const general = toKV(sections.General);
  const difficulty = toKV(sections.Difficulty);
  const timing = parseTiming(sections.TimingPoints || []);
  const objects = [];
  for (const line of sections.HitObjects || []) {
    const o = parseHitObject(line);
    if (o) objects.push(o);
  }
  objects.sort((a, b) => a.time - b.time);
  const lastTime = objects.length ? objects[objects.length - 1].time : 0;
  timing.mostCommon = computeMostCommonBeatLength(timing.raw, lastTime);
  return { general, difficulty, timing, objects };
}

function maniaCps(timing, svScale) {
  const mostCommon = timing.mostCommon || 500;
  return timing.cps.map((p) => ({
    time: p.time,
    m: ((svScale ? p.sv : 1) * mostCommon) / (p.beatLength || mostCommon)
  }));
}

function buildManiaNotes(parsed, keys) {
  const notes = [];
  for (const o of parsed.objects) {
    if (o.spinner) continue;
    const column = clamp(Math.floor((o.x * keys) / 512), 0, keys - 1);
    const endTime = o.hold ? Math.max(o.time, o.endTime === undefined ? o.time : o.endTime) : o.time;
    notes.push({ column, time: o.time, endTime, hold: !!o.hold && endTime > o.time });
  }
  notes.sort((a, b) => a.time - b.time);
  return {
    mode: "mania",
    keys,
    notes,
    cps: maniaCps(parsed.timing, true),
    od: num(parsed.difficulty.OverallDifficulty, 0)
  };
}

function localWindows() {
  const od = clamp(state.odConverted > 0 ? state.odConverted : state.od, 0, 10);
  const classic = state.client !== "lazer" || state.classicMod;
  let w;
  if (classic && !state.scoreV2) {
    const inv = clamp(10 - od, 0, 10);
    if (state.beatmap && state.beatmap.convert) {
      const high = Math.round(od) > 4;
      w = [16, high ? 34 : 47, high ? 67 : 77, 97, 121, 158];
    } else {
      w = [16, 34 + 3 * inv, 67 + 3 * inv, 97 + 3 * inv, 121 + 3 * inv, 158 + 3 * inv];
    }
  } else {
    const range = (min, mid, max) =>
      od > 5 ? mid + ((max - mid) * (od - 5)) / 5 : od < 5 ? mid - ((mid - min) * (5 - od)) / 5 : mid;
    w = [
      range(22.4, 19.4, 13.9),
      range(64, 49, 34),
      range(97, 82, 67),
      range(127, 112, 97),
      range(151, 136, 121),
      range(188, 173, 158)
    ];
  }
  const rate = state.client === "lazer" ? state.modsRate || 1 : 1;
  return w.map((v) => Math.floor(v * rate) + 0.5);
}

function updateWindows() {
  const hw = state.hitWindow;
  let w;
  if (state.client === "stable") {
    w = localWindows();
  } else if (hw && num(hw.perfect, 0) > 0 && num(hw.miss, 0) > 0) {
    const rate = state.modsRate || 1;
    w = WINDOW_KEYS.map((k) => num(hw[k], 0) * rate);
  } else {
    w = localWindows();
  }
  const sig = `${w.map((v) => v.toFixed(2)).join(",")}|${state.scoreV2 ? 1 : 0}`;
  if (state.windowSig === sig) return;
  state.windowSig = sig;
  state.windows = w;
  const pts = state.points;
  if (pts) {
    for (const p of pts) {
      if (p.matched && p.e !== null) p.j = classifyError(p.e);
    }
  }
  if (!state.scoreV2 && state.beatmap && state.beatmap.notes && state.noteState) {
    for (let i = 0; i < state.beatmap.notes.length; i++) {
      if (state.beatmap.notes[i].hold) settleV1LongNote(i);
    }
  }
}

function classifyError(e) {
  const w = state.windows;
  if (!w) return 4;
  const a = Math.abs(e);
  for (let i = 0; i < w.length - 1; i++) if (a <= w[i]) return i;
  return 4;
}

function classifyLongNote(startError, endError) {
  const w = state.windows;
  if (!w) return 4;
  const startDiff = Math.abs(startError);
  const endDiff = Math.abs(endError);
  const totalDiff = startDiff + endDiff;
  const fits = (j, rate) => startDiff <= w[j] * rate && totalDiff <= w[j] * rate * 2;
  if (fits(0, 1.2)) return 0;
  if (fits(1, 1.1)) return 1;
  if (fits(2, 1.0)) return 2;
  if (fits(3, 1.0)) return 3;
  return 4;
}

function settleV1LongNote(noteIdx) {
  if (state.scoreV2) return;
  const notes = state.beatmap && state.beatmap.notes;
  const nps = state.notePoints;
  const ns = state.noteState;
  if (!notes || !nps || !ns || !notes[noteIdx] || !notes[noteIdx].hold) return;
  const head = nps[noteIdx].head;
  const tail = nps[noteIdx].tail;
  const headError = head && head.matched && head.e !== null ? head.e : null;
  const tailError = tail && tail.matched && tail.e !== null ? tail.e : null;
  let j = null;
  if (headError !== null && tailError !== null) j = classifyLongNote(headError, tailError);
  else if (headError !== null) j = classifyError(headError);
  else if (tailError !== null) j = classifyError(tailError);
  else if ((head && head.matched) || (tail && tail.matched)) j = -1;
  const extras = ns[noteIdx].extra;
  if (extras && extras.length) {
    let worst = null;
    for (const e of extras) {
      const je = classifyError(e);
      if (worst === null || je > worst) worst = je;
    }
    if (worst !== null) j = j === null ? worst : Math.max(j, worst);
  }
  ns[noteIdx].head = j;
  ns[noteIdx].tail = j;
}

function buildPoints() {
  const map = state.beatmap;
  const pts = [];
  const notePoints = [];
  if (map && map.notes) {
    for (let i = 0; i < map.notes.length; i++) {
      const n = map.notes[i];
      const head = { note: i, column: n.column, time: n.time, end: false, matched: false, j: -1, at: 0, e: null };
      pts.push(head);
      let tail = null;
      if (n.hold && n.endTime > n.time) {
        tail = { note: i, column: n.column, time: n.endTime, end: true, matched: false, j: -1, at: 0, e: null };
        pts.push(tail);
      }
      notePoints.push({ head, tail });
    }
  }
  pts.sort((a, b) => a.time - b.time || a.column - b.column);
  state.points = pts;
  state.notePoints = notePoints;
  state.noteState = map && map.notes ? map.notes.map(() => ({ head: null, tail: null, extra: [] })) : [];
  state.windowSig = "";
  resetJudgements();
}

function resetJudgements() {
  state.errorCount = 0;
  state.statCount = 0;
  state.errorSum = 0;
  state.errorSq = 0;
  state.markedMiss = 0;
  state.searchFrom = 0;
  state.backfillFloor = -Infinity;
  const pts = state.points || [];
  for (const p of pts) {
    p.matched = false;
    p.j = -1;
    p.at = 0;
    p.e = null;
  }
  const ns = state.noteState || [];
  for (const s of ns) {
    s.head = null;
    s.tail = null;
    if (s.extra) s.extra.length = 0;
  }
}

function processError(e, pressTime) {
  const w = state.windows;
  const pts = state.points;
  if (!w || !pts || !pts.length) return;
  const near = w[w.length - 1] + 60;
  if (pressTime !== null && pressTime !== undefined) {
    const implied = pressTime - e;
    let bestOpen = -1;
    let bestOpenDist = Infinity;
    let bestAny = -1;
    let bestAnyDist = Infinity;
    const startIdx = Math.max(0, findFirstGE(pts, implied - near, (p) => p.time));
    for (let i = startIdx; i < pts.length; i++) {
      const p = pts[i];
      if (p.time - implied > near) break;
      const dist = Math.abs(p.time - implied);
      if (!p.matched && dist < bestOpenDist) {
        bestOpenDist = dist;
        bestOpen = i;
      }
      if (dist < bestAnyDist) {
        bestAnyDist = dist;
        bestAny = i;
      }
    }
    if (bestAny >= 0 && pts[bestAny].matched && !state.scoreV2) {
      const mergeNote = pts[bestAny].note;
      const mergeState = state.noteState[mergeNote];
      if (
        mergeState &&
        state.beatmap &&
        state.beatmap.notes[mergeNote].hold &&
        (bestOpen < 0 || bestAnyDist <= bestOpenDist)
      ) {
        if (!mergeState.extra) mergeState.extra = [];
        mergeState.extra.push(e);
        settleV1LongNote(mergeNote);
        addErrorStat(e);
        return;
      }
    }
    if (bestOpen < 0) return;
    matchPoint(pts[bestOpen], e, near);
    return;
  }
  let best = -1;
  consumeMissSkips();
  for (let i = state.searchFrom; i < pts.length; i++) {
    const p = pts[i];
    if (p.time < state.backfillFloor - near) continue;
    if (p.matched) continue;
    best = i;
    break;
  }
  if (best < 0) return;
  matchPoint(pts[best], e, near);
}

function addErrorStat(e) {
  state.statCount += 1;
  state.errorSum += e;
  state.errorSq += e * e;
}

function applyMatch(p, e) {
  p.matched = true;
  p.e = e;
  p.j = classifyError(e);
  p.at = p.time + e;
  const ns = state.noteState[p.note];
  if (ns) {
    if (p.end) {
      if (state.scoreV2) ns.tail = p.j;
    } else {
      ns.head = p.j;
    }
  }
  if (!state.scoreV2 && p.end) {
    const head = state.notePoints[p.note] && state.notePoints[p.note].head;
    if (head && !head.matched) head.matched = true;
  }
  if (!state.scoreV2) settleV1LongNote(p.note);
  addErrorStat(e);
}

function markPointMiss(p) {
  const n = state.beatmap.notes[p.note];
  if (!state.scoreV2 && n.hold) {
    p.matched = true;
    p.j = -1;
    const np = state.notePoints[p.note];
    if (np) {
      if (np.head) np.head.matched = true;
      if (np.tail) np.tail.matched = true;
    }
    settleV1LongNote(p.note);
    return;
  }
  p.matched = true;
  p.j = -1;
  const ns = state.noteState[p.note];
  if (ns) {
    if (p.end) ns.tail = -1;
    else ns.head = -1;
  }
}

function advanceSearchFrom(time, near) {
  const pts = state.points;
  let sf = state.searchFrom;
  while (sf < pts.length && (pts[sf].matched || pts[sf].time < time - near)) sf++;
  state.searchFrom = sf;
}

function matchPoint(p, e, near) {
  applyMatch(p, e);
  state.backfillFloor = p.time;
  advanceSearchFrom(p.time, near);
}

function canMarkMiss() {
  if (!state.hits) return true;
  return state.markedMiss < num(state.hits["0"], 0);
}

function markCandidateMiss(idx) {
  const pts = state.points;
  const p = pts[idx];
  if (!p || !state.beatmap.notes[p.note]) return false;
  markPointMiss(p);
  state.markedMiss += 1;
  let sf = state.searchFrom;
  while (sf < pts.length && pts[sf].matched) sf++;
  state.searchFrom = sf;
  return true;
}

function consumeMissSkips() {
  if (!state.hits) return;
  const pts = state.points || [];
  let guard = 0;
  while (canMarkMiss() && guard < 100) {
    let idx = -1;
    for (let i = state.searchFrom; i < pts.length; i++) {
      const p = pts[i];
      if (p.matched) continue;
      if (p.time < state.backfillFloor) continue;
      idx = i;
      break;
    }
    if (idx < 0) return;
    if (!markCandidateMiss(idx)) return;
    guard += 1;
    let sf = state.searchFrom;
    while (sf < pts.length && pts[sf].matched) sf++;
    state.searchFrom = sf;
  }
}

function sweepMisses(t) {
  const w = state.windows;
  const pts = state.points;
  const map = state.beatmap;
  if (!w || !pts || !map) return;
  const missW = w[w.length - 1];
  for (let i = state.searchFrom; i < pts.length; i++) {
    const p = pts[i];
    if (p.time > t - missW) break;
    if (p.matched) continue;
    const n = map.notes[p.note];
    if (!state.scoreV2 && n.hold && !p.end) continue;
    if (!canMarkMiss()) break;
    markPointMiss(p);
    state.markedMiss += 1;
  }
  let sf = state.searchFrom;
  while (sf < pts.length && pts[sf].matched) sf++;
  state.searchFrom = sf;
}

const runMemory = new Map();
const RUN_VERSION = 4;

function runStorageKey() {
  if (!state.checksum || !state.beatmap) return "";
  return `mrm.run.${state.checksum}.${state.client}.${state.modsNumber}.${state.beatmap.keys}.${state.scoreV2 ? "v2" : "v1"}`;
}

function loadRuns() {
  const key = runStorageKey();
  if (!key) return [];
  let stored = runMemory.get(key);
  try {
    const raw = localStorage.getItem(key);
    if (raw) stored = JSON.parse(raw);
  } catch {
  }
  const runs = Array.isArray(stored) ? stored : stored && Array.isArray(stored.matches) ? [stored] : [];
  return runs.filter((r) => r && r.g === RUN_VERSION && Array.isArray(r.matches));
}

function saveRun(complete) {
  const key = runStorageKey();
  if (!key || state.cached || !state.points) return;
  const matches = [];
  for (let i = 0; i < state.points.length; i++) {
    const p = state.points[i];
    if (p.matched && p.e !== null) matches.push([i, p.e]);
  }
  if (!matches.length) return;
  const runs = loadRuns();
  runs.unshift({ v: 1, g: RUN_VERSION, ts: Date.now(), complete: !!complete, matches });
  const trimmed = runs.slice(0, 3);
  runMemory.set(key, trimmed);
  try {
    localStorage.setItem(key, JSON.stringify(trimmed));
  } catch {
  }
}

function pickRun(prefix) {
  for (const run of loadRuns()) {
    let ok = true;
    for (let i = 0; i < prefix.length && i < run.matches.length; i++) {
      if (Math.abs(prefix[i] - run.matches[i][1]) > 1) {
        ok = false;
        break;
      }
    }
    if (ok) return run;
  }
  return null;
}

function applyRun(run) {
  const pts = state.points;
  if (!pts || !pts.length || !run) return false;
  resetJudgements();
  let lastTime = -Infinity;
  for (const m of run.matches) {
    const idx = m[0];
    const e = m[1];
    if (!(idx >= 0 && idx < pts.length)) continue;
    const p = pts[idx];
    if (p.matched) continue;
    applyMatch(p, e);
    if (p.time > lastTime) lastTime = p.time;
  }
  const w = state.windows || localWindows();
  const missBorder = run.complete ? Infinity : lastTime + w[w.length - 1];
  let misses = 0;
  for (const p of pts) {
    if (p.matched || p.time > missBorder) continue;
    const n = state.beatmap.notes[p.note];
    if (!state.scoreV2 && n.hold && !p.end) continue;
    markPointMiss(p);
    misses += 1;
  }
  state.markedMiss = misses;
  state.cached = true;
  state.cachedErrors = run.matches.map((m) => m[1]);
  state.cacheChecked = 0;
  state.errorCount = state.cachedErrors.length;
  state.searchFrom = pts.length;
  return true;
}

function applyCachedIfReady() {
  if (!state.pendingApply || !state.replayUi) return false;
  if (!state.beatmap || !state.points || !state.points.length) return false;
  if (state.statCount > 0) return false;
  const run = pickRun(state.runPrefix);
  if (!run) return false;
  state.pendingApply = false;
  return applyRun(run);
}

function parseListingNames(html) {
  const names = new Set();
  const re = /<a\s+href="([^"]+)"[^>]*>([^<]*)<\/a>/gi;
  let match;
  while ((match = re.exec(String(html || ""))) !== null) {
    const href = match[1];
    if (href.endsWith("/")) continue;
    const raw = href.split("/").pop();
    if (!raw) continue;
    try {
      names.add(decodeURIComponent(raw));
    } catch {
      names.add(raw);
    }
  }
  return names;
}

function findListedBeatmapFile(html, expectedName) {
  const target = String(expectedName || "").trim().toLowerCase();
  if (!target) return "";
  for (const name of parseListingNames(html)) {
    if (!name.toLowerCase().endsWith(".osu")) continue;
    if (name.trim().toLowerCase() === target) return name;
  }
  return "";
}

async function fetchBeatmapTextFromListing() {
  const folder = String(state.beatmapFolder || "").trim();
  const fileName = String(state.beatmapFileName || "").trim();
  if (!folder || !fileName) return null;
  const host = location.host;
  for (let folderPad = 0; folderPad <= 2; folderPad += 1) {
    const folderName = " ".repeat(folderPad) + folder;
    const listUrl = `http://${host}/files/beatmap/${encodeURIComponent(folderName)}/`;
    let html = "";
    try {
      const response = await fetch(listUrl, { cache: "no-store" });
      if (!response.ok) continue;
      html = await response.text();
    } catch {
      continue;
    }
    const actualName = findListedBeatmapFile(html, fileName);
    if (!actualName) continue;
    const fileUrl = `http://${host}/files/beatmap/${encodeURIComponent(folderName)}/${encodeURIComponent(actualName)}`;
    try {
      const response = await fetch(fileUrl, { cache: "no-store" });
      if (!response.ok) continue;
      const text = await response.text();
      if (text && text.includes("osu file format")) return text;
    } catch {
      continue;
    }
  }
  return null;
}

async function fetchBeatmapText() {
  let primaryError = "";
  try {
    const response = await fetch("/files/beatmap/file", { cache: "no-store" });
    if (response.ok) {
      const text = await response.text();
      if (text && text.includes("osu file format")) return text;
      primaryError = "empty beatmap response";
    } else {
      primaryError = `file request failed (${response.status})`;
    }
  } catch (err) {
    primaryError = String((err && err.message) || err);
  }
  const fallback = await fetchBeatmapTextFromListing();
  if (fallback) return fallback;
  throw new Error(primaryError || "beatmap fetch failed");
}

async function ensureBeatmap() {
  const identity = state.checksum || (state.beatmapFolder && state.beatmapFileName ? `${state.beatmapFolder}/${state.beatmapFileName}` : "");
  if (!identity || state.mapMode !== "mania") return;
  const key = `${identity}|${state.mapMode}|${state.csConverted}`;
  if (state.loadedKey === key) return;
  if (state.pendingKey === key) return;
  if (state.retryKey === key && performance.now() < state.retryAt) return;
  state.pendingKey = key;
  const token = ++state.loadToken;
  try {
    const text = await fetchBeatmapText();
    if (token !== state.loadToken) return;
    const parsed = parseOsu(text);
    const keys = clamp(Math.round(state.csConverted || num(parsed.difficulty.CircleSize, 4)), 1, 18);
    const map = buildManiaNotes(parsed, keys);
    map.convert = String(parsed.general.Mode === undefined ? "3" : parsed.general.Mode) !== "3";
    state.beatmap = map;
    state.loadedKey = key;
    state.retryKey = "";
    state.loadError = "";
    buildPoints();
    updateWindows();
    applyCachedIfReady();
  } catch (err) {
    if (token !== state.loadToken) return;
    state.beatmap = null;
    state.retryKey = key;
    state.retryAt = performance.now() + 2000;
    state.loadError = String((err && err.message) || err);
    console.error("[ManiaReplayMaster] beatmap fetch failed:", err);
  } finally {
    if (token === state.loadToken) state.pendingKey = "";
  }
}

function updateSettings(message) {
  if (!message || typeof message !== "object") return;
  for (const [key, value] of Object.entries(message)) {
    if (!Object.prototype.hasOwnProperty.call(settings, key)) continue;
    let next = value;
    if (typeof settings[key] === "number") next = Number(value);
    else if (typeof settings[key] === "boolean") next = typeof value === "string" ? value === "true" : Boolean(value);
    if (settings[key] === next || Number.isNaN(next)) continue;
    settings[key] = next;
  }
}

function makeScroll(cps, timeRange) {
  const pts = cps && cps.length ? cps : null;
  let cum = null;
  if (pts) {
    cum = new Float64Array(pts.length);
    for (let i = 1; i < pts.length; i++) {
      cum[i] = cum[i - 1] + ((pts[i].time - pts[i - 1].time) / timeRange) * pts[i - 1].m;
    }
  }
  return {
    at(x) {
      if (!pts) return x / timeRange;
      let i = findLastLE(pts, x, (p) => p.time);
      if (i < 0) i = 0;
      return cum[i] + ((x - pts[i].time) / timeRange) * pts[i].m;
    }
  };
}

function getScroll(map, timeRange) {
  if (renderCache.scroll && renderCache.scrollMap === map && renderCache.scrollRange === timeRange) {
    return renderCache.scroll;
  }
  const scroll = makeScroll(map.cps, timeRange);
  renderCache.scrollMap = map;
  renderCache.scrollRange = timeRange;
  renderCache.scroll = scroll;
  return scroll;
}

function visibleStartIndex(map, scroll, now, t, hitPos) {
  const notes = map.notes;
  if (renderCache.cursorMap !== map || t < renderCache.cursorTime - 1500) {
    renderCache.cursorMap = map;
    renderCache.cursor = Math.max(0, findFirstGE(notes, t - 30000, (n) => n.time));
  }
  const postFrac = (480 - hitPos) / hitPos + 0.2;
  let i = renderCache.cursor;
  while (i < notes.length) {
    const n = notes[i];
    const end = n.hold ? n.endTime : n.time;
    if (scroll.at(end) - now < -postFrac) {
      i++;
      continue;
    }
    break;
  }
  renderCache.cursor = i;
  renderCache.cursorTime = t;
  return i;
}

function getColumns(keys) {
  if (renderCache.cols && renderCache.colsKeys === keys) return renderCache.cols;
  const colW = 480 / keys;
  const cols = [];
  for (let i = 0; i < keys; i++) cols.push({ x: i * colW, w: colW });
  renderCache.cols = cols;
  renderCache.colsKeys = keys;
  return cols;
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, radius);
    return;
  }
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function judgementColor(j) {
  if (j === null || j === undefined) return settings.colorUnjudged;
  if (j < 0 || j > 5) return settings.colorMiss;
  return settings[COLOR_KEYS[j]];
}

function drawNoteBlock(ctx, x, y, w, h, j, opacity, colorOverride, stroke) {
  const top = y - h / 2;
  ctx.globalAlpha = opacity;
  ctx.strokeStyle = colorOverride || judgementColor(j);
  ctx.lineWidth = stroke;
  roundRect(ctx, x + stroke / 2, top + stroke / 2, Math.max(1, w - stroke), Math.max(1, h - stroke), Math.min(4, h / 3));
  ctx.stroke();
}

function drawActionBlock(ctx, col, y, h, j, opacity) {
  const cx = col.x + col.w / 2;
  ctx.globalAlpha = opacity;
  ctx.fillStyle = judgementColor(j);
  roundRect(ctx, cx - col.w * 0.2, y - h / 2, col.w * 0.4, h, Math.min(3, h / 2));
  ctx.fill();
}

function drawActionHold(ctx, col, y1, y2, h, opacity) {
  const cx = col.x + col.w / 2;
  const top = Math.min(y1, y2);
  const bottom = Math.max(y1, y2);
  ctx.globalAlpha = opacity * 0.9;
  ctx.fillStyle = settings.colorLongNote;
  for (let y = bottom - h * 2; y > top; y -= h * 2) {
    ctx.fillRect(cx - h / 2, y, h, h);
  }
}

function unstableRate() {
  const n = state.statCount;
  if (n < 2) return 0;
  const mean = state.errorSum / n;
  const variance = Math.max(0, state.errorSq / n - mean * mean);
  const ur = Math.sqrt(variance) * 10;
  return state.modsRate && state.modsRate !== 1 ? ur / state.modsRate : ur;
}

function drawStats(ctx, opacity) {
  const hits = state.hits || {};
  const counts = [num(hits.geki, 0), num(hits["300"], 0), num(hits.katu, 0), num(hits["100"], 0), num(hits["50"], 0), num(hits["0"], 0)];
  const scale = clamp(num(settings.statsScale, 1.4), 0.5, 4);
  const squareW = 5 * scale;
  const squareH = 10 * scale;
  const rowH = 13 * scale;
  const fontPx = 10 * scale;
  const panelW = 96 * scale;
  const x = 10;
  let y = 10 + 6 * scale;
  const panelH = counts.length * rowH + 36 * scale;
  ctx.globalAlpha = opacity * 0.42;
  ctx.fillStyle = "#000000";
  roundRect(ctx, x - 6 * scale, y - 11 * scale, panelW, panelH, 4);
  ctx.fill();
  ctx.globalAlpha = opacity;
  ctx.font = `${fontPx}px 'Segoe UI', system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  for (let i = 0; i < counts.length; i++) {
    const color = judgementColor(i);
    ctx.fillStyle = color;
    ctx.fillRect(x, y - squareH / 2, squareW, squareH);
    ctx.strokeStyle = "rgba(0,0,0,0.7)";
    ctx.lineWidth = Math.max(1, scale);
    ctx.strokeRect(x, y - squareH / 2, squareW, squareH);
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.fillText(`${STAT_LABELS[i]} ${counts[i]}`, x + squareW + 4 * scale, y);
    y += rowH;
  }
  y += 2 * scale;
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.fillText(`${state.accuracy.toFixed(2)}%`, x + squareW + 4 * scale, y);
  y += rowH;
  ctx.fillText(`UR ${unstableRate().toFixed(0)}`, x + squareW + 4 * scale, y);
}

function effectiveTimeRange(hitPos) {
  const override = num(settings.maniaScrollSpeedOverride, 0);
  const speed = override > 0 ? clamp(override, 1, 40) : clamp(state.maniaScrollSpeed || 5, 1, 40);
  const naturalPxPerMs = (402 * speed) / 11485;
  const reviewTime = Math.max(200, num(settings.reviewTime, 1500));
  const maxPxPerMs = (480 - hitPos) / reviewTime;
  const pxPerMs = Math.max(0.0001, Math.min(naturalPxPerMs, maxPxPerMs));
  return hitPos / pxPerMs;
}

function renderScene(ctx, t) {
  const map = state.beatmap;
  if (!map || !map.notes || !map.notes.length) return;
  const hitPos = clamp(num(settings.hitPosition, 80), 60, 470);
  const timeRange = effectiveTimeRange(hitPos);
  const scroll = getScroll(map, timeRange);
  const now = scroll.at(t);
  const cols = getColumns(map.keys);
  const noteH = clamp(num(settings.noteHeight, 22), 4, 80);
  const actionH = clamp(num(settings.actionHeight, 7), 2, 40);
  const strokeW = Math.max(1, num(settings.noteStroke, 2));
  const opacity = clamp(num(settings.playfieldOpacity, 1), 0, 1);

  if (settings.showHitLine) {
    const lineW = clamp(num(settings.hitLineWidth, 4), 1, 24);
    ctx.globalAlpha = opacity * 0.35;
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, hitPos - lineW / 2 - 1, 480, lineW + 2);
    ctx.globalAlpha = opacity * 0.65;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, hitPos - lineW / 2, 480, lineW);
  }

  const start = visibleStartIndex(map, scroll, now, t, hitPos);
  for (let i = start; i < map.notes.length; i++) {
    const n = map.notes[i];
    const fracHead = scroll.at(n.time) - now;
    if (fracHead > 1.3) break;
    const fracTail = n.hold ? scroll.at(n.endTime) - now : fracHead;
    const yHead = hitPos - fracHead * hitPos;
    const yTail = hitPos - fracTail * hitPos;
    if (Math.min(yHead, yTail) > 560) continue;
    if (Math.max(yHead, yTail) < -120) continue;
    const col = cols[n.column];
    if (!col) continue;
    const np = state.notePoints ? state.notePoints[i] : null;
    const ns = state.noteState ? state.noteState[i] : null;
    if (n.hold) {
      const top = Math.min(yHead, yTail);
      const bottom = Math.max(yHead, yTail);
      const x = col.x + col.w * 0.1;
      const w = col.w * 0.8;
      const center = (top + bottom) / 2;
      const height = Math.max(noteH, bottom - top);
      if (state.scoreV2) {
        drawNoteBlock(ctx, x, center, w, height, null, opacity, settings.colorLongNote, strokeW);
      } else {
        const j = ns ? (ns.head !== null ? ns.head : ns.tail) : null;
        drawNoteBlock(ctx, x, center, w, height, j, opacity, null, strokeW);
      }
    } else {
      drawNoteBlock(ctx, col.x + col.w * 0.1, yHead, col.w * 0.8, noteH, ns ? ns.head : null, opacity, null, strokeW);
    }
    if (settings.showActions && np) {
      const headMatched = np.head && np.head.matched && np.head.e !== null;
      const tailMatched = np.tail && np.tail.matched && np.tail.e !== null;
      const yActionHead = headMatched ? hitPos - (scroll.at(np.head.at) - now) * hitPos : null;
      const yActionTail = tailMatched ? hitPos - (scroll.at(np.tail.at) - now) * hitPos : null;
      if (yActionHead !== null && yActionHead > -160 && yActionHead < 560) drawActionBlock(ctx, col, yActionHead, actionH, np.head.j, opacity);
      if (yActionTail !== null && yActionTail > -160 && yActionTail < 560) drawActionBlock(ctx, col, yActionTail, actionH, np.tail.j, opacity);
      if (n.hold && yActionHead !== null) {
        let holdEndY = null;
        if (yActionTail !== null) holdEndY = yActionTail;
        else if (n.endTime > t) holdEndY = hitPos;
        else holdEndY = yTail;
        if (
          holdEndY !== null &&
          Math.max(yActionHead, holdEndY) > -160 &&
          Math.min(yActionHead, holdEndY) < 560
        ) {
          drawActionHold(ctx, col, yActionHead, holdEndY, actionH, opacity);
        }
      }
    }
  }
  ctx.globalAlpha = opacity;
  if (settings.showStats) drawStats(ctx, opacity);
  ctx.globalAlpha = 1;
}

const canvas = document.getElementById("preview");
const ctx = canvas.getContext("2d", { alpha: true, desynchronized: true });
const statusEl = document.getElementById("status");
let lastWidth = 0;
let lastHeight = 0;
let wasVisible = false;

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.floor(window.innerWidth * dpr));
  const height = Math.max(1, Math.floor(window.innerHeight * dpr));
  if (width !== lastWidth || height !== lastHeight) {
    canvas.width = width;
    canvas.height = height;
    lastWidth = width;
    lastHeight = height;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
  }
}

function currentViewport(width, height) {
  const scale = Math.min(width / 480, height / 480) * (clamp(num(settings.renderScale, 100), 1, 1000) / 100);
  const offsetX = (width - 480 * scale) / 2;
  const offsetY = (height - 480 * scale) / 2;
  const pad = 40 * scale;
  const left = Math.max(0, offsetX - pad);
  const top = Math.max(0, offsetY - pad);
  const right = Math.min(width, offsetX + 480 * scale + pad);
  const bottom = Math.min(height, offsetY + 480 * scale + pad);
  return {
    scale,
    offsetX,
    offsetY,
    clear: { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) }
  };
}

let lastFrameAt = 0;
let lastPaddedView = null;
let lastDrawRev = "";

function allowedState() {
  return state.gameState === "play" && state.mapMode === "mania";
}

function statusText() {
  if (!state.gameState) return "waiting for tosu...";
  if (state.gameState !== "play") return "";
  if (state.mapMode !== "mania") return "mania only";
  if (!state.beatmap) {
    if (state.loadError) return `beatmap fetch failed: ${state.loadError} (retrying)`;
    return "loading beatmap...";
  }
  return "";
}

function frame() {
  requestAnimationFrame(frame);
  const nowMs = performance.now();
  const fpsLimit = clamp(num(settings.fpsLimit, 0), 0, 1000);
  if (fpsLimit > 0 && nowMs - lastFrameAt < 1000 / fpsLimit - 1) return;
  lastFrameAt = nowMs;

  resize();
  const width = canvas.width;
  const height = canvas.height;
  const text = statusText();
  if (statusEl.textContent !== text) statusEl.textContent = text;

  const hasChart = state.beatmap && state.beatmap.notes && state.beatmap.notes.length > 0;
  if (!allowedState() || !hasChart) {
    if (wasVisible) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, width, height);
      lastPaddedView = null;
      lastDrawRev = "";
      wasVisible = false;
    }
    return;
  }

  const t = renderTime();
  sweepMisses(t);
  const rev = `${t.toFixed(3)}|${state.beatmap.keys}|${state.errorCount}|${state.windows ? state.windows.join(",") : ""}|${settings.playfieldOpacity}|${settings.renderScale}|${settings.backgroundOpacity}|${settings.backgroundColor}|${settings.noteHeight}|${settings.noteStroke}|${settings.actionHeight}|${settings.hitPosition}|${settings.hitLineWidth}|${settings.reviewTime}|${settings.statsScale}|${settings.showActions}|${settings.showStats}|${settings.showHitLine}|${settings.colorUnjudged}|${settings.colorLongNote}|${width}|${height}`;
  if (rev === lastDrawRev) return;
  lastDrawRev = rev;
  wasVisible = true;

  const bgOpacity = clamp(num(settings.backgroundOpacity, 0), 0, 1);
  const view = currentViewport(width, height);
  const clear = view.clear;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(clear.x, clear.y, clear.w, clear.h);
  if (
    lastPaddedView &&
    (lastPaddedView.x !== clear.x || lastPaddedView.y !== clear.y || lastPaddedView.w !== clear.w || lastPaddedView.h !== clear.h)
  ) {
    ctx.clearRect(lastPaddedView.x, lastPaddedView.y, lastPaddedView.w, lastPaddedView.h);
  }
  lastPaddedView = clear;
  if (bgOpacity > 0) {
    ctx.fillStyle = hexToRgba(settings.backgroundColor, bgOpacity);
    ctx.fillRect(view.offsetX, view.offsetY, 480 * view.scale, 480 * view.scale);
  }

  ctx.setTransform(view.scale, 0, 0, view.scale, view.offsetX, view.offsetY);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, 480, 480);
  ctx.clip();
  renderScene(ctx, t);
  ctx.restore();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
}

const sockets = new SocketManager(location.host);

const v2Filters = [
  "client",
  { field: "state", keys: ["name"] },
  { field: "settings", keys: ["replayUIVisible", { field: "mania", keys: ["scrollSpeed"] }] },
  {
    field: "play",
    keys: [
      { field: "mode", keys: ["name"] },
      { field: "mods", keys: ["number", "array", "rate"] },
      "failed",
      "hitErrorArray",
      "score",
      { field: "hits", keys: ["0", "50", "100", "300", "geki", "katu"] },
      "accuracy"
    ]
  },
  {
    field: "beatmap",
    keys: [
      { field: "mode", keys: ["name"] },
      { field: "stats", keys: ["od", "hitWindow", { field: "cs", keys: ["original", "converted"] }] },
      { field: "time", keys: ["live"] },
      "checksum"
    ]
  },
  { field: "folders", keys: ["beatmap"] },
  { field: "files", keys: ["beatmap"] }
];

function handleGameStateChange(stateName) {
  if (stateName === "play" && state.gameState !== "play") {
    state.cached = false;
    state.cachedErrors = null;
    state.cacheChecked = 0;
    state.runPrefix = [];
    state.pendingApply = true;
    state.lastHitsTotal = null;
    state.lastScore = 0;
    resetJudgements();
  } else if (stateName !== "play" && state.gameState === "play") {
    if (!state.cached && state.statCount > 0) {
      const notes = state.beatmap ? state.beatmap.notes : [];
      const last = notes.length ? notes[notes.length - 1] : null;
      const endTime = last ? last.endTime : 0;
      const reached = Math.max(state.lastLive, state.time) >= endTime - 500;
      saveRun(!state.failed && reached);
    }
    state.cached = false;
    state.cachedErrors = null;
    state.pendingApply = false;
    state.runPrefix = [];
  }
  state.gameState = stateName;
}

function applyMods(mods) {
  state.modsNumber = Number(mods.number) || 0;
  state.modsRate = Number.isFinite(Number(mods.rate)) ? Number(mods.rate) : 1;
  const arr = Array.isArray(mods.array) ? mods.array : [];
  const acronyms = arr.map((m) => (m && m.acronym ? String(m.acronym).toUpperCase() : ""));
  state.scoreV2 = (Number(mods.number) & (1 << 29)) !== 0 || acronyms.includes("V2") || acronyms.includes("SV2");
  state.classicMod = state.client !== "lazer" || acronyms.includes("CL");
}

function applyStats(stats) {
  if (stats.od) {
    if (Number.isFinite(Number(stats.od.converted))) state.odConverted = Number(stats.od.converted);
    if (Number.isFinite(Number(stats.od.original))) state.od = Number(stats.od.original);
  }
  if (stats.cs && Number.isFinite(Number(stats.cs.converted))) state.csConverted = Number(stats.cs.converted);
  state.hitWindow = stats.hitWindow && typeof stats.hitWindow === "object" ? stats.hitWindow : null;
}

function applyPlayUpdate(play) {
  state.hits = play.hits || null;
  state.failed = !!play.failed;
  const acc = Number(play.accuracy);
  if (Number.isFinite(acc)) state.accuracy = acc;
  if (state.gameState === "play" && !state.cached && state.hits) {
    const totalHits =
      num(state.hits.geki, 0) +
      num(state.hits["300"], 0) +
      num(state.hits.katu, 0) +
      num(state.hits["100"], 0) +
      num(state.hits["50"], 0) +
      num(state.hits["0"], 0);
    const score = Number(play.score);
    const restarted =
      state.lastHitsTotal !== null &&
      (totalHits < state.lastHitsTotal || (Number.isFinite(score) && state.lastScore > 0 && score < state.lastScore - 1));
    if (restarted) {
      state.runPrefix = [];
      state.pendingApply = false;
      resetJudgements();
    }
    state.lastHitsTotal = totalHits;
    if (Number.isFinite(score)) state.lastScore = score;
  }
  if (!state.cached && Array.isArray(play.hitErrorArray) && play.hitErrorArray.length < state.errorCount) resetJudgements();
}

function onV2(data) {
  if (!data) return;
  if (typeof data.client === "string" && data.client) state.client = data.client;
  if (data.settings) {
    if (typeof data.settings.replayUIVisible === "boolean") state.replayUi = data.settings.replayUIVisible;
    const scrollSpeed = Number(data.settings.mania && data.settings.mania.scrollSpeed);
    if (Number.isFinite(scrollSpeed) && scrollSpeed > 0) state.maniaScrollSpeed = scrollSpeed;
  }
  const stateName = data.state && data.state.name;
  if (stateName) handleGameStateChange(stateName);
  const mapMode = data.beatmap && data.beatmap.mode && data.beatmap.mode.name;
  if (mapMode) state.mapMode = mapMode;
  if (data.play && data.play.mods) applyMods(data.play.mods);
  if (data.beatmap && data.beatmap.stats) applyStats(data.beatmap.stats);
  if (data.play) applyPlayUpdate(data.play);
  if (data.folders && typeof data.folders.beatmap === "string") state.beatmapFolder = data.folders.beatmap;
  if (data.files && typeof data.files.beatmap === "string") state.beatmapFileName = data.files.beatmap;
  const checksum = data.beatmap ? String(data.beatmap.checksum || "") : "";
  if (checksum && checksum !== state.checksum) {
    state.checksum = checksum;
    state.loadError = "";
    state.retryKey = "";
  }
  const live = Number(data.beatmap && data.beatmap.time && data.beatmap.time.live);
  if (Number.isFinite(live)) {
    if (state.gameState === "play" && !state.cached && live < state.lastLive - 500) resetJudgements();
    state.lastLive = live;
    setTime(live);
  }
  updateWindows();
  ensureBeatmap();
  applyCachedIfReady();
  if (state.gameState === "play" && !state.cached && state.statCount > 0 && performance.now() >= state.nextSaveAt) {
    state.nextSaveAt = performance.now() + 3000;
    saveRun(false);
  }
}

function onPrecise(data) {
  if (!data) return;
  const arr = data.hitErrors;
  if (!Array.isArray(arr)) return;
  if (state.gameState !== "play") {
    if (!state.cached && state.errorCount !== 0) resetJudgements();
    return;
  }
  if (state.cached) {
    if (arr.length < state.cacheChecked) {
      state.cacheChecked = 0;
      state.runPrefix = [];
    }
    const ce = state.cachedErrors || [];
    for (let i = state.cacheChecked; i < arr.length; i++) {
      state.runPrefix.push(arr[i]);
      if (i >= ce.length || Math.abs(arr[i] - ce[i]) > 1) {
        state.cached = false;
        state.cachedErrors = null;
        state.pendingApply = false;
        resetJudgements();
        for (let j = 0; j < state.runPrefix.length; j++) processError(state.runPrefix[j], null);
        state.errorCount = state.runPrefix.length;
        return;
      }
    }
    state.cacheChecked = arr.length;
    return;
  }
  if (arr.length < state.errorCount) resetJudgements();
  if (arr.length > state.errorCount) {
    const count = arr.length - state.errorCount;
    if (count > 4 || state.errorCount === 0 || state.timeSpeed > 1.25) {
      for (let i = state.errorCount; i < arr.length; i++) {
        state.runPrefix.push(arr[i]);
        processError(arr[i], null);
      }
    } else {
      const now = renderTime();
      for (let i = state.errorCount; i < arr.length; i++) {
        state.runPrefix.push(arr[i]);
        processError(arr[i], now);
      }
    }
    state.errorCount = arr.length;
  }
  if (state.replayUi && state.pendingApply) applyCachedIfReady();
}

function onCommand(data) {
  if (!data) return;
  if (data.command === "getSettings" || data.command === "updateSettings") updateSettings(data.message);
}

function requestSettings(attempt) {
  attempt = attempt || 0;
  const sent = sockets.send("/websocket/commands", `getSettings:${encodeURI(window.COUNTER_PATH || "")}`);
  if (!sent && attempt < 100) setTimeout(() => requestSettings(attempt + 1), 100);
}

sockets.open("/websocket/v2", onV2, v2Filters);
sockets.open("/websocket/v2/precise", onPrecise, null);
sockets.open("/websocket/commands", onCommand, null);
requestSettings();

window.addEventListener("beforeunload", () => {
  if (state.gameState === "play" && !state.cached && state.statCount > 0) saveRun(false);
});

window.__maniaReplayMaster = {
  state,
  settings,
  parseOsu,
  buildManiaNotes,
  makeScroll,
  getScroll,
  localWindows,
  updateWindows,
  classifyError,
  effectiveTimeRange,
  buildPoints,
  resetJudgements,
  processError,
  sweepMisses,
  consumeMissSkips,
  saveRun,
  loadRuns,
  applyRun,
  runStorageKey,
  ensureBeatmap,
  fetchBeatmapText,
  onV2,
  onPrecise,
  renderTime,
  setTime,
  renderScene,
  frame,
  unstableRate,
  allowedState,
  statusText,
  updateSettings,
  canvas,
  sockets
};

requestAnimationFrame(frame);
