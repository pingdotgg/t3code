import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { extractToolCommandInput } from "@t3tools/shared/toolActivity";

import { redactAuditText } from "./auditRedaction.ts";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function timestamp(value: unknown): string | undefined {
  const ms =
    typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : undefined;
}

interface CommandExecutionMetadata {
  command?: string;
  cwd?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  exitCode?: number;
  timeoutMs?: number;
}

export function extractCommandExecutionMetadata(value: unknown): CommandExecutionMetadata {
  const data = record(value);
  const execution = record(data?.execution);
  const item = record(data?.item);
  const state = record(data?.state);
  const time = record(state?.time);
  const metadata = record(state?.metadata);
  const input =
    record(state?.input) ?? record(data?.input) ?? record(data?.rawInput) ?? record(item?.input);
  const candidate = extractToolCommandInput(data) ?? text(execution?.command);
  const command =
    typeof candidate === "string"
      ? candidate
      : candidate
          ?.filter((part): part is string => typeof part === "string")
          .map((part) => (/[\s"'`]/u.test(part) ? JSON.stringify(part) : part))
          .join(" ");
  const cwd = text(execution?.cwd) ?? text(item?.cwd) ?? text(input?.workdir) ?? text(input?.cwd);
  const startedAt = timestamp(execution?.startedAt ?? time?.start);
  const completedAt = timestamp(execution?.completedAt ?? time?.end);
  const durationMs = finiteNumber(execution?.durationMs ?? item?.durationMs);
  const exitCode = finiteNumber(execution?.exitCode ?? item?.exitCode ?? metadata?.exit);
  const timeoutMs = finiteNumber(execution?.timeoutMs ?? input?.timeout ?? input?.timeout_ms);
  return {
    ...(command ? { command: redactAuditText(command) } : {}),
    ...(cwd ? { cwd: redactAuditText(cwd) } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(durationMs !== undefined && durationMs >= 0 ? { durationMs } : {}),
    ...(exitCode !== undefined && Number.isInteger(exitCode) ? { exitCode } : {}),
    ...(timeoutMs !== undefined && timeoutMs >= 0 ? { timeoutMs } : {}),
  };
}

interface ShellExecution extends Omit<CommandExecutionMetadata, "startedAt" | "completedAt"> {
  itemId: string | null;
  turnId: string | null;
  provider: string | null;
  providerStatus: string;
  startedAt: string | null;
  completedAt: string | null;
  timingSource: "provider" | "activity" | "unknown";
  lastActivityAt: string;
  completionObserved: boolean;
}

export function inspectShellExecutions(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  asOf: string,
) {
  const executions = new Map<string, ShellExecution>();
  for (const activity of activities) {
    const payload = record(activity.payload);
    if (
      payload?.itemType !== "command_execution" ||
      !["tool.started", "tool.updated", "tool.completed"].includes(activity.kind)
    )
      continue;
    const itemId = text(payload.itemId) ?? null;
    const provider = text(payload.provider) ?? null;
    const key = JSON.stringify([activity.turnId, provider, itemId ?? activity.id]);
    const previous = executions.get(key);
    const metadata = extractCommandExecutionMetadata(payload.data);
    const completed = activity.kind === "tool.completed";
    const startedAt =
      metadata.startedAt ??
      previous?.startedAt ??
      (activity.kind === "tool.started" ? activity.createdAt : null);
    executions.set(key, {
      ...previous,
      ...metadata,
      itemId,
      turnId: activity.turnId,
      provider,
      providerStatus: previous?.completionObserved
        ? previous.providerStatus
        : (text(payload.status) ?? (completed ? "completed" : "inProgress")),
      startedAt,
      completedAt:
        metadata.completedAt ?? previous?.completedAt ?? (completed ? activity.createdAt : null),
      timingSource: metadata.startedAt
        ? "provider"
        : (previous?.timingSource ?? (startedAt ? "activity" : "unknown")),
      lastActivityAt: activity.createdAt,
      completionObserved: completed || previous?.completionObserved === true,
    });
  }
  return {
    scope: "activity-page",
    asOf,
    executions: [...executions.values()].map((execution) => {
      const end = Date.parse(execution.completedAt ?? asOf);
      const elapsed = execution.startedAt ? end - Date.parse(execution.startedAt) : NaN;
      return {
        ...execution,
        command: execution.command ?? null,
        elapsedMs:
          execution.durationMs ?? (Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null),
        lastActivityAgeMs: Math.max(0, Date.parse(asOf) - Date.parse(execution.lastActivityAt)),
      };
    }),
  };
}
