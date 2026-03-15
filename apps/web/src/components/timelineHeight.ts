import {
  buildCollapsedProposedPlanPreviewMarkdown,
  stripDisplayedPlanMarkdown,
} from "../proposedPlan";
import { buildTurnDiffTree, type TurnDiffTreeNode } from "../lib/turnDiffTree";

const ASSISTANT_CHARS_PER_LINE_FALLBACK = 72;
const USER_CHARS_PER_LINE_FALLBACK = 56;
const LINE_HEIGHT_PX = 22;
const ASSISTANT_BASE_HEIGHT_PX = 78;
const USER_BASE_HEIGHT_PX = 96;
const WORK_BASE_HEIGHT_PX = 36;
const WORK_HEADER_HEIGHT_PX = 26;
const WORK_ENTRY_HEIGHT_PX = 32;
const WORK_ENTRY_CHANGED_FILES_ROW_HEIGHT_PX = 22;
const WORK_MAX_VISIBLE_ENTRIES = 6;
const WORKING_ROW_HEIGHT_PX = 40;
const ASSISTANT_COMPLETION_DIVIDER_HEIGHT_PX = 48;
const ASSISTANT_DIFF_SUMMARY_BASE_HEIGHT_PX = 74;
const ASSISTANT_DIFF_TREE_NODE_HEIGHT_PX = 24;
const PROPOSED_PLAN_BASE_HEIGHT_PX = 110;
const PROPOSED_PLAN_COLLAPSED_CONTROLS_HEIGHT_PX = 60;
const PROPOSED_PLAN_COLLAPSED_PREVIEW_MAX_HEIGHT_PX = 300;
const ATTACHMENTS_PER_ROW = 2;
// Attachment thumbnails render with `max-h-[220px]` plus ~8px row gap.
const USER_ATTACHMENT_ROW_HEIGHT_PX = 228;
const USER_BUBBLE_WIDTH_RATIO = 0.8;
const USER_BUBBLE_HORIZONTAL_PADDING_PX = 32;
const ASSISTANT_MESSAGE_HORIZONTAL_PADDING_PX = 8;
const USER_MONO_AVG_CHAR_WIDTH_PX = 8.4;
const ASSISTANT_AVG_CHAR_WIDTH_PX = 7.2;
const MIN_USER_CHARS_PER_LINE = 4;
const MIN_ASSISTANT_CHARS_PER_LINE = 20;

interface TimelineMessageHeightInput {
  role: "user" | "assistant" | "system";
  text: string;
  attachments?: ReadonlyArray<{ id: string }>;
}

interface TimelineHeightEstimateLayout {
  timelineWidthPx: number | null;
}

interface TimelineWorkEntryHeightInput {
  label: string;
  tone: "thinking" | "tool" | "info" | "error";
  detail?: string;
  command?: string;
  changedFiles?: ReadonlyArray<string>;
  toolTitle?: string;
}

interface TimelineDiffSummaryHeightInput {
  files: ReadonlyArray<{
    path: string;
    additions?: number | undefined;
    deletions?: number | undefined;
  }>;
}

export type TimelineRowHeightInput =
  | {
      kind: "message";
      message: TimelineMessageHeightInput;
      showCompletionDivider?: boolean;
      diffSummary?: TimelineDiffSummaryHeightInput | null;
    }
  | {
      kind: "work";
      groupedEntries: ReadonlyArray<TimelineWorkEntryHeightInput>;
      expanded?: boolean;
    }
  | {
      kind: "proposed-plan";
      proposedPlan: {
        planMarkdown: string;
      };
    }
  | { kind: "working" };

function estimateWrappedLineCount(text: string, charsPerLine: number): number {
  if (text.length === 0) return 1;

  // Avoid allocating via split for long logs; iterate once and count wrapped lines.
  let lines = 0;
  let currentLineLength = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      lines += Math.max(1, Math.ceil(currentLineLength / charsPerLine));
      currentLineLength = 0;
      continue;
    }
    currentLineLength += 1;
  }

  lines += Math.max(1, Math.ceil(currentLineLength / charsPerLine));
  return lines;
}

function isFinitePositiveNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function estimateCharsPerLineForUser(timelineWidthPx: number | null): number {
  if (!isFinitePositiveNumber(timelineWidthPx)) return USER_CHARS_PER_LINE_FALLBACK;
  const bubbleWidthPx = timelineWidthPx * USER_BUBBLE_WIDTH_RATIO;
  const textWidthPx = Math.max(bubbleWidthPx - USER_BUBBLE_HORIZONTAL_PADDING_PX, 0);
  return Math.max(MIN_USER_CHARS_PER_LINE, Math.floor(textWidthPx / USER_MONO_AVG_CHAR_WIDTH_PX));
}

