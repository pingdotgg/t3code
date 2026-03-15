import { closeSync, mkdtempSync, openSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export type AgentWatchConditionCode =
  | "stale_output"
  | "non_zero_exit"
  | "abnormal_exit"
  | "missing_job";

export interface AgentWatchCondition {
  code: AgentWatchConditionCode;
  message: string;
}

export interface AgentWatchJobSnapshot {
  jobId: string;
  label: string;
  command: string;
  cwd: string;
  pid: number;
  status: "running" | "exited";
  exitCode?: number;
  startedAt: string;
  finishedAt?: string;
  lastOutputAt?: string;
  outputFreshnessMs?: number;
  shouldInspect: boolean;
  conditions: AgentWatchCondition[];
}

interface AgentWatchJob {
  jobId: string;
  label: string;
  command: string;
  cwd: string;
  pid: number;
  logPath: string;
  staleAfterMs: number;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
  lastOutputAt?: number;
}

const DEFAULT_STALE_AFTER_MS = 90_000;
const DEFAULT_WATCHDOG_INTERVAL_MS = 5_000;
const EXIT_MARKER_PREFIX = "__AGENTWATCH_EXIT_CODE:";

function nowIso(ms: number): string {
  return new Date(ms).toISOString();
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseExitCodeFromLog(logPath: string): number | undefined {
  try {
    const content = readFileSync(logPath, "utf8");
    const match = content.match(/__AGENTWATCH_EXIT_CODE:(\d+)/g);
    if (!match || match.length === 0) {
      return undefined;
    }
    const latest = match.at(-1);
    if (!latest) {
      return undefined;
    }
    const parsed = Number.parseInt(latest.slice(EXIT_MARKER_PREFIX.length), 10);
    return Number.isInteger(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function tailLog(logPath: string, lines: number): string {
  try {
    const content = readFileSync(logPath, "utf8");
    const parsedLines = content.split(/\r?\n/g);
    return parsedLines.slice(-Math.max(1, lines)).join("\n").trim();
  } catch {
    return "";
  }
}

export interface AgentWatchStartInput {
  command: string;
  cwd?: string;
  label?: string;
  staleAfterMs?: number;
}

export interface AgentWatchPollInput {
  jobId?: string;
  includeHealthy?: boolean;
}

export class AgentWatch {
  private readonly jobs = new Map<string, AgentWatchJob>();
  private readonly runtimeDir: string;
  private readonly interval: ReturnType<typeof setInterval>;

  constructor(watchdogIntervalMs = DEFAULT_WATCHDOG_INTERVAL_MS) {
    this.runtimeDir = mkdtempSync(path.join(tmpdir(), "agentwatch-"));
    this.interval = setInterval(() => {
      this.tick();
    }, watchdogIntervalMs);
    this.interval.unref();
  }

  dispose(): void {
    clearInterval(this.interval);
  }

  start(input: AgentWatchStartInput): AgentWatchJobSnapshot {
    const command = input.command.trim();
    if (command.length === 0) {
      throw new Error("AgentWatch start requires a non-empty command.");
    }

    const jobId = randomUUID();
    const cwd = input.cwd ?? process.cwd();
    const logPath = path.join(this.runtimeDir, `${jobId}.log`);
    const logFd = openSync(logPath, "a");

    const wrappedCommand = `${command}; __agentwatch_exit=$?; echo "${EXIT_MARKER_PREFIX}$__agentwatch_exit"`;

    const child = spawn("bash", ["-lc", wrappedCommand], {
      cwd,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    });
    child.unref();
    closeSync(logFd);

    const job: AgentWatchJob = {
      jobId,
      label: input.label?.trim() || `job-${jobId.slice(0, 8)}`,
      command,
      cwd,
      pid: child.pid ?? -1,
      logPath,
      staleAfterMs: input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
      startedAt: Date.now(),
    };

    this.jobs.set(jobId, job);
    this.tick();
    return this.toSnapshot(job, Date.now());
  }

  status(jobId: string): AgentWatchJobSnapshot {
    this.tick();
    const job = this.jobs.get(jobId);
    if (!job) {
      return {
        jobId,
        label: "unknown",
        command: "",
        cwd: "",
        pid: -1,
        status: "exited",
        startedAt: nowIso(Date.now()),
        shouldInspect: true,
        conditions: [{ code: "missing_job", message: `No AgentWatch job found for id ${jobId}.` }],
      };
    }

    return this.toSnapshot(job, Date.now());
  }

  poll(input: AgentWatchPollInput = {}): { jobs: AgentWatchJobSnapshot[] } {
    this.tick();
    const now = Date.now();

    if (input.jobId) {
      const snapshot = this.status(input.jobId);
      if (!input.includeHealthy && !snapshot.shouldInspect) {
        return { jobs: [] };
      }
      return { jobs: [snapshot] };
    }

    const snapshots = Array.from(this.jobs.values()).map((job) => this.toSnapshot(job, now));
    return {
      jobs: input.includeHealthy ? snapshots : snapshots.filter((job) => job.shouldInspect),
    };
  }

  tail(jobId: string, lines = 50): { jobId: string; output: string } {
    const job = this.jobs.get(jobId);
    if (!job) {
      return { jobId, output: "" };
    }

    return {
      jobId,
      output: tailLog(job.logPath, lines),
    };
  }

  private tick(): void {
    const now = Date.now();
    for (const job of this.jobs.values()) {
      try {
        const stats = statSync(job.logPath);
        job.lastOutputAt = stats.mtimeMs;
      } catch {
        // log may not exist yet
      }

      if (job.finishedAt !== undefined) {
        continue;
      }

      if (!isProcessAlive(job.pid)) {
        job.finishedAt = now;
        const exitCode = parseExitCodeFromLog(job.logPath);
        if (exitCode !== undefined) {
          job.exitCode = exitCode;
        }
      }
    }
  }

  private toSnapshot(job: AgentWatchJob, now: number): AgentWatchJobSnapshot {
    const status = job.finishedAt === undefined ? "running" : "exited";
    const outputFreshnessMs =
      job.lastOutputAt !== undefined ? Math.max(0, Math.round(now - job.lastOutputAt)) : undefined;

    const conditions: AgentWatchCondition[] = [];

    if (
      status === "running" &&
      outputFreshnessMs !== undefined &&
      outputFreshnessMs > job.staleAfterMs
    ) {
      conditions.push({
        code: "stale_output",
        message: `No terminal output for ${outputFreshnessMs}ms (threshold ${job.staleAfterMs}ms).`,
      });
    }

    if (status === "exited") {
      if (job.exitCode === undefined) {
        conditions.push({
          code: "abnormal_exit",
          message: "Process exited without a recorded exit code.",
        });
      } else if (job.exitCode !== 0) {
        conditions.push({
          code: "non_zero_exit",
          message: `Process exited with code ${job.exitCode}.`,
        });
      }
    }

    return {
      jobId: job.jobId,
      label: job.label,
      command: job.command,
      cwd: job.cwd,
      pid: job.pid,
      status,
      ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
      startedAt: nowIso(job.startedAt),
      ...(job.finishedAt !== undefined ? { finishedAt: nowIso(job.finishedAt) } : {}),
      ...(job.lastOutputAt !== undefined ? { lastOutputAt: nowIso(job.lastOutputAt) } : {}),
      ...(outputFreshnessMs !== undefined ? { outputFreshnessMs } : {}),
      shouldInspect: conditions.length > 0,
      conditions,
    };
  }

  handleToolCall(toolName: string, args: Record<string, unknown> | undefined): unknown {
    if (toolName === "agentwatch.start") {
      return {
        job: this.start({
          command: typeof args?.command === "string" ? args.command : "",
          ...(typeof args?.cwd === "string" ? { cwd: args.cwd } : {}),
          ...(typeof args?.label === "string" ? { label: args.label } : {}),
          ...(typeof args?.staleAfterMs === "number" ? { staleAfterMs: args.staleAfterMs } : {}),
        }),
      };
    }

    if (toolName === "agentwatch.status") {
      if (typeof args?.jobId !== "string") {
        throw new Error("agentwatch.status requires jobId.");
      }
      return { job: this.status(args.jobId) };
    }

    if (toolName === "agentwatch.poll") {
      return this.poll({
        ...(typeof args?.jobId === "string" ? { jobId: args.jobId } : {}),
        ...(typeof args?.includeHealthy === "boolean"
          ? { includeHealthy: args.includeHealthy }
          : {}),
      });
    }

    if (toolName === "agentwatch.tail") {
      if (typeof args?.jobId !== "string") {
        throw new Error("agentwatch.tail requires jobId.");
      }
      return this.tail(args.jobId, typeof args?.lines === "number" ? args.lines : 50);
    }

    throw new Error(`Unsupported tool: ${toolName}`);
  }
}
