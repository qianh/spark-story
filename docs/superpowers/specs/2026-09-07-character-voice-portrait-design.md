# 角色声音画像与试听稿

版本：1.0；日期：2026-09-07；状态：已按讨论确认，待实现。

产品规则见 [01-产品设计.md](../../01-产品设计.md)：系统推荐并生成试听，用户确认后绑定角色。本规格把「声音」从定妆外观里拆出来，变成可复用的结构化声音卡，减少 VoiceDesign 因提示词漂移造成的随机性。

## 1. 问题

当前定妆试听有三处错误：

1. 试听句取本集分镜第一句台词。EP001 沈不言只有「还活着。」「先走。」，听不出长句，播放器还把不足 1 秒显示成 `0:00`。
2. VoiceDesign 的 `instruct` 被塞进定妆外观（头骨、湿袍、金叶）。模型要的是听得见的声音，不是画面。
3. 没有跨集沉淀。Qwen 路径每次按 `identity + state` 重写 instruct，库里已确认的声线绑不住。

VoiceDesign 不能当声音克隆。本规格降低的是提示词方向漂移；同一条 instruct 再生成仍是抽样，不是复刻。

## 2. 已确认决定

| 项 | 决定 |
| --- | --- |
| 试听文本 | 专门写试听稿：2～4 句长句，只用于听声，不进成片 |
| 画像来源 | 定妆阶段由文本模型根据剧情与人物 `identity` 填写声音卡，直接生成试听；用户听声音确认。画像只读，默认不改 |
| 跨集 | 全剧稳定。性别+年龄段不变则整份复用；只有这两项变了才新写一版 |
| 重新生成 | 声音卡和试听稿不动，只再抽一条音频 |
| 实现 | 结构化声音卡，代码编译成 30～80 字 instruct，源数据在 `voice_library` |

不在本规格内：声音克隆、句级情绪轨、用户手改槽位、为试听新开页面。

## 3. 术语

| 用语 | 含义 |
| --- | --- |
| 声音卡 | 角色的结构化声线槽位，全剧稳定 |
| 试听稿 | 只用于听声的 2～4 句长句，不是分镜台词 |
| 声线键 | `性别 + 年龄段`，用来判断要不要作废旧卡 |
| instruct | 由声音卡编译出的短描述，交给 TTS `--instruct` |
| 绑定 | 用户确认定妆后写入 `voice_library` 的声音卡、instruct、试听稿、试听音频 |

声音卡不是定妆图的 `identity`，也不是本集 `state`。

## 4. 数据

### 4.1 声音卡槽位

`gender` 只有男/女。幼童、少年等放在 `ageBand`，不放进性别。

| 字段 | 取值 | 约束 |
| --- | --- | --- |
| `gender` | `male` / `female` | 必填 |
| `ageBand` | `child` / `teen` / `youth` / `adult` / `elder` | 必填。对应幼童 / 少年 / 青年 / 中年 / 老年 |
| `pitch` | `low` / `mid-low` / `mid` / `mid-high` / `high` | 必填 |
| `timbre` | 短中文 | 只写听感，≤ 20 字。禁止外貌、服饰、场景 |
| `pace` | `slow` / `slightly-slow` / `medium` / `slightly-fast` | 必填 |
| `accent` | 短中文 | 默认「标准普通话，无方言」，≤ 20 字 |
| `baselineEmotion` | 短中文 | 一贯气质，不是某一句的情绪，≤ 20 字 |
| `avoid` | 字符串数组 | 至少一项。如广告腔、卖萌、朗诵、读画面 |

声线键：`{gender}:{ageBand}`，例如 `male:youth`。湿袍、金叶、发型、境界服饰不进键。

### 4.2 试听稿

- 2～4 句，合计 80～200 个汉字。
- 口吻像该角色，但不是本集台词，也不进成片。
- 可参考已确认台词的说话习惯，禁止与本集任一台词完全相同。
- 禁止自我介绍、禁止剧透未发生情节、禁止读出外貌/衣服/天气。
- 话少的角色也要写长句：试听测长句能不能站住，不是复刻他平时有多寡言。