function estimateCharsPerLineForAssistant(timelineWidthPx: number | null): number {
  if (!isFinitePositiveNumber(timelineWidthPx)) return ASSISTANT_CHARS_PER_LINE_FALLBACK;
  const textWidthPx = Math.max(timelineWidthPx - ASSISTANT_MESSAGE_HORIZONTAL_PADDING_PX, 0);
  return Math.max(
    MIN_ASSISTANT_CHARS_PER_LINE,
    Math.floor(textWidthPx / ASSISTANT_AVG_CHAR_WIDTH_PX),
  );
}

export function estimateTimelineMessageHeight(
  message: TimelineMessageHeightInput,
  layout: TimelineHeightEstimateLayout = { timelineWidthPx: null },
): number {
  if (message.role === "user") {
    const attachmentCount = message.attachments?.length ?? 0;
    const attachmentRows = Math.ceil(attachmentCount / ATTACHMENTS_PER_ROW);
    const attachmentHeight = attachmentRows * USER_ATTACHMENT_ROW_HEIGHT_PX;
    return estimateTextHeight({
      text: message.text,
      charsPerLine: estimateCharsPerLineForUser(layout.timelineWidthPx),
      baseHeightPx: USER_BASE_HEIGHT_PX,
      extraHeightPx: attachmentHeight,
    });
  }

  return estimateTextHeight({
    text: message.text,
    charsPerLine: estimateCharsPerLineForAssistant(layout.timelineWidthPx),
    baseHeightPx: ASSISTANT_BASE_HEIGHT_PX,
  });
}

export function estimateTimelineRowHeight(
  row: TimelineRowHeightInput,
  layout: TimelineHeightEstimateLayout = { timelineWidthPx: null },
): number {
  switch (row.kind) {
    case "working":
      return WORKING_ROW_HEIGHT_PX;
    case "work":
      return estimateTimelineWorkRowHeight(row);
    case "proposed-plan":
      return estimateTimelineProposedPlanHeight(row.proposedPlan.planMarkdown, layout);
    case "message":
      if (row.message.role === "user") {
        return estimateTimelineMessageHeight(row.message, layout);
      }

      return (
        estimateAssistantMessageHeight(row.message.text, layout) +
        (row.showCompletionDivider ? ASSISTANT_COMPLETION_DIVIDER_HEIGHT_PX : 0) +
        (row.diffSummary ? estimateAssistantDiffSummaryHeight(row.diffSummary.files) : 0)
      );
  }
}

function estimateAssistantMessageHeight(
  text: string,
  layout: TimelineHeightEstimateLayout,
): number {
  return estimateTextHeight({
    text,
    charsPerLine: estimateCharsPerLineForAssistant(layout.timelineWidthPx),
    baseHeightPx: ASSISTANT_BASE_HEIGHT_PX,
    extraHeightPx: estimateAssistantMarkdownStructureBonusPx(text),
  });
}

function estimateAssistantMarkdownStructureBonusPx(text: string): number {
  if (text.trim().length === 0) {
    return 0;
  }

  const lines = text.split("\n");
  let blankLineCount = 0;
  let headingCount = 0;
  let listItemCount = 0;
  let blockquoteLineCount = 0;
  let tableLineCount = 0;
  let fencedCodeBlockCount = 0;
  let insideFence = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      if (insideFence) {
        fencedCodeBlockCount += 1;
      }
      insideFence = !insideFence;
      continue;
    }

    if (insideFence) {
      continue;
    }

    if (trimmed.length === 0) {
      blankLineCount += 1;
      continue;
    }
    if (/^#{1,6}\s+/.test(trimmed)) {
      headingCount += 1;
    }
    if (/^([-*+]\s+|\d+[.)]\s+)/.test(trimmed)) {
      listItemCount += 1;
    }
    if (/^>\s?/.test(trimmed)) {
      blockquoteLineCount += 1;
    }
    if (looksLikeMarkdownTableRow(trimmed)) {
      tableLineCount += 1;
    }
  }

  if (insideFence) {
    fencedCodeBlockCount += 1;
  }

  return (
    blankLineCount * 8 +
    headingCount * 10 +
    listItemCount * 4 +
    blockquoteLineCount * 3 +
    tableLineCount * 10 +
    fencedCodeBlockCount * 44
  );
}

