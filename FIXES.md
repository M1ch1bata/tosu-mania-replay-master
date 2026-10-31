# 修复记录（相对上游 0.5.0）

本目录 `Mania Replay Master (fixed)` 是代码审查后的修复版本，版本号 0.5.4（基于上游 0.5.0；0.5.4 重写了回放判定模型并修复实时判定归属，见第 19、20 条）。
以下按审查发现的问题逐条对应修改，测试为 `node test/mrm-test.mjs`（92/92 通过）。

## P0 安全

### 1. helper 对任意网页开放 + 可远程触发键盘钩子
- 文件：`tools/mrm-helper.mjs`
- 修改：
  - 新增 `ORIGIN_RE` 与 `corsFor(req)`：只对 `127.0.0.1` / `localhost` / `::1` 来源回显 CORS 头，其他浏览器来源直接 403；回显时带 `Vary: Origin`。
  - 新增 `--token <secret>` 参数与 `tokenOk(url)` 校验；`/status`、`/replay`、`/live`（含 OPTIONS）无 token 一律 403。CLI/测试脚本（无 Origin）不带 token 时仍会被 token 拦截，需在 URL 加 `?token=`。
  - 插件侧新增 `helperToken` 设置，`helperEndpoint()` 自动附加 `token` 参数。
- 验证：伪造 Origin 的请求返回 403；白名单 Origin 且 token 正确返回 200。

### 2. 键盘钩子在无 SSE 客户端时长期驻留
- 文件：`tools/mrm-helper.mjs`
- 修改：新增 `scheduleHookIdle()` / `cancelHookIdle()`；最后一个 SSE 连接断开后 10 秒自动 `stopHook()`，新连接建立时取消回收。

## P1 功能

### 3. exact 回放数据在实时游玩时被套用并屏蔽实时数据
- 文件：`main.js`
- 修改：
  - `maybeExact()` / `applyExactData()` 增加 `state.replayUi` 门槛：exact `.osr` 时间轴只在观看回放时加载。
  - 新增 `resetExactRun()`（复位 `exactApplied / exactKey / exactActions / exactFetching / exactRetryAt` 并关闭 live SSE），在进入 play、快速重试（`applyPlayUpdate` 的 restarted 分支）时调用。

### 4. exact 拉取失败不重试
- 文件：`main.js`
- 修改：仅在拿到有效 `actions` 时记录 `exactKey`；失败或无回放时记录 `exactRetryAt = now + 5000`，超时后自动重试。`fetch` 增加 3 秒 `AbortController` 超时（无 `AbortController` 时自动降级）。

### 6c. 实时键盘钩子被旧 `.osr` 抢占（同排和弦判定串位）
- 文件：`main.js`、`test/mrm-test.mjs`
- 背景：tosu precise 的 `hitErrors` 只有时间误差、没有列信息；同一排和弦的多个 note 无法按列归属，顺序匹配会让整排判定串位。`tools/key-hook.ps1` + SSE（`exactLive`）就是为此提供的逐列按下/抬起事件，`applyLiveKey()` 按列匹配 note，这是和弦正确渲染的唯一实时数据源；helper 的 `.osr`（`exactReplay`）只适合回放，不适合实时游玩。
- 问题：0.5.1 用 `state.replayUi` 作为「是否在看回放」的门槛并不可靠——tosu 的 `replayUIVisible = !isReplayUiHidden`，而 `isReplayUiHidden` 只在 `isWatchingReplay` 时刷新，普通游玩时保留旧值（初始为 false），因此实时游玩时它经常是 `true`。于是旧 `.osr` 仍会在实时游玩期间套用，`state.exactApplied = true` 又命中 `ensureLive()` 的提前返回，**键盘钩子从未启动**，判定退回 `onPrecise` 顺序匹配，同排和弦再次串位；反之若观播时隐藏了回放 UI，门槛又会错误地禁用 `.osr`。
- 修改：
  - 新增 `exactReplayReady()`：只有「没有收到任何实时按键」+「游戏已过第一个 note 1 秒」+「实时 SSE 已握手（hello）」时才允许套用旧 `.osr`。
  - `ensureLive()` 不再因 `exactApplied` 提前返回：实时游玩期间钩子始终连接，用真实输入来决定模式。
  - SSE 收到 `hello` 记录 `state.liveReady`；`applyExactData()` 在 `state.liveActive`（已有实时按键）时拒绝套用；`maybeExact()` 同样跳过。
  - `applyCachedIfReady()` 增加 `liveActive` 保护，避免 run 缓存在实时游玩中抢占；快速重试改用 `clearExactState()`（保留 SSE，不再反复重连）。
  - 新增状态 `state.liveReady`，`closeLive()` 一并复位。
- 测试：新增 2 条断言——实时有输入时 `applyExactData()` 必须失败；实时通道安静时旧 `.osr` 正常套用。
- 行为总结：先按键即实时模式（钩子逐列判定），先静默即回放模式（`.osr` 整体套用），两者不再互相抢占。

### 6d. 把「边玩边分析」与「一边播放录像一边分析」拆成两条独立管线
- 文件：`main.js`、`settings.json`、`test/mrm-test.mjs`
- 原因：tosu v2 没有可靠的「是否正在观播」字段（`settings.replayUIVisible` 在普通游玩时是陈旧值），仅靠启发式切换会让两条数据源互相污染。按需求拆分为两个明确管线：
  - **Live（实时判定）**：只使用 `tools/key-hook.ps1` 的逐列按下/抬起事件，完全不走 `.osr`、run 缓存与 precise 顺序匹配；无钩子时回退 `hitErrors`。
  - **Replay（回放预渲染）**：只读取 `.osr`，一次把整局逐列动作对齐并预渲染，不连接键盘钩子、不需要实时输入判断。
- 修改：
  - 新增设置 `analysisMode`（`Auto` / `Live` / `Replay`），tosu 设置面板可选；`analysisMode()` 作为两种管线的总开关。
  - `ensureLive()`：`Replay` 模式不连接钩子。
  - `maybeExact()` / `applyExactData()` / `applyCachedIfReady()`：`Live` 模式一律不读 `.osr`/缓存；`Replay` 模式不做 `replayUi`、输入静默、首 note 延迟等限制，拿到文件立即预渲染。
  - `Auto` 模式保留上一节的优先级：先收到实时按键 → Live；实时通道安静 → Replay；并且实时按键现在可以**抢占**已预渲染的 `.osr`（`clearReplayRun()`），不会再出现「旧回放锁死整局」。