### 4.3 编译 instruct

由代码拼接，不把文本模型的原文直接交给 TTS。VoiceDesign 用官方听觉效果句式，不用规格清单和「不要…」清单：

```
体现{岁数}{少年|幼童|中年|老年}{男|女}声，{音调}，声线{timbre}，语速{语速中文}，{accent}，{baselineEmotion}，营造出{听觉效果}。
```

沈不言示例：

> 体现17岁少年男声，音调中高偏亮，声线清冷、偏薄、不浑厚，语速中，标准普通话，无方言，克制、冷、不煽情，营造出未满20岁清亮国漫少年配音的听觉效果。

岁数：child → 8 岁幼童，teen → 15 岁少年，youth → 17 岁少年。禁止写「青年」（该模型年龄表里青年是 19 至 35 岁）。编译目标 30～80 字，硬上限 120 字。若命中画面词（衣、袍、发、骨、鼻、眉、靴、雨、叶、绣、锁骨、皮肤、场景等），视为不合格，不调用 TTS。

文本模型必须只返回 JSON：

```json
{
  "voicePortrait": {
    "gender": "male",
    "ageBand": "youth",
    "pitch": "mid",
    "timbre": "清冷、偏薄、不浑厚",
    "pace": "medium",
    "accent": "标准普通话，无方言",
    "baselineEmotion": "克制、冷、不煽情",
    "avoid": ["广告腔", "卖萌", "朗诵", "读画面"]
  },
  "sampleText": "两到四句试听稿……"
}
```

不得返回 `instructions`；instruct 只由代码编译。

### 4.4 存哪

继续用现有表 `voice_library(projectId, character, connectionId, data)`。`data` 在现有 voices 对象上增加：

```json
{
  "character": "沈不言",
  "voice": "VoiceDesign",
  "sampleText": "试听稿……",
  "instructions": "编译后的 instruct",
  "castingNote": "按已确认声音卡生成；再生成是同一方向的抽样，不能当声音克隆。",
  "status": "ready",
  "audioId": "……",
  "voicePortrait": {
    "gender": "male",
    "ageBand": "youth",
    "pitch": "mid",
    "timbre": "清冷、偏薄、不浑厚",
    "pace": "medium",
    "accent": "标准普通话，无方言",
    "baselineEmotion": "克制、冷、不煽情",
    "avoid": ["广告腔", "卖萌", "朗诵", "读画面"]
  },
  "voiceIdentityKey": "male:youth"
}
```

`assetPlan.voices[]` 使用同一形状，便于定妆产物和库互转。未开口角色不写库。

主键仍是项目 + 角色名 + 语音连接。新版绑定覆盖库里的旧绑定，只影响之后的生成；旧集已经落盘的对白文件不改。

换语音连接：若同角色在其他连接已有声音卡，复用槽位与试听稿，按新模型重编译 instruct 并重新试听，不重问文本模型。

## 5. 定妆流程

图像规划与出图不变。声音在图像完成之后单独处理，不再把本集 `state` 塞进配音。

对每个角色：

1. 本集已确认文字分镜无该角色台词 → `not_required`，不写卡。
2. 查 `voice_library`（本项目、本角色、当前语音连接）。
3. 用与现有选声相同的规则从当前 `identity` 解析 `gender` 与 `ageBand`，**不调用文本模型**。解析不出 → `needs_voice`。解析结果与库中 `voiceIdentityKey` 相同，且卡、instruct、试听稿、试听音频齐全 → 整份复用，不调文本模型，不跑 TTS。
4. 未命中，或键变了（蜕相导致年龄段/性别变化）→ 文本模型只根据角色名、稳定 `identity`、已确认故事设定里含该角色名的摘录（合计上限 4000 字），一次返回声音卡 + 试听稿。不传入本集 `state`、湿袍、金叶、分镜画面。
5. 代码校验枚举、字数、画面词、试听稿是否抄台词、性别/年龄是否与 `identity` 明显打架。失败则按文本任务规则最多再试 3 次，仍失败则暂停并写出原因。
6. 通过后编译 instruct，用试听稿调用当前语音连接生成试听。
7. 用户听过并确认定妆后，`registerAssets` 写入 `voice_library`。未确认的候选不写库。

