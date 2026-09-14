// 实时模式环境自检：helper 是否在线、键盘钩子是否启动、SSE 按键事件是否正常。
// 用法：
//   1) 先启动 helper：node "tools/mrm-helper.mjs"
//   2) 运行本脚本：  node test/mrm-live-check.mjs
//   3) 在 45 秒内依次按下 D F J K（4K 默认键位），建议每键按 2 次
// 参数：--url http://127.0.0.1:24051  --keys 4  --seconds 45
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
};
const base = arg("url", "http://127.0.0.1:24051").replace(/\/+$/, "");
const keys = Number(arg("keys", 4)) || 4;
const seconds = Number(arg("seconds", 45)) || 45;

async function getJson(path) {
  const res = await fetch(`${base}${path}`, { cache: "no-store" });
  return res.json();
}

const events = [];
let hello = null;
let aborted = false;

try {
  const status = await getJson("/status");
  console.log(`[1/3] helper 在线：ok=${status.ok} 回放数=${status.replays} hook=${status.hook}`);
} catch (err) {
  console.error(`[1/3] helper 不可达：${err.message}`);
  console.error("      请先启动：node \"tools/mrm-helper.mjs\"");
  process.exit(1);
}

console.log(`[2/3] 连接 ${base}/live?keys=${keys} ...`);
console.log(`      请做两步测试：`);
console.log(`      A) 先在终端窗口按 D F J K 各 1 次（应看到事件）；`);
console.log(`      B) 再切到 osu! 窗口（游戏内/菜单均可）按 D F J K 各 2 次——`);
console.log(`         如果 A 有事件而 B 没有，就是游戏前台时钩子被拦截。`);
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), seconds * 1000);
try {
  const res = await fetch(`${base}/live?keys=${keys}`, { signal: controller.signal });
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
      let msg = null;
      try {
        msg = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      if (msg.type === "hello") {
        hello = msg;
        console.log(`      hello: hook=${msg.hook}${msg.error ? ` error=${msg.error}` : ""}${msg.layout ? `  键位=[${msg.layout}] (${msg.from})` : ""}`);
      } else if (msg.type === "error") {
        console.log(`      [hook error] ${msg.message}`);
      } else if (msg.type === "key") {
        events.push(msg);
        console.log(`      key ${msg.down ? "down" : "up  "}  col=${msg.column}  t=${msg.t}ms`);
      }
    }
  }
} catch (err) {
  if (err.name !== "AbortError") console.error(`      SSE 错误：${err.message}`);
} finally {
  clearTimeout(timer);
  aborted = true;
}

console.log("[3/3] 结果：");
const down = events.filter((e) => e.down);
const up = events.filter((e) => !e.down);
const perDown = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((c) => down.filter((e) => e.column === c).length);
const perUp = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((c) => up.filter((e) => e.column === c).length);
console.log(`      down=${down.length} up=${up.length}`);
console.log(`      每列 down=${perDown.slice(0, keys).join(",")}  up=${perUp.slice(0, keys).join(",")}`);
const layoutNames = hello && hello.layout ? hello.layout.split(" ") : ["D", "F", "J", "K", "Space", "S", "L", "A", ";", "'"];
const names = layoutNames.map((n) => (n === "OemSemicolon" ? ";" : n === "OemQuotes" ? "'" : n));
for (let c = 0; c < keys; c++) {
  if (perDown[c] > 0) continue;
  console.log(`      !! col${c}（键 ${names[c]}）一次都没收到：请单独按这个键确认，若仍无事件则是键位/键盘布局问题`);
}
if (!hello || !hello.hook) console.log("      FAIL: 键盘钩子未启动（看上面 hook error；检查 PowerShell/安全软件）");
else if (!events.length) console.log("      FAIL: 钩子已启动但收不到按键（可能被安全软件拦截，或按键不在映射内）");
else {
  const missing = perDown.slice(0, keys).filter((n) => n === 0).length;
  if (missing) console.log("      WARN: 有列没收到按键，见上面提示");
  else console.log("      PASS: 事件通道正常");
}
void aborted;