- 测试：新增 `analysis modes`（Live 不预渲染 / Replay 预渲染）两条断言。

### 6e. 实时/预渲染匹配从「最近音符」改为客户端音符锁规则
- 文件：`main.js`、`test/mrm-test.mjs`
- 问题：原 `nearestPoint()` 取列内**时间最近**的未判定音符。osu! 客户端实际是音符锁：按键只能命中该列**最早的、仍在判定窗口内**的音符。列内音符密集时（例如和弦后紧跟同列音符、连打），最近匹配会把按键算到后面那个音符上，整排/整段判定串位。
- 修改：`nearestPoint()` 改为 `lockPoint()`：按列内顺序扫描，跳过已判定与已超出 miss 窗口的音符，命中最早的合法音符；过晚按下的旧音符不再抢占。`applyLiveKey()` 与 `applyExactTimeline()` 共用该规则。
- 测试：新增 `live note lock matching`（1080ms 按下只能命中 1000ms 的音符，不能命中 1050ms 的近音符）与 `live chord per-column`（同排四个 note 各自命中本列）三条断言。

### 6f. 实时判定时间基准错误（同排判定依旧混乱的根因）
- 文件：`main.js`、`test/mrm-test.mjs`
- 问题：实时按键的判定误差一直用 `renderTime()` 计算，它的时间基准只来自 v2 通道的 `beatmap.time.live`（tosu 默认 `pollRate = 100ms`），中间靠 `timeSpeed` 估算外推；而每个按键事件还会在不同 JS 任务里依次处理。MAX 判定窗口只有 ±16.5ms，DT/HT 下这几十毫秒的基准漂移与逐事件抖动，会让同一排和弦的各个键被算成不同的判定颜色。
- 关键事实（已修正）：该版本 tosu 的 `/websocket/v2/precise` 实测载荷只有 `keys / hitErrors / tourney`（三份 `events.jsonl` 录制里 `currentTime` 出现 0 次），`preciseDataPollRate = 10ms` 只保证 `hitErrors` 的刷新频率（见 `packages/tosu/src/api/utils/buildResultV2Precise.ts`、`packages/common/utils/config.ts`）。插件仍保留 `setTime(currentTime)` 兼容分支（新版本 tosu 若补该字段会自动生效），当前时间基准只能来自 v2 通道的 `beatmap.time.live`（默认 100ms）加外推。
- 修改：
  - `onPrecise()` 先消费 `data.currentTime`：`if (Number.isFinite(current)) setTime(current);`，再走原有逻辑（**这条是兼容分支**：实测 tosu 4.20 / 4.26 的 precise 载荷没有 `currentTime`，平时不会触发；对支持的版本才会把时钟校到 10ms 精度）。
  - 新增 `hookSongTime(hookT)`：以钩子自己的按键时间戳为基准，与游戏时钟做锚定并做慢速漂移校正（大跳变视为重开/跳转直接重锚），按键误差不再受 SSE/JS 调度延迟影响；`applyLiveKey()` 改用该时间。
  - `state` 新增 `liveAnchorHook / liveAnchorSong`，`closeLive()` 复位锚点。
- 测试：新增 3 条断言——precise `currentTime` 驱动实时时钟；nomod 下钩子时钟 1:1；rate 1.5 下钩子时钟按 1.5 缩放。

### 6g. 实时钩子 down/up 极性反转（按下永远匹配不到 note 头）
- 文件：`main.js`、`test/mrm-test.mjs`
- 问题：SSE 处理器里写的是 `applyLiveKey(msg.column, t, !msg.down)`，而 `applyLiveKey` 内部又用 `!down` 决定找头还是找尾，**双重取反**导致语义完全反了：
  - 按下（`msg.down === true`）→ 内部 `wantEnd = true` → 去找**尾判点**，普通 note 没有尾判 → `lockPoint` 返回 -1，按下时永远命中不了；
  - 抬起（`msg.down === false`）→ 内部 `wantEnd = false` → 去匹配 **note 头**，于是所有击打都在**松键时刻**才判定，误差还叠加了按键持续时间。
  - 结果：同排和弦每个键在各自松键时间被判定，颜色混乱；长条的头/尾判定全部错位；按下的轨道很可能直接显示 Miss。
  - 该 bug 从上游 0.5.0 就存在，之前的单元测试直接调用 `applyLiveKey(col, t, true)`（绕过了处理器），所以一直没暴露。
- 修改：SSE 处理器改为 `applyLiveKey(msg.column, hookSongTime(msg.t), !!msg.down)`；`applyLiveKey` 内部 `!down` 的语义保持不变（按下找头、抬起找尾）。
- 测试：新增 6 条集成断言（用 mock EventSource 走真实 SSE 处理器）——hello 上报 helper 状态与键位、按下命中本列 note 头、抬起不重复判定普通 note、未按轨道被扫成 MISS、长条按下判头 / 抬起判尾。

### 6h. 无 helper 的列归属：tosu precise keys 提示 + 未暴露列排除法
- 文件：`main.js`、`test/mrm-test.mjs`
- 背景：helper 是常驻进程，不符合「只开 tosu」的使用方式；tosu v4.20 的 `/websocket/v2/precise` 除 `hitErrors` 外还带 `keys`（k1/k2/m1/m2 的 `isPressed`/`count`）。如果 stable 的 mania key overlay 是逐列的，就能不依赖 helper 做列归属；tosu 只送前 3 槽（mania 不读第 4 槽），第 4 列用排除法。
- 修改：
  - `updateKeyHints(keys)`：在 `onPrecise` 中消费 `keys`，按 `isPressed` 上升沿/`count` 增量记录列按下提示，下降沿记录抬起提示（长条尾判）。
  - `consumeError(e, pressTime)`：命中误差仍用游戏给出的 `hitErrors` 精确值；匹配时优先消费按键提示（提示列 + 该列最近的可判定 note），提示不可用时对「tosu 未暴露的列」（4K 的第 4 列等）做唯一候选排除；仍不明确才回退原有顺序匹配。
  - `keyHintExposed` 初始为 `[true,true,true,false]`（tosu 固定提供前三槽，第四槽仅在观察到其变化后才认为已暴露），保证 4K 第 4 列可通过排除法定向。
  - 诊断：首次收到有效按键提示时打印一次 `tosu precise keys: column hints active`；状态可在 `window.__maniaReplayMaster.state.keyHintSeen` 查看。
  - **完整列数组支持**：`updateKeyHints()` 现在同时接受 `keys` 为数组、或 `keys.maniaKeys` 数组，并把全部 N 列都视为已暴露；一旦 tosu 侧提供完整列数组（见 `tools/tosu-mania-keys-patch.md`），5K–10K 的多列归属自动可用，无需 helper。
