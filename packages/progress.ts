export type TaskProgress = {
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
