// ln-record.mjs — 记录 Mania Replay Master 实时渲染所依赖的全部原始数据流，供 ln-analyze.mjs 离线复现与对比。
// 用法：
//   node test/ln-record.mjs [--tosu 127.0.0.1:24050] [--helper http://127.0.0.1:24051]
//                           [--out ln-logs/session-<ts>] [--max 0] [--linger 20]
// 产物：
//   <out>/events.jsonl         逐条事件（v2 / precise / helper / status / meta），带相对毫秒时间戳
//   <out>/maps/<checksum>.osu  游玩谱面原始文本
//   <out>/plugin-settings.json 开始时的插件设置快照
//   <out>/summary.json         结束时的汇总（游玩区间、hook 布局、各通道条数等）
//
// 设计说明：
//   * v2 消息只保留插件真正消费的字段（体积从 ~22KB/条降到 ~1KB/条）
//   * precise 消息只记录本轮新增的 hitErrors（delta），完整数组可由分析脚本还原
//   * helper /live 的 key/hello/error/hookexit 事件原样记录
//   * 不修改插件、不需要浏览器；recorder 自身会保持 /live 连接，因此 hook 在记录期间常驻
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
};
const numArg = (name, dflt) => {
  const v = Number(arg(name, dflt));
  return Number.isFinite(v) ? v : dflt;
};

const TOSU = String(arg("tosu", "127.0.0.1:24050")).replace(/^https?:\/\//, "").replace(/\/+$/, "");
const HELPER = String(arg("helper", "http://127.0.0.1:24051")).replace(/\/+$/, "");
const MAX_SEC = Math.max(0, numArg("max", 0));
const LINGER_SEC = Math.max(0, numArg("linger", 20));
const tosuRoot = path.resolve(__dirname, "../../..");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = path.resolve(process.cwd(), arg("out", `ln-logs/session-${stamp}`));
fs.mkdirSync(path.join(OUT, "maps"), { recursive: true });

const eventsPath = path.join(OUT, "events.jsonl");
const stream = fs.createWriteStream(eventsPath, { flags: "a" });
const t0 = performance.now();
let lineCount = 0;
let byteCount = 0;
const chanCount = Object.create(null);

function emit(ch, extra) {
  chanCount[ch] = (chanCount[ch] || 0) + 1;
  const rec = { t: Math.round((performance.now() - t0) * 10) / 10, wall: Date.now(), ch, ...extra };
  const s = JSON.stringify(rec) + "\n";
  lineCount += 1;
  byteCount += s.length;
  stream.write(s);
}

const startedWall = Date.now();
emit("meta", {
  event: "start",
  tosu: TOSU,
  helper: HELPER,
  maxSec: MAX_SEC,
  lingerSec: LINGER_SEC,
  out: OUT,
  node: process.version
});
try {
  const env = fs.readFileSync(path.join(tosuRoot, "tosu.env"), "utf8");
  emit("meta", { event: "tosu-env", text: env.slice(0, 4000) });
} catch {
}
try {
  const src = path.join(tosuRoot, "settings", "Mania Replay Master (fixed).values.json");
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(OUT, "plugin-settings.json"));
    emit("meta", { event: "plugin-settings-copied", from: src });
  }
} catch {
}

// ---------- tosu websockets ----------
let v2Count = 0;
let preciseCount = 0;
let lastPreciseLen = 0;
let lastPlayState = "";
let currentKeys = 0;
let mapMode = "";
let checksum = "";
let mapFetched = false;
let mapsSaved = [];
const playSegments = [];
let playStartT = 0;
let inPlay = false;
let lingerTimer = null;
let maxTimer = null;
let stopping = false;

