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
  fpsLimit: 0,
  helperUrl: "http://127.0.0.1:24051",
  helperToken: "",
  analysisMode: "Auto",
  exactReplay: true,
  exactLive: true
};

function analysisMode() {
  const mode = String(settings.analysisMode || "Auto");
  return mode === "Live" || mode === "Replay" ? mode : "Auto";
}

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
  sweepFrom: 0,
  backfillFloor: -Infinity,
  hits: null,
  accuracy: 100,
  markedMiss: 0,
  exactApplied: false,
  exactFetching: false,
  exactKey: "",
  exactActions: null,
  exactCounts: null,
  urCache: null,
  exactRetryAt: 0,
  liveActive: false,
  liveReady: false,
  liveAnchorHook: null,
  liveAnchorSong: 0,
  liveKey: "",
  liveSource: null,
  helperState: "off",
  helperLayout: "",
  helperHookError: "",
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
  nextSaveAt: 0,
  lastV2At: 0,
  streamStale: false,
  keyHints: [],
  keyHintPressed: [false, false, false, false],
  keyHintCounts: [0, 0, 0, 0],
  keyHintSlotCount: 0,
  keyHintExposed: [],
  keyHintSeen: false,
  keyHintLogged: false,
  livePending: [],
  liveRecentErrors: [],
  liveErrorCount: 0,
  liveBias: 0,
  lastPreciseAt: 0,
  preciseStalledUntil: 0
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
  const a = Number.isFinite(Number(alpha)) ? Math.max(0, Math.min(1, Number(alpha))) : 1;
  return `rgba(${r},${g},${b},${a})`;
}

const SOCKET_BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 10000];
let socketErrorText = "";

class SocketManager {
  constructor(host) {
    this.host = host;
    this.sockets = {};
    this.retries = {};
    this.reopeners = {};
  }
  open(path, onMessage, filters, onOpen) {
    if (this.sockets[path]) return;
    // Reopening has to re-announce the settings request too, otherwise a tosu restart
    // leaves the overlay on its default settings for the rest of the session.
    if (onOpen) this.reopeners[path] = onOpen;
    const proto = location.protocol === "https:" ? "wss://" : "ws://";
    const url = `${proto}${this.host}${path}?l=${encodeURIComponent(window.COUNTER_PATH || "")}`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.retry(path, onMessage, filters, onOpen);
      return;
    }
    this.sockets[path] = ws;
    ws.onopen = () => {
      this.retries[path] = 0;
      if (filters) ws.send(`applyFilters:${JSON.stringify(filters)}`);
      const cb = this.reopeners[path];
      if (cb) {
        try {
          cb();
        } catch (err) {
          console.error("[ManiaReplayMaster]", err);
        }
      }
    };
    ws.onclose = () => {
      delete this.sockets[path];
      this.retry(path, onMessage, filters, onOpen);
    };
    ws.onerror = () => {
      // onclose follows and schedules the reconnect; the browser gives no detail here.
    };
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data && typeof data === "object" && "error" in data) {
          // tosu reports filter/socket problems inside the payload; they used to be dropped.
          const detail = typeof data.error === "string" ? data.error : JSON.stringify(data.error);
          if (detail && detail !== socketErrorText) {
            socketErrorText = detail;
            console.warn("[ManiaReplayMaster] tosu socket error:", detail);
          }
          return;
        }
        socketErrorText = "";
        onMessage(data);
      } catch (err) {
        console.error("[ManiaReplayMaster]", err);
      }
    };
  }
  retry(path, onMessage, filters, onOpen) {
    const n = Math.min((this.retries[path] || 0) + 1, SOCKET_BACKOFF_MS.length);
    this.retries[path] = n;
    setTimeout(() => this.open(path, onMessage, filters, onOpen), SOCKET_BACKOFF_MS[n - 1]);
  }
  closeAll() {
    for (const key of Object.keys(this.sockets)) {
      const ws = this.sockets[key];
      delete this.sockets[key];
      try {
        ws.close();
      } catch (err) {
        /* already closed */
      }
    }
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
  const delta = t - state.time;
  if (dt > 0 && dt < 1000) {
    const inst = (t - state.time) / dt;
    if (inst >= 0 && inst < 12) state.timeSpeed = state.timeSpeed * 0.75 + inst * 0.25;
    else if (inst < -0.01) state.timeSpeed = 1;
  } else {
    state.timeSpeed = 1;
  }
  // A forward jump (pause/resume, replay seek, tosu hiccup) makes `renderTime()` point at a
  // later part of the map than the hitErrors currently being delivered. Match the next
  // couple of batches by note order instead of by that misleading wall-clock time.
  if (delta > 250) state.preciseStalledUntil = now + 500;
  state.time = t;
  state.timeLocal = now;
}

function renderTime() {
  // A stalled v2 stream means the extrapolated song clock is no longer anchored to the
  // game; freeze on the last sample instead of drifting ahead of the playfield.
  if (state.streamStale) return state.time;
  const now = performance.now();
  const age = now - state.timeLocal;
  // A stale time sample means the v2 stream stalled (pause, webview/GC stall, tosu hiccup).
  // Extrapolating from it would run the playfield ahead of the game, so freeze on the last
  // known song time instead. Without this a single 300ms stall could shift the clock far
  // enough that a hitError lines up with a later note and the real note stays unjudged.
  if (age > 250 || !Number.isFinite(state.time)) return state.time;
  const dt = clamp(age, 0, 200);
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
  const rate = state.modsRate || 1;
  return w.map((v) => Math.floor(v * rate) + 0.5);
}

