# osu!stable mania Random（RD）机制：格式、算法与集成指南

本文记录 osu!stable（mania 规则）**Random（RD）** mod 的实现细节，以及如何从一局回放中**确定性地重建**它产生的列置换。目标读者是其他 tosu 插件、谱面工具、回放分析器的开发者。

- 适用版本：stable `b20260924.1`（实验所用的版本），以及同一代使用 .NET Framework `System.Random` 的实现。
- 结论一句话：**RD 是每局随机、整局恒定的列置换；种子写在 `.osr` 的最后一帧 `-12345|0|0|<seed>`；置换 = 用 `System.Random(seed)` 做拒绝采样（`Next(keys)` 抽列，重复则重抽）得到。**

---

## 1. 数据在哪：`.osr` 的种子帧

`.osr` 由 header + LZMA 压缩的输入帧组成。mania 每一帧的格式是：

```
deltaTime|x|y|keys
```

- `x` 的低位是该帧的列位掩码（`1 << column`），`y` 无用（stable mania 下为 `22.81879`；DT/HT 时按 rate 缩放），`keys` 是鼠标键。
- `deltaTime` 是相对上一帧的时间差；负值表示时间跳变；**`-12345` 是结束标记**。

最后一帧长这样：

```
-12345|0|0|<seed>
```

第 4 个字段就是本局 RD 使用的 RNG 种子。osu!lazer 的解码器也承认这一点（`osu.Game/Scoring/Legacy/LegacyScoreDecoder.cs`）：

```csharp
if (split[0] == "-12345")
{
    // Todo: The seed is provided in split[3], which we'll need to use at some point
}
```

**只有 RD（以及所有需要随机化的 mod）才有意义**；no-mod 局也有这一帧，但种子不会改变列。种子是毫秒级递增的整数（本机实测 7 局：`30745429`、`30840347`、`30924341`、`34973272`、`35078231`、`35161951`、`35245621`）。

> 注意：这是 **stable** 的格式。lazer 的 `.osr` 同样带该帧，但 lazer 的 mania Random 走它自己的 `ModRandom` + `Seed` 设置，本文的 `.NET` 算法只对 stable 成立。

---

## 2. 算法：.NET System.Random + 拒绝采样

### 2.1 生成置换

```text
rng = new System.Random(seed)
shuffled = []
used = {}
while shuffled.Count < keys:
    v = rng.Next(keys)      # 0 .. keys-1
    if v in used: continue  # 重复就重抽
    used.add(v)
    shuffled.append(v)
```

`shuffled` 是 `keys` 長的一个排列，**下标 = 谱面原始列，值 = 显示列**：

```
displayedColumn(c) = shuffled[c]
```

因此反向（把玩家按下的显示列换回谱面列）就是它的逆：

```text
sourceColumn(d) = inverse(shuffled)[d]
```

### 2.2 为什么不是 Fisher-Yates

实测用 .NET `System.Random` 实现的 Fisher-Yates、`OrderBy(rng.Next())`、随机排序、插入式洗牌、pick-out 等全部无法复现（6 局全部失败）。唯一同时命中 6 局的配方是上面的**拒绝采样**——它看起来像 Fisher-Yates 的"抽完放回直到不重复"，但 RNG 消耗序列完全不同，所以之前测试的“错位”现象（某局种子算出另一局的置换）只是 24 分之一概率的巧合。

### 2.3 .NET Framework System.Random 的移植

下面是可直接用于 JS/TS 的实现（与 .NET Framework 4.x 的 `Random` 位级一致，已用 PowerShell 对拍：`Random(0).Next()` 前三个值 = `1559595546 / 1755192844 / 1649316166`）：

```js
function dotNetRandom(seed) {
  const MBIG = 2147483647;
  const MSEED = 161803398;
  const subtraction = seed === -2147483648 ? 2147483647 : Math.abs(Math.trunc(seed) | 0);
  let mj = MSEED - subtraction;
  const seedArray = new Array(56).fill(0);
  seedArray[55] = mj;
  let mk = 1;
  for (let i = 1; i < 55; i++) {
    const ii = (21 * i) % 55;
    seedArray[ii] = mk;
    mk = mj - mk;
    if (mk < 0) mk += MBIG;
    mj = seedArray[ii];
  }
  for (let k = 1; k < 5; k++) {
    for (let i = 1; i < 56; i++) {
      seedArray[i] -= seedArray[1 + ((i + 30) % 55)];
      if (seedArray[i] < 0) seedArray[i] += MBIG;
    }
  }
  let inext = 0;
  let inextp = 21;
  const sample = () => {
    if (++inext >= 56) inext = 1;
    if (++inextp >= 56) inextp = 1;
    let r = seedArray[inext] - seedArray[inextp];
    if (r === MBIG) r--;
    if (r < 0) r += MBIG;
    seedArray[inext] = r;
    return r * (1 / MBIG);
  };
  return (max) => Math.floor(sample() * max);
}

function rdShuffledColumns(seed, keys) {
  const next = dotNetRandom(seed);
  const used = new Set();
  const out = [];
  while (out.length < keys) {
    const v = next(keys);
    if (used.has(v)) continue;
    used.add(v);
    out.push(v);
  }
  return out;
}
```