function projectV2(d) {
  const beatmap = d.beatmap || {};
  const stats = beatmap.stats || {};
  const play = d.play || {};
  const mods = play.mods || {};
  const settings = d.settings || {};
  const out = {
    client: d.client,
    state: d.state ? { name: d.state.name } : undefined,
    settings: {
      replayUIVisible: settings.replayUIVisible,
      mania: { scrollSpeed: settings.mania ? settings.mania.scrollSpeed : undefined }
    },
    beatmap: {
      checksum: beatmap.checksum,
      mode: beatmap.mode ? { name: beatmap.mode.name } : undefined,
      stats: {
        od: stats.od,
        cs: stats.cs,
        ar: stats.ar,
        hp: stats.hp,
        bpm: stats.bpm,
        objects: stats.objects,
        hitWindow: stats.hitWindow,
        stars: stats.stars
      },
      time: beatmap.time
    },
    play: {
      mods: { number: mods.number, rate: mods.rate, array: mods.array },
      hits: play.hits,
      score: play.score,
      accuracy: play.accuracy,
      failed: play.failed
    },
    folders: d.folders ? { beatmap: d.folders.beatmap } : undefined,
    files: d.files ? { beatmap: d.files.beatmap } : undefined
  };
  return out;
}

function onV2(data) {
  v2Count += 1;
  const proj = projectV2(data);
  // track play segments from the projected stream
  const name = data.state && data.state.name;
  if (name && name !== lastPlayState) {
    const prev = lastPlayState;
    lastPlayState = name;
    emit("meta", { event: "state", name, prev });
    if (name === "play" && !inPlay) {
      inPlay = true;
      playStartT = performance.now() - t0;
      if (lingerTimer) {
        clearTimeout(lingerTimer);
        lingerTimer = null;
      }
      emit("meta", { event: "play-start", checksum: data.beatmap && data.beatmap.checksum });
    } else if (name !== "play" && inPlay) {
      inPlay = false;
      const seg = {
        startT: Math.round(playStartT * 10) / 10,
        endT: Math.round((performance.now() - t0) * 10) / 10,
        checksum: checksum,
        keys: currentKeys,
        hitErrors: lastPreciseLen
      };
      playSegments.push(seg);
      emit("meta", { event: "play-end", ...seg });
      // arm auto-stop
      if (LINGER_SEC > 0 && !lingerTimer && !stopping) {
        lingerTimer = setTimeout(() => finish(`play ended ${LINGER_SEC}s ago`), LINGER_SEC * 1000);
      }
    }
  }
  // map identity / fetch
  const bm = data.beatmap || {};
  if (bm.mode && bm.mode.name) mapMode = bm.mode.name;
  const cs = bm.stats && bm.stats.cs ? Number(bm.stats.cs.converted) : NaN;
  if (Number.isFinite(cs)) {
    const keys = Math.max(1, Math.min(18, Math.round(cs)));
    if (keys !== currentKeys) {
      currentKeys = keys;
      emit("meta", { event: "keys", keys });
      reconnectHelper(keys);
    }
  }
  const csum = bm.checksum ? String(bm.checksum) : "";
  const folder = data.folders && data.folders.beatmap;
  const fileName = data.files && data.files.beatmap;
  if (csum && csum !== checksum) {
    checksum = csum;
    mapFetched = false;
    emit("meta", { event: "map-change", checksum: csum, folder, file: fileName });
    if (mapMode === "mania") fetchMap(csum, folder, fileName).catch(() => {});
  }
  emit("v2", { data: proj });
}

function onPrecise(data) {
  preciseCount += 1;
  const arr = Array.isArray(data.hitErrors) ? data.hitErrors : [];
  const delta = arr.length - lastPreciseLen;
  const rec = {
    currentTime: data.currentTime,
    hitErrorsLen: arr.length,
    keys: data.keys,
    delta
  };
  if (delta > 0) rec.hitErrors = arr.slice(lastPreciseLen);
  else if (delta < 0) {
    rec.reset = true;
    rec.hitErrors = arr.slice();
  }
  lastPreciseLen = arr.length;
  emit("precise", rec);
}

