import type { V2ItemSupport } from "@t3tools/client-runtime/state/item-support";
import type { ThreadId } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import * as DateTime from "effect/DateTime";

import type { ThreadFeedActivity } from "./threadActivity";

export interface ThreadActivityInspectorField {
  readonly label: string;
  readonly value: string;
}

export interface ThreadActivityInspectorBlock {
  readonly label: string;
  readonly value: string;
  readonly monospaced: boolean;
}

export interface ThreadActivityFileLink {
  readonly label: string;
  readonly path: string;
  readonly line?: number;
}

export interface ThreadActivityWebLink {
  readonly label: string;
  readonly url: string;
}

export interface ThreadActivityInspectorModel {
  readonly fields: ReadonlyArray<ThreadActivityInspectorField>;
  readonly blocks: ReadonlyArray<ThreadActivityInspectorBlock>;
  readonly fileLinks: ReadonlyArray<ThreadActivityFileLink>;
  readonly webLinks: ReadonlyArray<ThreadActivityWebLink>;
  readonly canRollback: boolean;
  readonly rollbackTarget: {
    readonly threadId: ThreadId;
    readonly checkpointId: string;
    readonly scopeId: string;
  } | null;
  readonly structuredDetails: string;
}

function formatStructured(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function durationLabel(
  startedAt: DateTime.Utc | null,
  completedAt: DateTime.Utc | null,
): string | null {
  if (startedAt === null) return null;
  const start = DateTime.toEpochMillis(startedAt);
  const end = completedAt === null ? Date.now() : DateTime.toEpochMillis(completedAt);
  return formatDuration(Math.max(0, end - start));
}

function addBlock(
  blocks: ThreadActivityInspectorBlock[],
  label: string,
  value: unknown,
  monospaced = true,
): void {
  if (value === undefined || value === null || value === "") return;
  blocks.push({ label, value: formatStructured(value), monospaced });
}

export function buildThreadActivityInspector(
  activity: ThreadFeedActivity,
  support: V2ItemSupport,
): ThreadActivityInspectorModel {
  const row = activity.projectedItem;
  const item = row.item;
  const fields: ThreadActivityInspectorField[] = [
    { label: "Item", value: item.type.replaceAll("_", " ") },
    { label: "Status", value: item.status.replaceAll("_", " ") },
  ];
  const duration = durationLabel(item.startedAt, item.completedAt);
  if (duration) fields.push({ label: "Duration", value: duration });
  if (row.visibility !== "local") fields.push({ label: "Visibility", value: row.visibility });
  if (support.run) fields.push({ label: "Run", value: support.run.status });

  const latestAttempt = support.attempts.at(-1);
  if (latestAttempt) {
    fields.push({
      label: "Attempt",
      value: `${latestAttempt.attemptOrdinal} · ${latestAttempt.status} · ${latestAttempt.reason.replaceAll("_", " ")}`,
    });
  }
  if (support.node) {
    fields.push({
      label: "Node",
      value: `${support.node.kind.replaceAll("_", " ")} · ${support.node.status}`,
    });
  }
  if (support.providerThread) {
    fields.push({
      label: "Provider thread",
      value: `${support.providerThread.providerInstanceId} · ${support.providerThread.status}`,
    });
  }
  if (support.providerTurn) {
    fields.push({ label: "Provider turn", value: support.providerTurn.status });
  }
  if (support.providerSession) {
    fields.push({
      label: "Session",
      value: `${support.providerSession.status} · ${support.providerSession.model ?? "default model"}`,
    });
    fields.push({ label: "Working directory", value: support.providerSession.cwd });
  }
  if (support.runtimeRequest) {
    fields.push({
      label: "Request",
      value: `${support.runtimeRequest.status} · ${support.runtimeRequest.responseCapability.type.replaceAll("_", " ")}`,
    });
  }

  const blocks: ThreadActivityInspectorBlock[] = [];
  const fileLinks: ThreadActivityFileLink[] = [];
  const webLinks: ThreadActivityWebLink[] = [];

  if (support.attempts.length > 1) {
    addBlock(
      blocks,
      "Attempt history",
      support.attempts
        .map(
          (attempt) =>
            `Attempt ${attempt.attemptOrdinal} · ${attempt.status} · ${attempt.reason.replaceAll("_", " ")}`,
        )
        .join("\n"),
    );
  }

  switch (item.type) {
    case "reasoning":
      addBlock(blocks, "Reasoning", item.text, false);
      break;
    case "command_execution":
      addBlock(blocks, "Command", item.input);
      addBlock(blocks, "Output", item.output);
      if (item.exitCode !== undefined) {
        addBlock(blocks, "Exit", `Process exited with code ${item.exitCode}`);
      }
      break;
    case "file_change":
      fileLinks.push({ label: item.fileName, path: item.fileName });
      if (item.additions !== undefined || item.deletions !== undefined) {
        fields.push({
          label: "Changes",
          value: `+${item.additions ?? 0} −${item.deletions ?? 0}`,
        });
      }
      addBlock(blocks, "Patch", item.diffStr);
      addBlock(blocks, "Before", item.oldStr);
      addBlock(blocks, "After", item.newStr);
      break;
    case "file_search":
      addBlock(blocks, "Query", item.pattern);
      for (const result of item.results ?? []) {
        fileLinks.push({
          label: result.preview ? `${result.fileName} — ${result.preview}` : result.fileName,
          path: result.fileName,
          ...(result.line === undefined ? {} : { line: result.line }),
        });
      }
      break;
    case "web_search":
      addBlock(blocks, "Queries", item.patterns?.join("\n"));
      for (const result of item.results ?? []) {
        if (result.url) {
          webLinks.push({
            label: result.title ?? result.url,
            url: result.url,
          });
        }
        if (result.snippet)
          addBlock(blocks, result.title ?? "Search result", result.snippet, false);
      }
      break;
    case "dynamic_tool":
      addBlock(blocks, "Input", item.input);
      addBlock(blocks, "Output", item.output);
      break;
    case "approval_request":
      addBlock(blocks, "Prompt", item.prompt, false);
      break;
    case "user_input_request":
      addBlock(
        blocks,
        "Questions",
        item.questions.map((question) => question.question).join("\n"),
        false,
      );
      break;
    case "checkpoint":
      addBlock(
        blocks,
        "Files",
        item.files
          .map((file) => `${file.path}  +${file.additions} −${file.deletions}  ${file.kind}`)
          .join("\n"),
      );
      break;
    case "subagent":
      addBlock(blocks, "Prompt", item.prompt, false);
      addBlock(blocks, "Progress", support.subagent?.progress ?? item.progress, false);
      addBlock(blocks, "Result", support.subagent?.result ?? item.result, false);
      if (support.subagent) {
        fields.push({
          label: "Delegated task",
          value: `${support.subagent.origin.replaceAll("_", " ")} · ${support.subagent.status}`,
        });
      }
      break;
    case "handoff":
      addBlock(blocks, "Summary", item.summary, false);
      fields.push({
        label: "Handoff",
        value: `${item.strategy.replaceAll("_", " ")} · ${support.contextHandoff?.status ?? item.status}`,
      });
      if (support.contextTransfer) {
        fields.push({
          label: "Transfer",
          value: `${support.contextTransfer.type.replaceAll("_", " ")} · ${support.contextTransfer.status}`,
        });
        if (support.contextTransfer.resolution) {
          fields.push({
            label: "Context",
            value: support.contextTransfer.resolution.strategy.replaceAll("_", " "),
          });
        }
      }
      break;
    case "error":
      addBlock(blocks, "Error", item.failure.message, false);
      if (item.failure.code) fields.push({ label: "Code", value: item.failure.code });
      if (item.failure.retryable !== null) {
        fields.push({ label: "Retryable", value: item.failure.retryable ? "yes" : "no" });
      }
      break;
    case "proposed_plan":
      addBlock(blocks, "Plan", item.markdown, false);
      break;
    case "todo_list":
      addBlock(
        blocks,
        "Tasks",
        item.steps
          .map((step) => `${step.status === "completed" ? "✓" : "○"} ${step.text}`)
          .join("\n"),
        false,
      );
      addBlock(blocks, "Explanation", item.explanation, false);
      break;
    case "compaction":
      addBlock(blocks, "Summary", item.summary, false);
      if (item.beforeTokenCount !== undefined || item.afterTokenCount !== undefined) {
        fields.push({
          label: "Context tokens",
          value: `${item.beforeTokenCount ?? "?"} → ${item.afterTokenCount ?? "?"}`,
        });
      }
      break;
    case "run_interrupt_request":
    case "run_interrupt_result":
      addBlock(blocks, "Message", item.message, false);
      break;
    case "fork":
    case "thread_created":
    case "user_message":
    case "assistant_message":
      break;
  }

  const checkpoint = item.type === "checkpoint" ? support.checkpoint : null;
  return {
    fields,
    blocks,
    fileLinks,
    webLinks,
    canRollback: checkpoint?.status === "ready",
    rollbackTarget:
      checkpoint?.status === "ready"
        ? {
            threadId: row.sourceThreadId,
            checkpointId: checkpoint.id,
            scopeId: checkpoint.scopeId,
          }
        : null,
    structuredDetails: formatStructured({
      visibility: row.visibility,
      sourceThreadId: row.sourceThreadId,
      sourceItemId: row.sourceItemId,
      item,
    }),
  };
}
