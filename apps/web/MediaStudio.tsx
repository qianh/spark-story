import React, { useState } from "react";
import { MarkdownContent } from "./MarkdownContent";
import {
  ArrowDownToLine,
  ArrowUp,
  ArrowDown,
  Film,
  Image,
  Music,
  Play,
  Pause,
  Plus,
  RefreshCw,
  Upload,
  Check,
} from "lucide-react";
import {
  mediaBundle,
  mediaKinds,
  mediaGenerationProgress,
  type MediaFile,
  type MediaJob,
} from "../../packages/media";
import type { Task } from "../../packages/domain";
import type { ProductionRules } from "../../packages/production";
const mediaUrl = (id: string) => "/api/media/files/" + id;
export function MediaGenerationProgress({
  progress,
}: {
  progress: ReturnType<typeof mediaGenerationProgress>;
}) {
  if (progress.phase === "idle") return null;
  const pending = progress.items.findIndex((i) => !i.fileId);
  return (
    <div className="media-generation-progress" aria-label="产物生成进度">
      <div className="media-generation-top">
        <strong>{progress.label}</strong>
        {progress.current && (
          <span>
            {statusLabels[progress.current.status] || progress.current.status}
            {progress.current.prompt
              ? ` · ${progress.current.prompt.slice(0, 36)}`
              : ""}
          </span>
        )}
      </div>
      {progress.phase === "planning" ? (
        <p>方案确定后，生成完成的图片、声音和视频会逐项出现在这里。</p>
      ) : (
        <>
          <ol className="media-generation-track">
            {progress.items.map((item, i) => (
              <li
                key={item.id}
                className={
                  item.fileId ? "done" : i === pending ? "current" : ""
                }
                title={item.name}
              />
            ))}
          </ol>
          <ul className="media-generation-items">
            {progress.items.map((item, i) => (
              <li
                key={item.id}
                className={
                  item.fileId ? "done" : i === pending ? "current" : ""
                }
              >
                {item.name}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
const statusLabels: Record<string, string> = {
  queued: "准备提交",
  submitting: "正在提交",
  polling: "供应商生成中",
  downloading: "下载与校验",
  completed: "已完成",
  failed: "执行失败",
  unknown: "提交状态待核实",
  detached: "已中断，可继续查询",
  poll_error: "查询失败，可恢复",
  cancelled: "已取消",
};
async function request(path: string, body: any) {
  const r = await fetch("/api" + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw Error(data.error);
  return data;
}
export function MediaPreview({
  id,
  files,
}: {
  id?: string;
  files: MediaFile[];
}) {
  const f = files.find((f) => f.id === id);
  if (!f)
    return (
      <div className="media-placeholder">
        <Image size={25} />
        <span>等待实际产物</span>
      </div>
    );
  return (
    <div className={"media-preview " + f.kind}>
      {f.kind === "image" ? (
        <img src={mediaUrl(f.id)} alt={f.name} loading="lazy" />
      ) : f.kind === "video" ? (
        <video controls preload="metadata" src={mediaUrl(f.id)} />
      ) : f.kind === "audio" ? (
        <div>
          <Music size={26} />
          <audio controls preload="metadata" src={mediaUrl(f.id)} />
        </div>
      ) : (
        <p>{f.name}</p>
      )}
      <a
        className="media-download"
        href={mediaUrl(f.id) + "?download=1"}
        title={"下载 " + f.name}
      >
        <ArrowDownToLine size={15} />
      </a>
    </div>
  );
}
export function MediaLibrary({
  files,
  task,
  act,
  onUpdated,
}: {
  files: MediaFile[];
  task: Task;
  act: (fn: () => Promise<unknown>) => void;
  onUpdated: () => void;
}) {
  const [filter, setFilter] = useState("all");
  const upload = async (file: File) => {
    const f = new FormData();
    f.set("taskId", task.id);
    f.set("file", file);
    const r = await fetch(`/api/projects/${task.projectId}/upload`, {
      method: "POST",
      body: f,
    });
    if (!r.ok) throw Error((await r.json()).error);
    onUpdated();
  };
  return (
    <section className="media-library">
      <div className="section-heading">
        <h2>
          媒体素材 <span>{files.length}</span>
        </h2>
        <label className="button secondary upload-button">
          <Upload size={14} /> 导入本地素材
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,audio/*,video/*"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) act(() => upload(f));
              e.target.value = "";
            }}
          />
        </label>
      </div>
      <div className="media-filters">
        {[
          ["all", "全部"],
          ["image", "图片"],
          ["video", "视频"],
          ["audio", "音频"],
          ["document", "导出文件"],
        ].map(([k, label]) => (
          <button
            className={filter === k ? "active" : ""}
            key={k}
            onClick={() => setFilter(k)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="media-library-grid">
        {files
          .filter((f) => filter === "all" || f.kind === filter)
          .map((f) => (
            <div className="panel media-file-card" key={f.id}>
              <MediaPreview id={f.id} files={files} />
              <div>
                <strong>{f.name}</strong>
                <small>
                  修订 {f.revision} · {f.kind}
                </small>
              </div>
            </div>
          ))}
      </div>
      {!files.length && (
        <p className="muted">
          生成或导入图片、视频、配音、音乐后，实际文件会显示在这里。
        </p>
      )}
    </section>
  );
}
export function MediaJobs({
  jobs,
  files,
  task,
  act,
}: {
  jobs: MediaJob[];
  files: MediaFile[];
  task: Task;
  act: (fn: () => Promise<unknown>) => void;
}) {
  const [open, setOpen] = useState(false),
    [kind, setKind] = useState("image"),
    [prompt, setPrompt] = useState("");
  return (
    <section className="panel media-jobs">
      <div className="panel-heading">
        <span>
          <Film size={16} /> 专业媒体任务
        </span>
        <button className="text-button" onClick={() => setOpen(!open)}>
          <Plus size={14} /> 单独生成
        </button>
      </div>
      {open && (
        <form
          className="padded"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            act(async () => {
              await request("/media/jobs", {
                taskId: task.id,
                revision: task.revision,
                kind,
                prompt,
                inputs: f.getAll("inputs").filter(Boolean),
                options: {
                  duration: Number(f.get("duration") || 6),
                  voice: f.get("voice") || "alloy",
                },
              });
              setOpen(false);
            });
          }}
        >
          <div className="form-grid">
            <label>
              生成类型
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                {[
                  ["image", "图片 / 定妆 / 关键帧"],
                  ["video", "视频"],
                  ["speech", "配音"],
                  ["music", "音乐"],
                  ["sound", "音效"],
                  ["lipsync", "口型同步"],
                ].map(([k, l]) => (
                  <option value={k} key={k}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label>
              时长（秒）
              <input
                name="duration"
                type="number"
                min=".5"
                max="600"
                step=".1"
                defaultValue="6"
              />
            </label>
          </div>
          <label>
            生成要求
            <textarea
              required
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="描述画面、动作、台词或音乐氛围…"
            />
          </label>
          {["image", "video"].includes(kind) && (
            <label>
              {kind === "image" ? "参考图片（可多选）" : "参考关键帧"}
              <select name="inputs" multiple={kind === "image"}>
                {kind === "video" && <option value="">不使用参考图</option>}
                {files
                  .filter((f) => f.kind === "image")
                  .map((f) => (
                    <option value={f.id} key={f.id}>
                      {f.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
          {kind === "lipsync" &&
            (["video", "audio"] as const).map((type) => (
              <label key={type}>
                {type === "video" ? "需要对口型的视频" : "对白音频"}
                <select name="inputs" required>
                  <option value="">请选择素材</option>
                  {files
                    .filter((f) => f.kind === type)
                    .map((f) => (
                      <option value={f.id} key={f.id}>
                        {f.name}
                      </option>
                    ))}
                </select>
              </label>
            ))}
          {kind === "speech" && (
            <label>
              声音 ID
              <input name="voice" defaultValue="alloy" />
            </label>
          )}
          <button className="button primary">
            <Play size={14} /> 提交真实生成
          </button>
          <p className="muted">
            使用该类型绑定的媒体连接。图片和视频支持 Grok Build CLI 或 API；API
            按预算预留费用，CLI 用量以供应商为准。
          </p>
        </form>
      )}
      {jobs
        .filter((j) => j.taskId === task.id)
        .map((j) => (
          <div className="media-job-row" key={j.id}>
            <div>
              <strong>{j.agent}</strong>
              <span className="tag">{statusLabels[j.status] || j.status}</span>
              <p>{j.prompt.slice(0, 160)}</p>
              {j.remoteId && <small>供应商任务：{j.remoteId}</small>}
              {j.error && <p className="job-error">{j.error}</p>}
            </div>
            <div className="button-group">
              {j.outputId && (
                <a
                  className="button secondary compact"
                  href={mediaUrl(j.outputId)}
                  target="_blank"
                  rel="noreferrer"
                >
                  查看产物
                </a>
              )}
              {["queued", "polling", "submitting", "downloading"].includes(
                j.status,
              ) && (
                <button
                  className="icon-button"
                  title="中断此任务"
                  onClick={() =>
                    act(() => request(`/media/jobs/${j.id}/stop`, {}))
                  }
                >
                  <Pause size={15} />
                </button>
              )}
              {["detached", "poll_error", "queued"].includes(j.status) && (
                <button
                  className="icon-button"
                  title="继续查询"
                  onClick={() =>
                    act(() => request(`/media/jobs/${j.id}/resume`, {}))
                  }
                >
                  <RefreshCw size={15} />
                </button>
              )}
              {["unknown", "cancelled"].includes(j.status) && !j.remoteId && (
                <button
                  className="text-button"
                  onClick={() => {
                    if (
                      confirm(
                        "只有在你已核实供应商状态、接受再次提交可能收费时，才允许重新生成。确认？",
                      )
                    )
                      act(() => request(`/media/jobs/${j.id}/allow-retry`, {}));
                  }}
                >
                  已核实，允许重试
                </button>
              )}
            </div>
          </div>
        ))}
      {!jobs.some((j) => j.taskId === task.id) && (
        <p className="muted padded">
          开始阶段后，子 Agent
          的生成任务、进度和真实产物会出现在这里，也可以单独提交生成。
        </p>
      )}
    </section>
  );
}
export function BundleView({
  content,
  files,
  onSave,
  onRetryAsset,
  busy,
  production,
}: {
  content: string;
  files: MediaFile[];
  onSave: (content: string) => void;
  onRetryAsset?: (assetId: string) => void;
  busy: boolean;
  production?: ProductionRules;
}) {
  const original = mediaBundle(content);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<any>(null);
  if (!original)
    return <MarkdownContent content={content} rules={production} />;
  const bundle = editing ? draft : original,
    data = bundle.data;
  const update = (fn: (data: any) => void) => {
    const next = structuredClone(draft);
    fn(next.data);
    setDraft(next);
  };
  const selectFile = (
    value: string | undefined,
    onChange: (id: string) => void,
    kind: string,
  ) => (
    <select value={value || ""} onChange={(e) => onChange(e.target.value)}>
      <option value="">
        {kind === "audio" ? "自动生成 / 不使用" : "自动生成"}
      </option>
      {files
        .filter((f) => f.kind === kind)
        .map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
    </select>
  );
  return (
    <div className="bundle-view">
      <div className="bundle-toolbar">
        <p>{data.summary}</p>
        <button
          className="button secondary compact"
          onClick={() => {
            setDraft(structuredClone(original));
            setEditing(!editing);
          }}
        >
          {editing ? "取消编辑" : "调整内容与素材"}
        </button>
      </div>
      {(data.previewId || data.exportId) && (
        <MediaPreview id={data.exportId || data.previewId} files={files} />
      )}
      {bundle.type === "assets" ? (
        <>
          <div className="bundle-asset-grid">
            {data.assets.map((asset: any, i: number) => (
              <section key={asset.id} className="bundle-card">
                <MediaPreview id={asset.imageId} files={files} />
                <h3>
                  {asset.name}
                  <span className="tag">
                    {
                      { character: "角色", scene: "场景", prop: "道具" }[
                        asset.kind as string
                      ]
                    }
                  </span>
                </h3>
                {editing ? (
                  <>
                    <textarea
                      value={asset.prompt}
                      onChange={(e) =>
                        update((d) => {
                          d.assets[i].prompt = e.target.value;
                          delete d.assets[i].imageId;
                        })
                      }
                    />
                    {selectFile(
                      asset.imageId,
                      (id) =>
                        update((d) => {
                          d.assets[i].imageId = id || undefined;
                        }),
                      "image",
                    )}
                  </>
                ) : (
                  <details className="asset-prompt">
                    <summary>查看提示词</summary>
                    <p>{asset.prompt}</p>
                  </details>
                )}
                {onRetryAsset && (
                  <button
                    className="text-button asset-retry"
                    disabled={busy}
                    onClick={() => onRetryAsset(asset.id)}
                  >
                    <RefreshCw size={13} />
                    {asset.imageId ? "重新生成" : "生成此图"}
                  </button>
                )}
              </section>
            ))}
          </div>
          <h3 className="section-heading">角色声音试听</h3>
          {data.voices.map((voice: any, i: number) => (
            <div className="voice-option" key={i}>
              <div>
                <strong>{voice.character}</strong>
                <small>
                  {voice.voice} · {voice.sampleText}
                </small>
              </div>
              <MediaPreview id={voice.audioId} files={files} />
              {editing && (
                <button
                  className="button secondary compact"
                  onClick={() =>
                    update((d) => {
                      const [v] = d.voices.splice(i, 1);
                      d.voices.unshift(v);
                    })
                  }
                >
                  <Check size={13} /> 优先使用此声音
                </button>
              )}
            </div>
          ))}
        </>
      ) : (
        <>
          {data.shots?.map((shot: any, i: number) => (
            <section className="shot-editor" key={shot.id}>
              <div className="shot-editor-head">
                <span className="number">{String(i + 1).padStart(2, "0")}</span>
                <h3>{shot.title}</h3>
                <span className="tag">{shot.duration.toFixed(1)} 秒</span>
                {shot.draftImage && (
                  <span className="tag">资产占位 · 节奏草稿</span>
                )}
                {editing && (
                  <div className="button-group">
                    <button
                      className="icon-button"
                      disabled={i === 0}
                      onClick={() =>
                        update((d) => {
                          [d.shots[i - 1], d.shots[i]] = [
                            d.shots[i],
                            d.shots[i - 1],
                          ];
                        })
                      }
                      title="向前移动"
                    >
                      <ArrowUp size={15} />
                    </button>
                    <button
                      className="icon-button"
                      disabled={i === data.shots.length - 1}
                      onClick={() =>
                        update((d) => {
                          [d.shots[i + 1], d.shots[i]] = [
                            d.shots[i],
                            d.shots[i + 1],
                          ];
                        })
                      }
                      title="向后移动"
                    >
                      <ArrowDown size={15} />
                    </button>
                  </div>
                )}
              </div>
              <div className="shot-editor-body">
                <MediaPreview id={shot.videoId || shot.imageId} files={files} />
                <div>
                  {editing ? (
                    <>
                      <label>
                        画面与动作
                        <textarea
                          value={shot.prompt}
                          onChange={(e) =>
                            update((d) => {
                              d.shots[i].prompt = e.target.value;
                              delete d.shots[i].imageId;
                              delete d.shots[i].videoId;
                            })
                          }
                        />
                      </label>
                      <label>
                        台词
                        <textarea
                          value={shot.dialogue}
                          onChange={(e) =>
                            update((d) => {
                              d.shots[i].dialogue = e.target.value;
                              delete d.shots[i].audioId;
                              delete d.shots[i].videoId;
                            })
                          }
                        />
                      </label>
                      <div className="form-grid">
                        {[
                          ["beatId", "剧情节拍 ID"],
                          ["sceneId", "场景 ID"],
                          ["imagePrompt", "静态画面提示词"],
                          ["motionPrompt", "视频动作提示词"],
                          ["camera", "景别、机位与视线"],
                          ["startState", "起始状态"],
                          ["endState", "结束状态"],
                        ].map(([key, label]) => (
                          <label key={key}>
                            {label}
                            <textarea
                              value={shot[key] || ""}
                              onChange={(e) =>
                                update((d) => {
                                  d.shots[i][key] = e.target.value;
                                  if (
                                    [
                                      "imagePrompt",
                                      "camera",
                                      "startState",
                                    ].includes(key)
                                  )
                                    delete d.shots[i].imageId;
                                  if (!["beatId", "sceneId"].includes(key))
                                    delete d.shots[i].videoId;
                                })
                              }
                            />
                          </label>
                        ))}
                        <label>
                          视频生成策略
                          <select
                            value={shot.strategy || "tail-chain"}
                            onChange={(e) =>
                              update((d) => {
                                d.shots[i].strategy = e.target.value;
                                delete d.shots[i].videoId;
                              })
                            }
                          >
                            <option value="single">
                              单段生成（超长时停止）
                            </option>
                            <option value="tail-chain">长镜头末帧接续</option>
                          </select>
                        </label>
                      </div>
                      <div className="form-grid">
                        <label>
                          时长（秒）
                          <input
                            type="number"
                            min=".5"
                            max="600"
                            step=".1"
                            value={shot.duration}
                            onChange={(e) =>
                              update(
                                (d) =>
                                  (d.shots[i].duration = Number(
                                    e.target.value,
                                  )),
                              )
                            }
                          />
                        </label>
                        <label>
                          起始裁切（秒）
                          <input
                            type="number"
                            min="0"
                            step=".1"
                            value={shot.trimStart || 0}
                            onChange={(e) =>
                              update(
                                (d) =>
                                  (d.shots[i].trimStart = Number(
                                    e.target.value,
                                  )),
                              )
                            }
                          />
                        </label>
                        <label>
                          对白音量
                          <input
                            type="number"
                            min="0"
                            max="3"
                            step=".1"
                            value={shot.volume ?? 1}
                            onChange={(e) =>
                              update(
                                (d) =>
                                  (d.shots[i].volume = Number(e.target.value)),
                              )
                            }
                          />
                        </label>
                        <label>
                          转场
                          <select
                            value={shot.transition || "cut"}
                            onChange={(e) =>
                              update(
                                (d) => (d.shots[i].transition = e.target.value),
                              )
                            }
                          >
                            <option value="cut">直接切换</option>
                            <option value="fade">淡入淡出</option>
                          </select>
                        </label>
                        <label>
                          音画路线
                          <select
                            value={shot.route}
                            onChange={(e) =>
                              update((d) => {
                                d.shots[i].route = e.target.value;
                                delete d.shots[i].videoId;
                              })
                            }
                          >
                            <option value="separate">独立配音 / 画外音</option>
                            <option value="native">原生音画</option>
                            <option value="lipsync">独立配音 + 对口型</option>
                          </select>
                        </label>
                        <label>
                          声音 ID
                          <input
                            value={shot.voice}
                            onChange={(e) =>
                              update((d) => {
                                d.shots[i].voice = e.target.value;
                                delete d.shots[i].audioId;
                                delete d.shots[i].videoId;
                              })
                            }
                          />
                        </label>
                      </div>
                      <label>
                        替换关键帧
                        {selectFile(
                          shot.imageId,
                          (id) =>
                            update((d) => {
                              d.shots[i].imageId = id || undefined;
                              delete d.shots[i].videoId;
                            }),
                          "image",
                        )}
                      </label>
                      <label>
                        替换视频
                        {selectFile(
                          shot.videoId,
                          (id) =>
                            update(
                              (d) => (d.shots[i].videoId = id || undefined),
                            ),
                          "video",
                        )}
                      </label>
                      <label>
                        替换配音
                        {selectFile(
                          shot.audioId,
                          (id) =>
                            update(
                              (d) => (d.shots[i].audioId = id || undefined),
                            ),
                          "audio",
                        )}
                      </label>
                    </>
                  ) : (
                    <>
                      <p>{shot.prompt}</p>
                      <blockquote>{shot.dialogue || "无对白镜头"}</blockquote>
                      <small className="muted">
                        {shot.speaker} ·{" "}
                        {
                          {
                            separate: "独立配音",
                            native: "原生音画",
                            lipsync: "对口型",
                          }[shot.route as string]
                        }
                      </small>
                    </>
                  )}
                  {shot.audioId && (
                    <MediaPreview id={shot.audioId} files={files} />
                  )}
                </div>
              </div>
            </section>
          ))}
          {bundle.type === "timeline" && (
            <section className="sound-editor">
              <h3>音乐、音效与字幕</h3>
              {editing ? (
                <>
                  <label>
                    配乐生成要求
                    <textarea
                      value={data.musicPrompt || ""}
                      onChange={(e) =>
                        update((d) => {
                          d.musicPrompt = e.target.value;
                          delete d.musicId;
                        })
                      }
                    />
                  </label>
                  <label>
                    或使用已有音乐
                    {selectFile(
                      data.musicId,
                      (id) => update((d) => (d.musicId = id || undefined)),
                      "audio",
                    )}
                  </label>
                  <label>
                    音乐音量
                    <input
                      type="number"
                      min="0"
                      max="2"
                      step=".05"
                      value={data.musicVolume}
                      onChange={(e) =>
                        update((d) => (d.musicVolume = Number(e.target.value)))
                      }
                    />
                  </label>
                  <label>
                    音效生成要求
                    <textarea
                      value={data.soundPrompt || ""}
                      onChange={(e) =>
                        update((d) => {
                          d.soundPrompt = e.target.value;
                          delete d.soundId;
                        })
                      }
                    />
                  </label>
                  <label>
                    或使用已有音效
                    {selectFile(
                      data.soundId,
                      (id) => update((d) => (d.soundId = id || undefined)),
                      "audio",
                    )}
                  </label>
                  <label>
                    音效音量
                    <input
                      type="number"
                      min="0"
                      max="2"
                      step=".05"
                      value={data.soundVolume}
                      onChange={(e) =>
                        update((d) => (d.soundVolume = Number(e.target.value)))
                      }
                    />
                  </label>
                  <label>
                    字幕
                    <select
                      value={data.subtitles ? "on" : "off"}
                      onChange={(e) =>
                        update((d) => (d.subtitles = e.target.value === "on"))
                      }
                    >
                      <option value="on">烧录中文字幕 + 导出 SRT</option>
                      <option value="off">仅导出 SRT</option>
                    </select>
                  </label>
                  <label>
                    字幕字号
                    <input
                      type="number"
                      min="12"
                      max="96"
                      value={data.subtitleSize}
                      onChange={(e) =>
                        update((d) => (d.subtitleSize = Number(e.target.value)))
                      }
                    />
                  </label>
                </>
              ) : (
                <>
                  <MediaPreview id={data.musicId} files={files} />
                  {data.soundId && (
                    <MediaPreview id={data.soundId} files={files} />
                  )}
                </>
              )}
              <div className="export-links">
                {[
                  ["exportId", "MP4 成片"],
                  ["subtitleId", "SRT 字幕"],
                  ["dialogueTrackId", "对白轨"],
                  ["mixedTrackId", "混音轨"],
                ].map(
                  ([key, label]) =>
                    data[key] && (
                      <a
                        className="button secondary"
                        href={mediaUrl(data[key]) + "?download=1"}
                        key={key}
                      >
                        <ArrowDownToLine size={14} />
                        {label}
                      </a>
                    ),
                )}
              </div>
            </section>
          )}
        </>
      )}
      {editing && (
        <div className="bundle-save">
          <span className="muted">
            保存为新修订；下一次执行会复用未改动的素材。
          </span>
          <button
            className="button primary"
            disabled={busy}
            onClick={() => {
              const changed = structuredClone(draft);
              delete changed.data.exportId;
              delete changed.data.previewId;
              onSave(JSON.stringify(changed, null, 2));
              setEditing(false);
            }}
          >
            保存修改
          </button>
        </div>
      )}
    </div>
  );
}
