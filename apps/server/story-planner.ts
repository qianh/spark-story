import type { Runtime } from "./runtime";
import type { Task, Connection } from "../../packages/domain";
import { reviewSchema } from "../../packages/domain";
import { inventorySchema, type StoryInventory } from "../../packages/capacity";
import { parseResult } from "./connectors";

export function recoverInventory(content: string): StoryInventory | undefined {
  const candidates = [
    content,
    ...Array.from(
      content.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g),
      (m) => m[1],
    ),
  ];
  const valid = new Map<string, StoryInventory>();
  for (const raw of candidates) {
    try {
      const inventory = inventorySchema.parse(JSON.parse(raw));
      valid.set(JSON.stringify(inventory), inventory);
    } catch {}
  }
  return valid.size === 1 ? valid.values().next().value : undefined;
}

export async function prepareInventory(
  runtime: Runtime,
  task: Task,
  attemptId: string,
  text: Connection,
  master: Connection,
  context: string,
  signal: AbortSignal,
  editedInventory?: StoryInventory,
): Promise<StoryInventory> {
  const { store } = runtime;
  const cached = store.one<{ content: string }>(
    "SELECT content FROM planning_checkpoints WHERE taskId=? AND revision=? AND kind='inventory' AND status='reviewed' ORDER BY createdAt DESC LIMIT 1",
    task.id,
    task.revision,
  );
  if (cached) return inventorySchema.parse(JSON.parse(cached.content));
  const latest = store.one<{ content: string; status: string }>(
    "SELECT content,status FROM planning_checkpoints WHERE taskId=? AND revision=? AND kind='inventory' ORDER BY createdAt DESC,rowid DESC LIMIT 1",
    task.id,
    task.revision,
  );
  const progress =
    !latest &&
    store.one<{ content: string }>(
      "SELECT content FROM task_progress WHERE taskId=? AND revision=? AND phase='generate' AND status IN ('failed','interrupted')",
      task.id,
      task.revision,
    );
  const recovered =
    latest?.status === "candidate"
      ? recoverInventory(latest.content)
      : progress
        ? recoverInventory(progress.content)
        : undefined;
  if (recovered)
    store.event(
      task.projectId,
      task.id,
      "planning.inventory.recovered",
      `恢复完整情节清单：${recovered.units.length} 个戏剧单元，${recovered.units.reduce((n, u) => n + u.steps.length, 0)} 个步骤，待主控审核；不是集数。`,
    );
  let feedback = "";
  for (let round = 0; round < 4; round++) {
    if (signal.aborted || store.task(task.id).revision !== task.revision)
      throw Error("任务已中断");
    store.updateTask(task.id, task.revision, "running");
    store.event(
      task.projectId,
      task.id,
      "planning.inventory",
      `先展开全剧情节单元与因果步骤，再按表演容量拆集 · 第 ${round + 1} 次`,
    );
    const content =
      round === 0 && (editedInventory || recovered)
        ? JSON.stringify(editedInventory || recovered)
        : await runtime.call(
            task,
            attemptId,
            text,
            `你是剧情展开 Agent。只创作文本，不调用工具。先把来源展开为完整可演出的情节清单，不分集、不填总集数，不把全剧阶段概述当单集。充分展开相识、日常相处、建立信任、试探、失败、后果和关系变化，尊重来源，不为凑集重复注水。一个 unit 只围绕一个具体戏剧问题；大事件必须拆成各自有目标、阻碍和变化的单元。例如错药不能把喂药、察觉异化、师兄冲突、抢救、她的选择、突破、能力首次反哺打包为一个单元。高潮变化必须有前置经历和事后反应。\n返回合法 JSON {"units":[{"id":"U001","arc":"故事阶段","sourceAnchor":"对应概要或原著的具体事件依据；新增场景标明适度改编","description":"具体可演的冲突，不是阶段摘要","dramaticQuestion":"唯一戏剧问题","steps":[{"id":"U001-S01","description":"一项可见行为或反应，不把多个事件写成一句话","kind":"setup/pressure/choice/consequence/reaction/milestone 六者之一"}]}]}。全剧步骤按因果顺序列出，ID 全局唯一，覆盖开端、发展、高潮与结局，后续按这些步骤拆集。milestone 标出破境、治愈、身份揭晓等重大不可逆变化，不可漏标。\n只输出一个 units JSON 对象，完成后立即结束。不写分集、对白、performance、秒数或 production-json。每个步骤简洁描述可见行为，保留铺垫和反应。\n素材上下文：${context}\n返工：${feedback}`,
            signal,
          );
    let inventory: StoryInventory | undefined;
    try {
      inventory = inventorySchema.parse(parseResult(content));
    } catch (e) {
      feedback = `情节清单结构错误：${String(e).slice(0, 4000)}；上一版：${content}`;
    }
    let pass = false;
    const checkpointId = crypto.randomUUID();
    if (inventory) {
      if (signal.aborted || store.task(task.id).revision !== task.revision)
        throw Error("任务已中断");
      store.db.run("INSERT INTO planning_checkpoints VALUES(?,?,?,?,?,?,?)", [
        checkpointId,
        task.id,
        task.revision,
        "inventory",
        JSON.stringify(inventory),
        "candidate",
        new Date().toISOString(),
      ]);
      store.updateTask(task.id, task.revision, "reviewing");
      const review = reviewSchema.parse(
        parseResult(
          await runtime.call(
            task,
            attemptId,
            master,
            `你是主控。审核全剧情节展开清单，还没有分集。拒绝把宏观阶段、多个戏剧目标伪装成一个 unit；检查来源完整性、动机、铺垫、反应与后果，不准为了更多集数新增无因果支线或重复冲突。重点检查大事件是否拆出具体可演单元、关键成长是否有经历支撑，milestone 是否漏标。只返回 JSON {"pass":boolean,"feedback":"定位 U/步骤 ID，指出应拆出的目标或缺少的经历"}。\n来源：${context}\n清单：${JSON.stringify(inventory)}`,
            signal,
          ),
        ),
      );
      pass = review.pass;
      feedback = review.feedback + "\n上一版：" + JSON.stringify(inventory);
    }
    if (signal.aborted || store.task(task.id).revision !== task.revision)
      throw Error("任务已中断");
    store.db.run(
      "INSERT OR REPLACE INTO planning_checkpoints VALUES(?,?,?,?,?,?,?)",
      [
        checkpointId,
        task.id,
        task.revision,
        "inventory",
        inventory ? JSON.stringify(inventory) : content,
        pass ? "reviewed" : "rejected",
        new Date().toISOString(),
      ],
    );
    store.event(
      task.projectId,
      task.id,
      pass ? "planning.inventory.passed" : "planning.inventory.failed",
      pass
        ? `情节展开通过：${inventory!.units.length} 个戏剧单元，${inventory!.units.reduce((s, u) => s + u.steps.length, 0)} 个因果步骤。尚未确定集数。`
        : feedback.slice(0, 2500),
    );
    if (pass) return inventory!;
  }
  throw Error(
    "制作容量验收：情节展开已返工 3 次仍未通过，请查看情节清单审核意见",
  );
}
export function attachInventory(content: string, inventory: StoryInventory) {
  return content.replace(
    /```production-json\s*\n([\s\S]*?)\n```/,
    (block, raw) => {
      try {
        const data = JSON.parse(raw);
        if (!Array.isArray(data.episodes)) return block;
        return (
          "```production-json\n" +
          JSON.stringify({ ...data, inventory }, null, 2) +
          "\n```"
        );
      } catch {
        return block;
      }
    },
  );
}
export function episodeExcerpt(content: string, id: string) {
  const lines = content.split("\n");
  const start = lines.findIndex((l) =>
    new RegExp(`^#{1,6}\\s+${id}(?:[^0-9]|$)`).test(l),
  );
  if (start < 0) return "";
  const end = lines.findIndex(
    (l, i) =>
      i > start &&
      (/^#{1,6}\s+EP\d+/.test(l) || l.startsWith("```production-json")),
  );
  return lines.slice(start, end < 0 ? lines.length : end).join("\n");
}
