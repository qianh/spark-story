import {
  structured,
  storySchema,
  storyOutlineSchema,
  seriesPlanSchema,
  chapterSchema,
} from "../../packages/series";
import React, { memo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  timingManifest,
  productionRulesSchema,
  type ProductionRules,
} from "../../packages/production";
import { capacityAudit } from "../../packages/capacity";
export const MarkdownContent = memo(function MarkdownContent({
  content,
  rules = productionRulesSchema.parse({}),
}: {
  content: string;
  rules?: ProductionRules;
}) {
  const story = structured(content, storySchema);
  const outline = structured(content, storyOutlineSchema);
  const plan = structured(content, seriesPlanSchema);
  if (story)
    return (
      <article className="artifact-text markdown-content">
        <h2>完整故事稿</h2>
        <MarkdownContent content={story.bible} />
        {story.chapters.map((c) => (
          <section key={c.id}>
            <h2>
              {c.id} · {c.title}
            </h2>
            <MarkdownContent content={c.content} />
            <details>
              <summary>衔接与故事段落索引</summary>
              <p>{c.continuity}</p>
              {c.beats.map((b) => (
                <p key={b.id}>
                  {b.id} · {b.description}
                </p>
              ))}
            </details>
          </section>
        ))}
      </article>
    );
  if (outline)
    return (
      <article className="artifact-text markdown-content">
        <h2>故事结构</h2>
        <MarkdownContent content={outline.bible} />
        {outline.chapters.map((c) => (
          <section key={c.id}>
            <h3>
              {c.id} · {c.title}
            </h3>
            <p>{c.synopsis}</p>
          </section>
        ))}
      </article>
    );
  if (plan)
    return (
      <article className="artifact-text markdown-content">
        <h2>全剧分集规划 · {plan.episodes.length} 集</h2>
        <p>{plan.rationale}</p>
        {plan.episodes.map((ep) => (
          <section key={ep.id}>
            <h3>
              {ep.id} · {ep.title}
            </h3>
            <p>{ep.summary}</p>
            <p>开始：{ep.opening}</p>
            <p>变化：{ep.change}</p>
            <p>结束：{ep.ending}</p>
            <p>
              粗估 {ep.estimatedSeconds} 秒 · {ep.timingReason}
            </p>
            <small>来源：{ep.sourceBeatIds.join("、")}</small>
          </section>
        ))}
      </article>
    );
  const chapter = structured(content, chapterSchema);
  if (chapter)
    return (
      <article className="artifact-text markdown-content">
        <h2>
          {chapter.id} · {chapter.title}
        </h2>
        <MarkdownContent content={chapter.content} />
        <details className="story-meta">
          <summary>衔接与故事段落索引</summary>
          <p>{chapter.continuity}</p>
          {chapter.beats.map((b) => (
            <p key={b.id}>
              {b.id} · {b.description}
            </p>
          ))}
        </details>
      </article>
    );
  const timing = timingManifest(content);
  const purposes: Record<string, string> = {
    hook: "开场钩子",
    setup: "处境铺垫",
    conflict: "冲突升级",
    turn: "转折",
    payoff: "兑现",
    cliffhanger: "结尾悬念",
    closure: "收束",
  };
  return (
    <article className="artifact-text markdown-content">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          table: ({ node, ...props }) => (
            <div className="markdown-table">
              <table {...props} />
            </div>
          ),
          a: ({ node, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer" />
          ),
          img: ({ alt }) => (
            <span className="muted">[图片：{alt || "请在素材库查看"}]</span>
          ),
        }}
      >
        {timing
          ? content.replace(/```production-json\s*\n[\s\S]*?\n```/, "")
          : content}
      </Markdown>
      {timing && (
        <section>
          <h2>节拍时间表</h2>
          <p className="muted">
            容量数值按当前项目规则估算，不是已完成配音的实测时长。表演余量用于自然停顿，不代表可任意追加剧情。
          </p>
          {timing.episodes.map((ep) => (
            <details key={ep.id} open={timing.episodes.length === 1}>
              <summary>
                {ep.id} · {ep.duration} 秒 · {ep.beats.length} 个节拍
              </summary>
              {(() => {
                const audit = capacityAudit(ep, rules);
                return (
                  <>
                    <p>
                      本集问题：{ep.dramaticQuestion || "旧版未提供"} ·
                      重大变化：{ep.majorChanges?.length ?? "未标注"} 个
                    </p>
                    <p>
                      内容估算 {audit.estimatedSeconds.toFixed(1)} 秒 · 对白{" "}
                      {audit.speechSeconds.toFixed(1)} 秒 · 独立反应{" "}
                      {audit.reactionSeconds.toFixed(1)} 秒 · 表演余量{" "}
                      {audit.reserveSeconds.toFixed(1)} 秒
                    </p>
                    {audit.issues.length > 0 && (
                      <p role="status">
                        节奏参考（不作为强制返工条件）：
                        {audit.issues.join("；")}
                      </p>
                    )}
                  </>
                );
              })()}
              <div className="markdown-table">
                <table>
                  <thead>
                    <tr>
                      <th>节拍 / 时间</th>
                      <th>叙事作用</th>
                      <th>新增信息</th>
                      <th>人物变化 → 结束状态</th>
                      <th>表演依据</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ep.beats.map((b) => (
                      <tr key={b.id}>
                        <td>
                          {b.id}
                          <br />
                          {b.start}～{b.end} 秒
                        </td>
                        <td>{purposes[b.purpose]}</td>
                        <td>{b.information}</td>
                        <td>
                          {b.change} → {b.exitState}
                        </td>
                        <td>
                          {b.performance ? (
                            <>
                              {b.performance.dialogue.map((d, i) => (
                                <p key={i}>
                                  {d.speaker}：{d.text}
                                </p>
                              ))}
                              {b.performance.actions.map((a, i) => (
                                <p key={i}>
                                  {a.description} · {a.seconds} 秒
                                  {a.overlapSpeech ? "（与对白重叠）" : ""}
                                </p>
                              ))}
                              <p>
                                反应：{b.performance.reaction.description} ·{" "}
                                {b.performance.reaction.seconds} 秒
                              </p>
                            </>
                          ) : (
                            "缺少计时依据"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ))}
        </section>
      )}
    </article>
  );
});
