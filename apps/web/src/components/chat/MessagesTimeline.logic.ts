import { type MessageId } from "@marcode/contracts";
import { type TimelineEntry, type WorkLogEntry } from "../../session-logic";
import { buildTurnDiffTree, type TurnDiffTreeNode } from "../../lib/turnDiffTree";
import { type ChatMessage, type ProposedPlan, type TurnDiffSummary } from "../../types";
import { estimateTimelineMessageHeight } from "../timelineHeight";

export const MAX_VISIBLE_WORK_LOG_ENTRIES = 6;

export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  completedAt?: string | undefined;
}

export type MessagesTimelineRow =
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: WorkLogEntry[];
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      durationStart: string;
      showCompletionDivider: boolean;
      showAssistantCopyButton: boolean;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      kind: "file-change";
      id: string;
      createdAt: string;
      entry: WorkLogEntry;
    }
  | {
      kind: "exploration";
      id: string;
      createdAt: string;
      entries: WorkLogEntry[];
      isLive: boolean;
    }
  | {
      kind: "agent-group";
      id: string;
      createdAt: string;
      entry: WorkLogEntry;
      isLive: boolean;
    }
  | {
      kind: "command";
      id: string;
      createdAt: string;
      entry: WorkLogEntry;
      isLive: boolean;
    }
  | {
      kind: "web-search";
      id: string;
      createdAt: string;
      entry: WorkLogEntry;
      isLive: boolean;
    }
  | {
      kind: "web-fetch";
      id: string;
      createdAt: string;
      entry: WorkLogEntry;
      isLive: boolean;
    }
  | {
      kind: "mcp-tool";
      id: string;
      createdAt: string;
      entry: WorkLogEntry;
      isLive: boolean;
    }
  | { kind: "working"; id: string; createdAt: string | null };

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && message.completedAt) {
      lastBoundary = message.completedAt;
    }
  }

  return result;
}

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

export function resolveAssistantMessageCopyState({
  text,
  showCopyButton,
  streaming,
}: {
  text: string | null;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const hasText = text !== null && text.trim().length > 0;
  return {
    text: hasText ? text : null,
    visible: showCopyButton && hasText && !streaming,
  };
}

function deriveTerminalAssistantMessageIds(timelineEntries: ReadonlyArray<TimelineEntry>) {
  const lastAssistantMessageIdByResponseKey = new Map<string, string>();
  let nullTurnResponseIndex = 0;

  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== "message") {
      continue;
    }
    const { message } = timelineEntry;
    if (message.role === "user") {
      nullTurnResponseIndex += 1;
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }

    const responseKey = message.turnId
      ? `turn:${message.turnId}`
      : `unkeyed:${nullTurnResponseIndex}`;
    lastAssistantMessageIdByResponseKey.set(responseKey, message.id);
  }

  return new Set(lastAssistantMessageIdByResponseKey.values());
}

const FILE_CHANGE_CARD_COLLAPSED_HEIGHT = 64;
const EXPLORATION_CARD_COLLAPSED_HEIGHT = 36;
const AGENT_GROUP_HEADER_HEIGHT = 32;
const AGENT_TASK_ROW_HEIGHT = 36;
const COMMAND_CARD_COLLAPSED_HEIGHT = 64;
const WEB_SEARCH_CARD_COLLAPSED_HEIGHT = 64;
const WEB_FETCH_CARD_COLLAPSED_HEIGHT = 64;
const MCP_TOOL_CARD_COLLAPSED_HEIGHT = 80;

const EXPLORATION_LABEL_RE =
  /^(Read|Search(ed)?|Glob(bed)?|Grep(ped)?|List(ed)?|Find|Found|View(ed)?|Inspect(ed)?)\b/i;

const EXPLORATION_TOOL_NAMES = new Set([
  "read",
  "grep",
  "glob",
  "search",
  "find",
  "list",
  "view",
  "ls",
  "cat",
  "head",
  "tail",
]);

function isExplorationToolName(toolName: string | undefined): boolean {
  if (!toolName) return false;
  return EXPLORATION_TOOL_NAMES.has(toolName.toLowerCase());
}

export function isExplorationEntry(entry: WorkLogEntry): boolean {
  if (entry.requestKind === "file-change" || entry.requestKind === "command") return false;
  if (
    entry.itemType === "file_change" ||
    entry.itemType === "command_execution" ||
    entry.itemType === "web_search" ||
    entry.itemType === "web_fetch" ||
    entry.itemType === "mcp_tool_call"
  )
    return false;
  if (entry.command) return false;
  if ((entry.diffPreviews?.length ?? 0) > 0) return false;
  if (entry.agentGroup) return false;

  if (entry.requestKind === "file-read") return true;
  if (entry.itemType === "file_read") return true;
  if (entry.itemType === "image_view") return true;
  if (isExplorationToolName(entry.toolName)) return true;

  const heading = (entry.toolTitle ?? entry.label).trim();
  return EXPLORATION_LABEL_RE.test(heading);
}

export function isCommandEntry(entry: WorkLogEntry): boolean {
  if (entry.itemType === "command_execution" || !!entry.command) return true;
  if (entry.requestKind === "command" && (entry.itemType || entry.toolName)) return true;
  return false;
}

