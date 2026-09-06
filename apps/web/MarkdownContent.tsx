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
                        需要重新规划：{audit.issues.join("；")}
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
