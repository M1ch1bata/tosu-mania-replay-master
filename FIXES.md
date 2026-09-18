# 修复记录（相对上游 0.5.0）

本目录 `Mania Replay Master (fixed)` 是代码审查后的修复版本，版本号 0.5.2（基于上游 0.5.0）。
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
- 关键事实：用户运行的 **tosu v4.20.0** 在 `/websocket/v2/precise` 每个包都带 `currentTime: global.playTime`，且 `preciseDataPollRate = 10ms`（见 `packages/tosu/src/api/utils/buildResultV2Precise.ts`、`packages/common/utils/config.ts`）。插件此前只读取了 `hitErrors`，把高频时钟丢掉了。
- 修改：
  - `onPrecise()` 先消费 `data.currentTime`：`if (Number.isFinite(current)) setTime(current);`，再走原有逻辑，使 `renderTime()` 以 10ms 精度被持续校正（不支持的 tosu 版本自动忽略该字段）。
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
- 修改：`onV2()` 记录 `state.lastV2At`；`frame()` 中若 `play` 状态下超过 2.5 秒没有 v2 消息，调用 `handleGameStateChange("not_ready")`，正常走保存 run、关闭 live、清空画布流程。

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

## 未改动 / 保留的已知设计

- `classifyError()` 对超出 50 窗口的已记录误差固定归类为 50（测试 `recorded hit never classifies as miss` 固化）：依赖 tosu precise 只上报“已命中的判定”。如未来 tosu 开始上报 miss，需要重新评估。
- `fitExactOffset()` 仍在浏览器主线程执行；长图首次加载可能有一次性卡顿，后续可下沉到 helper 计算。
- `state.errorCount` 同时承担“precise 已消费下标”和“exact 统计数”两种含义；本次仅修复行为，未做字段拆分，改动该字段需要同步梳理 `onPrecise` / `applyRun` / `applyExactTimeline` 三处。
- `frame()` 的 `rev` 签名仍包含逐帧变化的时间戳，等价于每帧重绘；属于既有渲染设计，未做脏区域优化。