function openWS(pathname, handler) {
  let ws = null;
  let closed = false;
  const connect = () => {
    if (closed || stopping) return;
    try {
      ws = new WebSocket(`ws://${TOSU}${pathname}`);
    } catch (e) {
      setTimeout(connect, 1500);
      return;
    }
    ws.addEventListener("message", (ev) => {
      let data = null;
      try {
        data = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        return;
      }
      handler(data);
    });
    ws.addEventListener("close", () => {
      if (!closed && !stopping) setTimeout(connect, 1000);
    });
    ws.addEventListener("error", () => {});
  };
  connect();
  return () => {
    closed = true;
    try {
      ws && ws.close();
    } catch {
    }
  };
}

// ---------- helper SSE ----------
let helperAbort = null;
let helperReconnectTimer = null;
let helperConnected = false;
let helperHello = [];

function reconnectHelper(keys) {
  if (helperReconnectTimer) clearTimeout(helperReconnectTimer);
  helperReconnectTimer = setTimeout(() => connectHelper(keys), 200);
}

async function connectHelper(keys) {
  if (stopping) return;
  if (helperAbort) helperAbort.abort();
  const ac = new AbortController();
  helperAbort = ac;
  try {
    const res = await fetch(`${HELPER}/live?keys=${keys}`, {
      signal: ac.signal,
      headers: { Origin: `http://${TOSU}` }
    });
    if (!res.ok) {
      emit("meta", { event: "helper-http", status: res.status, keys });
      helperReconnectTimer = setTimeout(() => connectHelper(keys), 2000);
      return;
    }
    helperConnected = true;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (!stopping) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (!raw) continue;
          let msg = null;
          try {
            msg = JSON.parse(raw);
          } catch {
            emit("helper-raw", { raw });
            continue;
          }
          if (msg.type === "key") {
            const { t: hookT, ...rest } = msg;
            emit("key", { ...rest, hookT });
          }
          else {
            emit("helper", msg);
            if (msg.type === "hello") helperHello.push(msg);
          }
        }
      }
    }
  } catch (e) {
    if (!ac.signal.aborted && !stopping) emit("meta", { event: "helper-error", message: String((e && e.message) || e) });
  } finally {
    if (helperConnected) {
      helperConnected = false;
      if (!stopping) helperReconnectTimer = setTimeout(() => connectHelper(keys), 2000);
    }
  }
}

async function pollHelperStatus() {
  if (stopping) return;
  try {
    const res = await fetch(`${HELPER}/status`, { signal: AbortSignal.timeout(2000), headers: { Origin: `http://${TOSU}` } });
    if (res.ok) {
      const body = await res.json();
      emit("status", { data: body });
    }
  } catch {
  }
  if (!stopping) setTimeout(pollHelperStatus, 5000);
}

// ---------- map text ----------
async function fetchMapTextByListing(folder, fileName) {
  if (!folder || !fileName) return "";
  const target = String(fileName).trim().toLowerCase();
  for (let pad = 0; pad <= 2; pad += 1) {
    const folderName = " ".repeat(pad) + folder;
    let html = "";
    try {
      const res = await fetch(`http://${TOSU}/files/beatmap/${encodeURIComponent(folderName)}/`, {
        signal: AbortSignal.timeout(3000)
      });
      if (!res.ok) continue;
      html = await res.text();
    } catch {
      continue;
    }
    const re = /<a\s+href="([^"]+)"[^>]*>([^<]*)<\/a>/gi;
    let m;
    let actual = "";
    while ((m = re.exec(html)) !== null) {
      const href = m[1];
      if (href.endsWith("/")) continue;
      let raw = href.split("/").pop();
      try {
        raw = decodeURIComponent(raw);
      } catch {
      }
      if (raw && raw.toLowerCase() === target) {
        actual = raw;
        break;
      }
    }
    if (!actual) continue;
    try {
      const res = await fetch(
        `http://${TOSU}/files/beatmap/${encodeURIComponent(folderName)}/${encodeURIComponent(actual)}`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (!res.ok) continue;
      const text = await res.text();
      if (text && text.includes("osu file format")) return text;
    } catch {
    }
  }
  return "";
}

