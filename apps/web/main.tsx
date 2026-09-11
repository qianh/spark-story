import { MarkdownContent } from "./MarkdownContent";
import {
  stageOrder,
  globalStages,
  isMediaStage,
  rank,
  structured,
  storySchema,
  storyOutlineSchema,
  chapterSchema,
} from "../../packages/series";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Aperture,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  AudioLines,
  BookOpen,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clapperboard,
  Cpu,
  FileText,
  Film,
  FolderOpen,
  Image,
  Layers,
  LayoutDashboard,
  LoaderCircle,
  MessageSquare,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Terminal,
  WandSparkles,
  X,
} from "lucide-react";
import { ThemeSwitch } from "./theme";
import { StyleForm } from "./StyleForm";
import {
  roles,
  stages,
  templates,
  type Project,
  type Task,
  type Artifact,
  type Connection,
  type Event,
} from "../../packages/domain";
import "./style.css";
import "./media.css";
import {
  ArtifactLibrary,
  BundleView,
  MediaJobs,
  MediaLibrary,
  MediaGenerationProgress,
} from "./MediaStudio";
import {
  mediaBundle,
  mediaGenerationProgress,
  type MediaFile,
  type MediaJob,
} from "../../packages/media";
import type { TaskProgress } from "../../packages/progress";
import {
  TaskActivity,
  LiveDraft,
  StoryProgress,
  latestCheckpoints,
} from "./TaskActivity";
import "./reading.css";
import { SeriesPlanningProgress, scriptText } from "./SeriesPlanningProgress";
import {
  ProductionFields,
  ProductionForm,
  readProduction,
} from "./ProductionForm";
import {
  productionRulesSchema,
  narrativeTemplates,
  type ProductionRules,
} from "../../packages/production";