### 2.4 验证向量

`keys = 4` 时（`shuffled` 用四位数字串表示，比如 `0132` 表示 `displayedColumn(0)=0, (1)=1, (2)=3, (3)=2`）：

| seed | shuffled |
| --- | --- |
| `0` | `2301` |
| `30745429` | `0132` |
| `30840347` | `2301` |
| `34973272` | `1302` |
| `35078231` | `3201` |
| `35161951` | `0231` |
| `35245621` | `1023` |

上表后 5 个 seed 来自真实回放；用这套算法 + 判定重建，本插件能把每局的判定计数复现到 **L1 ≤ 18**（7 局，见第 4 节）。

---

## 3. 与 Mirror（MR）叠加

- Mirror 是列下标翻转：`display = keys - 1 - c`。
- 两者同时启用时，本插件按 **先 RD 洗牌、后 Mirror 翻转**：

```text
forward[c] = mirror ? keys - 1 - shuffled[c] : shuffled[c]
```

这一顺序来自对游戏内显示的观察，尚未用「MR+RD 同局」的回放做交叉验证；如果你的工具需要绝对正确，建议按同一顺序实现并对齐两次。

---

## 4. 回放端如何用（推荐做法）

1. 读完 header 后解压 LZMA，扫描 `-12345` 帧拿 `seed`。
2. 用第 2 节的算法算 `shuffled`。
3. 谱面：`x` 列 `c` 的音符画在 `shuffled[c]`。
4. 回放输入帧里的列是**显示列**，直接拿去和"显示后的谱面"比较即可（不需要再转回谱面列）。

本插件（`static/Mania Replay Master (fixed)`）的实现：

- `tools/mrm-helper.mjs` 的 `parseOsr()` 返回 `seed`；`/replay` 响应新增 `seed` 字段。
- `main.js` 的 `buildManiaNotes()` 用 `displayColumn()` 生成显示列，输入帧/按键不再做第二次映射（否则会双重变换）。
- 判定与渲染都在"显示空间"里进行，列变换只发生在谱面构建（和 Live 推断）阶段。

### 4.1 实测结果（同一张 4K 谱面，7 局）

游戏内判定计数（MAX / 300 / 200 / 100 / 50 / miss）与本插件用种子重建后的对比：

| 局（seed） | 游戏 | 本插件重建 | L1 |
| --- | --- | --- | --- |
| 30745429 | 948/115/1/0/0/0 | 945/118/1/0/0/0 | 6 |
| 30840347 | 930/133/0/0/0/1 | 939/124/0/0/0/1 | 18 |
| 34973272 | 888/175/1/0/0/0 | 892/170/2/0/0/0 | 10 |
| 35078231 | 920/138/4/0/1/1 | 918/140/4/0/1/1 | 4 |
| 35161951 | 910/154/0/0/0/0 | 905/158/1/0/0/0 | 10 |
| 35245621 | 893/162/8/0/1/0 | 893/162/8/0/1/0 | 0 |
| （无 RD）30924341 | 910/144/6/0/0/3 | 915/140/6/0/0/3 | 10 |

残差来自 offset 拟合与 stable 长条判定细节，和 RD 无关。

---

## 4.2 没有种子时（lazer 导出的 `.osr`、旧版回放）

osu!lazer 的 legacy 导出器把结束帧写死为 `-12345|0|0|0`（种子永远不会进入这个帧），20130319 之前的回放干脆没有该帧。不过 lazer 导出的文件末尾**还有第二块数据**，里面带着 mod 设置 —— 包括 RD 的种子，见 4.3。只有连这块也没有的 `.osr`（旧版本回放、或被第三方裁掉的文件）才需要**从输入帧反推**：

1. 统计每个谱面列的音符数与每个显示列的按键数（纯列置换保持两侧的多重集不变，可先剪枝到少量候选置换）；
2. 对候选置换做时间匹配：把按键时间与映射后谱面列的音符时间求最近差，取中位数作为偏移，再统计落在偏移 ±30ms 内的比例；
3. 最优置换需 ≥60% 命中且领先次优 ≥ max(4, 3% 样本量)，否则判为不可判（保持原样）。

本插件实现：`inferColumnPermutation(notes, actions, keys)`（`main.js`），对 6 局真实 RD 回放（4K）逐局还原出与种子一致的置换，最优命中 40/40 量级、次优差 61–80 个样本。

RD 是否启用有两路来源：实时 mods（bit 21 / `RD` 缩写）与 `.osr` 的 mods 字段（回放时 tosu 可能不上报 mods，此时以 `.osr` 为准并强制保持映射）。

## 4.3 lazer 的种子在哪里

osu!lazer 与 stable 的 RD 是两套实现，种子存放位置也不同：