async function fetchMap(csum, folder, fileName) {
  if (mapFetched || !csum) return;
  let text = "";
  try {
    const res = await fetch(`http://${TOSU}/files/beatmap/file`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const body = await res.text();
      if (body && body.includes("osu file format")) text = body;
    }
  } catch {
  }
  if (!text) text = await fetchMapTextByListing(folder, fileName);
  if (!text) {
    emit("meta", { event: "map-fetch-failed", checksum: csum });
    return;
  }
  const outPath = path.join(OUT, "maps", `${csum}.osu`);
  fs.writeFileSync(outPath, text);
  mapFetched = true;
  mapsSaved.push({ checksum: csum, path: outPath, bytes: Buffer.byteLength(text) });
  emit("meta", { event: "map-saved", checksum: csum, path: outPath, bytes: Buffer.byteLength(text) });
}

// ---------- status line ----------
const statusTimer = setInterval(() => {
  const sec = Math.round((performance.now() - t0) / 100) / 10;
  const line =
    `[ln-record] ${sec}s state=${lastPlayState || "?"} map=${checksum ? checksum.slice(0, 8) : "?"} keys=${currentKeys}` +
    ` v2=${v2Count} precise=${preciseCount} hitErrors=${lastPreciseLen} helper=${helperConnected ? "on" : "off"}` +
    ` hook=${helperHello.length ? (helperHello[helperHello.length - 1].hook ? "yes" : "NO") : "?"}`;
  if (process.stdout.isTTY) process.stdout.write("\r" + line + "   ");
  else console.log(line);
}, 2000);

function finish(reason) {
  if (stopping) return;
  stopping = true;
  clearInterval(statusTimer);
  if (lingerTimer) clearTimeout(lingerTimer);
  if (maxTimer) clearTimeout(maxTimer);
  if (helperAbort) helperAbort.abort();
  if (helperReconnectTimer) clearTimeout(helperReconnectTimer);
  closeWS.forEach((fn) => fn());
  emit("meta", { event: "stop", reason, elapsedSec: Math.round((performance.now() - t0) / 100) / 10 });
  const summary = {
    started: new Date(startedWall).toISOString(),
    stopped: new Date().toISOString(),
    elapsedSec: Math.round((performance.now() - t0) / 100) / 10,
    tosu: TOSU,
    helper: HELPER,
    out: OUT,
    events: eventsPath,
    lines: lineCount,
    bytes: byteCount,
    channels: chanCount,
    mapMode,
    checksum,
    keys: currentKeys,
    playSegments,
    maps: mapsSaved,
    helperHello,
    finalPreciseHitErrors: lastPreciseLen
  };
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  stream.end(() => {
    console.log(`\n[ln-record] done -> ${OUT}`);
    console.log(`[ln-record] events=${lineCount} lines, ${(byteCount / 1024 / 1024).toFixed(2)} MB, play segments=${playSegments.length}`);
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000);
}

const closeWS = [openWS("/websocket/v2", onV2), openWS("/websocket/v2/precise", onPrecise)];

// initial helper connect (keys unknown until first v2; start with 4 and reconnect on change)
connectHelper(4);
pollHelperStatus();

if (MAX_SEC > 0) {
  maxTimer = setTimeout(() => finish(`max ${MAX_SEC}s reached`), MAX_SEC * 1000);
}
process.on("SIGINT", () => finish("SIGINT"));
process.on("SIGTERM", () => finish("SIGTERM"));
console.log(`[ln-record] recording to ${OUT}`);
console.log(`[ln-record] tosu=${TOSU} helper=${HELPER} (Ctrl-C to stop)`);