type Board = {
  project: Project;
  production?: ProductionRules;
  productionNeedsReplan?: boolean;
  planningCheckpoints?: {
    taskId: string;
    revision: number;
    kind: string;
    status: string;
    content: string;
    createdAt?: string;
  }[];
  episodes?: { number: number; id: string; title: string }[];
  tasks: Task[];
  artifacts: Artifact[];
  events: Event[];
  interventions: any[];
  costs: { amount: number; status: string }[];
  mediaFiles: MediaFile[];
  mediaJobs: MediaJob[];
  progress?: TaskProgress[];
};
type Boot = {
  projects: Project[];
  connections: Connection[];
  bindings: { role: string; connectionId: string }[];
  templates?: typeof templates;
};
const states: Record<string, string> = {
  ready: "准备就绪",
  blocked: "等待前置确认",
  running: "正在创作",
  reviewing: "主控审核中",
  awaiting_user: "等待你确认",
  approved: "已确认",
  paused: "已暂停",
  coordinating: "主控协调中",
  needs_user: "需要你的意见",
  provider_blocked: "连接待处理",
  budget_blocked: "预算不足",
};
function taskStateLabel(task?: Task) {
  if (task?.status === "provider_blocked" && /语音审核待处理|本地配音已保存/.test(task.error || ""))
    return "语音审核待处理";
  return states[task?.status || "blocked"] || "等待更新";
}
const stageIcons = [
  BookOpen,
  Layers,
  FileText,
  Image,
  Layers,
  Film,
  AudioLines,
  BookOpen,
  Layers,
];
async function api<T = any>(
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const response = await fetch(
    "/api" + path,
    body === undefined
      ? undefined
      : {
          method: method || "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json();
  if (!response.ok) throw Error(data.error || "请求失败");
  return data;
}
function App() {
  const [boot, setBoot] = useState<Boot>({
    projects: [],
    connections: [],
    bindings: [],
  });
  const [board, setBoard] = useState<Board | null>(null);
  const [projectId, setProjectId] = useState(
    localStorage.getItem("spark-project") || "",
  );
  const [page, setPage] = useState("board");
  const [modal, setModal] = useState("");
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [stage, setStage] = useState(0);
  const [selectedEpisode, setSelectedEpisode] = useState(1);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [chat, setChat] = useState("");
  const [chapterInstruction, setChapterInstruction] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [offline, setOffline] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const lastProject = useRef(projectId);
  lastProject.current = projectId;
  async function reload() {
    const data = await api<Boot>("/bootstrap");
    setBoot(data);
    setLoaded(true);
    setOffline(false);
    const selected = lastProject.current;
    if (selected) {
      const b = await api<Board>("/projects/" + selected);
      if (lastProject.current === selected) setBoard(b);
    }
  }
  useEffect(() => {
    reload().catch((e) => {
      setError(e.message);
      setLoaded(true);
    });
  }, []);
  useEffect(() => {
    setBoard(null);
    setWorkspace(null);
    setStage(0);
    if (!projectId) return;
    localStorage.setItem("spark-project", projectId);
    let alive = true;
    const load = async () => {
      try {
        const b = await api<Board>("/projects/" + projectId);
        if (alive) {
          setBoard(b);
          setOffline(false);
        }
      } catch (e) {
        if (alive) setOffline(true);
      }
    };
    void load();
    const timer = setInterval(load, 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [projectId]);
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const episode = board?.episodes?.some((e) => e.number === selectedEpisode)
    ? selectedEpisode
    : board?.episodes?.[0]?.number || 1;
  const visibleTasks =
    board?.tasks.filter((t) => globalStages.includes(t.stage) || t.episode === episode) || [];
  const taskAt = (stage: number) => visibleTasks.find((t) => t.stage === stage);
  const task = board?.tasks.find((t) => t.id === workspace);
  const nextTask =
    task &&
    board?.tasks.find(
      (t) =>
        rank(t.stage) === rank(task.stage) + 1 &&
        (!t.episode || t.episode === (task.episode || episode)),
    );
  const artifact = task
    ? board?.artifacts.find(
        (a) => a.taskId === task.id && a.revision === task.revision,
      )
    : null;
  const liveContent =
    (task &&
      board?.progress?.find(
        (p) =>
          p.taskId === task.id &&
          p.revision === task.revision &&
          p.phase === "generate",
      )?.content) ||
    "";
  const storyCheckpoints = task
    ? latestCheckpoints(
        board?.planningCheckpoints || [],
        task.id,
        task.revision,
      )
    : [];
  const checkpointStatus = (status: string) =>
    ({ reviewed: "已通过", rejected: "未通过", candidate: "待审核" })[status] ||
    "待处理";
  const liveProduct =
    structured(liveContent, storySchema) ||
    structured(liveContent, storyOutlineSchema) ||
    structured(liveContent, chapterSchema);
  const mediaRunning =
    !!task &&
    isMediaStage(task.stage) &&
    ["running", "reviewing", "coordinating"].includes(task.status);
  const mediaProgress =
    task && isMediaStage(task.stage)
      ? mediaGenerationProgress({
          bundle: artifact ? mediaBundle(artifact.content) : null,
          jobs: (board?.mediaJobs || []).filter(
            (j) => j.taskId === task.id && j.revision === task.revision,
          ),
          running: mediaRunning,
        })
      : null;
  const activeTask =
    visibleTasks.find((t) =>
      ["running", "reviewing", "coordinating"].includes(t.status),
    ) || visibleTasks.find((t) => t.status !== "approved");
  const pending =
    board?.tasks.filter((t) =>
      ["awaiting_user", "needs_user"].includes(t.status),
    ).length || 0;
  const cost =
    board?.costs
      .filter((c) => c.status !== "released")
      .reduce((s, c) => s + c.amount, 0) || 0;
  const catalog = boot.templates?.length ? boot.templates : templates;
  const currentTemplate = catalog.find(
    (t) => t.id === board?.project.template,
  );
  const header =
    page === "connections"
      ? "模型与连接"
      : page === "templates"
        ? "画风模板库"
        : page === "assets"
          ? "项目资产库"
          : page === "activity"
            ? "运行记录"
            : page === "agents"
              ? "专业 Agent"
              : board?.project.name || "创作工作台";
  async function sendChat(e: React.FormEvent) {
    e.preventDefault();
    if (!chat.trim() || !activeTask) return;
    const message = chat;
    await act(async () => {
      await api(`/tasks/${activeTask.id}/interrupt`, {
        revision: activeTask.revision,
        message,
      });
      setChat("");
    });
  }
  function download(a: Artifact) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(
      new Blob([a.content], { type: "text/markdown;charset=utf-8" }),
    );
    link.download = `${task?.title || "产物"}-v${a.revision}.md`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button
          className="brand"
          onClick={() => {
            setPage("board");
            setWorkspace(null);
          }}
        >
          <span className="brand-mark">
            <Aperture size={24} />
          </span>
          <span>
            spark<span className="brand-light">story</span>
            <small>你的私人动画制作室</small>
          </span>
        </button>
        <button className="project-switch" onClick={() => setModal("projects")}>
          <span className="project-monogram">
            {(board?.project.name || "S").slice(0, 1)}
          </span>
          <span>
            {board?.project.name || "选择一个项目"}
            <small>个人工作空间</small>
          </span>
          <ChevronDown size={14} />
        </button>
        <div className="nav-label">
          工作空间 <span>WORKSPACE</span>
        </div>
        <nav>
          {[
            [LayoutDashboard, "board", "阶段看板"],
            [Image, "assets", "资产库"],
            [Cpu, "agents", "专业 Agent"],
            [RefreshCw, "activity", "运行记录"],
          ].map(([Icon, key, label]: any) => (
            <button
              key={key}
              className={page === key ? "nav-item active" : "nav-item"}
              onClick={() => {
                setPage(key);
                setWorkspace(null);
              }}
            >
              <Icon size={18} />
              {label}
              {key === "board" && pending > 0 && <b>{pending}</b>}
            </button>
          ))}
        </nav>
        <div className="nav-label second-label">
          创作资源 <span>RESOURCES</span>
        </div>
        <nav>
          {[
            [Layers, "templates", "画风模板"],
            [Settings2, "connections", "模型与连接"],
          ].map(([Icon, key, label]: any) => (
            <button
              key={key}
              className={page === key ? "nav-item active" : "nav-item"}
              onClick={() => {
                setPage(key);
                setWorkspace(null);
              }}
            >
              <Icon size={18} />
              {label}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-status">
            <i className={offline ? "off" : ""} />
            <span>
              {offline ? "后台暂时离线" : "本机工作台"}
              <small>{offline ? "等待重新连接" : "所有项目保存在本机"}</small>
            </span>
            <Terminal size={16} />
          </div>
          <button className="user-row" onClick={() => setModal("about")}>
            <span className="avatar">J</span>
            <span>
              我的制作室<small>PERSONAL STUDIO</small>
            </span>
            <CircleHelp size={17} />
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            工作空间 <ChevronRight size={13} />
            <strong>{header}</strong>
            {workspace && (
              <>
                <ChevronRight size={13} />
                <span>{task?.role}</span>
              </>
            )}
          </div>
          <div className="top-actions">
            <span className="version-label">LOCAL / v0.3</span>
            <ThemeSwitch />
            <button
              className="icon-button"
              aria-label="刷新"
              onClick={() => act(reload)}
            >
              <RefreshCw size={16} />
            </button>
            <span className="avatar small">J</span>
          </div>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button aria-label="关闭提示" onClick={() => setError("")}>
              <X size={16} />
            </button>
          </div>
        )}
        {!loaded ? (
          <div className="loading">
            <LoaderCircle className="spin" /> 正在打开制作室
          </div>
        ) : (
          <div
            className={
              "content-layout " +
              (page === "board" && board && !workspace ? "with-chat" : "")
            }
          >
            <main>
              {workspace && task && board ? (
                <>
                  <button
                    className="back"
                    onClick={() => {
                      setWorkspace(null);
                      setEditing(false);
                    }}
                  >
                    <ArrowLeft size={15} /> 返回阶段看板
                  </button>
                  <div className="page-heading">
                    <div>
                      <p className="eyebrow">
                        AGENT WORKSPACE ·{" "}
                        {String(rank(task.stage) + 1).padStart(2, "0")}
                      </p>
                      <h1>
                        {globalStages.includes(task.stage) ? "全剧 · " : `第 ${task.episode} 集 · `}
                        {task.title}
                        <span className={"status " + task.status}>
                          {taskStateLabel(task)}
                        </span>
                      </h1>
                      <p>
                        {task.role} <span className="divider">/</span> 修订{" "}
                        {task.revision}
                        {isMediaStage(task.stage) && (
                          <>
                            {" "}
                            <span className="divider">/</span>{" "}
                            <button
                              className="text-button"
                              onClick={() => setModal("style")}
                            >
                              画风 · {currentTemplate?.name}
                            </button>
                          </>
                        )}
                        {![1, 2, 8].includes(task.stage) && (
                          <>
                            {" "}
                            <span className="divider">/</span> {task.stage === 3 ? `自动重试 ${task.round} 轮` : `返工 ${task.round} / 3`}
                          </>
                        )}
                      </p>
                    </div>
                    <div className="button-group">
                      <button
                        className="button secondary"
                        disabled={busy}
                        onClick={() =>
                          act(() =>
                            api(`/tasks/${task.id}/interrupt`, {
                              revision: task.revision,
                              message: "",
                            }),
                          )
                        }
                      >
                        <Pause size={15} /> 立即中断
                      </button>
                      {(![
                        "running",
                        "reviewing",
                        "coordinating",
                        "awaiting_user",
                        "blocked",
                      ].includes(task.status) &&
                        (task.status !== "approved" || task.stage === 3)) && (
                        <button
                          className="button primary"
                          disabled={busy}
                          onClick={() =>
                            act(() =>
                              api(`/tasks/${task.id}/start`, {
                                revision: task.revision,
                              }),
                            )
                          }
                        >
                          <Play size={15} />{" "}
                          {task.stage === 3 && task.status === "approved"
                            ? "补后续定妆"
                            : "开始执行"}
                        </button>
                      )}
                    </div>
                  </div>
                  {task.error && <div className="notice">{task.error}</div>}
                  {task.stage === 1 && (
                    <div className="notice">
                      依据已确认完整故事拆集，只确定每集的故事边界、变化与粗估时长。确认后可选择各集独立制作。
                    </div>
                  )}
                  {task.status === "approved" && nextTask && (
                    <div className="notice">
                      此阶段已确认。
                      <button
                        className="text-button"
                        onClick={() => {
                          setWorkspace(nextTask.id);
                          setStage(nextTask.stage);
                          setEditing(false);
                        }}
                      >
                        进入{nextTask.title} →
                      </button>
                    </div>
                  )}
                  {board.events.find(
                    (e) => e.taskId === task.id && e.type === "workflow.part",
                  ) && (
                    <p className="notice">
                      最近步骤：
                      {
                        board.events.find(
                          (e) =>
                            e.taskId === task.id && e.type === "workflow.part",
                        )?.message
                      }
                    </p>
                  )}
                  {task.stage === 7 && (
                    <StoryProgress
                      outline={
                        structured(
                          storyCheckpoints.find((p) => p.kind === "故事结构")
                            ?.content || "",
                          storyOutlineSchema,
                        ) || undefined
                      }
                      checkpoints={storyCheckpoints}
                      currentKind={
                        board.events
                          .find(
                            (e) =>
                              e.taskId === task.id &&
                              e.type.startsWith("workflow.part"),
                          )
                          ?.message.match(/^(故事结构|章节 CH\d+)/)?.[1]
                      }
                    />
                  )}
                  <TaskActivity
                    task={task}
                    progress={board.progress?.find((p) => p.taskId === task.id)}
                    offline={offline}
                  />
                  {[1, 2, 8].includes(task.stage) && (
                    <SeriesPlanningProgress
                      task={task}
                      checkpoints={board.planningCheckpoints || []}
                      events={board.events}
                      liveContent={liveContent}
                    />
                  )}
                  {task.stage === 7 && (
                    <section className="panel">
                      <h3>章节检查点</h3>
                      <p>已通过的章节会保留；中断后从未完成片段继续。</p>
                      <textarea
                        aria-label="章节修改要求"
                        placeholder="先填写具体修改要求，再选择需要修改的章节。"
                        value={chapterInstruction}
                        onChange={(e) => setChapterInstruction(e.target.value)}
                      />
                      {storyCheckpoints.map((p, i) => (
                        <details
                          className="checkpoint-block"
                          key={p.kind}
                          open={i === 0}
                        >
                          <summary>
                            {p.kind} · {checkpointStatus(p.status)}
                          </summary>
                          <MarkdownContent content={p.content} />
                          {p.kind?.startsWith("章节 ") && (
                            <button
                              className="button"
                              disabled={
                                busy ||
                                !chapterInstruction.trim() ||
                                [
                                  "running",
                                  "reviewing",
                                  "coordinating",
                                ].includes(task.status)
                              }
                              onClick={() =>
                                act(() =>
                                  api(`/tasks/${task.id}/repair-chapter`, {
                                    revision: task.revision,
                                    chapterId: p.kind.slice(3),
                                    instruction: chapterInstruction,
                                  }),
                                )
                              }
                            >
                              修改本章及后续衔接
                            </button>
                          )}
                        </details>
                      ))}
                    </section>
                  )}
                  <div className="workspace-grid">
                    <section className="panel artifact-panel">
                      <div className="panel-heading">
                        <span>
                          <FileText size={16} /> 产物预览
                        </span>
                        <div className="button-group">
                          {artifact && (
                            <>
                              <button
                                className="icon-button"
                                title="下载 Markdown"
                                onClick={() => download(artifact)}
                              >
                                <ArrowDownToLine size={16} />
                              </button>
                              <button
                                className="text-button"
                                onClick={() => {
                                  setEditText(artifact.content);
                                  setEditing(!editing);
                                }}
                              >
                                {editing ? "取消编辑" : "直接编辑"}
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                      {mediaProgress &&
                        mediaProgress.phase !== "idle" &&
                        !editing &&
                        (mediaRunning ||
                          mediaProgress.phase === "generating") && (
                          <MediaGenerationProgress progress={mediaProgress} />
                        )}
                      {editing ? (
                        <div className="editor-wrap">
                          <textarea
                            className="artifact-editor"
                            value={editText}
                            onChange={(e) => setEditText(e.target.value)}
                          />
                          <button
                            className="button primary"
                            disabled={busy}
                            onClick={() =>
                              act(async () => {
                                await api(`/tasks/${task.id}/edit`, {
                                  revision: task.revision,
                                  content: editText,
                                });
                                setEditing(false);
                              })
                            }
                          >
                            保存为新版本
                          </button>
                        </div>
                      ) : !isMediaStage(task.stage) &&
                        task.status === "running" ? (
                        <>
                          <LiveDraft
                            key={task.id + ":" + task.revision}
                            content={
                              task.stage === 2
                                ? scriptText(liveContent)
                                : liveContent
                            }
                          />
                          {task.stage === 7 &&
                            storyCheckpoints[0] &&
                            !liveProduct && (
                              <>
                                <p className="muted">
                                  {storyCheckpoints[0].kind} ·{" "}
                                  {checkpointStatus(storyCheckpoints[0].status)}
                                  。下一段生成完成前，仍可在此阅读。
                                </p>
                                <MarkdownContent
                                  content={storyCheckpoints[0].content}
                                />
                              </>
                            )}
                        </>
                      ) : artifact ? (
                        <BundleView
                          production={board.production}
                          content={artifact.content}
                          files={board.mediaFiles || []}
                          busy={
                            busy ||
                            ["running", "reviewing", "coordinating"].includes(
                              task.status,
                            )
                          }
                          onSave={(content) =>
                            act(() =>
                              api(`/tasks/${task.id}/edit`, {
                                revision: task.revision,
                                content,
                              }),
                            )
                          }
                          onRetryVoices={(character, rewritePortrait) =>
                            act(() =>
                              api(`/tasks/${task.id}/retry-voices`, {
                                revision: task.revision,
                                ...(character ? { character } : {}),
                                ...(rewritePortrait
                                  ? { rewritePortrait: true }
                                  : {}),
                              }),
                            )
                          }
                          onRetryAsset={(assetId) =>
                            act(() =>
                              api(`/tasks/${task.id}/retry-asset`, {
                                revision: task.revision,
                                assetId,
                              }),
                            )
                          }
                          onSelectAsset={(assetId, imageId) =>
                            act(() =>
                              api(`/tasks/${task.id}/select-asset`, {
                                revision: task.revision,
                                assetId,
                                imageId,
                              }),
                            )
                          }
                        />
                      ) : board.progress?.find((p) => p.taskId === task.id)
                          ?.content ? (
                        <LiveDraft
                          active={false}
                          content={
                            board.progress.find((p) => p.taskId === task.id)!
                              .content
                          }
                        />
                      ) : (
                        <Empty
                          icon={FileText}
                          title={
                            mediaRunning
                              ? "产物生成后会出现在这里"
                              : "产物将在这里呈现"
                          }
                          description={
                            mediaRunning
                              ? "方案确定后，生成完成的图片、声音和视频会立即显示，无需刷新。"
                              : "开始任务后，Agent 的实际输出会保存为独立版本。"
                          }
                        />
                      )}
                      {task.status === "awaiting_user" &&
                        artifact?.status === "reviewed" && (
                          <div className="approval-bar">
                            <span>
                              <ShieldCheck size={17} />{" "}
                              主控审核已通过，等待你的确认
                            </span>
                            <button
                              className="button primary"
                              disabled={busy}
                              onClick={() =>
                                act(() =>
                                  api(`/tasks/${task.id}/approve`, {
                                    revision: task.revision,
                                    artifactId: artifact.id,
                                  }),
                                )
                              }
                            >
                              <Check size={15} /> 确认此版本
                            </button>
                          </div>
                        )}
                    </section>
                    <div>
                      <section className="panel">
                        <div className="panel-heading">
                          <span>
                            <MessageSquare size={16} /> 实时干预
                          </span>
                        </div>
                        <div className="padded">
                          <p className="muted">
                            明确的要求直接执行；不满意但没有具体方向时，主控会先提出方案。
                          </p>
                          <InterventionInput
                            disabled={busy}
                            onSubmit={(message) =>
                              act(() =>
                                api(`/tasks/${task.id}/interrupt`, {
                                  revision: task.revision,
                                  message,
                                }),
                              )
                            }
                          />
                          {board.interventions
                            .filter(
                              (i) =>
                                i.taskId === task.id &&
                                i.status === "awaiting_confirmation" &&
                                i.revision === task.revision,
                            )
                            .map((i) => (
                              <div className="proposal" key={i.id}>
                                <small>主控修改建议</small>
                                <p>{i.proposal}</p>
                                <button
                                  className="button primary"
                                  disabled={busy}
                                  onClick={() =>
                                    act(() =>
                                      api(`/interventions/${i.id}/confirm`, {}),
                                    )
                                  }
                                >
                                  确认并继续
                                </button>
                              </div>
                            ))}
                        </div>
                      </section>
                      <section className="panel history-panel">
                        <div className="panel-heading">
                          <span>
                            <Layers size={16} /> 版本历史
                          </span>
                        </div>
                        {board.artifacts
                          .filter((a) => a.taskId === task.id)
                          .map((a) => (
                            <details className="version-row" key={a.id}>
                              <summary>
                                <span>
                                  修订 {a.revision}
                                  <small>
                                    {new Date(a.createdAt).toLocaleString(
                                      "zh-CN",
                                    )}
                                  </small>
                                </span>
                                <span className="tag">
                                  {{
                                    approved: "正式版",
                                    reviewed: "主控通过",
                                    candidate: "候选",
                                    rejected: "待改进",
                                    superseded: "旧版本",
                                  }[a.status] || a.status}
                                </span>
                              </summary>
                              <pre>{a.content}</pre>
                              <button
                                className="text-button"
                                onClick={() => download(a)}
                              >
                                下载此版本
                              </button>
                            </details>
                          ))}
                      </section>
                    </div>
                  </div>
                  <MediaJobs
                    jobs={board.mediaJobs || []}
                    files={board.mediaFiles || []}
                    task={task}
                    act={act}
                  />
                  <MediaLibrary
                    files={(board.mediaFiles || []).filter(
                      (f) => f.taskId === task.id,
                    )}
                    task={task}
                    act={act}
                    onUpdated={reload}
                  />
                  <EventList
                    events={board.events.filter((e) => e.taskId === task.id)}
                  />
                </>
              ) : page === "connections" ? (
                <>
                  <div className="page-heading">
                    <div>
                      <p className="eyebrow">MODEL CONNECTIONS</p>
                      <h1>让合适的模型，各司其职。</h1>
                      <p>为六类能力分配执行连接，随时切换你的创作搭档。</p>
                    </div>
                    <button
                      className="button primary"
                      onClick={() => setModal("connection")}
                    >
                      <Plus size={16} /> 添加连接
                    </button>
                  </div>
                  <div className="notice subtle">
                    <Terminal size={16} />
                    <span>
                      CLI 按工具自身额度持续执行；API
                      按项目预算执行。图像、视频、配音使用对应媒体
                      API；音乐音效与口型可分别选择连接。
                    </span>
                  </div>
                  <div className="binding-grid">
                    {roles.map((role, i) => (
                      <section className="panel binding-card" key={role}>
                        <div className="binding-top">
                          <span className="number">0{i + 1}</span>
                          {React.createElement(
                            [Cpu, FileText, Image, Film, AudioLines, Sparkles][
                              i
                            ],
                            { size: 20 },
                          )}
                        </div>
                        <h3>{role}</h3>
                        <p>
                          {
                            [
                              "理解、规划、审核与任务协调",
                              "故事、人物、剧本与分镜文字",
                              "角色定妆、场景资产与关键帧",
                              "镜头生成与口型处理",
                              "角色声音与对白生成",
                              "音乐、音效与扩展能力",
                            ][i]
                          }
                        </p>
                        <select
                          aria-label={role + "连接"}
                          value={
                            boot.bindings.find((b) => b.role === role)
                              ?.connectionId || ""
                          }
                          onChange={(e) =>
                            e.target.value &&
                            act(() =>
                              api("/bindings", {
                                role,
                                connectionId: e.target.value,
                              }),
                            )
                          }
                        >
                          <option value="">选择执行连接</option>
                          {boot.connections.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name} · {c.transport.toUpperCase()}
                            </option>
                          ))}
                        </select>
                        {i > 1 && (
                          <small className="muted">
                            {
                              [
                                "",
                                "",
                                "OpenAI / xAI / Gemini / 兼容服务",
                                "OpenAI / xAI / 兼容服务",
                                "OpenAI / ElevenLabs",
                                "ElevenLabs 音乐与音效",
                              ][i]
                            }
                          </small>
                        )}
                      </section>
                    ))}
                  </div>
                  <section className="panel padded">
                    <label>
                      其他能力 · 口型同步连接
                      <select
                        aria-label="口型同步连接"
                        value={
                          boot.bindings.find((b) => b.role === "其他:口型")
                            ?.connectionId || ""
                        }
                        onChange={(e) =>
                          e.target.value &&
                          act(() =>
                            api("/bindings", {
                              role: "其他:口型",
                              connectionId: e.target.value,
                            }),
                          )
                        }
                      >
                        <option value="">选择 Sync 或媒体网关连接</option>
                        {boot.connections
                          .filter((c) =>
                            ["sync", "media-gateway"].includes(c.provider),
                          )
                          .map((c) => (
                            <option value={c.id} key={c.id}>
                              {c.name}
                            </option>
                          ))}
                      </select>
                    </label>
                    <p className="muted">
                      配音和口型是两种能力。出镜对白选择“独立配音 +
                      对口型”时，会使用这里的连接。
                    </p>
                  </section>
                  <div className="section-heading">
                    <h2>
                      已添加的连接 <span>{boot.connections.length}</span>
                    </h2>
                    <span className="muted">
                      探测仅检查安装或密钥存在，不产生模型费用
                    </span>
                  </div>
                  <section className="panel">
                    {boot.connections.map((c) => (
                      <div className="connection-row" key={c.id}>
                        <span className="connection-icon">
                          {c.transport === "cli" ? (
                            <Terminal size={20} />
                          ) : (
                            <Cpu size={20} />
                          )}
                        </span>
                        <div>
                          <h3>
                            {c.name}
                            <span className="tag">
                              {c.transport.toUpperCase()}
                            </span>
                          </h3>
                          <p>
                            {c.model || "使用工具默认模型"} ·{" "}
                            {c.version || c.executable || c.baseUrl}
                          </p>
                        </div>
                        <span className="health">
                          {{
                            installed: "已安装",
                            unverified: "待验证",
                            key_present: "密钥已配置",
                            key_missing: "缺少密钥",
                          }[c.health] || c.health}
                        </span>
                        <button
                          className="button secondary compact"
                          disabled={busy}
                          onClick={() =>
                            act(() => api(`/connections/${c.id}/probe`, {}))
                          }
                        >
                          检测连接
                        </button>
                        <button
                          className="text-button"
                          onClick={() => setModal("connection:" + c.id)}
                        >
                          编辑
                        </button>
                      </div>
                    ))}
                  </section>
                </>
              ) : page === "templates" ? (
                <>
                  <div className="page-heading">
                    <div>
                      <p className="eyebrow">VISUAL DIRECTION</p>
                      <h1>先选择故事的视觉语言。</h1>
                      <p>
                        内置风格起点，为角色、场景和镜头建立一致的表达。可应用到当前作品，定妆会按新画风重做。
                      </p>
                    </div>
                    <span className="tag">{catalog.length} 个内置模板</span>
                  </div>
                  <div className="template-grid">
                    {catalog.map((t, i) => (
                      <button
                        className={
                          "template-card" +
                          (t.id === board?.project.template ? " selected" : "")
                        }
                        key={t.id}
                        onClick={() => {
                          if (!board) setModal("new:" + t.id);
                          else setModal("style:" + t.id);
                        }}
                      >
                        <StyleArt index={i} color={t.color} />
                        <div className="template-caption">
                          <small>{t.en}</small>
                          <h2>
                            {t.name}
                            <ArrowRight size={20} />
                          </h2>
                          <p>{t.description}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                </>
              ) : page === "assets" ? (
                <>
                  <div className="page-heading">
                    <div>
                      <p className="eyebrow">PROJECT LIBRARY</p>
                      <h1>每一次创作，都有迹可循。</h1>
                      <p>
                        正式版本与候选版本独立保存，新的结果不会覆盖已有产物。
                      </p>
                    </div>
                  </div>
                  <div className="asset-tabs">
                    <span className="active">
                      全部产物 <b>{board?.artifacts.length || 0}</b>
                    </span>
                    <span>文本</span>
                    <span className="muted">
                      图片 / 视频 / 配音 / 音乐 / 音效
                    </span>
                  </div>
                  {board && (
                    <MediaLibrary
                      files={board.mediaFiles || []}
                      task={taskAt(3)!}
                      act={act}
                      onUpdated={reload}
                    />
                  )}
                  {board?.artifacts.length ? (
                    <ArtifactLibrary
                      artifacts={board.artifacts}
                      tasks={board.tasks}
                      projectId={projectId}
                      act={act}
                      onUpdated={reload}
                      onOpen={(a) => {
                        setWorkspace(a.taskId);
                        setPage("board");
                      }}
                    />
                  ) : (
                    <Empty
                      icon={FolderOpen}
                      title="你的故事资产，将从这里生长"
                      description="完成首个创作任务后，实际产物和版本会出现在资产库。"
                    />
                  )}
                </>
              ) : page === "activity" ? (
                <>
                  <div className="page-heading">
                    <div>
                      <p className="eyebrow">ACTIVITY & RECOVERY</p>
                      <h1>每一步，都有记录。</h1>
                      <p>查看 Agent 交接、审核结论和中断记录。</p>
                    </div>
                  </div>
                  <EventList events={board?.events || []} />
                </>
              ) : page === "agents" ? (
                <>
                  <div className="page-heading">
                    <div>
                      <p className="eyebrow">YOUR CREATIVE TEAM</p>
                      <h1>一个主控，一支制作团队。</h1>
                      <p>主控协调全局，专业 Agent 专注各自的交付。</p>
                    </div>
                  </div>
                  <div className="agent-grid">
                    {[
                      "主控 Agent",
                      "剧情 Agent",
                      "分镜 Agent",
                      "角色与资产 Agent",
                      "关键帧 Agent",
                      "视频 Agent",
                      "配音 Agent",
                      "音乐音效 Agent",
                      "后期 Agent",
                      "分集规划 Agent",
                    ].map((name, i) => (
                      <section className="panel agent-card" key={name}>
                        <span className={"agent-avatar a" + i}>
                          {React.createElement(
                            [
                              Cpu,
                              BookOpen,
                              Layers,
                              Image,
                              Image,
                              Film,
                              AudioLines,
                              Sparkles,
                              Clapperboard,
                              Layers,
                            ][i],
                            { size: 22 },
                          )}
                        </span>
                        <h3>{name}</h3>
                        <p>
                          {
                            [
                              "理解与规划 · 交接与审核",
                              "故事概要 · 分场剧本",
                              "镜头表达 · 节奏预览",
                              "定妆 · 场景 · 道具",
                              "参考资产 · 镜头画面",
                              "视频生成 · 口型同步",
                              "角色声音 · 情绪与台词",
                              "配乐 · 氛围 · 动作音效",
                              "拼接 · 混音 · 字幕",
                              "全剧集数 · 每集大纲 · 前后衔接",
                            ][i]
                          }
                        </p>
                        <span className="status ready">
                          {i < 2 || i === 9
                            ? "文本执行已接入"
                            : "媒体执行已接入"}
                        </span>
                        {board && (
                          <button
                            className="text-button"
                            onClick={() => {
                              setWorkspace(
                                visibleTasks.find(
                                  (t) =>
                                    t.stage ===
                                    [0, 0, 4, 3, 4, 5, 3, 6, 6, 1][i],
                                )!.id,
                              );
                              setPage("board");
                            }}
                          >
                            打开工作区 <ArrowRight size={13} />
                          </button>
                        )}
                      </section>
                    ))}
                  </div>
                </>
              ) : !board ? (
                <>
                  <div className="welcome">
                    <p className="eyebrow">
                      <span className="line" /> FROM A SPARK TO A STORY
                    </p>
                    <h1>
                      一个念头，
                      <br />
                      一场即将开幕的故事<span>。</span>
                    </h1>
                    <p className="welcome-description">
                      你的私人动漫制作工作台。
                      <br />
                      让专业 Agent 处理制作，让你专注每个值得讲述的瞬间。
                    </p>
                    <div className="button-group">
                      <button
                        className="button primary large"
                        onClick={() => setModal("new")}
                      >
                        <Plus size={18} /> 创建第一部作品
                      </button>
                      <button
                        className="button secondary large"
                        onClick={() => setPage("connections")}
                      >
                        配置模型 <ArrowRight size={16} />
                      </button>
                    </div>
                    <div className="welcome-reel">
                      <div className="reel-header">
                        <Aperture size={17} />
                        <span>SPARK STORY / CREATIVE STUDIO</span>
                        <span>001 — ∞</span>
                      </div>
                      <div className="reel-art">
                        <StyleArt index={0} color="#c4d69b" />
                        <div className="reel-title">
                          THE NEXT
                          <br />
                          <em>STORY</em>
                          <small>故事，始于你的想象</small>
                        </div>
                      </div>
                      <div className="reel-footer">
                        <span>CONCEPT → SCREEN</span>
                        <span>YOUR VISION. YOUR DIRECTION.</span>
                      </div>
                    </div>
                  </div>
                  <div className="welcome-features">
                    {[
                      [
                        Cpu,
                        "专业 Agent 协作",
                        "主控规划，专业分工，关键节点由你确认。",
                      ],
                      [
                        Layers,
                        "从故事到成片",
                        "剧情、定妆、分镜、视频与后期，连接完整流程。",
                      ],
                      [
                        ShieldCheck,
                        "随时介入创作",
                        "查看实际产物，中断调整，保留每一个版本。",
                      ],
                    ].map(([Icon, title, desc]: any) => (
                      <div key={title}>
                        <Icon size={20} />
                        <h3>{title}</h3>
                        <p>{desc}</p>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <div className="page-heading">
                    <div>
                      <p className="eyebrow">
                        PRODUCTION OVERVIEW{" "}
                        <span className="dot-separator">/</span> EPISODE 01
                      </p>
                      <h1>
                        {board.project.name}
                        <span className="project-badge">制作中</span>
                      </h1>
                      <p>
                        <button
                          className="text-button"
                          onClick={() => setModal("style")}
                        >
                          画风 · {currentTemplate?.name}
                        </button>
                        <span className="divider">/</span>
                        {board.project.aspect} 画幅
                        <span className="divider">/</span>第 {episode} 集制作
                        <span className="divider">/</span>
                        <button
                          className="text-button"
                          onClick={() => setModal("production")}
                        >
                          制作规则 · {board.production?.minSeconds ?? 90}～
                          {board.production?.maxSeconds ?? 120} 秒 ·{" "}
                          {narrativeTemplates.find(
                            (t) => t.id === board.production?.narrative,
                          )?.name || "冲突与爽点"}
                        </button>
                      </p>
                    </div>
                    <button
                      className="button secondary"
                      onClick={() => setModal("new")}
                    >
                      <Plus size={16} /> 新建项目
                    </button>
                  </div>
                  {board.productionNeedsReplan && (
                    <p className="muted">
                      当前分集产物尚未符合制作时间规则。请打开“制作规则”，保存后重新规划；原概要与历史产物会保留。
                    </p>
                  )}
                  <section className="overview-banner">
                    <div>
                      <span className="banner-kicker">
                        <Sparkles size={14} /> 从构想到银幕
                      </span>
                      <h2>
                        {activeTask?.status === "awaiting_user"
                          ? "新的创作已就绪，等你定夺。"
                          : "让故事，一步步成为画面。"}
                      </h2>
                      <p>
                        {activeTask
                          ? `当前阶段 · ${activeTask.title}。每个关键决定，都由你掌握。`
                          : "所有阶段已确认。"}
                      </p>
                      <button
                        className="text-button bright"
                        onClick={() =>
                          activeTask && setWorkspace(activeTask.id)
                        }
                      >
                        进入当前工作区 <ArrowRight size={16} />
                      </button>
                    </div>
                    <div className="banner-graphic">
                      <div className="orbit one" />
                      <div className="orbit two" />
                      <Clapperboard size={62} strokeWidth={1} />
                      <span>STORY IN MOTION</span>
                    </div>
                  </section>
                  <div className="metric-grid">
                    <div>
                      <small>制作进度</small>
                      <strong>
                        {
                          visibleTasks.filter((t) => t.status === "approved")
                            .length
                        }
                        <span> / {stages.length} 阶段</span>
                      </strong>
                      <div className="progress-line">
                        <i
                          style={{
                            width:
                              (visibleTasks.filter(
                                (t) => t.status === "approved",
                              ).length /
                                stages.length) *
                                100 +
                              "%",
                          }}
                        />
                      </div>
                    </div>
                    <div>
                      <small>待你确认</small>
                      <strong>
                        {String(pending).padStart(2, "0")}
                        <span> 个节点</span>
                      </strong>
                      <p>
                        {pending
                          ? "你的判断，让故事更进一步"
                          : "Agent 通过审核后将在这里通知你"}
                      </p>
                    </div>
                    <button onClick={() => setModal("budget")}>
                      <small>API 已预留 / 暂估</small>
                      <strong>
                        ${(cost / 100).toFixed(2)}
                        <span>
                          {" "}
                          / ${(board.project.budget / 100).toFixed(2)}
                        </span>
                      </strong>
                      <p>
                        CLI 不受此预算限制 <Settings2 size={12} />
                      </p>
                    </button>
                  </div>
                  <div className="section-heading">
                    <h2>制作流程</h2>
                    <span className="muted">
                      <span className="tiny-dot" /> 所有改动自动保存
                    </span>
                  </div>
                  <div className="episode-bar">
                    <label htmlFor="episode-select">制作集数</label>
                    <select
                      id="episode-select"
                      aria-label="制作集数"
                      value={episode}
                      onChange={(e) => {
                        setSelectedEpisode(Number(e.target.value));
                        setWorkspace("");
                      }}
                    >
                      {board.episodes?.length ? (
                        board.episodes.map((ep) => (
                          <option key={ep.number} value={ep.number}>
                            {ep.id} · {ep.title}
                          </option>
                        ))
                      ) : (
                        <option value={1}>分集确认后可选择</option>
                      )}
                    </select>
                    <p>
                      故事与定妆为全剧共享；切换集数只切换剧本、分镜、关键帧及后期任务。
                    </p>
                  </div>
                  <div className="stage-strip">
                    {stageOrder.map((i) => (
                      <button
                        key={i}
                        className={
                          (stage === i ? "selected " : "") +
                          (taskAt(i)?.status === "approved" ? "done" : "")
                        }
                        onClick={() => setStage(i)}
                      >
                        <span>
                          {taskAt(i)?.status === "approved" ? (
                            <Check size={14} />
                          ) : (
                            String(rank(i) + 1).padStart(2, "0")
                          )}
                        </span>
                        <strong>{stages[i]}</strong>
                        <small>
                          {taskStateLabel(taskAt(i))}
                        </small>
                      </button>
                    ))}
                  </div>
                  <div className="section-heading task-heading">
                    <h2>
                      {stages[stage]}
                      <span>1 个任务</span>
                    </h2>
                    <span className="muted">主控审核 → 你的确认</span>
                  </div>
                  {visibleTasks
                    .filter((t) => t.stage === stage)
                    .map((t) => (
                      <button
                        className="task-card"
                        key={t.id}
                        onClick={() => setWorkspace(t.id)}
                      >
                        <div className={"task-visual visual-" + stage}>
                          {React.createElement(stageIcons[stage], {
                            size: 38,
                            strokeWidth: 1,
                          })}
                          <span>
                            {String(rank(stage) + 1).padStart(2, "0")} /{" "}
                            {
                              [
                                "STORY",
                                "EPISODE PLAN",
                                "SCRIPT",
                                "CHARACTER",
                                "STORYBOARD",
                                "MOTION",
                                "FINAL CUT",
                                "COMPLETE STORY",
                                "SHOT PLAN",
                              ][stage]
                            }
                          </span>
                        </div>
                        <div className="task-body">
                          <div className="task-title">
                            <h3>
                              {t.title}
                              {stage === 0
                                ? "与人物设定"
                                : stage === 2
                                  ? "细化"
                                  : ""}
                            </h3>
                            <MoreHorizontal size={18} />
                          </div>
                          <p>
                            {
                              [
                                "从来源整理故事主线、人物关系与世界规则，建立整部作品的创作基础。",
                                "根据故事容量确定集数，逐集规划事件、人物变化、冲突、悬念与前后衔接。",
                                "依据已确认的全剧分集规划，细写本集的完整分场剧本，不提前消耗后续剧情。",
                                "依据完整故事与外观登记，按集补出本集用到的角色、声音、场景与道具；全剧共用，后集再补新变体。",
                                "把剧本转为镜头语言，使用动态预览检查节奏。",
                                "依据确认分镜生成关键帧、视频与正式配音。",
                                "完成镜头剪辑、音乐音效、字幕和成片导出。",
                                "按章节写完整部故事，完善人物经历、事件经过、伏笔与结局。章节分别审核保存，再整体确认。",
                                "依据本集剧本确定机位、动作、镜头衔接和资产需求，暂不生成图片。",
                              ][stage]
                            }
                          </p>
                          <div className="task-footer">
                            <span className="agent-chip">
                              <Cpu size={13} />
                              {t.role}
                            </span>
                            <span className={"status " + t.status}>
                              {taskStateLabel(t)}
                            </span>
                          </div>
                        </div>
                        <span className="task-open">
                          <ArrowRight size={19} />
                        </span>
                      </button>
                    ))}
                  <div className="section-heading">
                    <h2>最近动态</h2>
                    <button
                      className="text-button"
                      onClick={() => setPage("activity")}
                    >
                      查看全部 <ArrowRight size={13} />
                    </button>
                  </div>
                  <div className="recent-events">
                    {board.events.slice(0, 3).map((e) => (
                      <div key={e.seq}>
                        <span className="event-dot" />
                        <p>{e.message}</p>
                        <time>
                          {new Date(e.createdAt).toLocaleTimeString("zh-CN", {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </time>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </main>
            {page === "board" && board && !workspace && (
              <aside className="chat-panel">
                <div className="chat-heading">
                  <span className="master-mark">
                    <Sparkles size={18} />
                  </span>
                  <div>
                    <h3>主控 Agent</h3>
                    <small>
                      <i /> 创作协调中心
                    </small>
                  </div>
                  <span className="tag">主控</span>
                </div>
                <div className="chat-messages">
                  <div className="chat-date">项目工作记录</div>
                  <div className="chat-bubble">
                    <p>我是这部作品的主控。</p>
                    <p>
                      我会先检查专业 Agent
                      的产出，再把关键节点交给你确认。你也可以随时进入工作区调整方向。
                    </p>
                    <div className="chat-context">
                      <BookOpen size={15} />
                      <span>当前：{activeTask?.title || "已完成"}</span>
                    </div>
                  </div>
                  {board.events
                    .filter((e) =>
                      [
                        "master.message",
                        "review.passed",
                        "review.failed",
                        "task.error",
                      ].includes(e.type),
                    )
                    .slice(0, 5)
                    .reverse()
                    .map((e) => (
                      <div className="chat-bubble" key={e.seq}>
                        <small>
                          {e.type === "task.error" ? "执行提醒" : "主控"}
                        </small>
                        <p>{e.message}</p>
                      </div>
                    ))}
                </div>
                <form className="chat-compose" onSubmit={sendChat}>
                  <textarea
                    aria-label="给主控的修改意见"
                    value={chat}
                    onChange={(e) => setChat(e.target.value)}
                    placeholder="告诉主控，你想调整什么…"
                  />
                  <div>
                    <span>发送将中断当前任务并协调修改</span>
                    <button
                      aria-label="发送给主控"
                      disabled={busy || !chat.trim() || !activeTask}
                    >
                      <Send size={15} />
                    </button>
                  </div>
                </form>
                <div className="chat-footnote">
                  <ShieldCheck size={12} /> 关键决定，始终由你确认
                </div>
              </aside>
            )}
          </div>
        )}
      </div>
      {modal && (
        <div
          className="modal-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setModal("");
          }}
        >
          <section
            className={
              "modal " +
              (modal.startsWith("new") || modal.startsWith("style")
                ? "wide"
                : "")
            }
            role="dialog"
            aria-modal="true"
            aria-label="工作台设置"
          >
            <button
              className="modal-close icon-button"
              aria-label="关闭"
              onClick={() => setModal("")}
            >
              <X size={20} />
            </button>
            {modal.startsWith("new") ? (
              <NewProject
                initialTemplate={modal.split(":")[1]}
                busy={busy}
                onSubmit={(input) =>
                  act(async () => {
                    const p = await api<Project>("/projects", input);
                    setProjectId(p.id);
                    setPage("board");
                    setModal("");
                  })
                }
              />
            ) : modal.startsWith("connection") ? (
              <ConnectionForm
                initial={boot.connections.find(
                  (c) => c.id === modal.split(":")[1],
                )}
                busy={busy}
                onSubmit={(input) =>
                  act(async () => {
                    await api("/connections", input);
                    setModal("");
                  })
                }
              />
            ) : modal === "projects" ? (
              <>
                <p className="eyebrow">YOUR PROJECTS</p>
                <h2>切换作品</h2>
                {boot.projects.map((p) => (
                  <button
                    className="project-option"
                    key={p.id}
                    onClick={() => {
                      setProjectId(p.id);
                      setModal("");
                      setPage("board");
                    }}
                  >
                    <span className="project-monogram">
                      {p.name.slice(0, 1)}
                    </span>
                    <span>
                      {p.name}
                      <small>
                        {p.aspect} ·{" "}
                        {templates.find((t) => t.id === p.template)?.name}
                      </small>
                    </span>
                    {p.id === projectId ? (
                      <Check size={17} />
                    ) : (
                      <ChevronRight size={17} />
                    )}
                  </button>
                ))}
                <button
                  className="button primary full"
                  onClick={() => setModal("new")}
                >
                  <Plus size={16} /> 创建新项目
                </button>
              </>
            ) : modal.startsWith("style") && board ? (
              <StyleForm
                current={board.project.template}
                focus={modal.split(":")[1] || board.project.template}
                catalog={catalog}
                applied={(board.project as any).visualStyle}
                images={board.mediaFiles.filter((f: any) => f.kind === "image")}
                onReference={(referenceImageId) => act(async () => { await api(`/projects/${projectId}/visual-reference`, { referenceImageId }, "PUT"); })}
                busy={busy}
                onSubmit={(template) =>
                  act(async () => {
                    await api(`/projects/${projectId}`, { template }, "PATCH");
                    setModal("");
                  })
                }
              />
            ) : modal === "production" && board ? (
              <ProductionForm
                value={board.production || productionRulesSchema.parse({})}
                busy={busy}
                onSubmit={(input) =>
                  act(async () => {
                    await api(
                      `/projects/${projectId}/production`,
                      input,
                      "PUT",
                    );
                    setModal("");
                  })
                }
              />
            ) : modal === "budget" && board ? (
              <BudgetForm
                budget={board.project.budget}
                busy={busy}
                onSubmit={(budget) =>
                  act(async () => {
                    await api(`/projects/${projectId}`, { budget }, "PATCH");
                    setModal("");
                  })
                }
              />
            ) : (
              <>
                <p className="eyebrow">SPARK STORY / 0.2</p>
                <h2>个人动漫制作工作台</h2>
                <p className="muted">
                  支持剧情、定妆、声音试听、分镜预览、视频生成、配音、口型、音乐音效、字幕与本机成片合成。实际生成需要配置对应供应商连接。
                </p>
                <p className="muted">
                  任务和产物保存在本机。CLI 使用已有登录状态，API
                  使用本机保存或后台环境变量中的密钥。
                </p>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function Empty({
  icon: Icon,
  title,
  description,
}: {
  icon: any;
  title: string;
  description: string;
}) {
  return (
    <div className="empty">
      <span>
        <Icon size={30} strokeWidth={1} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}
function EventList({ events }: { events: Event[] }) {
  return (
    <section className="panel event-list">
      <div className="panel-heading">
        <span>
          <RefreshCw size={16} /> 执行记录
        </span>
        <small>最新记录在前</small>
      </div>
      {events.length ? (
        events.map((e) => (
          <div className="event-row" key={e.seq}>
            <span
              className={
                "event-dot " + (e.type.includes("error") ? "warning" : "")
              }
            />
            <div>
              <small>{e.type}</small>
              <p>{e.message}</p>
            </div>
            <time>{new Date(e.createdAt).toLocaleString("zh-CN")}</time>
          </div>
        ))
      ) : (
        <Empty
          icon={RefreshCw}
          title="尚无运行记录"
          description="开始制作后，每一步交接和审核都会记录在这里。"
        />
      )}
    </section>
  );
}
function InterventionInput({
  disabled,
  onSubmit,
}: {
  disabled: boolean;
  onSubmit: (s: string) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) onSubmit(value);
      }}
    >
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="例如：保留主线，让开场冲突更直接。"
        aria-label="修改要求"
      />
      <button
        className="button primary full"
        disabled={disabled || !value.trim()}
      >
        <Pause size={14} /> 中断并交给主控
      </button>
    </form>
  );
}
function StyleArt({ index, color }: { index: number; color: string }) {
  return (
    <div
      className={"style-art style-" + index}
      style={{ "--art-color": color } as React.CSSProperties}
      aria-hidden="true"
    >
      <div className="art-sun" />
      <div className="art-mountain back-mountain" />
      <div className="art-mountain front-mountain" />
      <div className="art-grid" />
      <span className="art-label">SS — 0{index + 1}</span>
    </div>
  );
}
function NewProject({
  initialTemplate,
  busy,
  onSubmit,
}: {
  initialTemplate?: string;
  busy: boolean;
  onSubmit: (input: any) => void;
}) {
  const [inputType, setInputType] = useState("idea");
  const [template, setTemplate] = useState(initialTemplate || "cel");
  const [aspect, setAspect] = useState("9:16");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        onSubmit({
          name: f.get("name"),
          source: f.get("source"),
          inputType,
          template,
          aspect: aspect === "custom" ? f.get("customAspect") : aspect,
          budget: Math.round(Number(f.get("budget") || 0) * 100),
          production: readProduction(f),
        });
      }}
    >
      <p className="eyebrow">START SOMETHING NEW</p>
      <h2>让一个故事开始。</h2>
      <p className="muted">从一个念头，或一份已经成形的剧本出发。</p>
      <label>
        作品名称
        <input
          name="name"
          required
          maxLength={80}
          placeholder="给你的作品起个名字"
          autoFocus
        />
      </label>
      <div className="segmented">
        {[
          ["idea", "一句话创意"],
          ["outline", "大致剧情"],
          ["script", "小说 / 剧本"],
        ].map(([key, label]) => (
          <button
            type="button"
            className={inputType === key ? "selected" : ""}
            key={key}
            onClick={() => setInputType(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <label>
        故事从这里开始
        <textarea
          name="source"
          required
          maxLength={120000}
          rows={5}
          placeholder={
            inputType === "idea"
              ? "例如：一个只能在雨天看见未来的少女，遇见了永远带着晴天的少年。"
              : "粘贴你的剧情、小说或剧本。当前文本执行支持 3 万字以内的输入。"
          }
        />
      </label>
      <div className="form-grid">
        <label>
          视觉模板
          <select
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
          >
            {templates.map((t) => (
              <option value={t.id} key={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          画面比例
          <select value={aspect} onChange={(e) => setAspect(e.target.value)}>
            <option>9:16</option>
            <option>16:9</option>
            <option value="custom">自定义</option>
          </select>
        </label>
        {aspect === "custom" && (
          <label>
            自定义比例
            <input
              name="customAspect"
              placeholder="4:3"
              pattern="[0-9]{1,4}:[0-9]{1,4}"
              required
            />
          </label>
        )}
        <label>
          API 预算（USD，可为 0）
          <input
            name="budget"
            type="number"
            min="0"
            max="1000000"
            step="0.01"
            defaultValue="0"
          />
        </label>
      </div>
      <ProductionFields />
      <div className="form-footer">
        <span>
          <ShieldCheck size={14} /> CLI 不受 API 预算限制
        </span>
        <button className="button primary" disabled={busy}>
          {busy ? (
            <LoaderCircle className="spin" size={16} />
          ) : (
            <Plus size={16} />
          )}{" "}
          创建项目
        </button>
      </div>
    </form>
  );
}
function ConnectionForm({
  busy,
  onSubmit,
  initial,
}: {
  busy: boolean;
  onSubmit: (input: any) => void;
  initial?: Connection;
}) {
  const [transport, setTransport] = useState<string>(
    initial?.transport || "cli",
  );
  const [provider, setProvider] = useState<string>(
    initial?.provider || "codex",
  );
  const [settingsError, setSettingsError] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        let settings: Record<string, unknown> = {};
        try {
          settings = JSON.parse(String(f.get("settings") || "{}"));
          if (
            !settings ||
            Array.isArray(settings) ||
            typeof settings !== "object"
          )
            throw Error();
          setSettingsError("");
        } catch {
          setSettingsError("高级参数需要有效的 JSON 对象");
          return;
        }
        onSubmit({
          id: initial?.id,
          settings,
          name: f.get("name"),
          transport,
          provider,
          executable: f.get("executable") || "",
          model: f.get("model") || "",
          baseUrl: f.get("baseUrl") || "",
          keyEnv: f.get("keyEnv") || "",
          apiKey: f.get("apiKey") || undefined,
          reserveCents: Math.round(Number(f.get("reserve") || 0) * 100),
        });
      }}
    >
      <p className="eyebrow">NEW CONNECTION</p>
      <h2>接入你的模型。</h2>
      <div className="segmented">
        {["cli", "api"].map((t) => (
          <button
            type="button"
            key={t}
            className={transport === t ? "selected" : ""}
            onClick={() => {
              setTransport(t);
              setProvider(t === "cli" ? "codex" : "compatible");
            }}
          >
            {t === "cli" ? "本机 CLI" : "API Key"}
          </button>
        ))}
      </div>
      <label>
        连接名称
        <input
          name="name"
          required
          placeholder="例如：我的 Codex"
          defaultValue={initial?.name}
        />
      </label>
      <label>
        工具 / 协议
        <select value={provider} onChange={(e) => setProvider(e.target.value)}>
          {(transport === "cli"
            ? [
                ["codex", "Codex CLI"],
                ["claude", "Claude Code"],
                ["grok-build", "Grok Build"],
                ["grokcli", "grokcli（待验证）"],
                ["qwen-tts", "Qwen3-TTS · 本机 MLX 配音"],
              ]
            : [
                ["compatible", "OpenAI 兼容协议"],
                ["openai", "OpenAI Chat Completions"],
                ["anthropic", "Anthropic Messages"],
                ["xai", "xAI · 图像 / 视频 / 文本"],
                ["gemini", "Gemini · 原生图像"],
                ["elevenlabs", "ElevenLabs · 配音 / 音乐 / 音效"],
                ["sync", "Sync · 口型同步"],
                ["media-gateway", "自定义媒体 HTTP 网关"],
              ]
          ).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </label>
      {transport === "cli" ? (
        <label>
          可执行文件绝对路径
          <input
            name="executable"
            required
            placeholder="/usr/local/bin/codex"
            defaultValue={initial?.executable}
          />
        </label>
      ) : (
        <>
          <label>
            API Base URL
            <input
              name="baseUrl"
              key={provider}
              required
              type="url"
              placeholder="https://api.openai.com/v1"
              defaultValue={
                initial?.provider === provider
                  ? initial.baseUrl
                  : (
                      {
                        xai: "https://api.x.ai/v1",
                        gemini:
                          "https://generativelanguage.googleapis.com/v1beta",
                        elevenlabs: "https://api.elevenlabs.io/v1",
                        sync: "https://api.sync.so/v2",
                        openai: "https://api.openai.com/v1",
                        anthropic: "https://api.anthropic.com/v1",
                      } as Record<string, string>
                    )[provider] || ""
              }
            />
          </label>
          <label>
            API Key
            <input
              name="apiKey"
              type="password"
              autoComplete="new-password"
              placeholder={
                initial ? "留空保留已保存的密钥" : "填写供应商 API Key"
              }
            />
            <small className="muted">
              仅存本机后台权限受限的凭据文件，不发送给 Agent。
            </small>
          </label>
          <label>
            或使用密钥环境变量
            <input
              name="keyEnv"
              defaultValue={initial?.keyEnv}
              placeholder="OPENAI_API_KEY"
            />
          </label>
          <label>
            每次调用预留金额（USD）
            <input
              name="reserve"
              required
              type="number"
              min="0.01"
              step="0.01"
              placeholder="0.50"
              defaultValue={
                initial?.reserveCents ? initial.reserveCents / 100 : undefined
              }
            />
            <small className="muted">
              暂按此金额计入预算，实际账单需在供应商核对。
            </small>
          </label>
        </>
      )}
      <label>
        模型 ID {transport === "cli" ? "（CLI 调度模型，可留空）" : ""}
        <input
          name="model"
          defaultValue={initial?.model}
          required={transport === "api"}
          placeholder={
            transport === "cli" ? "使用 CLI 默认模型" : "供应商提供的模型 ID"
          }
        />
      </label>
      {(transport === "api" ||
        provider === "grok-build" ||
        provider === "qwen-tts") && (
        <>
          <label>
            高级参数（JSON，可留空）
            <textarea
              name="settings"
              defaultValue={JSON.stringify(initial?.settings || {}, null, 2)}
              placeholder={
                '{"voice":"alloy","maxDuration":12,"nativeAudio":false}'
              }
            />
          </label>
          <p className="muted">
            可配置
            voice、voices、size、quality、maxDuration、nativeAudio、transcriptionModel；每个连接使用该供应商真实模型
            ID。
          </p>
          {provider === "media-gateway" && (
            <p className="muted">
              网关协议：POST /generate 返回媒体、URL 或 job_id；GET /jobs/:id
              查询；POST /transcribe 返回 text。输入素材通过 data URL 传递。
            </p>
          )}
          {settingsError && <p className="job-error">{settingsError}</p>}
        </>
      )}
      {provider === "qwen-tts" && (
        <p className="muted">
          可执行文件填写 MLX 环境的 Python 绝对路径，模型填写 Qwen3-TTS
          CustomVoice 或 VoiceDesign 的 MLX 模型 ID 或本地路径。少年或幼童声线必须用
          VoiceDesign：它按自然语言描述设计声线。CustomVoice
          的指示只改变情绪，Aiden、Serena 等预设不会变成少年。VoiceDesign
          必须填写 instructions
          人物声线描述，不使用固定音色；正式角色配音会使用角色设定。可绑定语音模型，无需
          API Key。高级参数支持 voice（默认 Vivian）、language（默认
          Chinese）、instructions（情绪、语速与语气，不要包含台词）。审核默认使用本地 Whisper，
          Python 环境需安装 mlx-whisper；transcriptionExecutable 可指定独立 Python，
          transcriptionModel 可指定转写模型（默认 mlx-community/whisper-large-v3-turbo）。
          配置 transcriptionConnectionId 后优先使用该 API 转写连接。
          预设音色配音不等于声音克隆。首次生成或转写需要加载模型。
        </p>
      )}
      {provider === "grok-build" && (
        <p className="muted">
          Grok Build 可绑定图片和视频模型，使用本机登录的 Imagine 工具；上方模型
          ID 是 CLI 调度模型，不是 Imagine
          模型。图片支持生成和参考图编辑，视频使用首帧动画化（6/10
          秒，480p/720p），长镜头由制作流程拆段。需账号具有媒体权限，CLI
          用量以供应商为准。
        </p>
      )}
      <p className="muted">
        图片提示词写主体、身份状态、构图与光线；视频写动作方向、机位运动与结束状态。系统按渠道适配，保留原始要求。高级参数
        promptGuidance 可补充当前模型要求；不会自动翻译或改写台词。API
        协议兼容不代表全部模型能力相同。
      </p>
      <button className="button primary full" disabled={busy}>
        保存连接 <ArrowRight size={15} />
      </button>
    </form>
  );
}
function BudgetForm({
  budget,
  busy,
  onSubmit,
}: {
  budget: number;
  busy: boolean;
  onSubmit: (n: number) => void;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(
          Math.round(Number(new FormData(e.currentTarget).get("budget")) * 100),
        );
      }}
    >
      <p className="eyebrow">API BUDGET</p>
      <h2>项目 API 预算</h2>
      <p className="muted">
        CLI 不受这个金额限制。API
        生成、返工和主控审核都会预留额度。当前按连接预估金额记账。
      </p>
      <label>
        金额（USD）
        <input
          type="number"
          name="budget"
          min="0"
          max="1000000"
          step="0.01"
          defaultValue={budget / 100}
          required
        />
      </label>
      <button className="button primary full" disabled={busy}>
        保存预算
      </button>
    </form>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