- 局限：若 stable 的 mania key overlay 不提供逐列数据（tosu 全是 0），提示不会触发，行为与之前一致；旧版 tosu 只送 3–4 槽时，第 4 列之后的多列无法用排除法覆盖，仍需 helper 或 tosu 补丁；完整和弦的误差-列配对在同帧内仍按顺序，可能有轻微换色。
- 测试：新增 4 条断言——按键提示把命中归到按下列、未暴露列用排除法命中、全和弦「提示 + 排除」组合、`maniaKeys` 完整列数组在 7K 下按列归属。

## P2 稳定 / 性能

### 5. 游戏退出后停留在 play 状态
- 文件：`main.js`
- 修改：`onV2()` 记录 `state.lastV2At`；`frame()` 中若 `play` 状态下超过 5 秒没有 v2 消息，置 `state.streamStale` 冻结时间外推与 miss 扫描并在状态行提示（第 26 条），不再强制切成 `not_ready` 清屏。

### 6. mania 判定窗口未按 rate 缩放（stable 与 lazer 均受影响）
- 文件：`main.js`、`test/mrm-test.mjs`
- 背景：ppy/osu#24603 中开发者的结论是——osu!stable 对除 mania 外的模式让 DT/HT 直接改变判定窗口；**mania 例外，stable 会对窗口做反向补偿，使真实时间下的窗口长度保持不变**。osu!lazer 的 `ManiaHitWindows.SpeedMultiplier`（ppy/osu#24636）同样把窗口乘以 rate。也就是说 mania 的歌曲时间轴窗口 = 原始窗口 × rate，而 tosu 的 `hitErrors` 是歌曲时间轴的误差。
- 修改：`localWindows()` 恢复并统一为 `Math.floor(window * modsRate) + 0.5`，stable / lazer 两条路径都按 rate 缩放（原先 stable 路径完全没有乘 rate，DT/HT 下判定整体偏严）。
- 测试：lazer DT 期望恢复为 `[23.5, 57.5, 107.5, 152.5, 188.5, 243.5]`，并新增 stable v1 DT 断言 `[24.5, 57.5, 107.5, 152.5, 188.5, 243.5]`。
- 注：审查第一轮曾误判为“lazer 回退路径多乘 rate”并把窗口改成不缩放，0.5.2 已更正（见 [ppy/osu#13187 讨论](https://github.com/ppy/osu/discussions/13187)）。

### 6b. 回放重新播放时统计面板不归零
- 文件：`main.js`、`test/mrm-test.mjs`
- 问题：exact / 缓存回放会在开局把整局判定预填进 `noteState`，而统计面板在 tosu `play.hits` 为 0 时会回退到 `computedCounts()`（全量时间轴），导致重新播放时面板直接显示整局最终统计；`unstableRate()` 同样读取全量累加器，不会随时间轴回退。
- 修改：
  - `computedCounts(t)` 增加时间过滤：只统计 `pointJudgedAt(p) <= t` 的判定（命中用 `p.at = time + error`，miss 用 `p.time`），统计面板随回放播放进度增长，倒带/重播自然归零。
  - `unstableRate(t)` 在 cached / exact 模式下按 `p.at <= t` 从 `state.points` 重新计算，实时模式仍用原有累加器。
  - `drawStats(ctx, opacity, t)` / `renderScene` 透传当前回放时间。
- 测试：新增 4 条断言——缓存回放在 t=0 全零、t=1001 计入首两个音符、UR 在首个判定前为 0、播完后统计完整。

### 7. run 缓存无上限增长
- 文件：`main.js`
- 修改：`runMemory` 增加 LRU 上限（60 个 key）；localStorage 写入失败时调用 `pruneStoredRuns()` 清理一半 `mrm.run.*` 条目后重试一次。

### 8. 低级键盘钩子回调内同步 I/O
- 文件：`tools/key-hook.ps1`
- 修改：回调只写入 `BlockingCollection`（容量 4096，`TryAdd` 不阻塞），由后台线程消费并 `Console.WriteLine + Flush`，避免钩子回调被 stdout 阻塞导致 Windows 摘除钩子或全局输入卡顿。

## P3 体验 / 配置

### 9. `helperUrl` 未限制且文档与 schema 不一致
- 文件：`main.js`、`settings.json`
- 修改：`helperBase()` 只接受回环地址；`settings.json` 新增 `helperUrl`、`helperToken`、`exactReplay`、`exactLive` 四项，tosu 设置面板现在可以真正配置它们。

### 10. live SSE 错误静默
- 文件：`main.js`
- 修改：`source.onerror` 首次触发时输出一条 `console.warn`，便于排查 helper 未启动的问题。

## 工具 / 部署

### 11. helper 双击启停（最简形态）
- 文件：`tools/start-helper.bat`、`tools/stop-helper.bat`、`tools/start-helper.vbs`、`tools/mrm-helper.mjs`、`main.js`
- 需求：不做登录自启 / 计划任务 / 常驻 watcher，只要双击即启动 helper、隐藏到后台，并在不需要时自动收尾。
- 实现：
  - `start-helper.bat` 调用 `start-helper.vbs` 以隐藏窗口启动 helper（osu 目录无需填写，helper 自动探测：`TOSU_OSU_PATH` → tosu.env → 运行中的 osu! 进程 → 注册表 → 系统默认位置；需要覆盖时把路径作为参数传入），双击后无控制台窗口；`stop-helper.bat` 立即结束 helper 的 node 进程。
  - helper 新增 `--watch-process "osu!,tosu"`：每 15 秒用 `tasklist` 检查，两者都出现过之后，任一进程消失就自行退出（先启动 helper 再开游戏时不会被误杀）；`--exit-idle`（启动器默认传 600 秒）作为兜底。
  - 插件每 25 秒发一次 `/status` 心跳刷新兜底计时；心跳失败静默，不影响无 helper 的回退模式。

### 14. 回放小幅回退后部分 note 不再渲染（0.5.2）
- 文件：`main.js`、`test/mrm-test.mjs`
- 问题：`visibleStartIndex` 的渲染游标只在「回退超过 1500ms」时重置，且重置时只回看 30 秒。回放复盘经常做小幅回退（<1.5s）或拖回某段，游标停在前方后，回退区间内的 note 不再被绘制，表现为「部分 note 未渲染」；超过 30 秒的长条在重置时也可能被跳过。
- 修复：任何向后的时间跳变（超过约一帧的 32ms）都将游标重置为 0，再由剔除循环前进到首个可见 note；同时去掉 30 秒回看限制。
- 验证：真实回放（2681 note）全量渲染对齐、判定 2681/2681；新增单测「小回退后 note 恢复渲染」；`node test/mrm-exact-test.mjs` 仍为 6/6。

### 15. 实时按键延迟：hookSongTime 锚点偏置（0.5.2）
- 文件：`main.js`、`test/mrm-test.mjs`
- 问题：旧实现只在**首个按键事件**建立一次映射（anchor = 当次 `renderTime()`）。若首个事件因钩子启动、谱面加载或浏览器卡顿而延迟，这个偏移会被永久记录；之后每次漂移只按 2% 修正，大偏差要几十个事件才收敛，表现为实时判定与动作位置明显滞后；速率偏差时还会出现最大 400ms 的锯齿。
- 修复：`hookSongTime` 改为「事件间推进 + 偏差重同步」——每个事件按钩子时间差 × rate 从前一个事件推进（密集段落保留高精度相对时序）；当事件间隔 >750ms 或与游戏时钟偏差 >120ms 时，直接重同步到 `renderTime()`，消除锚点偏置与速率锯齿。
- 验证：新增单测「停顿后钩子时钟重同步到游戏时钟」；原有 1:1 与 rate 1.5 缩放断言保持通过。

### 16. 实时判定偏差：用游戏 hitErrors 校正（0.5.2）
- 文件：`main.js`、`test/mrm-test.mjs`
- 排查：实测键盘钩子 → helper → SSE 端到端约 8ms（不是管道延迟）。实时误差此前完全由插件的时间基准 `renderTime()` 推算；该基准只在 v2 通道每 100ms 校准一次、间隙靠外推，平均会落后游戏时钟几十毫秒，导致实时判定的误差整体偏移（UR 正常，但颜色与动作标记与游戏不一致）。
- 修复：
  - 钩子事件只负责**列归属与预判**（立即上色）；当 tosu precise 的 `hitErrors` 到达时，按“隐含时间/误差最接近”与最近的实时匹配配对，用**游戏给出的精确误差**覆盖预判值（重算 `j`、`at`、统计量），颜色、动作标记与 UR 与游戏一致。
  - 双向配对：钩子事件先到进 pending 队列；`hitErrors` 先到则进 recent 缓冲，钩子事件到达时立即配对。V1 长条不参与覆盖（保持头尾合成逻辑）。
  - 偏差反馈：配对差值以 EMA 记入 `liveBias`，在 `hookSongTime` 中扣减，让预判值随时间收敛。
- 测试：新增 4 条断言——预判分类、hitError 覆盖、统计量一致（`errorSum`/`liveBias`）、误差先到仍能配对。

### 17. 卡顿/暂停后 hitError 记到后面的音符，原音符永远未判定（0.5.3）
- 文件：`main.js`
- 现象：截图中的音符已经越过判定线，却一直是未判定色（`#8fa3c8`），而它后面、还没到线的音符反而拿到了 300 的黄色判定。
- 原因：`renderTime()` 会从最后一次 v2 时间样本外推最多 300ms。暂停、WebView 卡顿或 tosu 抖动时，v2 样本过期或 precise 消息堆积，`implied = pressTime - e` 落到更晚的音符附近；`processError()` 用“最近音符”匹配，于是把判定记到后面的音符，真正被按下的那个音符永远没有判定。
- 修复：
  - `renderTime()`：时间样本超过 250ms 未更新时直接返回 `state.time`，不再外推；
  - `onPrecise()`：记录 precise 间隔，>120ms 视为卡顿，之后 500ms 内的 hitError 按音符顺序匹配；
  - `setTime()`：检测 >250ms 的前跳（暂停恢复、回放跳转），同样进入顺序匹配；
  - `processError()`：若推算时间比最早未判定音符超前 >260ms 且没有待补 miss，按音符顺序匹配。
### 18. 没有按键提示时仍启用“第 4 列排除法”（0.5.3）
- 文件：`main.js`
- 现象：无关卡/客户端，个别 hitError 会被固定配到第 4 列。
- 原因：`updateKeyHints()` 只要收到 tosu 的 4 个 key 槽位就把 `keyHintExposed` 设为 `[true,true,true,false]`，但 stable mania 的 `keys` 恒为 0，`keyHintSeen` 从不为真；`consumeError()` 仍按“前三列已知、只剩第 4 列未知”做排除，把落点接近第 4 列的 hitError 强行归到第 4 列。
- 修复：仅当 `keyHintSeen === true` 时才执行排除法，否则交给 `processError()` 做时间/顺序匹配。
- 验证：92/92 单测通过；A/B 仿真中，同样的“时钟前跳 + 单个延迟 hitError”场景由“记到 2776ms 音符”变为“正确记到 2261ms 音符”。

### 19. 回放（.osr）判定结果与 stable 实际评分不一致（0.5.4）
- 文件：`main.js`、`test/ln-analyze.mjs`
- 现象：与 osu! 实际结算对比，回放（exact）路径的判定分布偏差极大——4K LN 图 OD8 一局中 V1 模式 note 级总偏差（L1）为 890（游戏 `1264/997/102/13/6/5`，插件 `1704/604/58/9/11/1`），ScoreV2 模式点级 L1 为 618；表现为长条整根颜色错、头尾判定互换、密集 LN 段落「整排串色」。
- 原因：exact 路径自建了一套简化模型 —— `lockPoint()` 按「该列最早未判定点」匹配（松手时甚至能抢到尚未开始的长条尾点），V1 长条用头尾误差**平均**再套绝对窗口分档，ScoreV2 也不区分「头判未命中时尾判降级」等 stable 规则；同时 helper 解出的 `.osr` 帧时间相对谱面时钟有约 2.6 秒的整体偏移，`fitExactOffset()` 只能给出粗估，误差足以跨过判定边界。
- 修复：按参考实现 Mania-Replay-Master（Keytoyze，Apache-2.0，`judger/OsuManiaJudger.kt` + `BaseJudger.kt`）移植判定模型：
  - 新增 `replayWindowTable()`：V1 用 `[16,34,67,97,121,158] + 3*(10-OD)` 截断整数并乘 HR/EZ 系数；ScoreV2 用 lazer 的 `DifficultyRange(22.4,19.4,13.9)` 等六段，同样截断整数（游戏实际用的就是截断值，此前插件用的是四舍五入 +0.5）。
  - 新增 `judgeReplayNotes()`：按列先进先出扫描、`TOO_EARLY` / `TOO_LATE` 语义、长条「同列下一个 note 覆盖的过晚判定」「hold 过长的反向扫描」等规则；V1 长条由 `judgeRelease()` 给出**头尾合并**的单一判定（`totalDiff <= window*rate*2`，rate 1.2/1.1/1.0），ScoreV2 头尾分开且「头判未命中/已 miss 时尾判降为 MEH」，与 stable 一致。
  - `applyExactTimeline()` 改为用该模型直接写入 `points` / `noteState`（V1 整根同色、ScoreV2 头尾分色），未命中的 note 统一按 miss 上色，不再依赖 `lockPoint()` 与超时 `sweepMisses()`。
  - 新增 `exactOffsetFor()`：先用 `fitExactOffset()` 粗估，再用 helper `/replay` 返回的 `.osr` 计数在 ±80ms 内逐毫秒最小化计数偏差，自动定标（实测稳定收敛到 -2629）；helper 的 `/replay` 增加可选 `file=` 参数以便精确指定哪一局回放（同一张图多局 `.osr` 时不再取错）。
- 验证（`node test/ln-analyze.mjs`，真实录制 + 真实 `.osr`）：
  - V1 局（`ln-logs/session-v1-1`）：note 级 `1265/998/105/11/6/2`，游戏 `1264/997/102/13/6/5`，**L1 890 → 10**。
  - ScoreV2 局（`ln-logs/session-ln3`）：点级 `2346/1317/245/20/5/10`，游戏 `2342/1315/245/17/8/16`，**L1 618 → 18**。
  - `node test/mrm-test.mjs` 92/92 通过；离线渲染冒烟（exact 应用后连续 `frame()`）无异常。

### 20. 实时（Live）判定归属与长条尾判错乱（0.5.4）
- 文件：`main.js`、`test/ln-analyze.mjs`
- 现象：V1 模式实时游玩时大范围错色 —— 长条整根变紫/红、头尾判定互换、同一排和弦串列；note 级分布与游戏相差 448（L1），135 条长条被渲染成 50/200，而游戏里对应的只有 6/102。
- 原因：
  1. `applyLiveKey()` 用 `lockPoint()` 只取「该列时间最近/最早的未判定点」，松手时不检查该长条的**头是否已经按下**：实测 871 次松手被提前 1–164ms 判给尚未开始的尾点，141 次判给「头根本没按」的长条，circle 的松手也会去抢同列尾点。
  2. 游戏 `hitErrors` 的校正按「误差值最接近」配对；LN 密集处误差值大量重复，配对经常错位，±几十毫秒的偏差让判定档位整体翻转（0↔1 约 1000 个点）。
  3. V1 长条用「头尾误差平均」再按绝对窗口分档，与客户端「头尾距离相加、窗口放宽 1.2/1.1 倍」的合并规则不同。
  4. `sweepMisses()` 在音符刚出窗口就当 miss，尾判的 hitError 晚 10–30ms 到，先判 miss 后到的误差被丢弃。
- 修复：
  - 新增 `lockLivePoint()`：按列先进先出找第一个仍在窗口内的点；已超窗口的点按 miss 消费（与客户端一致，不堵住该列）；**V1 长条的尾点只在头判已命中后才可匹配**；并补上「过早」判断。
  - `applyLiveKey()` 改用 `lockLivePoint()`，V1 长条的头/尾现在也能接受游戏 `hitErrors` 校正。
  - `correctLiveError()` 改为「隐含按键时间 + 误差值」联合打分（时间权重 0.25），不再单纯按误差值最近配对；失败时才退回最近误差。
  - `classifyLongNote()` / `settleV1LongNote()` 改为客户端的合并规则：`totalDiff = |头误差| + |尾误差|`，`totalDiff <= 窗口*rate*2`（rate 1.2/1.1/1.0），尾判早放超过 miss 窗口判 miss。
  - `sweepMisses()` 增加 30ms 宽限，等迟到的 hitError/按键事件。
- 验证（`node test/ln-analyze.mjs`，同一份 V1 录制回放，对比游戏结算）：
  - note 级 live 分布 `1052/990/155/59/131/0`（L1 448）→ `1273/964/117/14/15/4`（**L1 68**）；游戏 `1264/997/102/13/6/5`，回放（exact）`1265/998/105/11/6/2`（L1 10）。
  - 头判类不同的 note 1195 → 264，尾判 884 → 194；`|dE| <= 5ms` 5.7% → 80.3%，`|dE| > 50ms` 222 → 70（1.8%）；着色延迟 p95 171.4 → 111.2ms；miss 延迟中位 -232.4 → 24.8ms。
  - ScoreV2 录制同样回放：头判类不同 507 → 377，回放侧 L1 仍是 18（无回退）。
  - `node test/mrm-test.mjs` 92/92 通过。

### 21. ScoreV2 下把 LN 提前松手当成"重开"，整屏已渲染音符回退为未判定色（0.5.4）

**文件：** `main.js`

**现象：** 采用 ScoreV2（V2）判定游玩时，长条提前松手被判 miss 的瞬间，画面上**已经上色的音符（含附近没关系的 LN）整片变回未判定色 `#8fa3c8`**，随后只能靠后续事件零散重画；V1 也会出现（任何让 play.score 回退的判定都会触发）。

**原因：** `applyPlayUpdate()` 的"重开检测"用 `play.score` 是否下降来判断重开。ScoreV2 每打一个判定都会重算总分，LN 提前松手被改判 miss 时游戏会**扣掉已计入的分数**，于是 score 出现小幅回落（实测一局 164s 内 31 次），被误判成"重新开始"，调用 `resetJudgements()` 清空全部渲染状态。

**修复：** 重开检测只看判定计数：`totalHits + max(2, 0.2% note数) < lastHitsTotal` 才算重开（真重开时计数会清零，必然触发）；score 单独回退不再重置。同时记录 score 供其它逻辑使用，但不再作为重置依据。

**验证：** 用 session-ln3（ScoreV2，164s，3943 判定点）离线重放同一份 `main.js`：
- 修复前：31 次 score 回退 → 31 次 `resetJudgements()` → **67,232 次 point 级回退**（41,692 note 级），live 最终 counts 只剩 `miss 3931`，等于整屏塌掉；
- 修复后：play 期间 **0 次重开重置**（仅开局那条陈旧 live 样本 + 首次按键的两条无害重置），live counts `[2147,1202,455,96,29,14]`，与回放 `[2346,1317,245,20,5,10]` 处于同一量级；
- `node test/mrm-test.mjs` 92/92 通过。

### 22. ScoreV2 长条尾判按原始误差分档，判定档位整体偏严（0.5.4）

**文件：** `main.js`

**现象：** ScoreV2 游玩时密集 LN 段落整排颜色偏深/偏差（大量本应 MAX/300 的尾巴被画成 200/100），与结算差异明显。

**原因：** 客户端对 ScoreV2 长条的**释放**判定不是直接拿释放误差查窗口，而是先把释放误差除以 1.5 再查（参考实现 `judgeRelease` 的 `endDiff / 1.5`）；另外头判未命中（miss/未判）时尾巴最多只能算 MEH。本插件实时路径直接用 `|释放误差|` 查窗口，等于把尾巴判得严格 1.5 倍。

**修复：** 新增 `classifyV2Tail(noteIdx, endError)`：`classifyError(|e| / 1.5)`，若该 note 的头未命中则 0..3 档降为 MEH；`applyMatch()` / `correctMatch()` / `updateWindows()` 在 `state.scoreV2 && p.end` 时改用它。

**验证（session-ln3，ScoreV2，3943 判定点，对比 osu! 结算 `[2342,1315,245,17,8,16]`）：**
- 修复前 live `[2147,1202,455,96,29,14]`（L1 620）→ 修复后 `[2348,1264,271,35,11,14]`（**L1 106**）；
- 尾判类不同的 note 656 → **182**，头判 284（不变，头判受时间基准影响）；
- 着色延迟 p95 18.6ms，`node test/mrm-test.mjs` 115/115 通过。

- **实时误差配对（2026-10-31 实验，未采用）**：试过三种替代 `correctLiveError()` 的配对策略（判定顺序 FIFO、按容差门控的 FIFO 优先、缓冲后单调一维排序匹配），同一份 ScoreV2 录制（session-ln3）离线对比均比现有「隐含时间 + 误差值」打分配对差：`|dE|>50ms` 由 138 升到 149 / 160 / 162，尾判类别不同的 note 由 182 升到 189 / 192 / 206，故保留原策略。诊断结论：**99.9%（3927/3929）的实时判定点已经拿到游戏原始 hitErrors**，剩余 3.5% 不是「拿不到误差」而是密集段落里同一误差值重复出现导致的归属歧义，受 `/websocket/v2/precise` 没有 `currentTime`（时间只能靠 100ms 的 v2 样本外推）所限；要再往下压需要给 tosu 打补丁输出逐判定时间/列。

### 23. 批次 B：失效检测被短路、可见区间游标、exact 数据校验（0.5.4）

**文件：** main.js

**原因：** 审查（批次 B）发现的整合类缺陷——
1) exact 判决写入后 state.cached=true，重开检测与时间回退检测都被 !cached 短路，onPrecise 又因 exactApplied 早退：状态仍是 play 的快速重开会继续显示上一局 .osr 的判定，新的 hitErrors 全被丢弃；
2) 可见区间游标只在谱面对象变化或时间回退 32ms 时重置，不随时间跨度失效：调大 reviewTime 或调慢滚动后，判定线下方已经过线的音符成片不画（实测 60 帧缺画 520 帧次、最差单帧缺 11 个）；
3) helper 返回的 actions 未校验 column，越界/undefined 会让 fitExactOffset 抛 TypeError，而 applyExactData 在 try 之外、exactKey 已置，于是每 100ms 一次 unhandled rejection、exact 永不生效；
4) 游玩中切换 analysisMode / exactLive 不清理状态：exact 判决仍在时 Live 既不吃 hook 按键也不吃 hitErrors，EventSource 也不关；
5) 抓 .osu 没有超时（/files/beatmap/file 挂起则 pendingKey 永不清、永久 loading）；
6) helper 的 hello 里 hook:false 仍置 liveReady，Auto 模式会把 helper 里同 md5 的上一局 .osr 套到实时游玩，且没有按键事件能解除；error / hookexit 事件被完全忽略；
7) renderScene 没有 try/finally，异常会让 canvas 的 clip / save 栈残留；
8) RUN_VERSION 仍是 4，0.5.4 重写判定模型后旧算法的 run 缓存（matches 数组）仍会被 loadRuns 接受，老谱重看会显示旧的错误匹配。