- **运行时**：`ModRandom.Seed`（可空 `Bindable<int?>`，范围 0–2147483647，默认留空）。`ManiaModRandom.ApplyToBeatmap()` 里 `Seed.Value ??= RNG.Next()`，然后 `new Random((int)Seed.Value)`；洗牌是 `Enumerable.Range(0, n).OrderBy(_ => rng.Next())`（稳定排序 → 等价于「按随机键升序排列列索引」），与 stable 的拒绝采样不同。
- **lazer 自己存成绩的地方**：模组设置随成绩序列化，`APIMod.Settings` 的键是属性名的 snake_case（`Seed` → `"seed"`），落在本地 Realm 数据库 `client.realm` 的 `Score` 表（`ModsJson` 字段），并随成绩上传（API 的 `score.mods`）。
- **导出的 `.osr`**：结束帧永远是 `-12345|0|0|0`，但文件在回放流之后按 `LegacyScoreEncoder` 的布局追加了第二块：

```text
[replay 帧 LZMA 块]                      ← 结束帧 -12345|0|0|0
[8 字节 LegacyOnlineID，通常为 0]
[int32 长度][LZMA(JSON) LegacyReplaySoloScoreInfo]
```

  JSON 形如 `{"online_id":0,"mods":[{"acronym":"RD","settings":{"seed":30745429}}],...}`。stable 写的 `.osr` 只有前面 8 字节（全 0）而没有 JSON 块。

  读取：跳过回放流和 8 字节 LegacyOnlineID，读 int32 长度，解压后面的 LZMA 流，`JSON.mods[].acronym == "RD"` 的 `settings.seed` 就是种子（注意 JSON 键是 snake_case）。

本插件的行为（`main.js` 的 `maybeExact()`）：

1. helper 返回的 `lazerSeed` 有效 → 用 **lazer 算法** `lazerShuffledColumns(seed, keys)` 重建置换（`state.seedKind = "lazer"`）；
2. 否则用 stable 结束帧的种子 → 拒绝采样（`state.seedKind = "stable"`）；
3. 两者都没有 → 反推（4.2）。

lazer 洗牌实现（与 stable 不同，别混用）：

```js
const next = dotNetRandom(seed);
const items = [];
for (let i = 0; i < keys; i++) items.push({ c: i, r: next(2147483647) });
items.sort((a, b) => (a.r - b.r) || (a.c - b.c));   // LINQ OrderBy 是稳定排序
const shuffled = items.map((x) => x.c);
```

验证向量（n=4，由 .NET Framework 的 `Enumerable.OrderBy` + `Random` 直接生成，JS 实现逐位一致）：

| seed | lazer `shuffled` | stable `shuffled` |
|---|---|---|
| 0 | `3021` | `2301` |
| 1 | `1023` | — |
| 42 | `2130` | — |
| 30745429 | `3102` | `0132` |
| 34973272 | `3021` | `1302` |

同一个 crate（`.osr`）里如果两块种子都在，以 lazer 块为准（说明文件是 lazer 导出的，判定也应按 lazer 的窗口与洗牌）。

> 注意：lazer 的判定窗口与 stable 也不同（见 `ManiaHitWindows` 与 Classic 分支），本插件目前按 stable 的窗口模型显示颜色；跨版本回放的颜色差异属于已知限制。

## 5. Live 端没有 `.osr` 怎么办

游玩进行中拿不到该局 `.osr`（分数结算才写盘），种子不可得。可行做法是**从按键反推置换**：

对每个候选置换 `p`（`keys ≤ 7` 时最多 5040 种，4K 只有 24 种），给所有按键打分：

```text
score(p) = #{ press d at t : 存在未匹配音符 (beatmapColumn = p[d], time ≈ t) }
```

- 容差 ±60ms；
- 样本数 ≥ 48 个按键后才尝试锁定（实测 48 个按键时正确置换的领先 margin 为 4–6，96 个按键时约 22）；
- 领先 margin ≥ 6 才接受，否则继续累积；
- 锁定后重建谱面并 `resetJudgements()`，把开局几秒的错色纠正掉。

本插件的 `sampleLiveRandom()` 就是这一实现，`keys > 7` 时跳过推断（全排列过大）。

---

## 6. 已知限制

- Live 推断在开局 8–10 秒内可能把前几十个音判到错误列（随后自愈）。
- RD + Mirror 同时启用时的叠加顺序未做真实回放验证（见第 3 节）。
- lazer 的 Random 使用另一套算法（`ModRandom` + `Seed` 设置），不要套用本文的 .NET 拒绝采样。
- 本机制依赖 `.osr` 中保留种子帧；第三方工具若重新封装/裁剪回放，务必保留最后一帧。

---

## 7. 最小复现清单

```text
输入：.osr（mania）、.osu（4K）
1. 解压帧文本，找到 -12345|0|0|<seed>  → seed
2. shuffled = rdShuffledColumns(seed, keys)        // 本文 2.3 实现
3. 谱面每个 note 的列 c 显示为 shuffled[c]
4. 输入帧的列 = 显示列，直接与显示后的谱面对齐
期望：判定计数与游戏结算一致（L1 个位数，残差来自判定窗口/偏移细节）
```
