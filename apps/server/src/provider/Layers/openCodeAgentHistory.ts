import type { Message, Part, Session } from "@opencode-ai/sdk/v2";
import type { AgentHistoryEntry, OrchestrationGetAgentHistoryResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { agentHistoryEntry, collectAgentHistory } from "./agentHistory.ts";

/** Keep message order while normalizing displayable parts; internal step and token metadata stay hidden. */
function historyEntry(role: Message["role"], part: Part): AgentHistoryEntry | null {
  switch (part.type) {
    case "text":
      return agentHistoryEntry(part.id, role, role === "user" ? "Prompt" : "Agent", part.text);
    case "reasoning":
      return agentHistoryEntry(part.id, "reasoning", "Reasoning", part.text);
    case "tool": {
      const fileEdit = part.tool === "edit" || part.tool === "write" || part.tool === "apply_patch";
      const path = part.state.input.filePath ?? part.state.input.file_path;
      return agentHistoryEntry(
        part.id,
        fileEdit ? "file-edit" : "tool",
        fileEdit && typeof path === "string" ? `Edit ${path}` : part.tool,
        JSON.stringify(
          {
            input: part.state.input,
            status: part.state.status,
            ...(part.state.status === "completed" ? { output: part.state.output } : {}),
            ...(part.state.status === "error" ? { error: part.state.error } : {}),
          },
          null,
          2,
        ),
      );
    }
    default:
      return null;
  }
}

/** Read only descendants of the saved session, including nested agents, without resuming them. */
export const readOpenCodeAgentHistory = Effect.fn("readOpenCodeAgentHistory")(function* <E>(input: {
  parentSessionId: string;
  agentId: string;
  offset: number;
  view?: "recent-tools" | "latest" | undefined;
  readSession: (
    id: string,
  ) => Effect.Effect<Pick<Session, "id" | "parentID" | "revert"> | undefined, E>;
  readMessages: (
    id: string,
  ) => Effect.Effect<
    ReadonlyArray<{ info: Pick<Message, "id" | "role">; parts: ReadonlyArray<Part> }>,
    E
  >;
}): Effect.fn.Return<OrchestrationGetAgentHistoryResult, E> {
  const seen = new Set([input.parentSessionId]);
  let currentId = input.agentId;
  let belongsToParent = false;
  let revertMessageId: string | undefined;
  for (let depth = 0; depth < 32; depth++) {
    if (seen.has(currentId)) break;
    seen.add(currentId);
    const session = yield* input.readSession(currentId);
    if (currentId === input.agentId) revertMessageId = session?.revert?.messageID;
    if (!session?.parentID) break;
    currentId = session.parentID;
    if (currentId === input.parentSessionId) {
      belongsToParent = true;
      break;
    }
  }
  if (!belongsToParent)
    return {
      status: "unavailable",
      entries: [],
      nextOffset: null,
      message: "This agent does not belong to the saved provider session.",
    };
  const messages = yield* input.readMessages(input.agentId);
  const page = collectAgentHistory(input);
  for (const message of messages) {
    if (message.info.id === revertMessageId) break;
    for (const part of message.parts) {
      const entry = historyEntry(message.info.role, part);
      if (entry && page.add({ ...entry, id: `${message.info.id}:${entry.id}` }))
        return page.result();
    }
  }
  return page.result();
});