**修复：** 重开检测只看判定计数（score 仍记录但不参与）；时间回退时清 runPrefix / replay 缓存；onPrecise 检测「exact 判决仍在但新局 hitErrors 明显更少」时丢弃旧判决；getScroll 重建滚动映射时重置可见游标；actions 过滤增加 column 合法性；applyExactData 包 try/catch；updateSettings 检测模式变化后 closeLive / clearReplayRun / resetJudgements；新增 fetchWithTimeout（5000/4000ms）替换三处抓谱请求；hello 按 hook 真假设置 liveReady 并处理 error / hookexit；frame 的渲染块改为 try/catch/finally；RUN_VERSION 升到 5。

**验证：** node test/mrm-test.mjs 92/92 通过；session-v1-1 与 session-ln3 的 exact / live 指标与修复前逐项一致（exact L1 10 / 18、live 2165,1239,423,85,25,6 / 2348,1264,271,35,11,14）。

### 24. 批次 C：exact 偏移定标性能、helper 资源与生命周期（0.5.4）

**文件：** main.js、tools/mrm-helper.mjs

**原因：** 审查（批次 C）发现——exactOffsetFor 在 onV2 主线程同步跑 161 次全量 judgeReplayNotes（2387 notes / 2400 actions 实测 438ms，长图开局冻结约 0.5s）；fitExactOffset 的 ±12s 粗扫用 961 次全量打分；helper 的 LZMA 解压没有输出上限（损坏/截断的 .osr 可解出巨大字符串耗尽堆），osrCache 无界；SSE 没有心跳、死连接不会被清理，/live 的 keys 未 clamp，多客户端不同 keys 会互相静默换掉钩子；spawn 失败与 server EADDRINUSE 都没有错误处理（直接崩）；localStorage 的 run 缓存超限时按「键列表前一半」删除，可能删掉最新的几局，且游玩中每 3s 同步写三份。

