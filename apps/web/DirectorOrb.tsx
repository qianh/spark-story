import { useEffect, useRef, useState } from "react";
import { BookOpen, Send, Sparkles, X } from "lucide-react";
import { ChangePlanView } from "./ChangePlanView";
import type { Event, Task } from "../../packages/domain";

function taskStatus(task?: { status?: string } | Task | null) {
  return task && "status" in task ? task.status : "";
}

type BoardSlice = {
  events: Event[];
  interventions: { id: string; status: string; proposal: string }[];
};

export function DirectorOrb({
  board,
  task,
  busy,
  open: openProp,
  onSend,
  onConfirm,
}: {
  board: BoardSlice;
  task?: { id: string; revision: number; title: string } | Task | null;
  busy: boolean;
  open?: boolean;
  onSend: (message: string) => Promise<unknown> | unknown;
  onConfirm: (id: string) => Promise<unknown> | unknown;
}) {
  const pending = board.interventions.filter(
    (i) => i.status === "awaiting_confirmation",
  );
  const applying = taskStatus(task) === "coordinating";
  const [internalOpen, setInternalOpen] = useState(false);
  const open = openProp ?? internalOpen;
  const setOpen = (next: boolean) => {
    if (openProp === undefined) setInternalOpen(next);
  };
  const prevPending = useRef(pending.length);
  const [draft, setDraft] = useState("");
  useEffect(() => {
    if (pending.length > prevPending.current || applying) setInternalOpen(true);
    prevPending.current = pending.length;
  }, [pending.length, applying]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <div className="director-orb">
      {open && (
        <section
          className="director-orb-panel"
          role="dialog"
          aria-label="主控对话"
        >
          <header className="director-orb-heading">
            <span className="master-mark">
              <Sparkles size={16} />
            </span>
            <div>
              <h3>主控</h3>
              <small>口述要改的剧情、人物或定妆</small>
            </div>
            <button
              className="icon-button"
              aria-label="收起主控"
              onClick={() => setOpen(false)}
            >
              <X size={16} />
            </button>
          </header>
          <div className="director-orb-messages">
            <div className="chat-bubble">
              <p>直接说要改什么。我会先评估影响，确认后再改设定、剧本并重出相关画面。</p>
              <div className="chat-context">
                <BookOpen size={15} />
                <span>当前：{task?.title || "请先进入一个阶段"}</span>
              </div>
            </div>
            {applying && (
              <div className="chat-bubble">
                <p>主控正在按已确认的方案改设定并重出相关画面，不是暂停。</p>
              </div>
            )}
            {pending.map((i) => (
              <ChangePlanView
                key={i.id}
                proposal={i.proposal}
                busy={busy}
                onConfirm={() => onConfirm(i.id)}
              />
            ))}
          </div>
          <form
            className="chat-compose"
            onSubmit={(e) => {
              e.preventDefault();
              if (!draft.trim() || !task) return;
              const message = draft;
              setDraft("");
              void onSend(message);
            }}
          >
            <textarea
              aria-label="给主控的修改意见"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="例如：药童改成男童"
            />
            <div>
              <span>确认后再改稿，不能只改提示词</span>
              <button
                aria-label="发送给主控"
                disabled={busy || !draft.trim() || !task}
              >
                <Send size={15} />
              </button>
            </div>
          </form>
        </section>
      )}
      <button
        className={"director-orb-ball" + (pending.length ? " waiting" : "")}
        aria-label={open ? "收起主控" : "打开主控"}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Sparkles size={22} />
        {pending.length > 0 && (
          <span className="director-orb-badge">{pending.length}</span>
        )}
      </button>
    </div>
  );
}
