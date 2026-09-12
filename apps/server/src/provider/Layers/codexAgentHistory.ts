import type { AgentHistoryEntry, OrchestrationGetAgentHistoryResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type {
  V2ThreadReadResponse,
  V2ThreadReadResponse__ThreadItem,
} from "effect-codex-app-server/schema";

import {
  agentHistoryEntry,
  boundedHistoryJson,
  boundedHistoryText,
  collectAgentHistory,
} from "./agentHistory.ts";

/** Identify entries that count toward pagination without serializing their payloads. */
function hasCodexHistoryEntry(item: V2ThreadReadResponse__ThreadItem): boolean {
  if (item.type === "reasoning")
    return (
      (item.summary ?? []).some((part) => part.trim()) ||
      (item.content ?? []).some((part) => part.trim())
    );
  return (
    item.type === "userMessage" ||
    item.type === "agentMessage" ||
    item.type === "plan" ||
    item.type === "commandExecution" ||
    item.type === "fileChange" ||
    item.type === "mcpToolCall" ||
    item.type === "dynamicToolCall" ||
    item.type === "webSearch" ||
    item.type === "collabAgentToolCall" ||
    item.type === "imageView" ||
    item.type === "imageGeneration" ||
    item.type === "enteredReviewMode" ||
    item.type === "exitedReviewMode"
  );
}

/** Yield file edits lazily so a large change list cannot create an unbounded intermediate string. */
function* fileChangeDetails(
  item: Extract<V2ThreadReadResponse__ThreadItem, { type: "fileChange" }>,
) {
  for (const change of item.changes) yield `${change.path}\n${change.diff}`;
}

/** Yield file paths lazily so history titles remain bounded for large change lists. */
function* fileChangePaths(item: Extract<V2ThreadReadResponse__ThreadItem, { type: "fileChange" }>) {
  for (const change of item.changes) yield change.path;
}

/** Normalize native items for all history views, preserving displayable reasoning and bounded tool detail. */
export function codexHistoryEntry(
  item: V2ThreadReadResponse__ThreadItem,
): AgentHistoryEntry | null {
  switch (item.type) {
    case "userMessage": {
      const detail = boundedHistoryText(
        item.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
      );
      return agentHistoryEntry(item.id, "user", "Prompt", detail.text, detail.truncated);
    }
    case "agentMessage":
      return agentHistoryEntry(item.id, "assistant", "Agent", item.text);
    case "reasoning": {
      const summary = boundedHistoryText(item.summary ?? []);
      const detail = summary.text.trim() ? summary : boundedHistoryText(item.content ?? []);
      if (!detail.text.trim()) return null;
      return agentHistoryEntry(
        item.id,
        "reasoning",
        summary.text.trim() ? "Reasoning summary" : "Reasoning",
        detail.text.trim(),
        detail.truncated,
      );
    }
    case "plan":
      return agentHistoryEntry(item.id, "assistant", "Plan", item.text);
    case "commandExecution": {
      const detail = boundedHistoryText(
        [
          item.aggregatedOutput,
          item.exitCode === null || item.exitCode === undefined
            ? null
            : `Exit code: ${item.exitCode}`,
        ].filter((value): value is string => typeof value === "string"),
      );
      return agentHistoryEntry(item.id, "tool", item.command, detail.text, detail.truncated);
    }
    case "fileChange": {
      const paths = boundedHistoryText(fileChangePaths(item), ", ");
      const detail = boundedHistoryText(fileChangeDetails(item), "\n\n");
      return agentHistoryEntry(
        item.id,
        "file-edit",
        `Edit ${paths.text}`,
        detail.text,
        paths.truncated || detail.truncated,
      );
    }
    case "mcpToolCall": {
      const detail = boundedHistoryJson({
        arguments: item.arguments,
        result: item.result,
        error: item.error,
      });
      return agentHistoryEntry(
        item.id,
        "tool",
        `${item.server}: ${item.tool}`,
        detail.text,
        detail.truncated,
      );
    }
    case "dynamicToolCall": {
      const detail = boundedHistoryJson({
        arguments: item.arguments,
        result: item.contentItems,
      });
      return agentHistoryEntry(item.id, "tool", item.tool, detail.text, detail.truncated);
    }
    case "webSearch":
      return agentHistoryEntry(item.id, "tool", `Search: ${item.query}`);
    case "collabAgentToolCall":
      return agentHistoryEntry(item.id, "tool", item.tool, item.prompt ?? item.status);
    case "imageView":
      return agentHistoryEntry(item.id, "tool", `View image: ${item.path}`);
    case "imageGeneration":
      return agentHistoryEntry(item.id, "tool", "Generate image", item.savedPath ?? item.status);
    case "enteredReviewMode":
    case "exitedReviewMode":
      return agentHistoryEntry(item.id, "assistant", "Review", item.review);
    default:
      return null;
  }
}

/** Report an unverified child without returning any of its saved content. */
const unavailable = (message: string): OrchestrationGetAgentHistoryResult => ({
  status: "unavailable",
  entries: [],
  nextOffset: null,
  message,
});

/** Verify native ancestry before reading content, including nested children. No resume/start calls. */
export const readCodexAgentHistory = Effect.fn("readCodexAgentHistory")(function* <E>(input: {
  parentThreadId: string;
  agentId: string;
  offset: number;
  view?: "recent-tools" | "latest" | undefined;
  readThread: (threadId: string, includeTurns: boolean) => Effect.Effect<V2ThreadReadResponse, E>;
}) {
  const seen = new Set<string>([input.parentThreadId]);
  let currentId = input.agentId;
  let belongsToParent = false;
  for (let depth = 0; depth < 32; depth++) {
    if (seen.has(currentId)) break;
    seen.add(currentId);
    const { thread } = yield* input.readThread(currentId, false);
    const source = thread.source;
    if (
      typeof source !== "object" ||
      !("subAgent" in source) ||
      typeof source.subAgent !== "object" ||
      !("thread_spawn" in source.subAgent)
    )
      break;
    currentId = source.subAgent.thread_spawn.parent_thread_id;
    if (currentId === input.parentThreadId) {
      belongsToParent = true;
      break;
    }
  }
  if (!belongsToParent)
    return unavailable("This agent does not belong to the saved provider session.");
  const { thread } = yield* input.readThread(input.agentId, true);
  let skippedEntries = 0;
  const page = collectAgentHistory(input, input.view === undefined ? input.offset : 0);
  for (const turn of thread.turns) {
    for (const item of turn.items) {
      if (input.view === undefined && skippedEntries < input.offset && hasCodexHistoryEntry(item)) {
        skippedEntries++;
        continue;
      }
      const entry = codexHistoryEntry(item);
      if (entry && page.add({ ...entry, id: `${turn.id}:${entry.id}` })) return page.result();
    }
  }
  return page.result();
});
