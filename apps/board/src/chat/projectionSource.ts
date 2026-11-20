import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";

import type { ChatItem, TimelineSource } from "./timeline";

type Projection = Pick<OrchestrationV2ThreadProjection, "runs" | "messages" | "visibleTurnItems">;
type TurnItem = Projection["visibleTurnItems"][number]["item"];

const RUNNING_ITEM = ["pending", "running", "waiting"];
const MAX_LABEL = 90;

const firstLine = (text: string) => {
  const line = text.split("\n")[0] ?? "";
  return line.length > MAX_LABEL ? `${line.slice(0, MAX_LABEL - 1)}…` : line;
};

function toolLabel(item: TurnItem): string | null {
  switch (item.type) {
    case "dynamic_tool":
      return item.toolName?.replace(/^mcp__t3-code__/, "") ?? "Tool call";
    case "command_execution":
      return `$ ${firstLine(item.input)}`;
    case "file_change":
      return `Edited ${item.fileName}`;
    case "subagent":
      return `Agent: ${firstLine(item.prompt)}`;
    default:
      return null;
  }
}

function chatItem(item: TurnItem): ChatItem | null {
  const label = toolLabel(item);
  if (label !== null) {
    return {
      kind: "tool",
      id: item.id,
      label,
      running: RUNNING_ITEM.includes(item.status),
      failed: item.status === "failed",
    };
  }
  switch (item.type) {
    case "user_message":
      return {
        kind: "user",
        id: item.id,
        messageId: item.messageId,
        text: item.text,
        textOmitted: item.textOmitted === true,
      };
    case "assistant_message":
      return {
        kind: "assistant",
        id: item.id,
        messageId: item.messageId,
        text: item.text,
        textOmitted: item.textOmitted === true,
        streaming: item.streaming,
      };
    case "error":
      return { kind: "notice", id: item.id, text: item.failure.message, error: true };
    case "system_notice":
      return { kind: "notice", id: item.id, text: item.message, error: item.level === "error" };
    case "compaction":
      return { kind: "notice", id: item.id, text: "Context compacted", error: false };
    default:
      return null;
  }
}

/** A thread projection as the chat reads it: its turn items in order, with the ones the chat does not draw dropped. */
export function timelineSource(projection: Projection): TimelineSource {
  return {
    runs: projection.runs,
    messages: projection.messages,
    items: projection.visibleTurnItems
      .toSorted((a, b) => a.position - b.position)
      .flatMap(({ item }) => chatItem(item) ?? []),
  };
}
