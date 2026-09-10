import React, { useEffect, useRef, useState } from "react";
import { Clock3, Radio, ArrowDown, Check, LoaderCircle } from "lucide-react";
import type { Task } from "../../packages/domain";
import type { TaskProgress } from "../../packages/progress";
import { MarkdownContent } from "./MarkdownContent";

const elapsed = (date: string, now: number) =>
  Math.max(0, Math.floor((now - Date.parse(date)) / 1000)) || 0;
export function TaskActivity({
  task,
  progress,
  offline = false,
}: {
  task: Task;
  progress?: TaskProgress;
  offline?: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  const active = ["running", "reviewing", "coordinating"].includes(task.status);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  if (!active) return null;
  const p = progress?.revision === task.revision ? progress : undefined,
    seconds = elapsed(p?.startedAt || task.updatedAt, now);
  const reviewing = task.status === "reviewing",
    coordinating = task.status === "coordinating";
  const review = reviewing ? p?.review : undefined;
  const reviewSeconds = review ? elapsed(review.startedAt, now) : 0;
  const noHeartbeat =
    p?.status === "running" && elapsed(p.heartbeatAt, now) > 15;
  const title = reviewing
    ? "主控正在审核"
    : coordinating
      ? "主控正在判断修改范围"
      : p?.outputAt
        ? "已收到模型输出，继续生成中"
        : "已开始执行，等待模型首段输出";
  return (
    <section className="task-activity" aria-label="实时执行状态">
      <div className="activity-top">
        <span className="activity-title">
          <LoaderCircle className="activity-spin" size={17} />
          {title}
        </span>
        <span className="activity-clock">
          <Clock3 size={14} />
          {review && `审核累计 ${Math.floor(reviewSeconds / 60)} 分 ${reviewSeconds % 60} 秒 · `}
          {review?.step === "visual" ? "本批审核已耗时" : "本次调用已耗时"} {Math.floor(seconds / 60)} 分 {seconds % 60} 秒
        </span>
      </div>
      <div className="activity-steps" aria-label="当前执行步骤">
        {["专业 Agent 创作", "主控审核", "你的确认"].map((label, i) => (
          <span
            key={label}
            className={
              reviewing
                ? i === 0
                  ? "done"
                  : i === 1
                    ? "current"
                    : ""
                : i === 0
                  ? "current"
                  : ""
            }
          >
            {reviewing && i === 0 ? <Check size={12} /> : <i>{i + 1}</i>}
            {label}
          </span>
        ))}
      </div>
      <p>
        {p?.actor || task.role}
        {p?.model ? ` · ${p.model}` : ""} ·{" "}
        {offline
          ? "工作台连接断开，正在重连；下方内容可能不是最新。"
          : noHeartbeat
            ? "执行心跳暂未更新，无法确认后台是否仍在响应；可检查运行记录。"
            : reviewing
              ? review
                ? "正在检查声音转写、实际画面和交付完整性。音色与语气仍需你试听确认。"
                : "正在检查完整性、人物动机和故事一致性。你可以先阅读下方候选稿，审核通过后再确认。"
              : coordinating
                ? "正在分析你的要求；明确的修改会继续执行，方向不明确时会请你确认。"
                : p?.outputAt
                  ? `最近一次模型正文返回在 ${elapsed(p.outputAt, now)} 秒前。`
                  : "部分模型会先处理较长时间才返回正文；尚未收到内容，不代表已经完成。"}
      </p>
      {review && (
        <div aria-label="媒体审核进度" aria-live="polite">
          <p>
            声音转写 {review.speechDone} / {review.speechTotal} 项
            {review.speechTotal === 0 ? "（无需转写）" : "已完成"}
            {" · "}图片 / 视频审核 {review.visualDone} / {review.visualTotal} 项已完成
            {" · "}汇总审核：{review.summaryDone ? "已完成" : review.step === "summary" ? "进行中" : "待开始"}
          </p>
          <p>
            当前：{review.step === "speech" ? "声音转写" : review.step === "visual" ? "图片 / 视频审核" : "汇总审核"}
            {" · "}{review.current}
          </p>
          <small>完成数量表示已检查，不代表全部通过。</small>
        </div>
      )}
      {!offline && !noHeartbeat && p?.status === "running" && (
        <small>
          <Radio size={12} />
          本机执行器心跳已连接 · 不代表供应商完成进度
        </small>
      )}
    </section>
  );
}
const checkpointLabel = (status?: string) =>
  ({ reviewed: "已通过", rejected: "未通过", candidate: "待审核" }[status || ""] ||
  "未开始");
export function latestCheckpoints<
  T extends { taskId: string; revision: number; kind: string },
>(all: T[], taskId: string, revision: number) {
  const latest = new Map<string, T>();
  for (const p of all)
    if (p.taskId === taskId && p.revision === revision && !latest.has(p.kind))
      latest.set(p.kind, p);
  return Array.from(latest.values());
}
export function StoryProgress({
  outline,
  checkpoints,
  currentKind,
}: {
  outline?: { chapters: { id: string; title: string }[] };
  checkpoints: { kind: string; status: string }[];
  currentKind?: string;
}) {
  const statusOf = (kind: string) =>
    checkpoints.find((p) => p.kind === kind)?.status;
  const chapters = outline?.chapters || [];
  const passed = chapters.filter(
    (c) => statusOf(`章节 ${c.id}`) === "reviewed",
  ).length;
  const structure = statusOf("故事结构");
  return (
    <section className="story-progress" aria-label="执行进度">
      <header>
        <strong>执行进度</strong>
        <span>故事结构 · {checkpointLabel(structure)}</span>
        {chapters.length > 0 && (
          <span>
            {passed} / {chapters.length} 章已通过
          </span>
        )}
        {currentKind && (
          <span>
            当前 {currentKind} ·{" "}
            {statusOf(currentKind)
              ? checkpointLabel(statusOf(currentKind))
              : "生成中"}
          </span>
        )}
      </header>
      <ol>
        <li
          className={
            (structure === "reviewed" ? "done " : structure ? "active " : "") +
            (currentKind === "故事结构" ? "current" : "")
          }
        >
          结构
          <small>{checkpointLabel(structure)}</small>
        </li>
        {chapters.map((c) => {
          const kind = `章节 ${c.id}`;
          const status = statusOf(kind);
          const generating = currentKind === kind && !status;
          return (
            <li
              key={c.id}
              className={
                (status === "reviewed" ? "done " : status || generating ? "active " : "") +
                (currentKind === kind ? "current" : "")
              }
            >
              {c.id}
              <small>
                {c.title} · {generating ? "生成中" : checkpointLabel(status)}
              </small>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
export function LiveDraft({
  content,
  active = true,
}: {
  content: string;
  active?: boolean;
}) {
  const [follow, setFollow] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (follow) {
      const article = container.current?.querySelector("article");
      if (article) article.scrollTop = article.scrollHeight;
    }
  }, [content, follow]);
  return (
    <div className="live-draft" ref={container}>
      <div className="draft-heading">
        <span>
          {active ? "实时草稿 · 尚未完成、未审核" : "中断前草稿 · 非完整交付"}
        </span>
        <button
          className="text-button"
          aria-pressed={follow}
          onClick={() => setFollow(!follow)}
        >
          <ArrowDown size={13} />
          {follow ? "停止跟随" : "跟随最新内容"}
        </button>
      </div>
      {content ? (
        <MarkdownContent content={content} />
      ) : (
        <div className="draft-wait">
          <span className="waiting-orbit" />
          <h3>正在等待第一段正文</h3>
          <p>收到内容后会自动显示，无需刷新或重复开始。</p>
          <p>你可以查看运行记录，或随时中断并调整要求。</p>
        </div>
      )}
    </div>
  );
}