**修复：** 偏移定标两阶段化（±80ms 先 8ms 粗扫再 ±7ms 精扫，161 次 → 33 次）；fitExactOffset 的粗扫改用 1/10 采样、精扫合并成单趟打分；LZMA 解压上限 8MB 且空/超限视为 found:false；osrCache 上限 24 条；SSE 每 10s 发 ping、close/error 统一清理、keys clamp 1..18、hello 回报当前钩子 keys；spawn 与 server 增加 error 处理（EADDRINUSE 打印后 exit 1）；run 缓存按时间戳保留最新 30 局，saveRun 非结算时 5s 节流。

**验证：** exactOffsetFor 438.1ms → 82.9ms（fit 44.3ms、applyExactTimeline 4.2ms），offset 仍收敛到 -2629、exact counts 仍为 [2346,1317,245,20,5,10]；helper 实测：无 Origin 请求 403、回环 Origin 200、外部 Origin 403；/live hello 带 hookKeys、10s 后收到 ping；同端口再起实例打印 server error 并 exit 1。
### 25. 批次 D：exact 判定模型没有结果级断言、跳过被当成通过、分析器时钟被重复设置（0.5.4）

- 现象：`.osr` 判定模型（`judgeReplayNotes` / `judgeRelease` / `replayWindowTable`）在 0.5.4 重写后仍然只有一条「`applyExactTimeline` 返回 true」的断言；端到端测试缺 `MRM_MAP_INDEX` 时直接 `process.exit(0)`，CI 视为通过且会留下 helper 进程；离线分析器在 `api.onV2()` 之后又调了一次 `api.setTime(live)`，同一 `performance.now()` 下 `dt == 0`，`timeSpeed` 被固定为 1，`onPrecise` 的 `timeSpeed > 1.25` 分支永远不会被覆盖。
- 修复：
  - `test/mrm-test.mjs` 新增「exact judgement model」小节：窗口阈值边界、点击 / 过早 / 过晚 / 和弦、V1 长条合并、V1 提前松手判 miss、V2 头尾分离与晚放只丢尾、`exactOffsetFor` 定标、`applyExactTimeline` 端到端计数；并新增「playback clock extrapolation」小节（DT 时 `timeSpeed` 上升、`renderTime` 外推、陈旧样本冻结）。
  - `main.js` 导出 `getJudgementClass` / `judgeRelease` / `replayJudgementCounts` / `classifyV2Tail` 供测试直接断言。
  - `test/mrm-exact-test.mjs`：缺 map index 时打印 SKIP 并 `exit 2`（不再算通过），`finally` 中照旧 `helper.kill()`，spawn 失败有错误输出。
  - `test/ln-analyze.mjs`：只在 `onV2()` 没有推进时钟时才补 `setTime()`，并输出 `timeSpeed` 实际范围与 stalled 计数。
