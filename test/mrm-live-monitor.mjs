// 实时游玩监控：同时记录 tosu 状态、tosu hitErrors、helper 键盘事件，输出诊断报告。
// 用法：
//   1) 启动 helper：node "tools/mrm-helper.mjs"
//   2) 运行：node test/mrm-live-monitor.mjs            （默认监控 180 秒）
//   3) 正常游玩一张 mania 图（4K 需 ≥30 秒），结束后把输出与日志文件发回
// 参数：--seconds 180  --out mrm-live-log.json  --tosu 127.0.0.1:24050  --helper http://127.0.0.1:24051
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
};
const seconds = Number(arg("seconds", 180)) || 180;
const outFile = arg("out", "mrm-live-log.json");
const tosu = arg("tosu", "127.0.0.1:24050");
const helper = arg("helper", "http://127.0.0.1:24051").replace(/\/+$/, "");
const fs = await import("node:fs");

if (typeof WebSocket === "undefined") {
  console.error("需要 Node 22+（内置 WebSocket）");
  process.exit(1);
}

const startedAt = Date.now();
const latest = { state: "", play: null, beatmap: null, beatmapAt: 0 };
let map = null;
let mapKey = "";
let hitErrors = [];
const keyEvents = [];
const matched = [];
let hookHello = null;
let playSeen = false;
let playStartAt = 0;
let playMs = 0;

