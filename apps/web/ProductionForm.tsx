import React from "react";
import {
  narrativeTemplates,
  productionRulesSchema,
  type ProductionRules,
} from "../../packages/production";
import { capacityRules, inventorySchema } from "../../packages/capacity";

export function InventoryPreview({ content }: { content?: string }) {
  if (!content) return null;
  let inventory;
  try {
    inventory = inventorySchema.parse(JSON.parse(content));
  } catch {
    return null;
  }
  return (
    <details className="notice">
      <summary>
        全剧情节展开清单 · {inventory.units.length} 个戏剧单元（不是集数）
      </summary>
      <p>
        主控已检查情节展开，下一步按表演容量分集；你仍将在整份分集规划完成后确认。
      </p>
      {inventory.units.map((u) => (
        <details key={u.id}>
          <summary>
            {u.id} · {u.arc} · {u.dramaticQuestion}
          </summary>
          <p>{u.description}</p>
          <p>来源：{u.sourceAnchor}</p>
          <ol>
            {u.steps.map((s) => (
              <li key={s.id}>
                {s.id} · {s.description}
                {s.kind === "milestone" ? "（重大变化）" : ""}
              </li>
            ))}
          </ol>
        </details>
      ))}
    </details>
  );
}

export function ProductionFields({
  value = productionRulesSchema.parse({}),
}: {
  value?: ProductionRules;
}) {
  const capacity = capacityRules(value);
  return (
    <div className="form-grid">
      <label>
        叙事模板
        <select name="narrative" defaultValue={value.narrative}>
          {narrativeTemplates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <details style={{ gridColumn: "1 / -1" }}>
        <summary>自然展开 · 单集容量标准（可调整）</summary>
        <p className="muted">
          每集一个戏剧目标；先展开情节，再以试写对白、动作和反应计算容量。以下为平台制作默认值，并非行业统一标准。估算须经配音和节奏预演复核。
        </p>
        <div className="form-grid">
          {[
            ["speechUnitsPerSecond", "估算语速（发音单元/秒）", 2, 5, 0.1],
            ["maxScenes", "每集最多场景", 1, 4, 1],
            ["maxNewCharacters", "每集最多新人物", 0, 5, 1],
            ["maxNewRules", "每集最多新规则", 0, 3, 1],
            ["maxMajorChanges", "每集最多重大变化", 1, 3, 1],
            ["minReactionRatio", "最少独立反应占比", 0.05, 0.3, 0.01],
            ["reserveRatio", "最少表演余量占比", 0.05, 0.2, 0.01],
            ["maxSlackRatio", "最多未分配时间占比", 0.2, 0.4, 0.01],
          ].map(([key, label, min, max, step]) => (
            <label key={key}>
              {label}
              <input
                name={"capacity." + key}
                type="number"
                min={min}
                max={max}
                step={step}
                required
                defaultValue={capacity[key as keyof typeof capacity]}
              />
            </label>
          ))}
        </div>
      </details>
      <label>
        单集最短（秒）
        <input
          name="minSeconds"
          type="number"
          min="1"
          max="600"
          required
          defaultValue={value.minSeconds}
        />
      </label>
      <label>
        单集最长（秒）
        <input
          name="maxSeconds"
          type="number"
          min="1"
          max="600"
          required
          defaultValue={value.maxSeconds}
        />
      </label>
    </div>
  );
}
export function readProduction(f: FormData) {
  return {
    narrative: f.get("narrative"),
    minSeconds: Number(f.get("minSeconds")),
    maxSeconds: Number(f.get("maxSeconds")),
    capacity: Object.fromEntries(
      [
        "speechUnitsPerSecond",
        "maxScenes",
        "maxNewCharacters",
        "maxNewRules",
        "maxMajorChanges",
        "minReactionRatio",
        "reserveRatio",
        "maxSlackRatio",
      ].map((key) => [key, Number(f.get("capacity." + key))]),
    ),
  };
}
export function ProductionForm({
  value,
  busy,
  onSubmit,
}: {
  value: ProductionRules;
  busy: boolean;
  onSubmit: (input: unknown) => void;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(readProduction(new FormData(e.currentTarget)));
      }}
    >
      <p className="eyebrow">STORY RHYTHM / 制作规则</p>
      <h2>先确定节奏，再让画面发生。</h2>
      <p className="muted">
        时长包含对白、停顿、动作与片头片尾。集数由内容容量决定，视觉模板与叙事模板分别选择。
      </p>
      <ProductionFields value={value} />
      <p className="muted">
        保存会保留故事概要、历史文本和媒体文件，重置全剧分集规划及后续阶段，需重新生成并确认。执行中的项目须先中断任务。
      </p>
      <button className="button primary" disabled={busy}>
        保存规则并重新规划
      </button>
    </form>
  );
}