- 验证：`node test/mrm-test.mjs` 92 → **112/112** 通过；`node test/mrm-exact-test.mjs` 缺索引时输出 `Summary: SKIPPED (exit 2, helper killed)`；session-ln3 的 `timeSpeed` 范围由固定 1 变为 0.042..1.025（1x 谱面本身不会触发 DT 分支，但分析器不再掩盖它），回放对比计数不变。

### 26. 批次 P2：连接层健壮性、设置重发、流中断不再清屏、窗口表校验、helper 回放定位（0.5.4）

**文件：** main.js、tools/mrm-helper.mjs、test/mrm-test.mjs、FIXES.md

**原因与修复：**

1. **SocketManager 硬编码 `ws://`、无重连退避、丢弃 tosu 的 `error` 载荷**：https 部署会连不上；tosu 重启期间每 1s 重连一次；`applyFilters` 被拒绝时错误被静默吞掉。改为按 `location.protocol` 选 `ws/wss`，指数退避 0.5/1/2/4/8/10s（连上即复位），`error` 载荷去重后 `console.warn`，并新增 `closeAll()` 供页面卸载时关闭。
2. **ws 重连后不重发 `getSettings`**：`requestSettings()` 只在启动时调用一次，tosu 重启后插件设置永停默认值。现在 `SocketManager.open()` 支持 `onOpen` 回调，`/websocket/commands` 每次（重）连都会重发一次 `getSettings`。
3. **2.5s 收不到 v2 就把状态切成 `not_ready`**：一次 tosu 卡顿会清空整屏判定并写半局存档。改为 5s 阈值 + `state.streamStale` 标志：渲染与 miss 扫描冻结在最后一个采样（`renderTime()` 直接返回 `state.time`），状态行提示 `tosu stream stalled`，v2 恢复后自动继续，判定不再丢。
4. **lazer `hitWindow` 只校验 `perfect`/`miss`**：payload 缺 `great/good/ok/meh` 时会构造出 0ms 窗口，整张图判成 MEH/MISS。改为 `WINDOW_KEYS.every((k) => num(hw[k], 0) > 0)` 才采用，否则回退到 OD 窗口表。
5. **helper 找不到 osu!lazer 命名的回放**：lazer 的 `.osr` 文件名是 score id，不含谱面 md5，`findReplayFile()` 按文件名前缀永远不命中，Replay 精确模式无数据。新增 `readHeaderMd5()`（只读文件头）并在按名未命中时扫描最近 600 个 `.osr` 的头部 md5 匹配。
6. **测试**：`hook clock resyncs to game clock after a stall` 由 5ms 容差改为「2s 停顿后映射只前进 1ms 钩子增量且与冻结时钟差 <5ms」，避免恒真断言。

