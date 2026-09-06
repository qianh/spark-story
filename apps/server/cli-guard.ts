export class CliActivityGuard {
  private started: number;
  private last: number;
  private idle: number;
  private max: number;
  constructor(
    settings: Record<string, unknown> = {},
    private now = Date.now,
  ) {
    this.started = this.last = now();
    const seconds = (v: unknown, fallback: number) =>
      typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 86400
        ? v
        : fallback;
    this.idle = seconds(settings.cliIdleTimeoutSeconds, 600) * 1000;
    this.max = seconds(settings.cliMaxDurationSeconds, 7200) * 1000;
  }
  activity() {
    this.last = this.now();
  }
  reason(): string | undefined {
    if (this.now() - this.started >= this.max)
      return `CLI 总时长达到 ${this.max / 60000} 分钟安全上限，本次任务已停止`;
    if (this.now() - this.last >= this.idle)
      return `CLI 连续 ${this.idle / 60000} 分钟无有效输出，本次任务已停止`;
  }
}