export function isWebSearchEntry(entry: WorkLogEntry): boolean {
  if (entry.itemType === "web_search") return true;
  const lower = entry.toolName?.toLowerCase() ?? "";
  return lower === "websearch" || lower === "web_search";
}

export function isWebFetchEntry(entry: WorkLogEntry): boolean {
  if (entry.itemType === "web_fetch") return true;
  const lower = entry.toolName?.toLowerCase() ?? "";
  return lower === "webfetch" || lower === "web_fetch";
}

export function isMcpToolEntry(entry: WorkLogEntry): boolean {
  if (entry.itemType === "mcp_tool_call") return true;
  return (entry.toolName ?? "").startsWith("mcp__");
}

export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  completionDividerBeforeEntryId: string | null;
  isWorking: boolean;
  activeTurnStartedAt: string | null;
}): MessagesTimelineRow[] {
  const nextRows: MessagesTimelineRow[] = [];
  const durationStartByMessageId = computeMessageDurationStart(
    input.timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
  );
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(input.timelineEntries);

  for (let index = 0; index < input.timelineEntries.length; index += 1) {
    const timelineEntry = input.timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    if (timelineEntry.kind === "work") {
      let pendingWork: WorkLogEntry[] = [];
      let pendingWorkFirstId: string | null = null;
      let pendingWorkFirstCreatedAt: string | null = null;
      let pendingExploration: WorkLogEntry[] = [];
      let pendingExplorationFirstId: string | null = null;
      let pendingExplorationFirstCreatedAt: string | null = null;
      let cursor = index;

      const flushPendingWork = () => {
        if (pendingWork.length > 0) {
          nextRows.push({
            kind: "work",
            id: pendingWorkFirstId!,
            createdAt: pendingWorkFirstCreatedAt!,
            groupedEntries: pendingWork,
          });
          pendingWork = [];
          pendingWorkFirstId = null;
          pendingWorkFirstCreatedAt = null;
        }
      };

      const flushPendingExploration = () => {
        if (pendingExploration.length > 0) {
          nextRows.push({
            kind: "exploration",
            id: pendingExplorationFirstId!,
            createdAt: pendingExplorationFirstCreatedAt!,
            entries: pendingExploration,
            isLive: false,
          });
          pendingExploration = [];
          pendingExplorationFirstId = null;
          pendingExplorationFirstCreatedAt = null;
        }
      };

      while (cursor < input.timelineEntries.length) {
        const current = input.timelineEntries[cursor];
        if (!current || current.kind !== "work") break;

        if (current.entry.agentGroup) {
          flushPendingWork();
          flushPendingExploration();
          nextRows.push({
            kind: "agent-group",
            id: current.id,
            createdAt: current.createdAt,
            entry: current.entry,
            isLive: false,
          });
        } else if (isCommandEntry(current.entry)) {
          flushPendingWork();
          flushPendingExploration();
          nextRows.push({
            kind: "command",
            id: current.id,
            createdAt: current.createdAt,
            entry: current.entry,
            isLive: false,
          });
        } else if (isWebSearchEntry(current.entry)) {
          flushPendingWork();
          flushPendingExploration();
          nextRows.push({
            kind: "web-search",
            id: current.id,
            createdAt: current.createdAt,
            entry: current.entry,
            isLive: false,
          });
        } else if (isWebFetchEntry(current.entry)) {
          flushPendingWork();
          flushPendingExploration();
          nextRows.push({
            kind: "web-fetch",
            id: current.id,
            createdAt: current.createdAt,
            entry: current.entry,
            isLive: false,
          });
        } else if (isMcpToolEntry(current.entry)) {
          flushPendingWork();
          flushPendingExploration();
          nextRows.push({
            kind: "mcp-tool",
            id: current.id,
            createdAt: current.createdAt,
            entry: current.entry,
            isLive: false,
          });
        } else if (
          current.entry.itemType === "file_change" &&
          (current.entry.diffPreviews?.length ?? 0) > 0
        ) {
          flushPendingWork();
          flushPendingExploration();
          // Apply_patch / MultiEdit / any tool emitting multiple diff hunks in a
          // single activity renders as ONE card per file, not a collapsed
          // aggregate. Each per-file row reuses the existing FileChangeCard
          // "single-hunk" code path so the user sees each diff inline instead
          // of "N files changed — Show full diff".
          const previews = current.entry.diffPreviews ?? [];
          for (const [index, hunk] of previews.entries()) {
            const rowId = previews.length === 1 ? current.id : `${current.id}#${index}`;
            nextRows.push({
              kind: "file-change",
              id: rowId,
              createdAt: current.createdAt,
              entry: {
                ...current.entry,
                id: rowId,
                diffPreviews: [hunk],
              },
            });
          }
        } else if (isExplorationEntry(current.entry)) {
          flushPendingWork();
          if (pendingExploration.length === 0) {
            pendingExplorationFirstId = current.id;
            pendingExplorationFirstCreatedAt = current.createdAt;
          }
          pendingExploration.push(current.entry);
        } else {
          flushPendingExploration();
          if (pendingWork.length === 0) {
            pendingWorkFirstId = current.id;
            pendingWorkFirstCreatedAt = current.createdAt;
          }
          pendingWork.push(current.entry);
        }
        cursor += 1;
      }
      flushPendingWork();
      flushPendingExploration();
      index = cursor - 1;
      continue;
    }

    if (timelineEntry.kind === "proposed-plan") {
      nextRows.push({
        kind: "proposed-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        proposedPlan: timelineEntry.proposedPlan,
      });
      continue;
    }

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      durationStart:
        durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt,
      showCompletionDivider:
        timelineEntry.message.role === "assistant" &&
        input.completionDividerBeforeEntryId === timelineEntry.id,
      showAssistantCopyButton:
        timelineEntry.message.role === "assistant" &&
        terminalAssistantMessageIds.has(timelineEntry.message.id),
    });
  }

  if (input.isWorking) {
    for (let i = nextRows.length - 1; i >= 0; i--) {
      const r = nextRows[i];
      if (!r) break;
      if (
        r.kind === "exploration" ||
        r.kind === "agent-group" ||
        r.kind === "command" ||
        r.kind === "web-search" ||
        r.kind === "web-fetch" ||
        r.kind === "mcp-tool"
      ) {
        nextRows[i] = { ...r, isLive: true };
        break;
      }
      if (r.kind === "message" || r.kind === "proposed-plan") break;
    }

    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt,
    });
  }

  return nextRows;
}