**验证：** `node --check main.js`、`node --check tools/mrm-helper.mjs` 通过；`node test/mrm-test.mjs` **112/112**；两局回归与批次 A–C 后一致（session-ln3 live `[2348,1264,271,35,11,14]` / exact `[2346,1317,245,20,5,10]`；session-v1-1 exact `[1959,1755,194,20,12,3]`）。

### 27. HT/DT 下回放判定窗口没有按 rate 缩放（0.5.4）

**现象**：HT（0.75x）的 `.osr` 回放里完美判定明显多于游戏（同一张 4K LN 图，V1 note 级 L1 776，MAX 1828 vs 游戏 1440）；DT 会反向偏少。实时路径没有这个问题。

**原因**：stable 按**实时**时间判窗，所以在歌曲时钟里有效窗口 = 基础窗口 × rate。实时路径的 `localWindows()` 一直有 `v * rate`，回放的 `replayWindowTable()` 忘了乘，HT 下窗口偏大、DT 下偏小。

**修复**：`main.js` 新增 `scaleReplayWindows(w)`（`rate = state.modsRate || 1`，rate 为 1 时原样返回），`replayWindowTable()` 的 V1 / ScoreV2 两个分支统一包一层。`test/mrm-test.mjs` 增加 3 条断言（OD8 的 V1 表、HT 下 V1/V2 表 = 基础 × 0.75）。

