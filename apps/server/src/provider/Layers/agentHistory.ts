import type {
  AgentHistoryEntry,
  OrchestrationGetAgentHistoryInput,
  OrchestrationGetAgentHistoryResult,
} from "@t3tools/contracts";

const MAX_DETAIL_LENGTH = 8000;
const MAX_JSON_DEPTH = 5;
const MAX_JSON_ITEMS = 25;
const MAX_JSON_NODES = 100;
const MAX_JSON_STRING_LENGTH = 1000;

export interface BoundedHistoryText {
  readonly text: string;
  readonly truncated: boolean;
}

/** Keep history payloads bounded; omitted detail is explicitly marked in the UI. */
export function agentHistoryEntry(
  id: string,
  kind: AgentHistoryEntry["kind"],
  title: string,
  detail = "",
  truncated = false,
): AgentHistoryEntry {
  return {
    id,
    kind,
    title: title.slice(0, 500),
    detail: detail.slice(0, MAX_DETAIL_LENGTH),
    truncated: truncated || title.length > 500 || detail.length > MAX_DETAIL_LENGTH,
  };
}

/** Join text without first materializing an unbounded provider payload. */
export function boundedHistoryText(parts: Iterable<string>, separator = "\n"): BoundedHistoryText {
  let text = "";
  let truncated = false;
  for (const part of parts) {
    const prefix = text.length === 0 ? "" : separator;
    const available = MAX_DETAIL_LENGTH - text.length;
    if (available <= prefix.length) {
      truncated = true;
      break;
    }
    text += prefix;
    if (part.length > available - prefix.length) {
      text += part.slice(0, available - prefix.length);
      truncated = true;
      break;
    }
    text += part;
  }
  return { text, truncated };
}

/** Serialize a shallow, bounded projection instead of walking arbitrary provider payloads. */
export function boundedHistoryJson(value: unknown): BoundedHistoryText {
  let remainingNodes = MAX_JSON_NODES;
  let truncated = false;
  const seen = new WeakSet<object>();

  /** Copy one provider value while enforcing the shared traversal budget. */
  const project = (current: unknown, depth: number): unknown => {
    if (remainingNodes-- <= 0) {
      truncated = true;
      return "[content omitted]";
    }
    if (typeof current === "string") {
      if (current.length > MAX_JSON_STRING_LENGTH) truncated = true;
      return current.slice(0, MAX_JSON_STRING_LENGTH);
    }
    if (
      current === null ||
      typeof current === "boolean" ||
      typeof current === "number" ||
      typeof current === "undefined"
    )
      return current;
    if (typeof current !== "object") return String(current);
    if (depth >= MAX_JSON_DEPTH) {
      truncated = true;
      return "[content omitted]";
    }
    if (seen.has(current)) {
      truncated = true;
      return "[circular]";
    }
    seen.add(current);
    if (Array.isArray(current)) {
      const result = current.slice(0, MAX_JSON_ITEMS).map((entry) => project(entry, depth + 1));
      if (current.length > MAX_JSON_ITEMS) {
        truncated = true;
        result.push(`[${current.length - MAX_JSON_ITEMS} more items]`);
      }
      return result;
    }
    const result: Record<string, unknown> = {};
    let count = 0;
    for (const key in current) {
      if (!Object.hasOwn(current, key)) continue;
      if (count++ === MAX_JSON_ITEMS) {
        truncated = true;
        result["…"] = "Additional properties omitted";
        break;
      }
      const boundedKey = key.slice(0, 200);
      if (boundedKey.length !== key.length) truncated = true;
      result[boundedKey] = project((current as Record<string, unknown>)[key], depth + 1);
    }
    return result;
  };

  const serialized = JSON.stringify(project(value, 0), null, 2) ?? "";
  return {
    text: serialized.slice(0, MAX_DETAIL_LENGTH),
    truncated: truncated || serialized.length > MAX_DETAIL_LENGTH,
  };
}

/** Full history pages forward; previews retain only the latest five tools, oldest first. */
export function collectAgentHistory(
  input: Pick<OrchestrationGetAgentHistoryInput, "offset" | "view">,
  initialIndex = 0,
) {
  const entries: AgentHistoryEntry[] = [];
  let index = initialIndex;
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
