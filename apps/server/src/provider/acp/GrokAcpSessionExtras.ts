import type { ThreadTokenUsageSnapshot } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { extractGrokTokenUsage } from "./XAiAcpExtension.ts";
import { grokCompleteCostUsd } from "../../usage/usageTranscripts.ts";

/**
 * Pure mapping of Grok Build `_x.ai/session/update` extras onto existing T3
 * runtime events. Claude maps compact_boundary / hook_* / session recap the
 * same way. Do not invent a third UI shape.
 */

export const GROK_SESSION_NOTIFICATION_METHODS = [
  "x.ai/session_notification",
  "_x.ai/session_notification",
  "x.ai/session/update",
  "_x.ai/session/update",
] as const;

export type GrokSessionNotificationMethod = (typeof GROK_SESSION_NOTIFICATION_METHODS)[number];

export const GROK_QUEUE_CHANGED_METHODS = ["_x.ai/queue/changed", "x.ai/queue/changed"] as const;

export const XAiQueueChangedNotification = Schema.Struct({
  sessionId: Schema.optional(Schema.Unknown),
  session_id: Schema.optional(Schema.Unknown),
  entries: Schema.Array(Schema.Unknown),
});
export type XAiQueueChangedNotification = typeof XAiQueueChangedNotification.Type;

export interface GrokHookRun {
  readonly hookId: string;
  readonly hookName: string;
  readonly outcome: "success" | "error" | "cancelled";
  readonly elapsedMs: number | undefined;
}

export interface GrokHookExecution {
  readonly hookEvent: string;
  readonly promptId: string | undefined;
  readonly runs: ReadonlyArray<GrokHookRun>;
}

export interface GrokAutoCompactStarted {
  readonly kind: "started";
  readonly tokensUsed: number;
  readonly contextWindow: number | undefined;
  readonly percentage: number | undefined;
  readonly reason: string | undefined;
}

export interface GrokAutoCompactCompleted {
  readonly kind: "completed";
  readonly tokensBefore: number | undefined;
  readonly tokensAfter: number;
  readonly elapsedMs: number | undefined;
}

export type GrokAutoCompact = GrokAutoCompactStarted | GrokAutoCompactCompleted;

export interface GrokSessionRecap {
  readonly summary: string;
  readonly auto: boolean;
}

export interface GrokTurnCompletedUsage {
  readonly usage: ThreadTokenUsageSnapshot;
  readonly costUsd: number | undefined;
}

export interface GrokBackgroundTask {
  readonly kind: "started" | "completed";
  readonly taskId: string;
  readonly description: string;
  readonly command: string | undefined;
  readonly outputFile: string | undefined;
  readonly exitCode: number | undefined;
  readonly output: string | undefined;
}

export interface GrokQueueChanged {
  readonly sessionId: string | undefined;
  readonly entries: ReadonlyArray<unknown>;
}

export type GrokExtraEventSpec =
  | {
      readonly type: "hook.started";
      readonly payload: { hookId: string; hookName: string; hookEvent: string };
    }
  | {
      readonly type: "hook.completed";
      readonly payload: {
        hookId: string;
        outcome: "success" | "error" | "cancelled";
      };
    }
  | {
      readonly type: "thread.token-usage.updated";
      readonly payload: { usage: ThreadTokenUsageSnapshot };
    }
  | {
      readonly type: "thread.state.changed";
      readonly payload: { state: "compacted"; detail?: unknown };
    }
  | {
      readonly type: "session.state.changed";
      readonly payload: {
        state: "waiting" | "running" | "ready";
        reason: string;
        detail?: unknown;
      };
    }
  | {
      readonly type: "thread.metadata.updated";
      readonly payload: { metadata: Record<string, unknown> };
    }
  | {
      readonly type: "task.started" | "task.progress" | "task.completed" | "task.updated";
      readonly payload: Record<string, unknown>;
    };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function nonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.trunc(value);
}

function sessionUpdateTag(update: Record<string, unknown>): string | undefined {
  return readString(update.sessionUpdate) ?? readString(update.session_update);
}

function unwrapSessionUpdate(payload: unknown): Record<string, unknown> | undefined {
  const envelope = asRecord(payload);
  return asRecord(envelope?.update) ?? envelope;
}

function hookOutcome(status: string | undefined): "success" | "error" | "cancelled" {
  switch (status) {
    case "success":
    case "ok":
    case "completed":
      return "success";
    case "cancelled":
    case "canceled":
    case "skipped":
      return "cancelled";
    default:
      return "error";
  }
}