function parseMapText(text) {
  const sections = {};
  let cur = "";
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//")) continue;
    if (line[0] === "[" && line.endsWith("]")) {
      cur = line.slice(1, -1);
      continue;
    }
    (sections[cur] = sections[cur] || []).push(line);
  }
  const kv = (lines) => {
    const o = {};
    for (const line of lines || []) {
      const i = line.indexOf(":");
      if (i >= 0) o[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return o;
  };
  const diff = kv(sections.Difficulty);
  const keys = Math.max(1, Math.round(parseFloat(diff.CircleSize) || 4));
  const notes = [];
  for (const line of sections.HitObjects || []) {
    const p = line.split(",");
    if (p.length < 4) continue;
    const x = parseFloat(p[0]);
    const time = parseFloat(p[2]);
    const type = parseInt(p[3]) || 0;
    if ((type & 8) !== 0) continue;
    const col = Math.min(keys - 1, Math.max(0, Math.floor((x * keys) / 512)));
    let endTime = time;
    if ((type & 128) !== 0 && p.length >= 6) {
      const e = parseFloat(String(p[5]).split(":")[0]);
      if (Number.isFinite(e) && e > time) endTime = e;
    }
    notes.push({ time, column: col, endTime, hold: endTime > time, down: false, up: false });
  }
  notes.sort((a, b) => a.time - b.time);
  return { keys, notes, od: parseFloat(diff.OverallDifficulty) || 0, mode: kv(sections.General).Mode };
}

async function loadMap(checksum) {
  if (!checksum || checksum === mapKey) return;
  mapKey = checksum;
  map = null;
  try {
    const res = await fetch(`http://${tosu}/files/beatmap/file`, { cache: "no-store" });
    if (!res.ok) return;
    const parsed = parseMapText(await res.text());
    if (String(parsed.mode) !== "3") return;
    map = parsed;
    console.log(`[map] keys=${parsed.keys} od=${parsed.od} notes=${parsed.notes.length}`);
  } catch (err) {
    console.log(`[map] fetch failed: ${err.message}`);
  }
}

function mapNow() {
  const live = latest.beatmap && latest.beatmap.time && latest.beatmap.time.live;
  if (!Number.isFinite(live)) return null;
  const rate = latest.play && latest.play.mods && Number.isFinite(Number(latest.play.mods.rate)) ? Number(latest.play.mods.rate) : 1;
  return live + ((Date.now() - latest.beatmapAt) / 1000) * rate;
}

function matchEvent(ev) {
  if (!map || latest.state !== "play") return;
  const t = mapNow();
  if (t === null) return;
  const window = 200;
  let best = null;
  for (const n of map.notes) {
    if (n.column !== ev.column) continue;
    if (n.time - t > window) break;
    if (!ev.down) {
      if (!n.hold || n.up) continue;
      const d = n.endTime - t;
      if (Math.abs(d) <= window && (!best || Math.abs(d) < Math.abs(best.err))) best = { note: n, err: d, at: t, kind: "up" };
    } else {
      if (n.down) continue;
      const d = n.time - t;
      if (Math.abs(d) <= window && (!best || Math.abs(d) < Math.abs(best.err))) best = { note: n, err: d, at: t, kind: "down" };
    }
  }
  if (best) {
    if (best.kind === "down") best.note.down = true;
    else best.note.up = true;
    matched.push({ column: ev.column, down: ev.down, err: Math.round(best.err * 10) / 10, at: Math.round(t), hookT: ev.t });
  }
}

console.log(`监控 ${seconds}s：tosu=${tosu} helper=${helper}`);
console.log("请正常游玩一张 mania 图（无需重开，支持多图）...");

const ws = new WebSocket(`ws://${tosu}/websocket/v2`);
ws.addEventListener("open", () => {
  ws.send(JSON.stringify([
    "client",
    { field: "state", keys: ["name"] },
    { field: "play", keys: ["mods", "hits", "accuracy", { field: "mode", keys: ["name"] }] },
    { field: "beatmap", keys: ["mode", "checksum", "stats", { field: "time", keys: ["live"] }] }
  ]));
});
ws.addEventListener("message", (msg) => {
  let data = null;
  try {
    data = JSON.parse(msg.data);
  } catch {
    return;
  }
  if (data.state && data.state.name !== undefined) {
    const name = data.state.name;
    if (name === "play" && !playSeen) {
      playSeen = true;
      playStartAt = Date.now();
    } else if (name !== "play" && playStartAt) {
      playMs += Date.now() - playStartAt;
      playStartAt = 0;
    }
    latest.state = name;
  }
  if (data.beatmap) {
    latest.beatmap = data.beatmap;
    latest.beatmapAt = Date.now();
    if (data.beatmap.mode && data.beatmap.mode.name) void data.beatmap.mode.name;
    const checksum = data.beatmap.checksum;
    if (checksum && data.beatmap.mode && data.beatmap.mode.name === "mania") loadMap(checksum);
  }
  if (data.play) latest.play = data.play;
});

const wsPrecise = new WebSocket(`ws://${tosu}/websocket/v2/precise`);
wsPrecise.addEventListener("message", (msg) => {
  try {
    const data = JSON.parse(msg.data);
    if (Array.isArray(data.hitErrors)) hitErrors = data.hitErrors.slice();
  } catch {
  }
});

try {
  const st = await (await fetch(`${helper}/status`, { cache: "no-store" })).json();
  console.log(`[helper] ok=${st.ok} 回放数=${st.replays} hook=${st.hook}`);
} catch {
  console.log(`[helper] 不可达：${helper}`);
  console.log("         请保持另一个终端运行：node \"tools/mrm-helper.mjs\"（脚本会每 2 秒自动重试）");
}

let stopped = false;
const controller = new AbortController();
setTimeout(() => {
  stopped = true;
  controller.abort();
}, seconds * 1000);

async function sseLoop() {
  while (!stopped) {
    try {
      const res = await fetch(`${helper}/live?keys=4`, { signal: controller.signal });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const line = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          let event = null;
          try {
            event = JSON.parse(line.slice(6));
          } catch {
            continue;
          }
          if (event.type === "hello") {
            hookHello = event;
            console.log(`[hook] ${event.hook ? "ok" : "FAILED"} ${event.error || ""}`);
          } else if (event.type === "error") {
            console.log(`[hook error] ${event.message}`);
          } else if (event.type === "hookexit") {
            console.log(`[hook exit] 键盘钩子进程已退出（code=${event.code}）`);
          } else if (event.type === "key") {
            const rec = { ...event, recv: Date.now() };
            keyEvents.push(rec);
            matchEvent(rec);
          }
        }
      }
    } catch (err) {
      if (stopped || err.name === "AbortError") break;
      console.log(`[sse] 断开：${err.message || err}；2 秒后重试（请确认 helper 终端仍开着）`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
sseLoop();

function stats(arr) {
  if (!arr.length) return "-";
  const s = arr.slice().sort((a, b) => a - b);
  const mean = s.reduce((x, y) => x + y, 0) / s.length;
  return `mean=${mean.toFixed(1)} p50=${s[Math.floor(s.length / 2)]} p90=${s[Math.floor(s.length * 0.9)]}`;
}

setTimeout(async () => {
  const down = keyEvents.filter((e) => e.down);
  const up = keyEvents.filter((e) => !e.down);
  const errs = matched.map((m) => m.err);
  const lat = keyEvents.filter((e) => Number.isFinite(e.t)).map((e) => e.recv - startedAt - e.t);
  console.log("\n===== 诊断报告 =====");
  if (playStartAt) playMs += Date.now() - playStartAt;
  console.log(`hook: ${hookHello ? (hookHello.hook ? "ok" : "FAILED " + (hookHello.error || "")) : "未收到 hello"}`);
  console.log(`游玩状态: ${playSeen ? `监测期间出现过 play（累计 ${Math.round(playMs / 1000)}s）` : "监测期间未进入 play（可能没在监测时段内游玩）"}`);
  console.log(`键盘事件: down=${down.length} up=${up.length}`);
  if (playSeen && keyEvents.length === 0) {
    console.log(">> 关键：游玩期间收不到按键事件——若在 osu! 前台按键，说明钩子被系统/安全软件拦截；");
    console.log("   请用 mrm-live-check.mjs，把 osu! 切到前台后再按 D F J K 复测。");
  }
  for (let c = 0; c < 4; c++) {
    const d = down.filter((e) => e.column === c).length;
    if (d) console.log(`  col${c}: down=${d} up=${up.filter((e) => e.column === c).length}`);
  }
  console.log(`与谱面匹配: ${matched.length}/${down.length + up.length}（误差 ${stats(errs)}）`);
  console.log(`钩子→脚本延迟(ms): ${stats(lat)}`);
  console.log(`tosu hitErrors: ${hitErrors.length} 条（最后 8 条: ${hitErrors.slice(-8).join(", ")}）`);
  const ghost = keyEvents.length - matched.length;
  console.log(`未匹配(提前/空按/不同步): ${ghost}`);
  const log = {
    startedAt: new Date(startedAt).toISOString(),
    tosu,
    helper,
    hookHello,
    state: latest.state,
    map: map ? { keys: map.keys, od: map.od, notes: map.notes.length } : null,
    hitErrorsCount: hitErrors.length,
    hitErrorsLast: hitErrors.slice(-20),
    keyEvents: keyEvents.slice(-2000),
    matched: matched.slice(-2000)
  };
  fs.writeFileSync(outFile, JSON.stringify(log, null, 1));
  console.log(`日志已保存: ${outFile}（请连同以上输出一起发回）`);
  process.exit(0);
}, seconds * 1000 + 500);