function looksLikeMarkdownTableRow(line: string): boolean {
  return line.includes("|") && line.split("|").length - 1 >= 2;
}

function estimateAssistantDiffSummaryHeight(
  files: TimelineDiffSummaryHeightInput["files"],
): number {
  if (files.length === 0) {
    return 0;
  }

  const visibleNodeCount = countVisibleTreeNodes(buildTurnDiffTree(files));
  return (
    ASSISTANT_DIFF_SUMMARY_BASE_HEIGHT_PX + visibleNodeCount * ASSISTANT_DIFF_TREE_NODE_HEIGHT_PX
  );
}

function countVisibleTreeNodes(nodes: ReadonlyArray<TurnDiffTreeNode>): number {
  let count = 0;
  for (const node of nodes) {
    count += 1;
    if (node.kind === "directory") {
      count += countVisibleTreeNodes(node.children);
    }
  }
  return count;
}

function estimateTimelineWorkRowHeight(
  row: Extract<TimelineRowHeightInput, { kind: "work" }>,
): number {
  const groupedEntries = row.groupedEntries;
  const visibleEntries = resolveVisibleWorkEntries(groupedEntries, row.expanded ?? false);
  const hasOverflow = groupedEntries.length > WORK_MAX_VISIBLE_ENTRIES;
  const onlyToolEntries = groupedEntries.every((entry) => entry.tone === "tool");
  const showHeader = hasOverflow || !onlyToolEntries;

  let height = WORK_BASE_HEIGHT_PX;
  if (showHeader) {
    height += WORK_HEADER_HEIGHT_PX;
  }

  for (const entry of visibleEntries) {
    height += estimateTimelineWorkEntryHeight(entry);
  }

  return height;
}

function resolveVisibleWorkEntries(
  groupedEntries: ReadonlyArray<TimelineWorkEntryHeightInput>,
  expanded: boolean,
): ReadonlyArray<TimelineWorkEntryHeightInput> {
  if (groupedEntries.length <= WORK_MAX_VISIBLE_ENTRIES || expanded) {
    return groupedEntries;
  }
  return groupedEntries.slice(-WORK_MAX_VISIBLE_ENTRIES);
}

function estimateTimelineWorkEntryHeight(entry: TimelineWorkEntryHeightInput): number {
  const hasChangedFiles = (entry.changedFiles?.length ?? 0) > 0;
  const previewIsChangedFiles = hasChangedFiles && !entry.command && !entry.detail;
  if (!hasChangedFiles || previewIsChangedFiles) {
    return WORK_ENTRY_HEIGHT_PX;
  }

  const visibleChipCount = Math.min(entry.changedFiles?.length ?? 0, 4);
  const extraIndicatorCount = (entry.changedFiles?.length ?? 0) > 4 ? 1 : 0;
  const chipRows = Math.ceil((visibleChipCount + extraIndicatorCount) / 2);
  return WORK_ENTRY_HEIGHT_PX + chipRows * WORK_ENTRY_CHANGED_FILES_ROW_HEIGHT_PX;
}

function estimateTimelineProposedPlanHeight(
  planMarkdown: string,
  layout: TimelineHeightEstimateLayout,
): number {
  const displayedPlanMarkdown = stripDisplayedPlanMarkdown(planMarkdown);
  const collapsible = planMarkdown.length > 900 || planMarkdown.split("\n").length > 20;
  const markdownToEstimate = collapsible
    ? buildCollapsedProposedPlanPreviewMarkdown(planMarkdown, { maxLines: 10 })
    : displayedPlanMarkdown;
  const markdownHeight = estimateAssistantMessageHeight(markdownToEstimate, layout);

  if (!collapsible) {
    return PROPOSED_PLAN_BASE_HEIGHT_PX + markdownHeight;
  }

  return (
    PROPOSED_PLAN_BASE_HEIGHT_PX +
    Math.min(markdownHeight, PROPOSED_PLAN_COLLAPSED_PREVIEW_MAX_HEIGHT_PX) +
    PROPOSED_PLAN_COLLAPSED_CONTROLS_HEIGHT_PX
  );
}

function estimateTextHeight(input: {
  text: string;
  charsPerLine: number;
  baseHeightPx: number;
  extraHeightPx?: number;
}): number {
  return (
    input.baseHeightPx +
    estimateWrappedLineCount(input.text, input.charsPerLine) * LINE_HEIGHT_PX +
    (input.extraHeightPx ?? 0)
  );
}