function updateWindows() {
  const hw = state.hitWindow;
  let w;
  if (state.client === "stable") {
    w = localWindows();
  } else if (hw && WINDOW_KEYS.every((k) => num(hw[k], 0) > 0)) {
    // A lazer payload with a missing window key used to yield a 0ms window, which made
    // every judgement MEH/MISS; require the complete set and fall back to OD windows.
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
  if (pts && !state.exactApplied) {
    for (const p of pts) {
      if (!p.matched || p.e === null) continue;
      p.j = state.scoreV2 && p.end ? classifyV2Tail(p.note, p.e) : classifyError(p.e);
      // The note-level colours are what the renderer reads; keeping them in sync with the
      // point classes avoids "pips are one colour, notes another" after OD/mods changes.
      const ns = state.noteState && state.noteState[p.note];
      if (!ns) continue;
      if (p.end) {
        if (state.scoreV2) ns.tail = p.j;
      } else {
        ns.head = p.j;
      }
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

// V1 stable judges a long note as ONE judgement: the head and tail distances are
// summed and compared against a slightly relaxed window (rate 1.2 / 1.1 for MAX / 300).
// ScoreV2 judges a hold release on its own: the release distance is divided by 1.5
// before it is compared with the usual windows, and an unreleased head degrades the
// tail to MEH (see judgeRelease in the reference implementation).
function classifyV2Tail(noteIdx, endError) {
  const w = state.windows;
  if (!w) return 4;
  let j = classifyError(Math.abs(endError) / 1.5);
  const nps = state.notePoints;
  const np = nps && nps[noteIdx];
  const head = np && np.head;
  const headOk = !!(head && head.matched && head.j >= 0);
  if (!headOk && j >= 0 && j <= 3) j = 4;
  return j;
}

// A ScoreV2 tail is judged on its own, but a release that arrives before its head was
// claimed is temporarily degraded to MEH. When the head shows up later, the tail has to be
// re-judged with the same rule as a normally ordered release, otherwise it stays MEH.
function refreshV2Tail(noteIdx) {
  if (!state.scoreV2) return;
  const nps = state.notePoints;
  const ns = state.noteState;
  const np = nps && nps[noteIdx];
  if (!np || !np.tail || !np.tail.matched || np.tail.e === null) return;
  if (!ns || !ns[noteIdx]) return;
  const j = classifyV2Tail(noteIdx, np.tail.e);
  if (np.tail.j === j) return;
  np.tail.j = j;
  ns[noteIdx].tail = j;
}

function classifyLongNote(startError, endError) {
  const w = state.windows;
  if (!w) return 4;
  const a = Math.abs(startError);
  const b = Math.abs(endError);
  const missW = w[w.length - 1];
  if (endError < -missW) return -1;
  const total = a + b;
  const rates = [1.2, 1.1, 1.0, 1.0];
  const n = Math.min(4, w.length - 1);
  for (let i = 0; i < n; i++) {
    const lim = w[i] * rates[i];
    if (a <= lim && total <= lim * 2) return i;
  }
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
  state.columnPoints = Array.from({ length: map ? map.keys : 0 }, () => []);
  for (let i = 0; i < pts.length; i++) {
    state.columnPoints[pts[i].column].push(i);
  }
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
  state.sweepFrom = 0;
  state.backfillFloor = -Infinity;
  state.keyHints.length = 0;
  state.keyHintPressed.length = 0;
  state.keyHintCounts.length = 0;
  state.keyHintExposed = [];
  state.keyHintSlotCount = 0;
  state.keyHintLogged = false;
  state.livePending.length = 0;
  state.liveRecentErrors.length = 0;
  state.liveErrorCount = 0;
  state.liveBias = 0;
  // Everything below was derived from the judgements we just dropped: keep none of it, or a
  // later applyExactData()/ensureLive() short-circuits on stale state and the fresh run is
  // never judged.
  state.exactApplied = false;
  state.exactKey = "";
  state.exactActions = null;
  state.exactCounts = null;
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
        bestAnyDist <= 30 &&
        (bestOpen < 0 || bestAnyDist + 2 < bestOpenDist)
      ) {
        if (!mergeState.extra) mergeState.extra = [];
        mergeState.extra.push(e);
        settleV1LongNote(mergeNote);
        addErrorStat(e);
        return;
      }
    }
    // If the clock is far ahead of the earliest note that still has no judgement and no
    // miss is pending, that note cannot be a skipped one: the delayed hitError belongs to
    // it, not to a later note. Matching by note order avoids crediting the later note and
    // leaving this one unjudged forever.
    const map = state.beatmap;
    let firstUnmatched = -1;
    for (let i = 0; i < pts.length; i++) {
      const cand = pts[i];
      if (cand.matched) continue;
      // V1 long note heads are deliberately never swept as misses (sweepMisses skips them),
      // so an old hold head can look like "the skipped note" forever. Letting the fallback
      // below claim it would turn a long note nobody pressed into a MAX long note and steal
      // the hitError from the note that was actually hit.
      if (!state.scoreV2 && !cand.end) {
        const n = map && map.notes[cand.note];
        if (n && n.hold) continue;
      }
      firstUnmatched = i;
      break;
    }
    if (firstUnmatched >= 0 && !canMarkMiss() && implied - pts[firstUnmatched].time > 260) {
      matchPoint(pts[firstUnmatched], e, near);
      return;
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
  p.j = state.scoreV2 && p.end ? classifyV2Tail(p.note, e) : classifyError(e);
  p.at = p.time + e;
  const ns = state.noteState[p.note];
  if (ns) {
    if (p.end) {
      if (state.scoreV2) ns.tail = p.j;
    } else {
      ns.head = p.j;
    }
  }
  if (state.scoreV2 && !p.end) refreshV2Tail(p.note);
  if (!state.scoreV2 && p.end) {
    const head = state.notePoints[p.note] && state.notePoints[p.note].head;
    if (head && !head.matched) head.matched = true;
  }
  if (!state.scoreV2) settleV1LongNote(p.note);
  addErrorStat(e);
}

function markPointMiss(p) {
  if (!p || !state.beatmap || !state.beatmap.notes || !state.beatmap.notes[p.note]) return;
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

function pushKeyHint(column, kind) {
  state.keyHints.push({ column, kind, at: renderTime() });
  if (state.keyHints.length > 128) state.keyHints.splice(0, state.keyHints.length - 128);
}

function updateKeyHints(keys) {
  if (!keys || typeof keys !== "object") return;
  let slots = null;
  if (Array.isArray(keys)) slots = keys;
  else if (Array.isArray(keys.maniaKeys)) slots = keys.maniaKeys;
  else if (keys.k1 || keys.k2 || keys.m1 || keys.m2) slots = [keys.k1, keys.k2, keys.m1, keys.m2];
  if (!slots || !slots.length) return;
  if (Array.isArray(keys) || Array.isArray(keys.maniaKeys)) {
    state.keyHintSlotCount = slots.length;
    for (let i = 0; i < slots.length; i++) state.keyHintExposed[i] = true;
  } else if (state.keyHintSlotCount === 0) {
    state.keyHintSlotCount = 4;
    state.keyHintExposed = [true, true, true, false];
  }
  while (state.keyHintPressed.length < slots.length) {
    state.keyHintPressed.push(false);
    state.keyHintCounts.push(0);
  }
  for (let i = 0; i < slots.length; i++) {
    const btn = slots[i];
    if (!btn || typeof btn !== "object") continue;
    const pressed = !!btn.isPressed;
    const count = num(btn.count, 0);
    if (count > state.keyHintCounts[i]) {
      const delta = Math.min(16, count - state.keyHintCounts[i]);
      for (let d = 0; d < delta; d++) pushKeyHint(i, "press");
      state.keyHintExposed[i] = true;
      state.keyHintSeen = true;
    } else if (pressed && !state.keyHintPressed[i]) {
      pushKeyHint(i, "press");
      state.keyHintExposed[i] = true;
      state.keyHintSeen = true;
    }
    if (!pressed && state.keyHintPressed[i]) pushKeyHint(i, "release");
    state.keyHintPressed[i] = pressed;
    state.keyHintCounts[i] = count;
  }
  if (state.keyHintSeen && !state.keyHintLogged) {
    state.keyHintLogged = true;
    console.info(`[ManiaReplayMaster] tosu precise keys: column hints active (${state.keyHintSlotCount} slots)`);
  }
}

function consumeError(e, pressTime) {
  const map = state.beatmap;
  const pts = state.points;
  const w = state.windows;
  if (!map || !pts || !w || !w.length) return;
  const missW = w[w.length - 1];
  const now = renderTime();
  const implied = now - e;
  while (state.keyHints.length) {
    const hint = state.keyHints[0];
    if (now - hint.at > 300) {
      state.keyHints.shift();
      continue;
    }
    const list = state.columnPoints[hint.column];
    let best = -1;
    let bestDist = Infinity;
    const wantEnd = hint.kind === "release";
    if (list) {
      for (const i of list) {
        const p = pts[i];
        if (!!p.end !== wantEnd || p.matched) continue;
        const dist = Math.abs(p.time - implied);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      }
    }
    state.keyHints.shift();
    if (best >= 0 && bestDist <= missW) {
      matchPoint(pts[best], e, missW + 60);
      return;
    }
  }
  // Only use the "unexposed column" elimination once a real per-column hint has been
  // observed. tosu keeps reporting four key slots for stable mania even when all counts
  // stay 0, so without this guard the plugin treats columns 0-2 as "known" forever and
  // forces ambiguous hitErrors onto the one slot it thinks is hidden.
  if (state.keyHintSeen) {
    const candidates = [];
    for (let c = 0; c < map.keys; c++) {
      if (c < state.keyHintSlotCount && state.keyHintExposed[c]) continue;
      const list = state.columnPoints[c];
      if (!list) continue;
      let best = -1;
      let bestDist = Infinity;
      for (const i of list) {
        const p = pts[i];
        if (p.matched || p.end) continue;
        const dist = Math.abs(p.time - implied);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      }
      if (best >= 0 && bestDist <= missW) candidates.push({ i: best, dist: bestDist });
    }
    if (candidates.length === 1) {
      matchPoint(pts[candidates[0].i], e, missW + 60);
      return;
    }
  }
  processError(e, pressTime);
}

function hitsAvailable() {
  return !!state.hits && gameHitsTotal() > 0;
}

function canMarkMiss() {
  if (!hitsAvailable()) return true;
  return state.markedMiss < num(state.hits["0"], 0);
}

function markCandidateMiss(idx) {
  const pts = state.points;
  const p = pts[idx];
  if (!p || !state.beatmap || !state.beatmap.notes || !state.beatmap.notes[p.note]) return false;
  markPointMiss(p);
  state.markedMiss += 1;
  let sf = state.searchFrom;
  while (sf < pts.length && pts[sf].matched) sf++;
  state.searchFrom = sf;
  return true;
}

function consumeMissSkips() {
  if (!hitsAvailable()) return;
  const pts = state.points || [];
  const now = renderTime();
  let guard = 0;
  while (canMarkMiss() && guard < 100) {
    let idx = -1;
    for (let i = state.searchFrom; i < pts.length; i++) {
      const p = pts[i];
      if (p.matched) continue;
      if (p.time < state.backfillFloor) continue;
      // A stale miss counter (counters can lag the note stream, especially right after a
      // restart) must never burn notes that have not even been reached yet.
      if (p.time > now + 60) return;
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
  // Small grace: the game's own hitErrors arrive one poll (10ms) late, and a delayed
  // key event can still claim a note right around the window edge.
  const missGrace = 30;
  for (let i = state.sweepFrom; i < pts.length; i++) {
    const p = pts[i];
    if (p.time > t - missW - missGrace) break;
    if (p.matched) continue;
    const n = map.notes[p.note];
    if (!state.scoreV2 && n.hold && !p.end) continue;
    if (!canMarkMiss()) break;
    markPointMiss(p);
    state.markedMiss += 1;
  }
  let sf = state.sweepFrom;
  while (sf < pts.length && pts[sf].matched) sf++;
  state.sweepFrom = sf;
}

const runMemory = new Map();
const RUN_VERSION = 5; // bumped in 0.5.4: the exact judgement model changed, old cached runs must not be reused
const RUN_MEMORY_LIMIT = 60;

function trimRunMemory() {
  while (runMemory.size > RUN_MEMORY_LIMIT) {
    const oldest = runMemory.keys().next().value;
    if (oldest === undefined) break;
    runMemory.delete(oldest);
  }
}

function pruneStoredRuns() {
  const keys = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith("mrm.run.")) keys.push(key);
    }
  } catch {
    return;
  }
  // Drop whole keys from the oldest side (by run timestamp) instead of blindly
  // deleting the first half of the key list, which may hold the freshest runs.
  const entries = [];
  for (const key of keys) {
    let runs = [];
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || "null");
      runs = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.matches) ? [parsed] : [];
    } catch {
      runs = [];
    }
    for (const run of runs) entries.push({ key, ts: num(run && run.ts, 0) });
  }
  entries.sort((a, b) => b.ts - a.ts);
  const dropKeys = new Set(entries.slice(30).map((x) => x.key));
  for (const key of dropKeys) {
    try {
      localStorage.removeItem(key);
    } catch {
    }
  }
}

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
  const now = Date.now();
  if (!complete && state.lastRunSaveAt && now - state.lastRunSaveAt < 5000) return;
  state.lastRunSaveAt = now;
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
  trimRunMemory();
  try {
    localStorage.setItem(key, JSON.stringify(trimmed));
  } catch {
    pruneStoredRuns();
    try {
      localStorage.setItem(key, JSON.stringify(trimmed));
    } catch {
    }
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
  if (!state.pendingApply || state.liveActive) return false;
  const mode = analysisMode();
  if (mode === "Live") return false;
  if (mode !== "Replay" && !state.replayUi) return false;
  if (!state.beatmap || !state.points || !state.points.length) return false;
  if (state.statCount > 0) return false;
  const run = pickRun(state.runPrefix);
  if (!run) return false;
  state.pendingApply = false;
  return applyRun(run);
}

