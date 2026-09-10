export type MediaReviewProgress = {
  startedAt: string;
  step: "speech" | "visual" | "summary";
  current: string;
  speechDone: number;
  speechTotal: number;
  visualDone: number;
  visualTotal: number;
  summaryDone: boolean;
};

export type TaskProgress = {
  review?: MediaReviewProgress;
  taskId: string;
  revision: number;
  callId: string;
  phase: string;
  actor: string;
  model: string;
  content: string;
  startedAt: string;
  heartbeatAt: string;
  outputAt: string;
  status: string;
};
