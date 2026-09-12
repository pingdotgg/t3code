import {
  EventId,
  MessageId,
  TurnId,
  isToolLifecycleItemType,
  type SharedThread,
} from "@t3tools/contracts";
import { deriveTimelineEntries, deriveWorkLogEntries } from "../../session-logic";

function parseToolValue(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function toolRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Reconstitute only the selected snapshot fields for the normal chat projection. */
export function deriveSharedTimelineEntries(share: SharedThread) {
  const workEntries = deriveWorkLogEntries(
    share.tools.map((tool) => {
      const input = parseToolValue(tool.input);
      const inputRecord = toolRecord(input);
      const result = parseToolValue(tool.result);
      const itemType =
        tool.itemType ?? (isToolLifecycleItemType(tool.name) ? tool.name : "mcp_tool_call");
      const command =
        inputRecord?.command ??
        inputRecord?.cmd ??
        (typeof inputRecord?.executable === "string"
          ? [inputRecord.executable, ...[inputRecord.args].flat()].filter(
              (part): part is string => typeof part === "string",
            )
          : undefined) ??
        (itemType === "command_execution"
          ? typeof input === "string" || Array.isArray(input)
            ? input
            : tool.input
          : undefined);
      return {
        id: EventId.make(tool.id),
        createdAt: tool.createdAt,
        turnId: tool.turnId ? TurnId.make(tool.turnId) : null,
        kind: "tool.completed",
        tone: "tool" as const,
        summary: tool.name,
        payload: {
          toolCallId: tool.id,
          itemType,
          title: tool.title ?? tool.name,
          detail: itemType === "command_execution" ? tool.detail : (tool.detail ?? tool.result),
          status: tool.status,
          toolSurface: tool.toolSurface,
          data: {
            toolName: tool.name,
            command,
            input,
            result,
            item: {
              tool: tool.name,
              input,
              arguments: input,
              command,
              aggregatedOutput: tool.result,
              result,
            },
          },
        },
      };
    }),
  );
  // A result-only command has no command preview. Keep its output in the body;
  // the native legacy payload fallback otherwise mistakes `detail` for a command.
  const toolsById = new Map(share.tools.map((tool) => [tool.id, tool]));
  for (const entry of workEntries) {
    const tool = toolsById.get(entry.id);
    if (!tool) continue;
    if (entry.itemType !== "command_execution" && entry.itemType !== "mcp_tool_call") {
      entry.detail = [...new Set([tool.detail, tool.input, tool.result])]
        .filter((value): value is string => Boolean(value))
        .join("\n\n");
    } else if (tool.input === undefined && tool.result !== undefined) {
      entry.detail = tool.result;
    }
  }
  return deriveTimelineEntries(
    share.messages.map((message) => ({
      ...message,
      id: MessageId.make(message.id),
      turnId: message.turnId ? TurnId.make(message.turnId) : null,
      streaming: false,
      updatedAt: message.createdAt,
    })),
    share.plans.map((plan) => ({
      id: plan.id,
      turnId: plan.turnId ? TurnId.make(plan.turnId) : null,
      planMarkdown: plan.text,
      createdAt: plan.createdAt,
      updatedAt: plan.createdAt,
      implementedAt: null,
      implementationThreadId: null,
    })),
    workEntries,
  );
}