「重新生成此角色」：保留声音卡、试听稿、instruct，强制再生成音频。新 `audioId` 在再次确认定妆后才覆盖库。

CustomVoice 遇到 `ageBand = child`：仍 `needs_voice`（没有童声预设）。VoiceDesign 可为幼童写卡并试听。性别或年龄段从 `identity` 读不出来：`needs_voice`，不按名字猜。

VoiceDesign：`voice` 固定 `VoiceDesign`。CustomVoice：`ageBand = child` 为 `needs_voice`；`ageBand = elder` 且男 → `Uncle_Fu`；其余男 → `Aiden`；女 → `Serena`。声音卡只编译成 `--instruct`，不再把外貌段落塞进去。

## 6. 正式配音

- 文本 = 该镜已确认台词原文。
- `instruct` = 库中（或本集已复用的）编译结果，全剧同一条。
- 不按镜头附加情绪、语速、场景气氛。句级演法以后另开，不写进声音卡。
- 禁止把试听稿当作镜头台词提交。
- 某句 TTS 失败只重做该句音频，不重写声音卡。

Qwen 路径必须先查库再决定是否写新卡。不得再在命中已绑定声线后，用 `identity + state` 覆盖 instruct。

## 7. 界面

仍在定妆声音列表，不新开页。

- 显示：角色名、编译后的 instruct（只读）、试听稿、试听播放器。
- 播放器旁标注文件元数据时长（保留一位小数，如 `8.2 秒`），不依赖浏览器整秒显示。
- 沿用库时标明「沿用已确认声线」，不进入生成中。
- 「重新生成此角色」文案含义：同一画像再听一条。
- `needs_voice` / 无台词：沿用现有说明，不给播放器。
- 继续写明：再生成是同一方向的抽样，不能当声音克隆。

## 8. 失败与边界

- TTS 失败：不写库，任务可从原工作区重试。
- 下游正在制作：先中断再改声音（现有规则）。
- 蜕相只改衣服、气质、境界，性别和年龄段不变：沿用原卡。
- 文本模型把画面写进 `timbre` / `accent` / 试听稿：当次作废。
- VoiceDesign 抽样随机性仍存在；声音卡不保证两次试听听感相同。

## 9. 验收

1. 第一次定妆为开口角色写出声音卡 + 80 字以上试听稿；instruct 不含湿袍、头骨、金叶等画面词。
2. 同一角色下一集、性别年龄段不变：不调文本模型写卡，不重新 TTS 试听，界面显示沿用。
3. `ageBand` 或 `gender` 变了：新写卡并新试听；旧集对白文件仍在。
4. 「重新生成此角色」不改声音卡和试听稿，只换 `audioId`。
5. 正式镜头 `prompt` 是分镜台词，`instructions` 是编译 instruct。
6. 试听稿与本集任一台词完全相同，或不足 80 字：不得送去 TTS。
7. CustomVoice + 幼童：`needs_voice`；VoiceDesign + 幼童：可试听。
8. 播放器旁能读到真实时长，不再把 0.7 秒显示成空白的 `0:00` 而不加说明。

## 10. 主要改动面

- `packages/media.ts`：voices 增加 `voicePortrait`、`voiceIdentityKey`
- `apps/server/voice-casting.ts`：槽位校验、声线键、编译 instruct、试听稿规则；Qwen 选声不再拼接外观
- `apps/server/media-pipeline.ts`：定妆先查库；未命中才问文本模型；正式配音用绑定 instruct；retry 只换音频
- `apps/server/store.ts`：绑定写入完整声音卡
- `apps/web/MediaStudio.tsx`：展示 instruct、试听稿、元数据时长；沿用/再听一条
- `tests/voice-casting.test.ts` 及定妆/配音相关测试