**验证**：HT + V1、同图 120s 录制（`ln-logs/session-v1-ht`，`.osr` `...-134379172796988711.osr`）。修前窗口不缩放 → L1 776（`[1828,512,41,2,1,3]`）；修后 `exactOffsetFor()` 自动定标 -2633 → note 级 L1 **44**（`[1440,834,102,7,1,3]` vs 游戏 `[1440,851,80,11,1,4]`）。同一录制经 `test/ln-analyze.mjs` 对比：|dE| ≤ 5ms 98.8%、> 50ms 仅 2 点，着色延迟中位 -5.5ms。分析器同时补了按 rate 的时钟映射（`songAt()` 用 v2 样本分段外推），此前 HT 下 `t - live` 不是常量，着色延迟曾报出 2814ms 的假值。

---

### 28. P3 清理：死代码、空守卫、统计/渲染小问题、工具与文档脚注（0.5.4）

文件：`main.js`、`tools/mrm-helper.mjs`、`tools/key-hook.ps1`、`tools/stop-helper.bat`、`README.md`、`test/mrm-live-monitor.mjs`、`test/mrm-live-check.mjs`、`test/mrm-test.mjs`。

- 死代码：删除 `lockPoint()` 及其调试导出（精确回放重写后已无调用）、`state.tailIndex`（只写不读）、`state.exactOffset`（只写不读）。
- 空守卫：`markPointMiss()` / `markCandidateMiss()` 先判 `state.beatmap` 与 `notes[p.note]`，避免谱面未加载时的 TypeError。
- 取值约束：`hexToRgba()` 的 alpha clamp 到 0..1；渲染用的 `noteStroke` clamp 1..12；`updateKeyHints()` 的 count 增量上限 4 → 16（高速连按不再丢边沿提示）。
- 渲染与统计：`drawActionHold()` 起点修正，补齐末端 2 格；`unstableRate()` 对 V1 长条的尾点去重（不再双计），并加 250ms 桶缓存（key 含 cached / exactApplied / statCount）；`rev` 摘要串补上判定色、`maniaScrollSpeedOverride`、`showHitLine`、cached/exactApplied，设置改动不再漏重绘；进入 play 时清空 `state.hits` / `accuracy` / `lastLive`，首帧不再显示上一局数字。
- 时序与生命周期：`frame()` 的流中断判定与 `sweepMisses()` 移到 `fpsLimit` 节流之前并去掉重复 sweep（`fpsLimit = 1` 时 miss 不再延迟约 1 秒）；`ensureLive()` 先构造 `EventSource` 再写 `liveKey`，构造异常时告警并置 `helperState = "error"`，不会把通道标记成 ready。
- 网络与路径：抓谱 URL 改用 `${location.protocol}//${host}`（https/反代下不再硬编码 http）；helper 的 `.cfg` 候选列表加 30s TTL（玩家改键位后不再用旧缓存）；`/replay` 的 500 内部记录 stack、对外只回 `error: "internal error"`；`key-hook.ps1` 的 C# 源码按 SHA1 缓存编译产物到 `%TEMP%\mrm-keyhook\MrmKeyHook-<hash>.dll`，第二次起的 spawn 直接 `Add-Type -Path`（实测 hook 就绪 hello 在 ~40ms 内返回 `hook: true`），队列满时写 stderr 而不再静默丢弃。
- 工具与文档：`stop-helper.bat` 统计进程数并如实输出 "not running" / "stopped (N process(es))"；`README.md` 的 OBS URL 改用本副本目录名 `Mania%20Replay%20Master%20(fixed)` 并注明"URL 目录名必须与 static 下文件夹同名"；`mrm-live-monitor.mjs` 的过滤器发送补 `applyFilters:` 前缀（裸 JSON 被 tosu 忽略）；`mrm-live-check.mjs` 按 hook/事件状态 `process.exit(1)`（原来恒 0）；`mrm-test.mjs` 的 `currentTime` 断言改名为兼容分支，避免让读者以为精确时钟是可用的。
- 未改动：`window.__maniaReplayMaster` 暴露可变的 `state` / `settings` / `canvas` / `sockets` 是有意的调试与离线测试接口，保留。
- 验证：`node --check` 全通过；`node test/mrm-test.mjs` 115/115；两局 1x 录制回归判定数字未变——session-ln3 live `[2348,1264,271,35,11,14]` / exact `[2346,1317,245,20,5,10]`，session-v1-1 live `[2165,1239,423,85,25,6]` / exact `[1959,1755,194,20,12,3]`。

## 未改动 / 保留的已知设计
- `classifyError()` 对超出 50 窗口的已记录误差固定归类为 50（测试 `recorded hit never classifies as miss` 固化）：依赖 tosu precise 只上报“已命中的判定”。如未来 tosu 开始上报 miss，需要重新评估。
- **DT/HT 下 exact 与 live 的窗口缩放不一致（待验证）**：exact 路径用 map 时间窗口（与参考实现 `Utils.adjust` 一致），live 路径的 `localWindows()` 乘了 `modsRate`；两套语义不可能同时正确，需要一局真实 DT/HT 录制（helper 的 `.osr` counts 可作目标）确认后统一，本次未改。
- **V1 长条只有尾判证据时的定档（待验证）**：`settleV1LongNote()` 在头判被钩子确认但无误差值时用 `classifyError(tailError)`（比参考实现的 `startDiff+endDiff` 合并规则严），无录制证据可验证，保持现状。
- **V1 晚放超窗（待验证）**：`classifyLongNote()` 只在 `endError < -missW` 时判 miss，晚放一律按合并窗口降档，与参考实现的 `judgeRelease` 一致（其 `TOO_LATE` 只用于“键没按下”的情形），故不算缺陷但需要真实数据确认。
- **`odConverted × rate` 是否双缩放（待验证）**：`localWindows()` 先用 `odConverted` 再乘 `modsRate`，与 lazer 的判定窗口语义（OD 与 rate 独立）理论上不冲突，但缺少 DT 实测。
- **`sweepMisses` 受 `fpsLimit` 门控（P3）**：`fpsLimit=1` 时 miss 会晚 1s 出现；不常用且属性能取舍，未改。
- `fitExactOffset()` 仍在浏览器主线程执行；长图首次加载可能有一次性卡顿，后续可下沉到 helper 计算。
- `state.errorCount` 同时承担“precise 已消费下标”和“exact 统计数”两种含义；本次仅修复行为，未做字段拆分，改动该字段需要同步梳理 `onPrecise` / `applyRun` / `applyExactTimeline` 三处。
- `frame()` 的 `rev` 签名仍包含逐帧变化的时间戳，等价于每帧重绘；属于既有渲染设计，未做脏区域优化。