function helperBase() {
  const url = String(settings.helperUrl || "").trim().replace(/\/+$/, "");
  if (!url) return "";
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(url) ? url : "";
}

function helperEndpoint(pathWithQuery) {
  const base = helperBase();
  if (!base) return "";
  const token = String(settings.helperToken || "").trim();
  if (!token) return `${base}${pathWithQuery}`;
  return `${base}${pathWithQuery}${pathWithQuery.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

function helperFetch(url, ms) {
  if (typeof AbortController !== "function") return fetch(url, { cache: "no-store" });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { cache: "no-store", signal: controller.signal }).finally(() => clearTimeout(timer));
}

function fitExactOffset(notes, keys, actions) {
  const cols = Array.from({ length: keys }, () => []);
  for (const n of notes) {
    if (n.column >= 0 && n.column < keys) cols[n.column].push(n.time);
  }
  const dist = (arr, t) => {
    if (!arr.length) return Infinity;
    let lo = 0;
    let hi = arr.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    let best = Math.abs(arr[lo] - t);
    if (lo > 0) best = Math.min(best, Math.abs(arr[lo - 1] - t));
    return best;
  };
  const sample = actions.filter((_, i) => i % 3 === 0);
  const soft = (off) => {
    let s = 0;
    for (const a of sample) {
      const d = dist(cols[a.column], a.time + off);
      if (d <= 15) s += (15 - d) / 15;
    }
    return s;
  };
  // The +-12s scan is a coarse first guess only: a 4x thinner sample finds the same peak
  // while keeping map starts cheap (it used to run 961 full scoring passes).
  const coarseStride = Math.max(3, Math.round(actions.length / 100));
  const coarseSample = actions.filter((_, i) => i % coarseStride === 0);
  const coarseSoft = (off) => {
    let s = 0;
    for (const a of coarseSample) {
      const d = dist(cols[a.column], a.time + off);
      if (d <= 15) s += (15 - d) / 15;
    }
    return s;
  };
  const hard = (off) => {
    let hits = 0;
    for (const a of sample) if (dist(cols[a.column], a.time + off) <= 15) hits += 1;
    return hits;
  };
  // hard*1000 + soft in a single pass (the refine scan used to walk the sample twice).
  const score = (off) => {
    let hits = 0;
    let s = 0;
    for (const a of sample) {
      const d = dist(cols[a.column], a.time + off);
      if (d <= 15) {
        hits += 1;
        s += (15 - d) / 15;
      }
    }
    return hits * 1000 + s;
  };
  let bestOff = 0;
  let bestScore = -1;
  for (let off = -12000; off <= 12000; off += 25) {
    const s = coarseSoft(off);
    if (s > bestScore) {
      bestScore = s;
      bestOff = off;
    }
  }
  const coarse = bestOff;
  bestScore = -1;
  for (let off = coarse - 40; off <= coarse + 40; off += 1) {
    const s = score(off);
    if (s > bestScore) {
      bestScore = s;
      bestOff = off;
    }
  }
  return bestOff;
}

// Replay judging model ported from Mania-Replay-Master (Keytoyze, Apache-2.0).
// It matches osu!stable's own replay re-judging closely, including the
// ScoreV2 long-note rules (head + tail judged separately, tail downgraded to
// MEH when the head is missing/missed, "hold too long" too-late detection).
const J_EARLY = -1;
const J_HIT = 0;
const J_HIT_AGAIN = 1;
const J_LATE = 2;

// stable judges in real time, so in song time the effective window scales with the
// playback rate (HT 0.75 -> x0.75, DT 1.5 -> x1.5). The live path already applied this
// in localWindows(); the replay path used to skip it, which inflated impossible-perfect
// notes on HT/DT replays (measured: HT V1 L1 776 -> 44 against the game counts).
function scaleReplayWindows(w) {
  const rate = state.modsRate || 1;
  if (rate === 1) return w;
  return w.map((v) => v * rate);
}

function replayWindowTable(scoreV2) {
  const od = clamp(state.odConverted > 0 ? state.odConverted : state.od, 0, 10);
  const mods = num(state.modsNumber, 0);
  const hr = (mods & (1 << 4)) !== 0;
  const ez = (mods & (1 << 1)) !== 0;
  if (scoreV2) {
    const diff = hr ? Math.min(10, od * 1.4) : ez ? Math.max(0, od / 2) : od;
    const range = (min, mid, max) => {
      const v = diff > 5 ? mid + ((max - mid) * (diff - 5)) / 5 : diff < 5 ? mid - ((mid - min) * (5 - diff)) / 5 : mid;
      return Math.trunc(v);
    };
    return scaleReplayWindows([
      range(22.4, 19.4, 13.9),
      range(64, 49, 34),
      range(97, 82, 67),
      range(127, 112, 97),
      range(151, 136, 121),
      range(188, 173, 158)
    ]);
  }
  const modeRate = hr ? 1 / 1.4 : ez ? 1.4 : 1;
  return scaleReplayWindows([16, 34, 67, 97, 121, 158].map((d, i) => Math.trunc((i === 0 ? d : d + 3 * (10 - od)) * modeRate)));
}

function getJudgementClass(diff, w) {
  for (let i = 0; i < w.length - 1; i++) if (diff <= w[i]) return i;
  return -1;
}

function judgeRelease(action, targetIdx, notes, results, w, scoreV2, judged) {
  const note = notes[targetIdx];
  const res = results[targetIdx];
  const endDiff = Math.abs(action.endTime - note.endTime);
  const signed = action.endTime - note.endTime;
  let endJ = signed <= w[3] * 1.5 ? getJudgementClass(endDiff / 1.5, w) : -1;
  if (judged[targetIdx] || res.start === -1 || res.start === 5) {
    if (endJ >= 0 && endJ <= 3) endJ = 4;
  }
  res.end = endJ;
  res.actionEnd = action.index;
  res.endErr = action.endTime - note.endTime;
  let startDiff = Math.abs(action.time - note.time);
  if (note.time - w[4] > action.time) startDiff = Math.abs(note.time - (note.endTime - 1));
  const totalDiff = startDiff + endDiff;
  let total;
  let canAgain;
  if (action.endTime - note.endTime < -w[4]) {
    total = -1;
    canAgain = true;
  } else {
    canAgain = false;
    const ok = (j, rate) => startDiff <= w[j] * rate && totalDiff <= w[j] * rate * 2;
    total = ok(0, 1.2) ? 0 : ok(1, 1.1) ? 1 : ok(2, 1) ? 2 : ok(3, 1) ? 3 : 4;
  }
  if (judged[targetIdx] && (total === 0 || total === 1)) total = 2;
  judged[targetIdx] = 1;
  res.total = total;
  if (!scoreV2) res.start = total;
  return canAgain;
}

function judgeReplayNotes(notes, actions, w, scoreV2, adjust) {
  const keys = state.beatmap ? state.beatmap.keys : 4;
  const colNotes = Array.from({ length: keys }, () => []);
  const colPos = new Array(notes.length).fill(-1);
  for (let i = 0; i < notes.length; i++) {
    const c = notes[i].column;
    if (!(c >= 0 && c < keys)) continue;
    colPos[i] = colNotes[c].length;
    colNotes[c].push(i);
  }
  const results = notes.map(() => ({ start: -1, end: -1, actionStart: -1, actionEnd: -1, startErr: null, endErr: null, total: -1 }));
  const dead = new Uint8Array(notes.length);
  const cannot = new Uint8Array(notes.length);
  const judged = new Uint8Array(notes.length);
  const cursor = new Int32Array(keys);
  const canHit = (action, idx) => {
    const note = notes[idx];
    if (action.column !== note.column) return -1;
    const diff = action.time - note.time;
    if (-diff > w[5]) return J_EARLY;
    const hold = note.endTime > note.time;
    if (!hold) return diff >= w[3] ? J_LATE : J_HIT;
    const v2Scale = scoreV2 ? 1.5 : 1;
    let isTooLate = action.time - note.endTime > w[3] * v2Scale;
    if (adjust) {
      const list = colNotes[note.column];
      const pos = colPos[idx];
      const nextIdx = pos >= 0 && pos + 1 < list.length ? list[pos + 1] : -1;
      if (nextIdx >= 0) {
        const next = notes[nextIdx];
        const nextDiff = next.time - note.time;
        const limit = nextDiff < w[4] ? next.time - 1 : nextDiff > w[4] * 2 ? next.time - w[4] : note.time + w[4];
        isTooLate = action.time > limit;
      }
    }
    if (isTooLate) return J_LATE;
    for (let j = action.index - 1; j >= 0; j--) {
      const another = actions[j];
      if (another.column !== action.column) continue;
      const endTime = another.endTime;
      if (endTime < note.endTime - w[4]) break;
      const rel = another.related >= 0 ? notes[another.related] : null;
      const isHoldTooLong = endTime > (rel ? rel.endTime : 0) + w[3] * v2Scale;
      if (!isHoldTooLong && rel) continue;
      if (endTime < note.endTime + w[3] * v2Scale && endTime > note.time + w[4]) return J_LATE;
    }
    return J_HIT_AGAIN;
  };
  for (const action of actions) {
    const list = colNotes[action.column];
    if (!list) continue;
    let c = cursor[action.column];
    let target = -1;
    while (c < list.length) {
      const idx = list[c];
      if (dead[idx]) {
        c += 1;
        continue;
      }
      const r = canHit(action, idx);
      if (r === J_EARLY) break;
      if (r === J_LATE || cannot[idx]) {
        dead[idx] = 1;
        c += 1;
        continue;
      }
      target = idx;
      if (r !== J_HIT_AGAIN) {
        dead[idx] = 1;
        c += 1;
      }
      break;
    }
    cursor[action.column] = c;
    if (target < 0) continue;
    const note = notes[target];
    const res = results[target];
    const judgement = getJudgementClass(Math.abs(action.time - note.time), w);
    if (res.start === -1) res.start = judgement;
    action.related = target;
    res.actionStart = action.index;
    res.startErr = action.time - note.time;
    if (note.endTime > note.time) {
      const canAgain = judgeRelease(action, target, notes, results, w, scoreV2, judged);
      if (!canAgain) cannot[target] = 1;
    }
  }
  return results;
}

function replayJudgementCounts(notes, results, scoreV2) {
  const counts = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < notes.length; i++) {
    const r = results[i];
    counts[r.start < 0 || r.start > 5 ? 5 : r.start] += 1;
    if (scoreV2 && notes[i].endTime > notes[i].time) {
      counts[r.end < 0 || r.end > 5 ? 5 : r.end] += 1;
    }
  }
  return counts;
}

function osrCountsToClasses(counts) {
  if (!Array.isArray(counts) || counts.length < 6) return null;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return [n(counts[3]), n(counts[0]), n(counts[4]), n(counts[1]), n(counts[2]), n(counts[5])];
}

// The helper decodes .osr frame times on a clock that runs ~2.6s ahead of the
// beatmap clock, so the offset must be recovered from the data. fitExactOffset
// gives a coarse estimate; when the replay's own hit counts are available we
// refine it by minimizing the count mismatch against them.
function exactOffsetFor(actions) {
  const map = state.beatmap;
  if (!map || !map.notes) return 0;
  const fit = fitExactOffset(map.notes, map.keys, actions);
  const target = osrCountsToClasses(state.exactCounts);
  if (!target) return fit;
  const sv2 = !!state.scoreV2;
  const w = replayWindowTable(sv2);
  const sorted = actions
    .map((a, i) => ({ column: a.column, time: a.time, endTime: a.endTime, index: i, related: -1 }))
    .filter((a) => Number.isFinite(a.time) && Number.isFinite(a.endTime) && Number.isInteger(a.column) && a.column >= 0 && a.column < map.keys)
    .sort((x, y) => x.time - y.time);
  if (!sorted.length) return fit;
  for (let i = 0; i < sorted.length; i++) sorted[i].index = i;
  const evaluate = (off) => {
    const acts = sorted.map((a) => ({ column: a.column, time: a.time + off, endTime: a.endTime + off, index: a.index, related: -1 }));
    const res = judgeReplayNotes(map.notes, acts, w, sv2, true);
    const counts = replayJudgementCounts(map.notes, res, sv2);
    let l1 = 0;
    for (let i = 0; i < counts.length; i++) l1 += Math.abs(counts[i] - target[i]);
    return l1;
  };
  let best = fit;
  let bestL1 = Infinity;
  // Coarse pass (5ms steps) then refine ±4ms around the winner: same result for every
  // offset that a 1ms scan could pick, but ~5x fewer full re-judgements (161 -> 33).
  for (let off = fit - 40; off <= fit + 40; off += 8) {
    const l1 = evaluate(off);
    if (l1 < bestL1 || (l1 === bestL1 && Math.abs(off - fit) < Math.abs(best - fit))) {
      bestL1 = l1;
      best = off;
    }
  }
  const coarse = best;
  for (let off = coarse - 7; off <= coarse + 7; off += 1) {
    if (off === coarse) continue;
    const l1 = evaluate(off);
    if (l1 < bestL1 || (l1 === bestL1 && Math.abs(off - fit) < Math.abs(best - fit))) {
      bestL1 = l1;
      best = off;
    }
  }
  return best;
}

function applyExactTimeline(actions, offset) {
  const map = state.beatmap;
  const pts = state.points;
  if (!map || !pts || !pts.length || !actions || !actions.length) return false;
  resetJudgements();
  const w = replayWindowTable(!!state.scoreV2);
  const sorted = actions
    .map((a, i) => ({ column: a.column, time: a.time + offset, endTime: a.endTime + offset, index: i, related: -1 }))
    .filter((a) => Number.isFinite(a.time) && Number.isFinite(a.endTime) && Number.isInteger(a.column) && a.column >= 0 && a.column < map.keys)
    .sort((x, y) => x.time - y.time);
  if (!sorted.length) return false;
  for (let i = 0; i < sorted.length; i++) sorted[i].index = i;
  const results = judgeReplayNotes(map.notes, sorted, w, !!state.scoreV2, true);
  let lastT = -Infinity;
  for (const a of sorted) if (a.time > lastT) lastT = a.time;
  let misses = 0;
  let statCount = 0;
  let sum = 0;
  let sq = 0;
  for (let i = 0; i < map.notes.length; i++) {
    const n = map.notes[i];
    const r = results[i];
    const np = state.notePoints[i];
    const ns = state.noteState[i];
    if (!np || !ns) continue;
    if (r.start === -1) {
      for (const p of [np.head, np.tail]) {
        if (!p) continue;
        p.matched = true;
        p.j = -1;
        p.e = null;
        p.at = p.time;
      }
      ns.head = -1;
      if (n.hold) ns.tail = -1;
      misses += 1;
      continue;
    }
    const startErr = Number.isFinite(r.startErr) ? r.startErr : 0;
    if (np.head) {
      np.head.matched = true;
      np.head.j = r.start;
      np.head.e = startErr;
      np.head.at = np.head.time + startErr;
      statCount += 1;
      sum += startErr;
      sq += startErr * startErr;
    }
    ns.head = r.start;
    if (n.hold && np.tail) {
      // V1 keeps one combined judgement for the whole long note (like stable
      // and like the reference renderer); V2 keeps head and tail apart.
      const tailJ = state.scoreV2 ? (r.end === -1 ? -1 : r.end) : r.start;
      const tailErr = Number.isFinite(r.endErr) ? r.endErr : startErr;
      np.tail.matched = true;
      np.tail.j = tailJ;
      np.tail.e = tailErr;
      np.tail.at = np.tail.time + tailErr;
      ns.tail = tailJ;
      statCount += 1;
      sum += tailErr;
      sq += tailErr * tailErr;
    }
  }
  state.markedMiss = misses;
  state.statCount = statCount;
  state.errorSum = sum;
  state.errorSq = sq;
  state.errorCount = statCount;
  state.searchFrom = pts.length;
  state.sweepFrom = pts.length;
  state.pendingApply = false;
  const lastNote = map.notes.length ? map.notes[map.notes.length - 1] : null;
  const complete = !!lastNote && Number.isFinite(lastT) && lastT >= lastNote.endTime - 1000;
  saveRun(complete);
  state.cached = true;
  state.cachedErrors = [];
  state.cacheChecked = 0;
  state.exactApplied = true;
  return true;
}

function applyExactData() {
  if (state.exactApplied || !state.exactActions || !state.beatmap || !state.points) return false;
  if (state.gameState !== "play") return false;
  const mode = analysisMode();
  if (mode === "Live") return false;
  if (state.liveActive) return false;
  if (mode === "Auto" && !exactReplayReady()) return false;
  try {
    const offset = exactOffsetFor(state.exactActions);
    return applyExactTimeline(state.exactActions, offset);
  } catch (err) {
    console.error("[ManiaReplayMaster] exact replay failed:", err);
    clearExactState();
    return false;
  }
}

function exactReplayReady() {
  if (state.liveActive) return false;
  const notes = state.beatmap && state.beatmap.notes;
  const first = notes && notes.length ? notes[0].time : 0;
  if (renderTime() < first + 1000) return false;
  // Only Auto mode has to wait for the keyboard hook: an explicit Replay mode should keep
  // using the .osr even when the hook could not start.
  if (analysisMode() === "Auto" && settings.exactLive && state.liveSource && state.liveSource.readyState === 1 && !state.liveReady) return false;
  return true;
}

async function maybeExact() {
  const base = helperBase();
  if (!base || !settings.exactReplay) return;
  if (analysisMode() === "Live") return;
  if (state.exactApplied || state.exactFetching) return;
  if (state.gameState !== "play") return;
  if (state.liveActive) return;
  if (!state.checksum || !state.beatmap || !state.points) return;
  const key = `${state.checksum}.${state.beatmap.keys}`;
  if (state.exactKey === key) {
    applyExactData();
    return;
  }
  if (performance.now() < state.exactRetryAt) return;
  state.exactFetching = true;
  const token = state.loadToken;
  let found = null;
  let foundCounts = null;
  let ok = false;
  try {
    const res = await helperFetch(helperEndpoint(`/replay?md5=${state.checksum}&keys=${state.beatmap.keys}`), 3000);
    const data = await res.json();
    if (data && data.found && Array.isArray(data.actions)) {
      found = data.actions;
      foundCounts = Array.isArray(data.counts) ? data.counts : null;
    }
    ok = true;
  } catch {
    ok = false;
  }
  state.exactFetching = false;
  if (token !== state.loadToken) return;
  if (ok) state.helperState = "ready";
  if (ok && found) {
    state.exactKey = key;
    state.exactActions = found;
    state.exactCounts = foundCounts;
    applyExactData();
  } else {
    state.exactRetryAt = performance.now() + 5000;
  }
}

function closeLive() {
  if (state.liveSource) {
    try {
      state.liveSource.close();
    } catch {
    }
  }
  state.liveSource = null;
  state.liveKey = "";
  state.liveActive = false;
  state.liveReady = false;
  state.liveAnchorHook = null;
  state.liveAnchorSong = 0;
  state.livePending.length = 0;
  state.liveRecentErrors.length = 0;
  state.liveErrorCount = 0;
  state.liveBias = 0;
  state.helperState = "off";
}

function clearExactState() {
  state.exactApplied = false;
  state.exactKey = "";
  state.exactActions = null;
  state.exactCounts = null;
  state.exactFetching = false;
  state.exactRetryAt = 0;
}

function clearReplayRun() {
  clearExactState();
  state.cached = false;
  state.cachedErrors = null;
  state.cacheChecked = 0;
  state.pendingApply = false;
}

function resetExactRun() {
  clearReplayRun();
  closeLive();
}

function liveMissWindow() {
  const w = state.windows || localWindows();
  return w && w.length ? w[w.length - 1] : 0;
}

// Live matching: same "earliest still-valid note in the lane" rule as the client,
// but with full window checks on both sides. Points that are already past the miss
// window are consumed as misses (the client does the same), so a lane cannot be
// blocked by a stale note.
function lockLivePoint(column, t, wantEnd) {
  const list = state.columnPoints && state.columnPoints[column];
  const pts = state.points;
  if (!list || !pts) return -1;
  const missW = liveMissWindow();
  const nps = state.notePoints;
  for (const i of list) {
    const p = pts[i];
    if (!!p.end !== wantEnd) continue;
    if (p.matched) continue;
    if (wantEnd) {
      // A tail is only valid once its head was really claimed. V1 additionally requires a
      // real judgement (j >= 0): a head merely queued as miss cannot start an LN.
      const np = nps && nps[p.note];
      if (!np || !np.head || !np.head.matched) continue;
      if (!state.scoreV2 && np.head.j < 0) continue;
    }
    if (p.time - t > missW) return -1;
    if (t - p.time > missW) {
      markPointMiss(p);
      state.markedMiss += 1;
      continue;
    }
    return i;
  }
  return -1;
}

function applyLiveKey(column, t, down) {
  const w = state.windows || localWindows();
  if (!state.points || !w || !w.length) return;
  const best = lockLivePoint(column, t, !down);
  if (best < 0) return;
  const point = state.points[best];
  const e = t - point.time;
  applyMatch(point, e);
  {
    const now = performance.now();
    const implied = renderTime();
    let matched = -1;
    let bestDist = Infinity;
    for (let i = 0; i < state.liveRecentErrors.length; i++) {
      const entry = state.liveRecentErrors[i];
      if (now - entry.at > 300) continue;
      const dist = Math.abs(point.time - (implied - entry.e));
      if (dist < bestDist) {
        bestDist = dist;
        matched = i;
      }
    }
    if (matched >= 0 && bestDist <= 250) {
      const eGame = state.liveRecentErrors[matched].e;
      state.liveRecentErrors.splice(matched, 1);
      correctMatch(point, eGame);
      return;
    }
    state.livePending.push({ point, e, at: now });
    if (state.livePending.length > 64) state.livePending.shift();
  }
}

function applyLiveCorrections(arr) {
  if (!Array.isArray(arr)) return;
  if (arr.length < state.liveErrorCount) {
    state.liveErrorCount = 0;
    state.livePending.length = 0;
  }
  for (let i = state.liveErrorCount; i < arr.length; i++) correctLiveError(arr[i]);
  state.liveErrorCount = arr.length;
}

function correctLiveError(eGame) {
  const now = performance.now();
  const implied = renderTime() - eGame;
  let best = null;
  let bestIdx = -1;
  let bestScore = Infinity;
  // Partner the game's error with the claim whose implied press time matches best.
  // Press order is only a tie-breaker: the hook can mis-claim when a lane is dense,
  // and a pure FIFO pairing would then shift every later error onto the wrong note.
  for (let i = 0; i < state.livePending.length; i++) {
    const entry = state.livePending[i];
    if (now - entry.at > 400) continue;
    const timeDist = Math.abs(entry.point.time - implied);
    if (timeDist > 250) continue;
    const errDist = Math.abs(entry.e - eGame);
    if (errDist > 150) continue;
    const score = errDist + timeDist * 0.25;
    if (score < bestScore) {
      bestScore = score;
      best = entry;
      bestIdx = i;
    }
  }
  if (!best) {
    let nearest = Infinity;
    for (let i = 0; i < state.livePending.length; i++) {
      const entry = state.livePending[i];
      if (now - entry.at > 400) continue;
      if (Math.abs(entry.point.time - implied) > 300) continue;
      const score = Math.abs(entry.e - eGame);
      if (score < nearest) {
        nearest = score;
        best = entry;
        bestIdx = i;
      }
    }
  }
  if (!best) {
    state.liveRecentErrors.push({ e: eGame, at: now });
    if (state.liveRecentErrors.length > 16) state.liveRecentErrors.shift();
    return;
  }
  state.livePending.splice(bestIdx, 1);
  const delta = best.e - eGame;
  if (Math.abs(delta) < 200) state.liveBias = clamp(state.liveBias * 0.8 + delta * 0.2, -150, 150);
  correctMatch(best.point, eGame);
}

function correctMatch(point, eGame) {
  const oldE = point.e;
  if (!Number.isFinite(oldE) || oldE === eGame) return;
  state.errorSum += eGame - oldE;
  state.errorSq += eGame * eGame - oldE * oldE;
  point.e = eGame;
  point.j = state.scoreV2 && point.end ? classifyV2Tail(point.note, eGame) : classifyError(eGame);
  point.at = point.time + eGame;
  const ns = state.noteState[point.note];
  if (ns) {
    if (point.end) {
      if (state.scoreV2) ns.tail = point.j;
    } else {
      ns.head = point.j;
    }
  }
  if (state.scoreV2 && !point.end) refreshV2Tail(point.note);
  if (!state.scoreV2) settleV1LongNote(point.note);
}

function hookSongTime(hookT) {
  const h = Number(hookT);
  if (!Number.isFinite(h)) return renderTime();
  const rate = clamp(state.modsRate || state.timeSpeed || 1, 0.5, 2);
  const measured = renderTime();
  const anchor = state.liveAnchorHook;
  let t = measured;
  if (anchor !== null && h > anchor && h - anchor <= 750) {
    t = state.liveAnchorSong + (h - anchor) * rate;
    if (Math.abs(measured - t) > 120) t = measured;
  }
  state.liveAnchorHook = h;
  state.liveAnchorSong = t;
  return t - state.liveBias;
}

function ensureLive() {
  if (!settings.exactLive || state.liveSource) return;
  if (analysisMode() === "Replay") return;
  if (typeof EventSource === "undefined") return;
  const base = helperBase();
  if (!base || state.gameState !== "play" || !state.beatmap || !state.points) return;
  const key = `${state.checksum}.${state.beatmap.keys}`;
  if (state.liveKey === key) return;
  state.helperState = "connecting";
  let source = null;
  try {
    source = new EventSource(helperEndpoint(`/live?keys=${state.beatmap.keys}`));
  } catch (err) {
    console.warn("[ManiaReplayMaster] helper hook unavailable:", (err && err.message) || err);
    state.helperState = "error";
    state.liveKey = "";
    return;
  }
  state.liveKey = key;
  state.liveSource = source;
  let warned = false;
  source.onmessage = (ev) => {
    let msg = null;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg && msg.type === "hello") {
      state.helperState = "ready";
      state.helperLayout = String(msg.layout || "");
      state.helperHookError = String(msg.error || "");
      state.liveReady = !!msg.hook;
      if (msg.hook) console.info(`[ManiaReplayMaster] hook layout: ${state.helperLayout} (${msg.from || "?"})`);
      else console.warn(`[ManiaReplayMaster] helper hook unavailable: ${state.helperHookError || "unknown error"}`);
      return;
    }
    if (msg && msg.type === "error") {
      state.helperHookError = String(msg.message || "helper error");
      state.liveReady = false;
      console.warn(`[ManiaReplayMaster] helper error: ${state.helperHookError}`);
      return;
    }
    if (msg && msg.type === "hookexit") {
      state.liveReady = false;
      state.liveActive = false;
      state.helperState = "error";
      console.warn("[ManiaReplayMaster] keyboard hook exited");
      return;
    }
    if (!msg || msg.type !== "key") return;
    if (state.gameState !== "play") return;
    if (analysisMode() === "Replay") return;
    if (state.exactApplied) {
      if (analysisMode() !== "Auto") return;
      clearReplayRun();
    }
    if (!state.liveActive) {
      state.liveActive = true;
      resetJudgements();
    }
    applyLiveKey(msg.column, hookSongTime(msg.t), !!msg.down);
  };
  source.onerror = () => {
    state.helperState = "error";
    if (warned) return;
    warned = true;
    console.warn("[ManiaReplayMaster] helper stream error - start tools/mrm-helper.mjs (see README)");
  };
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
    const listUrl = `${location.protocol}//${host}/files/beatmap/${encodeURIComponent(folderName)}/`;
    let html = "";
    try {
      const response = await fetchWithTimeout(listUrl, 4000);
      if (!response.ok) continue;
      html = await response.text();
    } catch {
      continue;
    }
    const actualName = findListedBeatmapFile(html, fileName);
    if (!actualName) continue;
    const fileUrl = `${location.protocol}//${host}/files/beatmap/${encodeURIComponent(folderName)}/${encodeURIComponent(actualName)}`;
    try {
      const response = await fetchWithTimeout(fileUrl, 4000);
      if (!response.ok) continue;
      const text = await response.text();
      if (text && text.includes("osu file format")) return text;
    } catch {
      continue;
    }
  }
  return null;
}