export function parseXAiHookExecution(payload: unknown): GrokHookExecution | undefined {
  const update = unwrapSessionUpdate(payload);
  if (!update) {
    return undefined;
  }
  const tag = sessionUpdateTag(update);
  if (tag !== "hook_execution" && tag !== "HookExecution") {
    return undefined;
  }
  const hookEvent = readString(update.event_name) ?? readString(update.eventName);
  if (hookEvent === undefined) {
    return undefined;
  }
  const runs = Array.isArray(update.runs)
    ? update.runs.flatMap((entry): ReadonlyArray<GrokHookRun> => {
        const record = asRecord(entry);
        const name = readString(record?.name);
        if (name === undefined) {
          return [];
        }
        const statusRecord = asRecord(record?.status);
        const status =
          readString(statusRecord?.status) ??
          readString(record?.status) ??
          readString(record?.outcome);
        return [
          {
            hookId: name,
            hookName: name,
            outcome: hookOutcome(status),
            elapsedMs: nonNegativeInt(statusRecord?.elapsed_ms ?? statusRecord?.elapsedMs),
          },
        ];
      })
    : [];
  if (runs.length === 0) {
    return undefined;
  }
  return {
    hookEvent,
    promptId: readString(update.prompt_id) ?? readString(update.promptId),
    runs,
  };
}

export function grokHookEvents(execution: GrokHookExecution): ReadonlyArray<GrokExtraEventSpec> {
  return execution.runs.flatMap((run) => [
    {
      type: "hook.started" as const,
      payload: {
        hookId: run.hookId,
        hookName: run.hookName,
        hookEvent: execution.hookEvent,
      },
    },
    {
      type: "hook.completed" as const,
      payload: {
        hookId: run.hookId,
        outcome: run.outcome,
      },
    },
  ]);
}

export function parseXAiAutoCompact(payload: unknown): GrokAutoCompact | undefined {
  const update = unwrapSessionUpdate(payload);
  if (!update) {
    return undefined;
  }
  const tag = sessionUpdateTag(update);
  if (tag === "auto_compact_started" || tag === "AutoCompactStarted") {
    const tokensUsed = nonNegativeInt(update.tokens_used ?? update.tokensUsed);
    if (tokensUsed === undefined || tokensUsed <= 0) {
      return undefined;
    }
    return {
      kind: "started",
      tokensUsed,
      contextWindow: nonNegativeInt(update.context_window ?? update.contextWindow),
      percentage: nonNegativeInt(update.percentage),
      reason: readString(update.reason),
    };
  }
  if (tag === "auto_compact_completed" || tag === "AutoCompactCompleted") {
    const tokensAfter = nonNegativeInt(update.tokens_after ?? update.tokensAfter);
    if (tokensAfter === undefined) {
      return undefined;
    }
    return {
      kind: "completed",
      tokensBefore: nonNegativeInt(update.tokens_before ?? update.tokensBefore),
      tokensAfter,
      elapsedMs: nonNegativeInt(update.elapsed_ms ?? update.elapsedMs),
    };
  }
  return undefined;
}

export function grokAutoCompactEvents(
  compact: GrokAutoCompact,
  previous: ThreadTokenUsageSnapshot | undefined,
): ReadonlyArray<GrokExtraEventSpec> {
  if (compact.kind === "started") {
    const maxTokens = compact.contextWindow ?? previous?.maxTokens;
    const usage: ThreadTokenUsageSnapshot = {
      usedTokens: compact.tokensUsed,
      lastUsedTokens: compact.tokensUsed,
      ...(maxTokens !== undefined && maxTokens > 0 ? { maxTokens } : {}),
      compactsAutomatically: true,
    };
    return [
      {
        type: "session.state.changed",
        payload: {
          state: "waiting",
          reason: compact.reason ?? "compacting",
          detail: compact,
        },
      },
      { type: "thread.token-usage.updated", payload: { usage } },
    ];
  }

  const maxTokens = previous?.maxTokens;
  const usedTokens = compact.tokensAfter > 0 ? compact.tokensAfter : (previous?.usedTokens ?? 0);
  const events: Array<GrokExtraEventSpec> = [];
  if (usedTokens > 0) {
    events.push({
      type: "thread.token-usage.updated",
      payload: {
        usage: {
          usedTokens,
          lastUsedTokens: compact.tokensBefore ?? previous?.usedTokens ?? usedTokens,
          ...(compact.tokensBefore !== undefined && compact.tokensBefore > usedTokens
            ? { totalProcessedTokens: compact.tokensBefore }
            : {}),
          ...(maxTokens !== undefined ? { maxTokens } : {}),
          compactsAutomatically: true,
        },
      },
    });
  }
  events.push({
    type: "thread.state.changed",
    payload: { state: "compacted", detail: compact },
  });
  return events;
}

