import { z } from "zod";
export const mediaKinds = [
  "image",
  "video",
  "speech",
  "music",
  "sound",
  "lipsync",
] as const;
export type MediaKind = (typeof mediaKinds)[number];
export type MediaFile = {
  id: string;
  projectId: string;
  taskId: string;
  revision: number;
  kind: string;
  name: string;
  path: string;
  mime: string;
  metadata: string;
  createdAt: string;
};
export type MediaJob = {
  id: string;
  projectId: string;
  taskId: string;
  revision: number;
  kind: MediaKind;
  agent: string;
  prompt: string;
  inputs: string;
  options: string;
  connection: string;
  status: string;
  remoteId: string;
  outputId: string;
  error: string;
  costId: string;
  operationKey: string;
  createdAt: string;
  updatedAt: string;
};
const ref = z.string();
export const assetPlanSchema = z.object({
  summary: z.string(),
  assets: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string(),
        kind: z.enum(["character", "scene", "prop"]),
        prompt: z.string().min(1),
        identity: z.string().default(""),
        state: z.string().default(""),
        imageId: ref.optional(),
      }),
    )
    .min(1),
  voices: z
    .array(
      z.object({
        character: z.string(),
        voice: z.string(),
        sampleText: z.string(),
        audioId: ref.optional(),
      }),
    )
    .default([]),
});
export const shotSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  prompt: z.string().min(1),
  beatId: z.string().default(""),
  sceneId: z.string().default(""),
  imagePrompt: z.string().default(""),
  motionPrompt: z.string().default(""),
  camera: z.string().default(""),
  startState: z.string().default(""),
  endState: z.string().default(""),
  strategy: z.enum(["single", "tail-chain"]).default("tail-chain"),
  duration: z.number().min(0.5).max(600),
  assetIds: z.array(z.string()).default([]),
  dialogue: z.string().default(""),
  speaker: z.string().default(""),
  voice: z.string().default(""),
  route: z.enum(["separate", "native", "lipsync"]).default("separate"),
  imageId: ref.optional(),
  draftImage: z.boolean().default(false),
  audioId: ref.optional(),
  videoId: ref.optional(),
  trimStart: z.number().min(0).default(0),
  volume: z.number().min(0).max(3).default(1),
  transition: z.enum(["cut", "fade"]).default("cut"),
});
export const storyboardSchema = z.object({
  summary: z.string(),
  shots: z.array(shotSchema).min(1),
  previewId: ref.optional(),
});
export const timelineSchema = z.object({
  summary: z.string().default(""),
  shots: z.array(shotSchema).min(1),
  musicPrompt: z.string().default(""),
  soundPrompt: z.string().default(""),
  musicId: ref.optional(),
  soundId: ref.optional(),
  musicVolume: z.number().min(0).max(2).default(0.18),
  soundVolume: z.number().min(0).max(2).default(0.3),
  subtitles: z.boolean().default(true),
  subtitleSize: z.number().int().min(12).max(96).default(32),
  exportId: ref.optional(),
  subtitleId: ref.optional(),
  dialogueTrackId: ref.optional(),
  mixedTrackId: ref.optional(),
});
export type AssetPlan = z.infer<typeof assetPlanSchema>;
export type Storyboard = z.infer<typeof storyboardSchema>;
export type Shot = z.infer<typeof shotSchema>;
export type Timeline = z.infer<typeof timelineSchema>;
export function mediaBundle(content: string): any | null {
  try {
    const v = JSON.parse(content);
    return v?.type && v?.data ? v : null;
  } catch {
    return null;
  }
}