function fetchWithTimeout(url, ms, opts) {
  const options = Object.assign({ cache: "no-store" }, opts || {});
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return fetch(url, Object.assign({}, options, { signal: AbortSignal.timeout(ms) }));
  }
  if (typeof AbortController === "function") {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return fetch(url, Object.assign({}, options, { signal: controller.signal })).finally(() => clearTimeout(timer));
  }
  return fetch(url, options);
}

async function fetchBeatmapText() {
  let primaryError = "";
  try {
    const response = await fetchWithTimeout("/files/beatmap/file", 5000);
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
    maybeExact();
    ensureLive();
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
  const modeBefore = analysisMode();
  const exactLiveBefore = !!settings.exactLive;
  for (const [key, value] of Object.entries(message)) {
    if (!Object.prototype.hasOwnProperty.call(settings, key)) continue;
    let next = value;
    if (typeof settings[key] === "number") next = Number(value);
    else if (typeof settings[key] === "boolean") next = typeof value === "string" ? value === "true" : Boolean(value);
    if (settings[key] === next || Number.isNaN(next)) continue;
    settings[key] = next;
  }
  if (modeBefore === analysisMode() && exactLiveBefore === !!settings.exactLive) return;
  // Switching the judgement source mid-play leaves both pipelines half-applied (live keys
  // ignored under exact, replay ignored under live). Drop whatever the previous mode set up.
  const modeAfter = analysisMode();
  if (!settings.exactLive || modeAfter === "Replay") closeLive();
  if (modeAfter === "Live" && state.exactApplied) clearReplayRun();
  state.pendingApply = false;
  state.runPrefix = [];
  state.cached = false;
  state.cachedErrors = null;
  state.cacheChecked = 0;
  resetJudgements();
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
  // The scroll mapping changed (reviewTime / scroll speed), so the visible-window cursor
  // is stale: notes that already passed the hit line can be back inside the visible range.
  renderCache.cursor = 0;
  renderCache.cursorTime = -Infinity;
  renderCache.cursorMap = null;
  return scroll;
}

function visibleStartIndex(map, scroll, now, t, hitPos) {
  const notes = map.notes;
  if (renderCache.cursorMap !== map || t < renderCache.cursorTime - 32) {
    renderCache.cursorMap = map;
    renderCache.cursor = 0;
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
  for (let y = bottom - h; y > top - h; y -= h * 2) {
    ctx.fillRect(cx - h / 2, y, h, h);
  }
}

function unstableRate(t) {
  let n = state.statCount;
  let sum = state.errorSum;
  let sq = state.errorSq;
  const exactMode = t !== undefined && (state.cached || state.exactApplied) && !!state.points;
  // The exact path scans every point; reuse the result until the song clock reaches the
  // next 250ms bucket instead of rescanning on every frame.
  const cacheKey = `${state.cached ? 1 : 0}${state.exactApplied ? 1 : 0}|${state.statCount}|${Math.floor(num(t, 0) / 250)}`;
  if (exactMode && state.urCache && state.urCache.key === cacheKey) return state.urCache.value;
  if (exactMode) {
    n = 0;
    sum = 0;
    sq = 0;
    const map = state.beatmap;
    for (const p of state.points) {
      if (!p.matched || p.e === null || p.at > t) continue;
      // V1 scores a long note once: its head and tail points carry the same merged judgement.
      if (!state.scoreV2 && p.end && map && map.notes[p.note] && map.notes[p.note].hold) continue;
      n += 1;
      sum += p.e;
      sq += p.e * p.e;
    }
  }
  let ur = 0;
  if (n >= 2) {
    const mean = sum / n;
    const variance = Math.max(0, sq / n - mean * mean);
    ur = Math.sqrt(variance) * 10;
    if (state.modsRate && state.modsRate !== 1) ur /= state.modsRate;
  }
  if (exactMode) state.urCache = { key: cacheKey, value: ur };
  return ur;
}

function gameHitsTotal() {
  const h = state.hits;
  if (!h) return 0;
  return num(h.geki, 0) + num(h["300"], 0) + num(h.katu, 0) + num(h["100"], 0) + num(h["50"], 0) + num(h["0"], 0);
}

function pointJudgedAt(p) {
  if (!p) return Infinity;
  return p.matched && p.e !== null ? p.at : p.time;
}

function computedCounts(t) {
  const counts = [0, 0, 0, 0, 0, 0];
  const notes = state.beatmap && state.beatmap.notes;
  const ns = state.noteState;
  const nps = state.notePoints;
  if (!notes || !ns || !nps) return counts;
  const visible = (p) => p && p.matched && (t === undefined || pointJudgedAt(p) <= t);
  for (let i = 0; i < notes.length; i++) {
    const s = ns[i];
    if (!s) continue;
    const np = nps[i];
    if (!np) continue;
    if (notes[i].hold && !state.scoreV2) {
      if (s.head !== null && visible(np.head)) counts[s.head < 0 ? 5 : s.head] += 1;
      continue;
    }
    if (s.head !== null && visible(np.head)) counts[s.head < 0 ? 5 : s.head] += 1;
    if (notes[i].hold && s.tail !== null && visible(np.tail)) counts[s.tail < 0 ? 5 : s.tail] += 1;
  }
  return counts;
}

function countsAccuracy(counts) {
  const weights = state.scoreV2
    ? [305 / 305, 300 / 305, 200 / 305, 100 / 305, 50 / 305, 0]
    : [1, 1, 2 / 3, 1 / 3, 1 / 6, 0];
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return 100;
  let sum = 0;
  for (let i = 0; i < counts.length; i++) sum += counts[i] * weights[i];
  return (sum / total) * 100;
}

function panelStats(t) {
  const h = state.hits;
  if (h && gameHitsTotal() > 0) {
    return {
      counts: [num(h.geki, 0), num(h["300"], 0), num(h.katu, 0), num(h["100"], 0), num(h["50"], 0), num(h["0"], 0)],
      accuracy: state.accuracy
    };
  }
  const counts = computedCounts(t);
  return { counts, accuracy: countsAccuracy(counts) };
}

function drawStats(ctx, opacity, t) {
  const { counts, accuracy } = panelStats(t);
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
  ctx.fillText(`${accuracy.toFixed(2)}%`, x + squareW + 4 * scale, y);
  y += rowH;
  ctx.fillText(`UR ${unstableRate(t).toFixed(0)}`, x + squareW + 4 * scale, y);
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
  const strokeW = Math.max(1, Math.min(12, num(settings.noteStroke, 2)));
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
  if (settings.showStats) drawStats(ctx, opacity, t);
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
  if (state.streamStale) return "tosu stream stalled, waiting for data...";
  if (state.mapMode !== "mania") return "mania only";
  if (!state.beatmap) {
    if (state.loadError) return `beatmap fetch failed: ${state.loadError} (retrying)`;
    return "loading beatmap...";
  }
  if (state.exactApplied) return "exact: replay";
  if (state.liveActive) return state.helperLayout ? `exact: live (${state.helperLayout})` : "exact: live";
  if (helperBase() && (settings.exactReplay || settings.exactLive)) {
    if (state.helperState === "error" || state.helperState === "off") return "exact: helper offline (run tools/mrm-helper.mjs)";
    if (state.helperHookError) return `exact: hook unavailable (${state.helperHookError})`;
    return "exact: waiting";
  }
  return "";
}

function frame() {
  requestAnimationFrame(frame);
  const nowMs = performance.now();
  // A short tosu hiccup must not wipe the judgements on screen: mark the stream stale
  // (rendering freezes on the last sample) and resume as soon as v2 comes back.
  state.streamStale = !!(state.gameState === "play" && state.lastV2At && nowMs - state.lastV2At > 5000);
  // Misses are decided by the song clock, so they must not be throttled by the render fps
  // cap (a fpsLimit of 1 used to delay every miss colour by up to a second).
  if (state.gameState === "play" && state.beatmap && state.beatmap.notes && !state.streamStale) {
    sweepMisses(renderTime());
  }
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
  const rev = `${t.toFixed(3)}|${state.beatmap.keys}|${state.errorCount}|${state.windows ? state.windows.join(",") : ""}|${settings.playfieldOpacity}|${settings.renderScale}|${settings.backgroundOpacity}|${settings.backgroundColor}|${settings.noteHeight}|${settings.noteStroke}|${settings.actionHeight}|${settings.hitPosition}|${settings.hitLineWidth}|${settings.reviewTime}|${settings.statsScale}|${settings.showActions}|${settings.showStats}|${settings.showHitLine}|${settings.colorUnjudged}|${settings.colorLongNote}|${settings.colorPerfect}|${settings.colorGreat}|${settings.colorGood}|${settings.colorOk}|${settings.colorMeh}|${settings.colorMiss}|${settings.maniaScrollSpeedOverride}|${settings.showHitLine}|${state.cached ? 1 : 0}${state.exactApplied ? 1 : 0}|${width}|${height}`;
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
  try {
    ctx.beginPath();
    ctx.rect(0, 0, 480, 480);
    ctx.clip();
    renderScene(ctx, t);
  } catch (err) {
    console.error("[ManiaReplayMaster] render error:", err);
  } finally {
    ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
  }
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
    state.hits = null;
    state.accuracy = 100;
    state.lastLive = NaN;
    resetExactRun();
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
    closeLive();
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
  if (state.gameState === "play" && state.hits) {
    const totalHits =
      num(state.hits.geki, 0) +
      num(state.hits["300"], 0) +
      num(state.hits.katu, 0) +
      num(state.hits["100"], 0) +
      num(state.hits["50"], 0) +
      num(state.hits["0"], 0);
    const score = Number(play.score);
    // ScoreV2 recalculates on every judgement: releasing an LN early re-judges it as a
    // miss and can make play.score go *down* by a few points while a hit was just added.
    // Treating that as "the map restarted" resets every rendered note (the mass revert
    // users see). Only a real restart empties the hit counters, so use those.
    const noteTotal = state.beatmap && Array.isArray(state.beatmap.notes) ? state.beatmap.notes.length : 0;
    const hitsSlack = Math.max(2, Math.round(noteTotal * 0.002));
    const restarted =
      state.lastHitsTotal !== null && totalHits + hitsSlack < state.lastHitsTotal;
    if (restarted) {
      state.runPrefix = [];
      state.pendingApply = false;
      clearExactState();
      resetJudgements();
    }
    state.lastHitsTotal = totalHits;
    if (Number.isFinite(score)) state.lastScore = score;
  }
}

function onV2(data) {
  if (!data) return;
  state.lastV2At = performance.now();
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
    if (state.gameState === "play" && live < state.lastLive - 500) {
      // A live clock going backwards means the map restarted or was seeked: the replay
      // cache no longer describes what the game is judging.
      state.pendingApply = false;
      state.runPrefix = [];
      clearReplayRun();
      resetJudgements();
    }
    state.lastLive = live;
    setTime(live);
  }
  updateWindows();
  ensureBeatmap();
  applyCachedIfReady();
  maybeExact();
  ensureLive();
  if (state.gameState === "play" && !state.cached && state.statCount > 0 && performance.now() >= state.nextSaveAt) {
    state.nextSaveAt = performance.now() + 3000;
    saveRun(false);
  }
}

function onPrecise(data) {
  if (!data) return;
  const nowMs = performance.now();
  const preciseGap = state.lastPreciseAt ? nowMs - state.lastPreciseAt : 0;
  state.lastPreciseAt = nowMs;
  // A gap far above the 10ms precise poll means this message (or the ones queued behind
  // it) was delayed. Their hitErrors were produced earlier than the clock says, so they
  // must be matched in note order instead of by wall-clock `implied` time; otherwise a
  // delayed error can be credited to a later note and the real note stays unjudged.
  if (preciseGap > 120) state.preciseStalledUntil = nowMs + 500;
  const stalled = nowMs < state.preciseStalledUntil;
  const current = Number(data.currentTime);
  if (Number.isFinite(current)) setTime(current);
  updateKeyHints(data.keys);
  if (state.liveActive) applyLiveCorrections(data.hitErrors);
  if (state.exactApplied && Array.isArray(data.hitErrors) && state.statCount > 50 && data.hitErrors.length + 50 < state.statCount) {
    // The game is judging a fresh attempt while an old replay result is still applied:
    // drop the stale replay so the live pipeline can take over.
    state.pendingApply = false;
    state.runPrefix = [];
    clearReplayRun();
    resetJudgements();
  }
  if (state.exactApplied || state.liveActive) return;
  const arr = data.hitErrors;
  if (!Array.isArray(arr)) return;
  if (state.gameState !== "play")   {
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
  if (arr.length < state.errorCount) {
    state.runPrefix = [];
    resetJudgements();
  }
  if (arr.length > state.errorCount) {
    const count = arr.length - state.errorCount;
    if (count > 1 || stalled || state.errorCount === 0 || state.timeSpeed > 1.25) {
      for (let i = state.errorCount; i < arr.length; i++) {
        state.runPrefix.push(arr[i]);
        consumeError(arr[i], null);
      }
    } else {
      const now = renderTime();
      for (let i = state.errorCount; i < arr.length; i++) {
        state.runPrefix.push(arr[i]);
        consumeError(arr[i], now);
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

function helperHeartbeat() {
  setTimeout(helperHeartbeat, 25000);
  if (!helperBase()) return;
  if (!settings.exactReplay && !settings.exactLive) return;
  helperFetch(helperEndpoint("/status"), 2000).catch(() => {});
}
helperHeartbeat();

sockets.open("/websocket/v2", onV2, v2Filters);
sockets.open("/websocket/v2/precise", onPrecise, null);
sockets.open("/websocket/commands", onCommand, null, () => requestSettings(0));
requestSettings();

window.addEventListener("beforeunload", () => {
  if (state.gameState === "play" && !state.cached && state.statCount > 0) saveRun(false);
});

// Closing sockets explicitly keeps tosu from logging dropped clients on page unload.
window.addEventListener("pagehide", () => sockets.closeAll());

window.__maniaReplayMaster = {
  state,
  settings,
  parseOsu,
  buildManiaNotes,
  makeScroll,
  getScroll,
  visibleStartIndex,
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
  fitExactOffset,
  exactOffsetFor,
  replayWindowTable,
  getJudgementClass,
  judgeRelease,
  judgeReplayNotes,
  replayJudgementCounts,
  classifyV2Tail,
  applyExactTimeline,
  applyExactData,
  maybeExact,
  applyLiveKey,
  hookSongTime,
  ensureLive,
  closeLive,
  resetExactRun,
  clearExactState,
  clearReplayRun,
  exactReplayReady,
  analysisMode,
  helperBase,
  helperEndpoint,
  ensureBeatmap,
  fetchBeatmapText,
  onV2,
  onPrecise,
  updateKeyHints,
  consumeError,
  applyLiveCorrections,
  renderTime,
  setTime,
  renderScene,
  frame,
  unstableRate,
  panelStats,
  allowedState,
  statusText,
  updateSettings,
  canvas,
  sockets
};

requestAnimationFrame(frame);
