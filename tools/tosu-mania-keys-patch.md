# 建议的 tosu 补丁：让 precise 暴露完整的 mania 逐列按键

## 为什么需要

- 插件（浏览器沙箱）抓不到全局键盘；唯一不额外开进程的数据源是 tosu 自己。
- 两个客户端内部都有逐列状态：
  - **osu!lazer**：`SDL3Window` 收 `SDL_EVENT_KEY_DOWN/UP` → `ManiaInputManager : RulesetInputManager<ManiaAction>`（`Key1..Key20`，`SimultaneousBindingMode.Unique`）；回放 `ManiaReplayFrame.Actions` 以位掩码写入 legacy 帧的 `MouseX`。
  - **osu!stable**：窗口消息 → `InputManager` → mania 每列按键状态；回放 `x` 字段就是逐列位掩码；内存里的 mania key overlay 每个元素对应一列。
- tosu 的 API 只固定输出 `keys.k1/k2/m1/m2` 四个槽；stable 的读取器更是只构造 3 个元素（`if (mode === 0)` 才补第 4 个）。所以 5K–10K 拿不到完整列信息。

插件侧（0.7.1 起）已经能消费完整列数组：`precise.keys` 可以是数组，或 `precise.keys.maniaKeys` 数组；收到后按列提示 + `hitErrors` 精确误差判定，多 K 自动生效。

## 补丁 1：API 层（对 stable/lazer 都需要）

`packages/tosu/src/api/utils/buildResultV2Precise.ts` 里 `keys` 的构造（v4.20）：

```ts
return {
    currentTime: global.playTime,
    keys: {
        k1: { isPressed: gameplay.keyOverlay.at(0)?.isPressed ?? false, count: gameplay.keyOverlay.at(0)?.count ?? 0 },
        k2: { ... },
        m1: { ... },
        m2: { ... }
    },
    hitErrors: gameplay.hitErrors,
    tourney: ...
};
```

在保留现有字段的同时补一个数组：

```diff
     return {
         currentTime: global.playTime,
+        maniaKeys: gameplay.keyOverlay.map((k) => ({
+            isPressed: k.isPressed,
+            count: k.count
+        })),
         keys: {
```

`buildResult.ts`（v1/gosumemory）里的 `gameplay.keyOverlay` 同理，插件不依赖 v1，可一并加。

## 补丁 2：stable 内存读取器（lazer 不需要）

`packages/tosu/src/memory/stable.ts` 的 `keyOverlay(mode)` 目前固定 3 个元素，只为 `mode === 0` 补第 4 个。mania（mode 3）应返回 `itemsSize` 个元素：

```diff
-            const keyOverlay = [
-                { name: 'K1', ... item 0 ... },
-                { name: 'K2', ... item 1 ... },
-                { name: 'M1', ... item 2 ... }
-            ];
-
-            if (mode === 0) {
-                keyOverlay.push({ name: 'M2', ... item 3 ... });
-            }
-
-            return keyOverlay;
+            const keyCount =
+                mode === 3 ? Math.min(itemsSize, 20) : mode === 0 ? 4 : 3;
+            const keyOverlay = [];
+
+            for (let i = 0; i < keyCount; i++) {
+                const item = this.process.readInt(
+                    keyOverlayArrayAddr + 0x8 + 0x4 * i
+                );
+                keyOverlay.push({
+                    name: mode === 2 ? (['L', 'R', 'D'][i] ?? `K${i + 1}`) : `K${i + 1}`,
+                    isPressed: Boolean(this.process.readByte(item + 0x1c)),
+                    count: this.process.readInt(item + 0x14)
+                });
+            }
+
+            return keyOverlay;
```

- `itemsSize` 的读取与元素地址已经在原实现里；mania 的 items 就是各列。
- 若担心 stable 的 mania 计数不存在，`count` 会是 0，但 `isPressed` 可用，插件按键提示走的是上升/下降沿，不依赖计数。

lazer 的读取器（`packages/tosu/src/memory/lazer.ts` 的 `keyOverlay()`）本来就是遍历 HUD `InputCountController` 的触发器返回 N 个元素，**只需补丁 1** 就能透出全部列。

## 打完补丁后

1. 重新构建 tosu（`pnpm compile:win`）或向上游提 PR。
2. 插件无需改动：首次收到有效提示时控制台会打印 `tosu precise keys: column hints active (N slots)`，`state.keyHintSlotCount` / `state.keyHintSeen` 可用于确认。
3. 此时 5K–10K 的逐列判定不再需要 helper；观看回放仍可用 `.osr`（helper）或等待 tosu 侧提供回放读取。
