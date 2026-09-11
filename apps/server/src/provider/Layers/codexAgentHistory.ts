import type { AgentHistoryEntry, OrchestrationGetAgentHistoryResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type {
  V2ThreadReadResponse,
  V2ThreadReadResponse__ThreadItem,
} from "effect-codex-app-server/schema";

import { agentHistoryEntry, collectAgentHistory } from "./agentHistory.ts";

/** Normalize native items for all history views, preserving displayable reasoning and bounded tool detail. */
export function codexHistoryEntry(
  item: V2ThreadReadResponse__ThreadItem,
): AgentHistoryEntry | null {
  switch (item.type) {
    case "userMessage":
      return agentHistoryEntry(
        item.id,
        "user",
        "Prompt",
        item.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
      );
    case "agentMessage":
      return agentHistoryEntry(item.id, "assistant", "Agent", item.text);
    case "reasoning": {
      const summary = (item.summary ?? []).join("\n").trim();
      const content = (item.content ?? []).join("\n").trim();
      if (!summary && !content) return null;
      return agentHistoryEntry(
        item.id,
        "reasoning",
        summary ? "Reasoning summary" : "Reasoning",
        summary || content,
      );
    }
    case "plan":
      return agentHistoryEntry(item.id, "assistant", "Plan", item.text);
    case "commandExecution":
      return agentHistoryEntry(
        item.id,
        "tool",
        item.command,
        [
          item.aggregatedOutput,
          item.exitCode === null || item.exitCode === undefined
            ? null
            : `Exit code: ${item.exitCode}`,
        ]
          .filter((value) => value !== null && value !== undefined)
          .join("\n"),
      );
    case "fileChange":
      return agentHistoryEntry(
        item.id,
        "file-edit",
        `Edit ${item.changes.map((change) => change.path).join(", ")}`,
        item.changes.map((change) => `${change.path}\n${change.diff}`).join("\n\n"),
      );
    case "mcpToolCall":
      return agentHistoryEntry(
        item.id,
        "tool",
        `${item.server}: ${item.tool}`,
        JSON.stringify(
          { arguments: item.arguments, result: item.result, error: item.error },
          null,
          2,
        ),
      );
    case "dynamicToolCall":
      return agentHistoryEntry(
        item.id,
        "tool",
        item.tool,
        JSON.stringify({ arguments: item.arguments, result: item.contentItems }, null, 2),
      );
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
  const page = collectAgentHistory(input);
  for (const turn of thread.turns) {
    for (const item of turn.items) {
      const entry = codexHistoryEntry(item);
      if (entry && page.add({ ...entry, id: `${turn.id}:${entry.id}` })) return page.result();
    }
  }
  return page.result();
});
