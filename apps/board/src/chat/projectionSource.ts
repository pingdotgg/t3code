import {
  turnItemDetailRevision,
  turnItemNeedsDetailFetch,
  turnItemOutputText,
} from "@t3tools/client-runtime/work-log/item-detail";
import {
  type OrchestrationV2ThreadProjection,
  orchestrationV2RunWorkStartedAt,
} from "@t3tools/contracts";
import { fileBasename } from "@t3tools/shared/path";
import {
  classifyToolActivity,
  collectToolFilePaths,
  dynamicToolTitle,
  formatReadToolLabel,
} from "@t3tools/shared/toolActivity";
import * as DateTime from "effect/DateTime";

import type { ChatItem, StepKind, TimelineSource, ToolStep } from "./timeline";

type Projection = Pick<OrchestrationV2ThreadProjection, "runs" | "messages" | "visibleTurnItems">;
type TurnItem = Projection["visibleTurnItems"][number]["item"];

const RUNNING_ITEM = ["pending", "running", "waiting"];
const MAX_LABEL = 90;
const MAX_INPUT = 4_000;

const firstLine = (text: string) => {
  const line = text.split("\n")[0] ?? "";
  return line.length > MAX_LABEL ? `${line.slice(0, MAX_LABEL - 1)}…` : line;
};

const clip = (text: string) => (text.length > MAX_INPUT ? `${text.slice(0, MAX_INPUT)}…` : text);

const toolInput = (json: string) => (json === "null" || json === "{}" ? null : clip(json));

/** The icon family of a tool call, which T3 decides from the call's name and kind. */
function dynamicToolFamily(item: Extract<TurnItem, { type: "dynamic_tool" }>): StepKind {
  const name = item.toolName?.replace(/^mcp__t3-code__/, "") ?? "";
  switch (
    classifyToolActivity({
      itemType: item.type,
      data: { toolName: name, kind: name.toLowerCase() },
    })
  ) {
    case "command":
      return "command";
    case "read":
      return "read";
    case "file_change":
      return "edit";
    case "search":
      return "search";
    case "other":
      return "tool";
  }
}

/** What a tool call is called: the skill it runs, the files it reads, or else its name. */
function dynamicToolLabel(
  item: Extract<TurnItem, { type: "dynamic_tool" }>,
  family: StepKind,
): string {
  const name = item.toolName?.replace(/^mcp__t3-code__/, "") ?? "Tool call";
  const title = dynamicToolTitle(item.toolName, item.input);
  if (title !== undefined) return title;
  const [first, ...more] = collectToolFilePaths({ input: item.input });
  return family === "read" && first !== undefined
    ? formatReadToolLabel(fileBasename(first), more.length)
    : name;
}

function toolStep(item: TurnItem): ToolStep | null {
  const base = {
    id: item.id,
    running: RUNNING_ITEM.includes(item.status),
    failed: item.status === "failed",
    exitCode: null,
    file: null,
    output: null,
    outputRef: null,
  };
  const ref = {
    threadId: item.threadId,
    itemId: item.id,
    revision: turnItemDetailRevision(item),
  };
  switch (item.type) {
    case "dynamic_tool": {
      const family = dynamicToolFamily(item);
      return {
        ...base,
        label: dynamicToolLabel(item, family),
        family,
        input: toolInput(JSON.stringify(item.input ?? null, null, 2)),
        output: turnItemOutputText(item),
        outputRef: turnItemNeedsDetailFetch(item) ? ref : null,
      };
    }
    case "command_execution":
      return {
        ...base,
        failed: base.failed || item.outputIndicatesFailure === true,
        label: `$ ${firstLine(item.input)}`,
        family: "command",
        input: clip(item.input),
        exitCode: item.exitCode ?? null,
        output: turnItemOutputText(item),
        outputRef: turnItemNeedsDetailFetch(item) ? ref : null,
      };
    case "file_change":
      return {
        ...base,
        label: `Edited ${fileBasename(item.fileName)}`,
        family: "edit",
        input: null,
        file: {
          name: item.fileName,
          additions: item.additions ?? null,
          deletions: item.deletions ?? null,
        },
        output: base.failed ? item.diffStr?.trim() || null : null,
        outputRef: base.failed ? null : ref,
      };
    case "subagent":
      return {
        ...base,
        label: `Agent: ${firstLine(item.prompt)}`,
        family: "agent",
        input: clip(item.prompt),
      };
    default:
      return null;
  }
}

function chatItem(item: TurnItem): ChatItem | null {
  const step = toolStep(item);
  if (step !== null) return { kind: "tool", ...step };
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
        runId: item.runId,
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
    runs: projection.runs.map((run) => ({
      id: run.id,
      status: run.status,
      startedAt: DateTime.toEpochMillis(orchestrationV2RunWorkStartedAt(run)),
    })),
    messages: projection.messages.map((message) => ({
      id: message.id,
      text: message.text,
      createdAt: DateTime.toEpochMillis(message.createdAt),
    })),
    items: projection.visibleTurnItems
      .toSorted((a, b) => a.position - b.position)
      .flatMap(({ item }) => chatItem(item) ?? []),
  };
}
