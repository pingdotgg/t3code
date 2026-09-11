import type {
  AgentHistoryEntry,
  OrchestrationGetAgentHistoryInput,
  OrchestrationGetAgentHistoryResult,
} from "@t3tools/contracts";

/** Keep history payloads bounded; omitted detail is explicitly marked in the UI. */
export function agentHistoryEntry(
  id: string,
  kind: AgentHistoryEntry["kind"],
  title: string,
  detail = "",
): AgentHistoryEntry {
  return {
    id,
    kind,
    title: title.slice(0, 500),
    detail: detail.slice(0, 8000),
    truncated: title.length > 500 || detail.length > 8000,
  };
}

/** Full history pages forward; previews retain only the latest five tools, oldest first. */
export function collectAgentHistory(
  input: Pick<OrchestrationGetAgentHistoryInput, "offset" | "view">,
) {
  const entries: AgentHistoryEntry[] = [];
  let index = 0;
  let nextOffset: number | null = null;
  return {
    add(entry: AgentHistoryEntry): boolean {
      if (input.view === "latest") {
        index++;
        entries.push(entry);
        if (entries.length > 50) entries.shift();
        return false;
      }
      if (input.view === "recent-tools") {
        if (entry.kind !== "tool" && entry.kind !== "file-edit") return false;
        entries.push({
          ...entry,
          detail: entry.detail.slice(0, 240),
          truncated: entry.truncated || entry.detail.length > 240,
        });
        if (entries.length > 5) entries.shift();
        return false;
      }
      if (index++ < input.offset) return false;
      if (entries.length === 50) {
        nextOffset = input.offset + entries.length;
        return true;
      }
      entries.push(entry);
      return false;
    },
    result(): OrchestrationGetAgentHistoryResult {
      return {
        status: "ready",
        entries,
        nextOffset,
        message: null,
        ...(input.view === "latest" ? { startOffset: Math.max(0, index - entries.length) } : {}),
      };
    },
  };
}