export function estimateMessagesTimelineRowHeight(
  row: MessagesTimelineRow,
  input: {
    timelineWidthPx: number | null;
    expandedWorkGroups?: Readonly<Record<string, boolean>>;
    turnDiffSummaryByAssistantMessageId?: ReadonlyMap<MessageId, TurnDiffSummary>;
  },
): number {
  switch (row.kind) {
    case "work":
      return estimateWorkRowHeight(row, input);
    case "proposed-plan":
      return estimateTimelineProposedPlanHeight(row.proposedPlan);
    case "working":
      return 40;
    case "file-change":
      return FILE_CHANGE_CARD_COLLAPSED_HEIGHT;
    case "exploration":
      return EXPLORATION_CARD_COLLAPSED_HEIGHT;
    case "agent-group": {
      const taskCount = row.entry.agentGroup?.tasks.length ?? 1;
      return AGENT_GROUP_HEADER_HEIGHT + taskCount * AGENT_TASK_ROW_HEIGHT + 12;
    }
    case "command":
      return COMMAND_CARD_COLLAPSED_HEIGHT;
    case "web-search":
      return WEB_SEARCH_CARD_COLLAPSED_HEIGHT;
    case "web-fetch":
      return WEB_FETCH_CARD_COLLAPSED_HEIGHT;
    case "mcp-tool":
      return MCP_TOOL_CARD_COLLAPSED_HEIGHT;
    case "message": {
      let estimate = estimateTimelineMessageHeight(row.message, {
        timelineWidthPx: input.timelineWidthPx,
      });
      const turnDiffSummary = input.turnDiffSummaryByAssistantMessageId?.get(row.message.id);
      if (turnDiffSummary && turnDiffSummary.files.length > 0) {
        estimate += estimateChangedFilesCardHeight(turnDiffSummary);
      }
      return estimate;
    }
  }
}

function estimateWorkRowHeight(
  row: Extract<MessagesTimelineRow, { kind: "work" }>,
  input: {
    expandedWorkGroups?: Readonly<Record<string, boolean>>;
  },
): number {
  const isExpanded = input.expandedWorkGroups?.[row.id] ?? false;
  const hasOverflow = row.groupedEntries.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
  const visibleEntries =
    hasOverflow && !isExpanded ? MAX_VISIBLE_WORK_LOG_ENTRIES : row.groupedEntries.length;
  const onlyToolEntries = row.groupedEntries.every((entry) => entry.tone === "tool");
  const showHeader = hasOverflow || !onlyToolEntries;

  // Card chrome, optional header, and one compact work-entry row per visible entry.
  return 28 + (showHeader ? 26 : 0) + visibleEntries * 32;
}

function estimateTimelineProposedPlanHeight(proposedPlan: ProposedPlan): number {
  const estimatedLines = Math.max(1, Math.ceil(proposedPlan.planMarkdown.length / 72));
  return 120 + Math.min(estimatedLines * 22, 880);
}

function estimateChangedFilesCardHeight(turnDiffSummary: TurnDiffSummary): number {
  const treeNodes = buildTurnDiffTree(turnDiffSummary.files);
  const visibleNodeCount = countTurnDiffTreeNodes(treeNodes);

  // Card chrome: top/bottom padding, header row, and tree spacing.
  return 60 + visibleNodeCount * 25;
}

function countTurnDiffTreeNodes(nodes: ReadonlyArray<TurnDiffTreeNode>): number {
  let count = 0;
  for (const node of nodes) {
    count += 1;
    if (node.kind === "directory") {
      count += countTurnDiffTreeNodes(node.children);
    }
  }
  return count;
}