export function parseXAiSessionRecap(payload: unknown): GrokSessionRecap | undefined {
  const update = unwrapSessionUpdate(payload);
  if (!update) {
    return undefined;
  }
  const tag = sessionUpdateTag(update);
  if (tag !== "session_recap" && tag !== "SessionRecap") {
    return undefined;
  }
  const summary = readString(update.summary);
  if (summary === undefined) {
    return undefined;
  }
  return {
    summary,
    auto: update.auto === true,
  };
}

export function grokSessionRecapEvents(recap: GrokSessionRecap): ReadonlyArray<GrokExtraEventSpec> {
  return [
    {
      type: "thread.metadata.updated",
      payload: {
        metadata: {
          recap: recap.summary,
          recapAuto: recap.auto,
        },
      },
    },
  ];
}

export function parseXAiTurnCompletedUsage(
  payload: unknown,
  maxTokens?: number,
): GrokTurnCompletedUsage | undefined {
  const update = unwrapSessionUpdate(payload);
  if (!update) {
    return undefined;
  }
  const tag = sessionUpdateTag(update);
  if (tag !== "turn_completed" && tag !== "TurnCompleted") {
    return undefined;
  }
  const usageRecord = asRecord(update.usage);
  if (!usageRecord) {
    return undefined;
  }
  const usage = extractGrokTokenUsage(usageRecord, maxTokens);
  if (!usage) {
    return undefined;
  }
  return {
    usage,
    costUsd: grokCompleteCostUsd(usageRecord) ?? undefined,
  };
}

export function parseXAiBackgroundTask(payload: unknown): GrokBackgroundTask | undefined {
  const update = unwrapSessionUpdate(payload);
  if (!update) {
    return undefined;
  }
  const tag = sessionUpdateTag(update);
  if (tag === "task_backgrounded" || tag === "TaskBackgrounded") {
    const taskId = readString(update.task_id) ?? readString(update.taskId);
    if (taskId === undefined) {
      return undefined;
    }
    return {
      kind: "started",
      taskId,
      description:
        readString(update.description) ?? readString(update.command) ?? "Background command",
      command: readString(update.command),
      outputFile: readString(update.output_file) ?? readString(update.outputFile),
      exitCode: undefined,
      output: undefined,
    };
  }
  if (tag === "task_completed" || tag === "TaskCompleted") {
    const snapshot = asRecord(update.task_snapshot) ?? asRecord(update.taskSnapshot) ?? update;
    const taskId = readString(snapshot.task_id) ?? readString(snapshot.taskId);
    if (taskId === undefined) {
      return undefined;
    }
    return {
      kind: "completed",
      taskId,
      description:
        readString(snapshot.description) ?? readString(snapshot.command) ?? "Background command",
      command: readString(snapshot.command),
      outputFile: readString(snapshot.output_file) ?? readString(snapshot.outputFile),
      exitCode: nonNegativeInt(snapshot.exit_code ?? snapshot.exitCode),
      output: readString(snapshot.output),
    };
  }
  return undefined;
}

export function grokBackgroundTaskEvents(
  task: GrokBackgroundTask,
): ReadonlyArray<GrokExtraEventSpec> {
  const linkage = {
    taskId: task.taskId,
    description: task.description,
    title: task.description,
    taskType: "local_bash",
    ...(task.outputFile ? { outputFile: task.outputFile } : {}),
  };
  if (task.kind === "started") {
    return [
      { type: "task.started", payload: linkage },
      {
        type: "task.updated",
        payload: {
          ...linkage,
          status: "running",
          isBackgrounded: true,
        },
      },
    ];
  }
  const failed = task.exitCode !== undefined && task.exitCode !== 0;
  return [
    {
      type: "task.completed",
      payload: {
        ...linkage,
        status: failed ? "failed" : "completed",
        summary: task.output ?? task.description,
      },
    },
  ];
}

export function parseXAiQueueChanged(payload: unknown): GrokQueueChanged | undefined {
  const record = asRecord(payload);
  if (!record) {
    return undefined;
  }
  if (!Array.isArray(record.entries)) {
    return undefined;
  }
  return {
    sessionId: readString(record.sessionId) ?? readString(record.session_id),
    entries: record.entries,
  };
}

export function grokQueueChangedEvents(
  queue: GrokQueueChanged,
  sessionIsActive: boolean,
): ReadonlyArray<GrokExtraEventSpec> {
  const length = queue.entries.length;
  return [
    {
      type: "session.state.changed",
      payload: {
        state: length > 0 ? "waiting" : sessionIsActive ? "running" : "ready",
        reason: `queue:${length}`,
        detail: { queueLength: length },
      },
    },
    {
      type: "thread.metadata.updated",
      payload: {
        metadata: {
          grokQueueLength: length,
        },
      },
    },
  ];
}
