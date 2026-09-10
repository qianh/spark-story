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
export const voicePortraitSchema = z.object({
  gender: z.enum(["male", "female"]),
  ageBand: z.enum(["child", "teen", "youth", "adult", "elder"]),
  pitch: z.enum(["low", "mid-low", "mid", "mid-high", "high"]),
  timbre: z.string().trim().min(1).max(20),
  pace: z.enum(["slow", "slightly-slow", "medium", "slightly-fast"]),
  accent: z.string().trim().min(1).max(20),
  baselineEmotion: z.string().trim().min(1).max(20),
  avoid: z.array(z.string().trim().min(1)).min(1),
});
export const voiceSampleSchema = z.object({
  character: z.string(),
  voice: z.string(),
  sampleText: z.string(),
  instructions: z.string().default(""),
  castingNote: z.string().default(""),
  status: z.enum(["ready", "not_required", "needs_voice"]).default("ready"),
  audioId: ref.optional(),
  voicePortrait: voicePortraitSchema.optional(),
  voiceIdentityKey: z.string().default(""),
  growthStage: z.string().optional(),
});
export function voiceInBatch(data: { voiceBatchAssetIds?: string[]; assets?: { id: string; name: string; growthStage?: string }[] }, voice: { character: string; growthStage?: string }) {
  return data.voiceBatchAssetIds === undefined || (data.assets || []).some(a =>
    data.voiceBatchAssetIds!.includes(a.id) && a.name === voice.character &&
    (a.growthStage || "") === (voice.growthStage || ""));
}

export const assetPlanSchema = z.object({
  summary: z.string(),
  // Scheduling metadata only; all assets and voices remain series-owned.
  voiceBatchAssetIds: z.array(z.string()).optional(),
  assets: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string(),
        kind: z.enum(["character", "scene", "prop"]),
        prompt: z.string().min(1),
        promptFormat: z
          .enum([
            "visual-description-v1",
            "character-content-v1",
            "prop-content-v1",
            "scene-content-v1",
          ])
          .optional(),
        identity: z.string().default(""),
        state: z.string().default(""),
        imageId: ref.optional(),
        generationPrompt: z.string().optional(),
        generationStyleVersion: z.string().optional(),
        generationStyleKey: z.string().optional(),
        generationReferenceIds: z.array(z.string()).optional(),
        sourceAssetId: z.string().optional(),
        sourceUsage: z.enum(["view", "extract", "variant"]).optional(),
        libraryId: ref.optional(),
        baseLibraryId: ref.optional(),
        entityId: z.string().optional(),
        variantId: z.string().optional(),
        variantKind: z.enum(["growth", "costume", "form"]).optional(),
        growthStage: z.string().optional(),
        candidates: z.array(z.string()).optional(),
        selectedCandidateId: ref.optional(),
        candidateSpecs: z.record(z.object({
          prompt: z.string(),
          styleKey: z.string(),
          styleVersion: z.string(),
          referenceIds: z.array(z.string()),
          passed: z.boolean().optional(),
        })).optional(),
      }),
    )
    .min(1),
  voices: z.array(voiceSampleSchema).default([]),
});
export const shotSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  prompt: z.string().min(1),
  beatId: z.string().default(""),
  sceneId: z.string().default(""),
  imagePrompt: z.string().default(""),
  motionPrompt: z.string().default(""),
  soundPrompt: z.string().default(""),
  musicPrompt: z.string().default(""),
  sourceAudioId: ref.optional(),
  sourceAudioVolume: z.number().min(0).max(2).default(0.3),
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
  generationStyleKey: z.string().optional(),
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
export type VoicePortrait = z.infer<typeof voicePortraitSchema>;
export type VoiceSample = z.infer<typeof voiceSampleSchema>;
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
export type MediaProgressItem = {
  id: string;
  name: string;
  kind: string;
  fileId?: string;
};
export function plannedMediaItems(
  bundle?: { type: string; data: any } | null,
): MediaProgressItem[] {
  if (!bundle?.data) return [];
  const data = bundle.data;
  if (bundle.type === "assets")
    return [
      ...(data.assets || [])
        .filter((a: any) => a.sourceUsage !== "view")
        .map((a: any) => ({
          id: String(a.id),
          name: String(a.name || a.id),
          kind: "image",
          fileId: a.imageId,
        })),
      ...(data.voices || [])
        .filter((v: any) => v.status !== "not_required" && voiceInBatch(data, v))
        .map((v: any, i: number) => ({
          id: `voice-${v.character}-${i}`,
          name: `${v.character} 试听`,
          kind: "audio",
          fileId: v.audioId,
        })),
    ];
  const items: MediaProgressItem[] = (data.shots || []).flatMap((s: any) => {
    const row: MediaProgressItem[] = [
      {
        id: String(s.id),
        name: String(s.title || s.id),
        kind: s.videoId ? "video" : "image",
        fileId: s.videoId || s.imageId,
      },
    ];
    if (s.dialogue && s.route !== "native")
      row.push({
        id: `${s.id}-audio`,
        name: `${s.title || s.id} 配音`,
        kind: "audio",
        fileId: s.audioId,
      });
    return row;
  });
  if (bundle.type === "storyboard")
    items.push({
      id: "preview",
      name: "动态预览",
      kind: "video",
      fileId: data.previewId,
    });
  if (bundle.type === "timeline") {
    if (data.musicPrompt || data.musicId)
      items.push({
        id: "music",
        name: "配乐",
        kind: "audio",
        fileId: data.musicId,
      });
    if (data.soundPrompt || data.soundId)
      items.push({
        id: "sound",
        name: "音效",
        kind: "audio",
        fileId: data.soundId,
      });
    items.push({
      id: "export",
      name: "成片",
      kind: "video",
      fileId: data.exportId,
    });
  }
  return items;
}
export function mediaGenerationProgress({
  bundle,
  jobs,
  running,
}: {
  bundle?: { type: string; data: any } | null;
  jobs: MediaJob[];
  running: boolean;
}) {
  const items = plannedMediaItems(bundle);
  const done = items.filter((i) => i.fileId).length;
  const current = jobs.find((j) =>
    ["queued", "submitting", "polling", "downloading"].includes(j.status),
  );
  const phase = !items.length
    ? running
      ? "planning"
      : "idle"
    : done < items.length || current
      ? "generating"
      : "complete";
  const label =
    phase === "planning"
      ? "正在规划需要生成的产物"
      : `产物 ${done} / ${items.length} 已呈现`;
  return { phase, items, done, total: items.length, current, label };
}
