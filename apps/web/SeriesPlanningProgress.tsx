import { storyboardSchema } from "../../packages/media";
import React from "react";
import type { Task, Event } from "../../packages/domain";
import {
  planEpisodeSchema,
  seriesPlanSchema,
  structured,
} from "../../packages/series";
import { MarkdownContent } from "./MarkdownContent";

type Checkpoint = {
  taskId: string;
  revision: number;
  kind: string;
  status: string;
  content: string;
  createdAt?: string;
};

// Only expose complete, schema-valid episode objects from an unfinished JSON array.
export function completedEpisodes(content: string) {
  const start = /"episodes"\s*:\s*\[/.exec(content);
  if (!start) return [];
  const episodes: ReturnType<typeof planEpisodeSchema.parse>[] = [];
  let depth = 0,
    quoted = false,
    escaped = false,
    from = -1;
  for (let i = start.index + start[0].length; i < content.length; i++) {
    const char = content[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") {
      if (depth++ === 0) from = i;
    } else if (char === "}" && depth > 0 && --depth === 0) {
      try {
        episodes.push(
          planEpisodeSchema.parse(JSON.parse(content.slice(from, i + 1))),
        );
      } catch {
        break;
      }
    } else if (char === "]" && depth === 0) break;
  }
  return episodes;
}

// Decode the script wrapper incrementally without displaying JSON escapes.
export function scriptText(raw: string) {
  const match = /^\s*(?:```(?:json)?\s*)?\{\s*"content"\s*:\s*"/.exec(raw);
  if (!match) return raw;
  let result = "";
  for (let i = match[0].length; i < raw.length; i++) {
    const char = raw[i];
    if (char === '"') break;
    if (char !== "\\") {
      result += char;
      continue;
    }
    const escaped = raw[++i];
    if (!escaped) break;
    if (escaped === "u") {
      const hex = raw.slice(i + 1, i + 5);
      if (!/^[0-9a-f]{4}$/i.test(hex)) break;
      result += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else {
      const value = (
        {
          n: "\n",
          r: "\r",
          t: "\t",
          b: "\b",
          f: "\f",
          '"': '"',
          "\\": "\\",
          "/": "/",
        } as Record<string, string>
      )[escaped];
      if (value === undefined) break;
      result += value;
    }
  }
  return result;
}

export function SeriesPlanningProgress({
  task,
  checkpoints,
  events,
  liveContent,
}: {
  task: Task;
  checkpoints: Checkpoint[];
  events: Event[];
  liveContent: string;
}) {
  const isScript = task.stage === 2;
  const isShot = task.stage === 8;
  const label = isShot ? "文字分镜" : isScript ? "单集剧本" : "分集规划";
  const kind = isShot
    ? `文字分镜 EP${String(task.episode || 1).padStart(3, "0")}`
    : isScript
      ? `单集剧本 EP${String(task.episode || 1).padStart(3, "0")}`
      : "全剧分集边界";
  const current = checkpoints.filter(
    (p) =>
      p.taskId === task.id && p.revision === task.revision && p.kind === kind,
  );
  const latest = current[0];
  const failures = current.filter((p) => p.status === "rejected").length;
  const versions = current.filter(
    (p, i) => current.findIndex((other) => other.content === p.content) === i,
  );
  const liveEpisodes =
    !isShot && !isScript && task.status === "running"
      ? completedEpisodes(liveContent)
      : [];
  const saved =
    !isScript && latest && structured(latest.content, seriesPlanSchema);
  const phase =
    task.status === "approved"
      ? "用户已确认"
      : task.status === "awaiting_user"
        ? "等待你的确认"
        : task.status === "reviewing"
          ? latest?.status === "reviewed"
            ? "整体衔接审核中"
            : isScript
              ? "剧本内容审核中"
              : "分集方案审核中"
          : task.status === "running"
            ? failures
              ? "根据反馈返工中"
              : isScript
                ? "生成单集剧本中"
                : "生成分集方案中"
            : task.status === "ready"
              ? "等待开始"
              : "已暂停，等待处理";
  const firstSavedAt = current.at(-1)?.createdAt;
  const feedback = firstSavedAt
    ? events.filter(
        (e) =>
          e.taskId === task.id &&
          e.createdAt >= firstSavedAt &&
          [
            "workflow.part.failed",
            "workflow.part.passed",
            "review.failed",
            "review.passed",
            "workflow.metrics",
          ].includes(e.type),
      )
    : [];
  return (
    <section className="panel" aria-label={`${label}进度与已保存内容`}>
      <div className="panel-heading">
        <strong>{label}进度</strong>
        <span>
          {isShot && ["running", "reviewing"].includes(task.status)
            ? events.find(
                (e) =>
                  e.taskId === task.id &&
                  e.type === "workflow.part" &&
                  e.createdAt >= task.updatedAt,
              )?.message ||
              (task.status === "reviewing"
                ? "审核镜头与衔接中"
                : "生成或修复镜头中")
            : phase}
        </span>
      </div>
      <div className="notice series-planning-status">
        <p>
          {isShot
            ? "提取共用约束 → 生成分镜 → 程序检查与审核 → 按镜头修复 → 你的确认"
            : isScript
              ? "生成剧本 → 内容与计时审核 → 整体审核 → 你的确认"
              : "生成方案 → 分集审核 → 整体审核 → 你的确认"}
        </p>
        <p>
          片段尝试{" "}
          {Math.min(
            task.status === "ready" && !latest
              ? 0
              : failures +
                  (latest?.status === "rejected" && task.status !== "running"
                    ? 0
                    : 1),
            3,
          )}{" "}
          / 3 · 已退回 {failures} 次
        </p>
        <p>
          {isScript
            ? latest
              ? `已保存 ${versions.length} 份剧本内容，可在下方阅读。`
              : "尚无完整保存的剧本。"
            : saved
              ? `最近保存的方案包含 ${saved.episodes.length} 集。`
              : "尚无完整保存的分集方案。"}
          {liveEpisodes.length > 0 &&
            ` 本次输出已有 ${liveEpisodes.length} 集内容完整，可在下方阅读（尚未审核）。`}
        </p>
        <small>
          {isScript
            ? `本次已返回 ${scriptText(liveContent).length} 字符；字符数不代表完成比例。`
            : "集数尚未最终确定，生成过程不显示完成百分比。"}
          已保存内容在审核、返工或中断期间仍可阅读。
        </small>
      </div>
      {feedback.length > 0 && (
        <details className="checkpoint-block" open>
          <summary>审核记录与修改意见</summary>
          {feedback.map((e) => (
            <div key={e.seq}>
              <small>{new Date(e.createdAt).toLocaleString("zh-CN")}</small>
              <MarkdownContent content={e.message} />
            </div>
          ))}
        </details>
      )}
      {versions.map((p, i) => (
        <details
          className="checkpoint-block"
          key={p.createdAt || i}
          open={i === 0}
        >
          <summary>
            {isScript
              ? i === 0
                ? "最近保存的剧本"
                : "此前保存的剧本"
              : i === 0
                ? "最近保存的方案"
                : "此前保存的方案"}{" "}
            ·{" "}
            {{
              reviewed: isScript ? "剧本内容审核通过" : "分集审核通过",
              unreviewed: "已生成，待你确认",
              candidate: "待审核",
              rejected: "未通过，待修改",
            }[p.status] || p.status}
          </summary>
          {isShot ? (
            <SavedShots content={p.content} />
          ) : (
            <MarkdownContent
              content={isScript ? scriptText(p.content) : p.content}
            />
          )}
        </details>
      ))}
      {liveEpisodes.length > 0 && (
        <details className="checkpoint-block" open>
          <summary>
            本次生成已完整返回的 {liveEpisodes.length} 集 · 未审核
          </summary>
          <MarkdownContent
            content={JSON.stringify({
              type: "series-plan",
              rationale: "实时生成中的部分内容；尚未完成全剧覆盖检查。",
              episodes: liveEpisodes,
            })}
          />
        </details>
      )}
    </section>
  );
}

function SavedShots({ content }: { content: string }) {
  const board = structured(content, storyboardSchema);
  if (!board) return <MarkdownContent content={content} />;
  return (
    <div className="markdown-content">
      <p>{board.summary}</p>
      <p>
        {board.shots.length} 个镜头 ·{" "}
        {board.shots.reduce((n, s) => n + s.duration, 0)} 秒
      </p>
      {board.shots.map((s) => (
        <details key={s.id} open>
          <summary>
            {s.id} · {s.title} · {s.duration} 秒
          </summary>
          <p>{s.prompt}</p>
          <p>画面：{s.imagePrompt}</p>
          <p>动作：{s.motionPrompt}</p>
          <p>机位：{s.camera}</p>
          <p>起始：{s.startState}</p>
          <p>结束：{s.endState}</p>
          <p>资产：{(s.assetIds || []).join("、")}</p>
          {s.dialogue && (
            <p>
              {s.speaker}：{s.dialogue}
            </p>
          )}
        </details>
      ))}
    </div>
  );
}
