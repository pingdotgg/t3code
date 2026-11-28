import { MessageId } from "@t3tools/contracts";

import type { TimelineEntry } from "../../session-logic";
import {
  deriveTerminalAssistantMessageIds,
  deriveUnsettledRunId,
  groupOwnUserMessages,
  type MessagesTimelineRow,
  type MessagesTimelineRowsInput,
} from "../chat/MessagesTimeline.logic";

export type BotTimelineRowsInput = Pick<
  MessagesTimelineRowsInput,
  "timelineEntries" | "latestRun" | "runningRunId" | "isWorking" | "pendingApprovalRequestIds"
>;

/**
 * A Bot's thread reads as a chat: your messages, the final reply of each turn, and what it asks or
 * what fails. Its progress, tools and wakes stay out; while it runs, one typing row shows its
 * latest progress line.
 */
/** The Bot's opening line, shown before the user's first message; no turn ever wrote it. */
export interface BotGreeting {
  readonly text: string;
  readonly createdAt: string;
}

/**
 * A Bot opens either with its greeting or with the server's setup prompt as its first message;
 * the prompt is written for the Bot, so the user never sees it.
 */
export function deriveBotTimelineRows(
  input: BotTimelineRowsInput,
  greeting: BotGreeting | null = null,
): MessagesTimelineRow[] {
  const setupPromptId =
    greeting === null
      ? input.timelineEntries.find(
          (entry) => entry.kind === "message" && entry.message.role === "user",
        )?.id
      : undefined;
  const running = input.isWorking && input.latestRun?.turnEnded !== true;
  const activeRunId = running
    ? deriveUnsettledRunId(input.latestRun ?? null, input.runningRunId ?? null)
    : null;
  const finalReplyIds = deriveTerminalAssistantMessageIds(input.timelineEntries);
  const rows: MessagesTimelineRow[] = greeting === null ? [] : [greetingRow(greeting)];
  for (const entry of input.timelineEntries) {
    if (entry.id === setupPromptId) continue;
    const row = botRow(entry, finalReplyIds, activeRunId, input.pendingApprovalRequestIds);
    if (row !== null) rows.push(row);
  }
  if (running && !input.pendingApprovalRequestIds?.size) {
    const detail = progressLine(input.timelineEntries, activeRunId);
    rows.push({
      kind: "bot-typing",
      id: "bot-typing",
      createdAt: null,
      ...(detail === undefined ? {} : { detail }),
    });
  }
  return groupOwnUserMessages(rows);
}

function greetingRow(greeting: BotGreeting): MessagesTimelineRow {
  const id = MessageId.make("bot-greeting");
  return {
    kind: "message",
    id,
    createdAt: greeting.createdAt,
    message: {
      id,
      role: "assistant",
      text: greeting.text,
      runId: null,
      createdAt: greeting.createdAt,
      updatedAt: greeting.createdAt,
      streaming: false,
    },
    showAssistantMeta: false,
    showAssistantCopyButton: false,
    assistantCopyStreaming: false,
    botAvatar: true,
  };
}

function botRow(
  entry: TimelineEntry,
  finalReplyIds: ReadonlySet<string>,
  activeRunId: string | null,
  pendingApprovalRequestIds: MessagesTimelineRowsInput["pendingApprovalRequestIds"],
): MessagesTimelineRow | null {
  switch (entry.kind) {
    case "message": {
      const { message } = entry;
      const reply = message.role === "assistant";
      if (reply && (!finalReplyIds.has(message.id) || message.runId === activeRunId)) return null;
      return {
        kind: "message",
        id: entry.id,
        createdAt: entry.createdAt,
        message,
        ...(entry.projectedItem === undefined ? {} : { projectedItem: entry.projectedItem }),
        showAssistantMeta: reply,
        showAssistantCopyButton: reply,
        assistantCopyStreaming: message.streaming,
        ...(reply ? { botAvatar: true as const } : {}),
      };
    }
    case "work": {
      const work = entry.entry;
      const item = work.projectedItem?.item;
      const shown =
        work.questionAnswer !== undefined ||
        work.tone === "error" ||
        work.sourceActivityKind === "runtime.error" ||
        (work.itemType === "error" && work.toolLifecycleStatus === "failed") ||
        (item?.type === "approval_request" && pendingApprovalRequestIds?.has(item.requestId));
      return shown
        ? {
            kind: "work",
            id: entry.id,
            createdAt: entry.createdAt,
            groupedEntries: [work],
            isExpandedToolGroup: false,
          }
        : null;
    }
    case "event":
      // The Bot's reply names the workers it starts; the panel lists them.
      return entry.projectedItem.item.type === "thread_created"
        ? null
        : {
            kind: "event",
            id: entry.id,
            createdAt: entry.createdAt,
            projectedItem: entry.projectedItem,
          };
    case "proposed-plan":
      return {
        kind: "proposed-plan",
        id: entry.id,
        createdAt: entry.createdAt,
        proposedPlan: entry.proposedPlan,
      };
    case "html-render":
      return {
        kind: "html-render",
        id: entry.id,
        createdAt: entry.createdAt,
        htmlRender: entry.htmlRender,
      };
    case "sent-message":
      return { kind: "sent-message", id: entry.id, createdAt: entry.createdAt, text: entry.text };
    case "mcp-app":
      return {
        kind: "mcp-app",
        id: entry.id,
        createdAt: entry.createdAt,
        sourceThreadId: entry.sourceThreadId,
        itemId: entry.itemId,
        revision: entry.revision,
        mcpApp: entry.mcpApp,
      };
  }
}

/** The last line of the running turn's latest progress message, as plain text. */
function progressLine(
  entries: ReadonlyArray<TimelineEntry>,
  activeRunId: string | null,
): string | undefined {
  const progress = entries.findLast(
    (entry) =>
      entry.kind === "message" &&
      entry.message.role === "assistant" &&
      entry.message.runId === activeRunId &&
      entry.message.text.trim() !== "",
  );
  if (progress?.kind !== "message") return undefined;
  return progress.message.text
    .trim()
    .split("\n")
    .findLast((line) => line.trim() !== "")
    ?.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replaceAll("`", "")
    .trim();
}
