import {
  characterSheetModule,
  donghuaStylePrompt,
  donghuaStyleVersion,
  propSheetModule,
  sceneSheetModule,
  xianxiaProductionPrompt,
} from "./visual-style";
import { z } from "zod";
import { productionRulesSchema } from "./production";
export const stages = [
  "故事概要",
  "全剧分集规划",
  "单集剧本",
  "定妆与资产",
  "分镜预览",
  "正式镜头",
  "后期成片",
  "完整故事稿",
  "文字分镜",
];
export const roles = [
  "主模型",
  "文本模型",
  "图片模型",
  "视频模型",
  "语音模型",
  "其他",
] as const;
export const templates = [
  {
    id: "cel",
    name: "热血赛璐璐",
    en: "CEL ANIMATION",
    color: "#d78662",
    description: "利落线条，强对比阴影，富有张力的动作表达",
    prompt: "赛璐璐动漫，清晰轮廓，色块阴影，强烈动作张力，统一角色比例",
  },
  {
    id: "fresh",
    name: "清新日系",
    en: "EVERYDAY POETRY",
    color: "#a6bea4",
    description: "柔和日光，细腻表情，日常里不经意的诗意",
    prompt: "清新动漫，柔和自然光，细腻表情，低饱和色彩，简洁背景",
  },
  {
    id: "ink",
    name: "国风水墨",
    en: "INK & SILENCE",
    color: "#abbcc4",
    description: "留白、笔触与墨色，铺开有呼吸感的东方画面",
    prompt: "国风水墨动画，墨色层次，克制留白，笔触质感，东方构图",
  },
  {
    id: "fantasy",
    name: "国风精细动画",
    en: "EASTERN FANTASY",
    color: "#bba2cc",
    description: "精致服饰与宏大场景，建立独特的幻想世界",
    prompt: "国风精细动画，服饰细节，统一材质，层次光照，东方幻想场景",
  },
  {
    id: "chibi",
    name: "Q 版轻喜剧",
    en: "LITTLE BIG WORLD",
    color: "#dfbf78",
    description: "圆润比例，夸张表情，让每一次互动更有趣",
    prompt: "Q版动画，圆润造型，夸张表情，明快色彩，轻喜剧节奏",
  },
  {
    id: "soft3d",
    name: "柔和三维动画",
    en: "SOFT DIMENSIONS",
    color: "#caa48c",
    description: "温暖材质、柔和体积光与有亲和力的角色",
    prompt: "柔和三维动画，温暖材质，柔和体积光，圆润角色，一致渲染风格",
  },
  {
    id: "donghua3d",
    name: "三维仙侠国漫",
    en: "XIANXIA DONGHUA",
    color: "#7b9aa8",
    description:
      "公共画风 DNA：仙侠 3D 材质与气质；人物、道具、场景各用自己的模块锁",
    prompt: donghuaStylePrompt,
  },
];
export function catalogVisualStyle(id: string) {
  const t = templates.find((x) => x.id === id);
  if (!t) throw Error("未知视觉模板");
  return {
    id: t.id,
    name: t.name,
    en: t.en,
    description: t.description,
    prompt: t.prompt,
    version: t.id === "donghua3d" ? donghuaStyleVersion : t.id,
    productionPrompt: t.id === "donghua3d" ? xianxiaProductionPrompt : t.prompt,
    ...(t.id === "donghua3d"
      ? {
          characterModule: characterSheetModule,
          propModule: propSheetModule,
          sceneModule: sceneSheetModule,
        }
      : {}),
  };
}
export const projectInput = z.object({
  name: z.string().trim().min(1).max(80),
  source: z.string().trim().min(1).max(120000),
  inputType: z.enum(["idea", "outline", "script"]),
  aspect: z
    .string()
    .regex(/^\d{1,4}:\d{1,4}$/)
    .refine((v) => v.split(":").every((n) => +n > 0)),
  template: z.string().refine((v) => templates.some((t) => t.id === v)),
  budget: z.number().int().min(0).max(100000000).default(0),
  production: productionRulesSchema.optional(),
});
export const connectionInput = z
  .object({
    id: z.string().optional(),
    name: z.string().trim().min(1).max(80),
    transport: z.enum(["cli", "api"]),
    provider: z.enum([
      "codex",
      "claude",
      "grok-build",
      "grokcli",
      "qwen-tts",
      "openai",
      "anthropic",
      "compatible",
      "xai",
      "gemini",
      "elevenlabs",
      "media-gateway",
      "sync",
    ]),
    executable: z.string().max(600).default(""),
    model: z.string().max(100).default(""),
    baseUrl: z.string().max(500).default(""),
    keyEnv: z
      .string()
      .regex(/^$|^[A-Z][A-Z0-9_]*$/)
      .default(""),
    reserveCents: z.number().int().min(0).max(1000000).default(0),
    settings: z.record(z.unknown()).optional(),
  })
  .superRefine((v, c) => {
    if (
      v.transport === "cli" &&
      (!v.executable.startsWith("/") ||
        !["codex", "claude", "grok-build", "grokcli", "qwen-tts"].includes(
          v.provider,
        ))
    )
      c.addIssue({
        code: "custom",
        message: "CLI 需要绝对路径和对应的工具类型",
      });
    if (
      v.provider === "qwen-tts" &&
      (v.transport !== "cli" || !/(CustomVoice|VoiceDesign)/.test(v.model))
    )
      c.addIssue({
        code: "custom",
        message:
          "Qwen 本地配音需要 CLI 和 CustomVoice/VoiceDesign 模型 ID 或路径",
      });
    if (v.transport === "api") {
      try {
        const u = new URL(v.baseUrl);
        if (
          u.protocol !== "https:" &&
          !(
            u.protocol === "http:" &&
            ["127.0.0.1", "localhost"].includes(u.hostname)
          )
        )
          throw Error();
      } catch {
        c.addIssue({
          code: "custom",
          message: "API 地址须为 HTTPS 或本机 HTTP",
        });
      }
      if (
        !v.keyEnv ||
        !v.model ||
        v.reserveCents < 1 ||
        ![
          "openai",
          "anthropic",
          "compatible",
          "xai",
          "gemini",
          "elevenlabs",
          "media-gateway",
          "sync",
        ].includes(v.provider)
      )
        c.addIssue({
          code: "custom",
          message: "API 需要模型、密钥环境变量和每次调用预留额度",
        });
    }
  });
export type Connection = z.infer<typeof connectionInput> & {
  id: string;
  health: string;
  version: string;
};
export type Project = z.infer<typeof projectInput> & {
  id: string;
  createdAt: string;
};
export type Task = {
  id: string;
  projectId: string;
  stage: number;
  episode?: number;
  title: string;
  role: string;
  status: string;
  revision: number;
  round: number;
  instruction: string;
  error: string;
  updatedAt: string;
};
export type Artifact = {
  id: string;
  taskId: string;
  revision: number;
  content: string;
  status: string;
  createdAt: string;
};
export type Event = {
  seq: number;
  projectId: string;
  taskId: string;
  type: string;
  message: string;
  createdAt: string;
};
export const reviewSchema = z.object({
  pass: z.boolean(),
  feedback: z.string().min(1),
});
export const interventionSchema = z.object({
  clear: z.boolean(),
  instruction: z.string().min(1),
  explanation: z.string().min(1),
});
