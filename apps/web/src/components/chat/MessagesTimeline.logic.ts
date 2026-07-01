import * as Equal from "effect/Equal";
import {
  formatDuration,
  workEntryIndicatesToolNeutralStatus,
  workLogEntryIsToolLike,
  type TimelineEntry,
  type WorkLogEntry,
} from "../../session-logic";
import { type ChatMessage, type ProposedPlan, type TurnDiffSummary } from "../../types";
import { type MessageId, type OrchestrationLatestTurn, type TurnId } from "@t3tools/contracts";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import { createChangedFileDiffPathMatcher } from "../../lib/diffRendering";

export const MAX_VISIBLE_WORK_LOG_ENTRIES = 1;
export const COMMAND_OUTPUT_TAIL_LINES = 40;
export const TIMELINE_MINIMAP_ITEM_SPACING = 8;
export const TIMELINE_MINIMAP_MIN_ITEMS = 2;
export const TIMELINE_MINIMAP_MAX_HEIGHT_CSS = "calc(100vh - 18rem)";
export const TIMELINE_CONTENT_MAX_WIDTH = 768;
export const TIMELINE_MINIMAP_PERSISTENT_GUTTER = 48;

export interface TimelineEndState {
  readonly isAtEnd?: boolean;
  readonly isNearEnd?: boolean;
}

export function resolveTimelineIsAtEnd(state: TimelineEndState | undefined): boolean | undefined {
  return state?.isNearEnd ?? state?.isAtEnd;
}

export function resolveTimelineMinimapHeightStyle(itemCount: number): string {
  const naturalHeight = Math.max(1, (itemCount - 1) * TIMELINE_MINIMAP_ITEM_SPACING);
  return `min(${naturalHeight}px, ${TIMELINE_MINIMAP_MAX_HEIGHT_CSS})`;
}

export function resolveTimelineMinimapTopPercent(index: number, itemCount: number): number {
  if (itemCount <= 1) {
    return 0;
  }
  return (Math.max(0, Math.min(index, itemCount - 1)) / (itemCount - 1)) * 100;
}

export function resolveTimelineMinimapIndexFromPointer(input: {
  readonly itemCount: number;
  readonly railTop: number;
  readonly railHeight: number;
  readonly pointerY: number;
}): number | null {
  if (input.itemCount <= 0 || input.railHeight <= 0) {
    return null;
  }
  if (input.itemCount === 1) {
    return 0;
  }

  const progress = Math.max(0, Math.min(1, (input.pointerY - input.railTop) / input.railHeight));
  return Math.max(0, Math.min(input.itemCount - 1, Math.round(progress * (input.itemCount - 1))));
}

export function resolveTimelineMinimapHasPersistentGutter(viewportWidth: number): boolean {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return false;
  }

  const contentWidth = Math.min(viewportWidth, TIMELINE_CONTENT_MAX_WIDTH);
  const sideGutter = Math.max(0, (viewportWidth - contentWidth) / 2);
  return sideGutter >= TIMELINE_MINIMAP_PERSISTENT_GUTTER;
}

function computeElapsedMs(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

function maxIsoTimestamp(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (!Number.isFinite(aMs)) return b;
  if (!Number.isFinite(bMs)) return a;
  return bMs > aMs ? b : a;
}

export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  updatedAt: string;
  streaming: boolean;
}

export type TimelineLatestTurn = Pick<
  OrchestrationLatestTurn,
  "turnId" | "state" | "startedAt" | "completedAt"
>;

export type MessagesTimelineRow =
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: WorkLogEntry[];
    }
  | {
      kind: "work-toggle";
      id: string;
      createdAt: string;
      groupId: string;
      hiddenCount: number;
      expanded: boolean;
      onlyToolEntries: boolean;
    }
  | {
      kind: "turn-fold";
      id: string;
      createdAt: string;
      turnId: TurnId;
      label: string;
      expanded: boolean;
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      durationStart: string;
      showAssistantMeta: boolean;
      showAssistantCopyButton: boolean;
      assistantCopyStreaming: boolean;
      assistantTurnDiffSummary?: TurnDiffSummary | undefined;
      revertTurnCount?: number | undefined;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | { kind: "working"; id: string; createdAt: string | null };

export interface StableMessagesTimelineRowsState {
  byId: Map<string, MessagesTimelineRow>;
  result: MessagesTimelineRow[];
}

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
    if (message.role === "assistant" && !message.streaming) {
      lastBoundary = message.updatedAt;
    }
  }

  return result;
}

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

export function deriveToolWorkEntryHeading(workEntry: WorkLogEntry): string {
  if (!workEntry.toolTitle) {
    return capitalizePhrase(normalizeCompactToolLabel(workEntry.label));
  }
  return capitalizePhrase(normalizeCompactToolLabel(workEntry.toolTitle));
}

export function deriveWorkEntryPreview(
  workEntry: Pick<WorkLogEntry, "detail" | "command" | "changedFiles" | "itemType" | "requestKind">,
  workspaceRoot: string | undefined,
): string | null {
  const changedFilesPreview = deriveChangedFilesPreview(workEntry, workspaceRoot);
  if (workEntry.itemType === "file_change" || workEntry.requestKind === "file-change") {
    return changedFilesPreview ?? workEntry.command ?? workEntry.detail ?? null;
  }
  if (workEntry.command) return workEntry.command;
  if (workEntry.detail) return workEntry.detail;
  return changedFilesPreview;
}

export interface DerivedWorkEntryDisplay {
  heading: string;
  preview: string | null;
  displayText: string;
}

export function deriveWorkEntryDisplay(
  workEntry: WorkLogEntry,
  workspaceRoot: string | undefined,
): DerivedWorkEntryDisplay {
  const heading = deriveToolWorkEntryHeading(workEntry);
  const rawPreview = deriveWorkEntryPreview(workEntry, workspaceRoot);
  const preview =
    rawPreview &&
    normalizeCompactToolLabel(rawPreview).toLowerCase() ===
      normalizeCompactToolLabel(heading).toLowerCase()
      ? null
      : rawPreview;

  return {
    heading,
    preview,
    displayText: preview ? `${heading} - ${preview}` : heading,
  };
}

function deriveChangedFilesPreview(
  workEntry: Pick<WorkLogEntry, "changedFiles">,
  workspaceRoot: string | undefined,
): string | null {
  if ((workEntry.changedFiles?.length ?? 0) === 0) return null;
  const [firstPath] = workEntry.changedFiles ?? [];
  if (!firstPath) return null;
  const displayPath = formatWorkspaceRelativePath(firstPath, workspaceRoot);
  return workEntry.changedFiles!.length === 1
    ? displayPath
    : `${displayPath} +${workEntry.changedFiles!.length - 1} more`;
}

export function shouldToggleWorkEntryRowFromKeyDown({
  key,
  targetIsCurrentTarget,
}: {
  key: string;
  targetIsCurrentTarget: boolean;
}): boolean {
  return targetIsCurrentTarget && (key === "Enter" || key === " ");
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

export function hasRenderableCommandOutput(value: string | null | undefined): value is string {
  return getRenderableCommandOutputLines(value).length > 0;
}

export function getRenderableCommandOutputLines(value: string | null | undefined): string[] {
  if (typeof value !== "string" || value.length === 0) {
    return [];
  }
  const lines = value.split(/\r?\n/u);
  let startIndex = 0;
  let endIndex = lines.length;
  while (startIndex < endIndex && (lines[startIndex]?.trim().length ?? 0) === 0) {
    startIndex += 1;
  }
  while (endIndex > startIndex && (lines[endIndex - 1]?.trim().length ?? 0) === 0) {
    endIndex -= 1;
  }
  return lines.slice(startIndex, endIndex);
}

export function buildSupplementalToolDetailBody(
  workEntry: WorkLogEntry,
  options: { dedupeRenderedCommandOutput: boolean },
): string | null {
  const detail = workEntry.detail?.trim();
  if (!detail) {
    return null;
  }
  const command = workEntry.command?.trim();
  const rawCommand = workEntry.rawCommand?.trim();
  const renderedOutputMatchesDetail =
    options.dedupeRenderedCommandOutput && commandOutputMatchesDetail(workEntry, detail);
  if (detail === command || detail === rawCommand || renderedOutputMatchesDetail) {
    return null;
  }
  return detail;
}

function commandOutputMatchesDetail(workEntry: WorkLogEntry, detail: string): boolean {
  const stdoutLines = getRenderableCommandOutputLines(workEntry.stdout);
  const stderrLines = getRenderableCommandOutputLines(workEntry.stderr);
  const hasStreamOutput = stdoutLines.length > 0 || stderrLines.length > 0;
  const outputLines = hasStreamOutput ? [] : getRenderableCommandOutputLines(workEntry.output);
  const normalizedDetail = normalizeToolDetailLines(detail.split(/\r?\n/u));

  return [stdoutLines, stderrLines, outputLines].some(
    (lines) => lines.length > 0 && normalizeToolDetailLines(lines) === normalizedDetail,
  );
}

function normalizeToolDetailLines(lines: ReadonlyArray<string>): string {
  const normalizedLines = lines.map((line) => line.trim());
  let startIndex = 0;
  let endIndex = normalizedLines.length;
  while (startIndex < endIndex && normalizedLines[startIndex]?.length === 0) {
    startIndex += 1;
  }
  while (endIndex > startIndex && normalizedLines[endIndex - 1]?.length === 0) {
    endIndex -= 1;
  }
  return normalizedLines.slice(startIndex, endIndex).join("\n");
}

function isCollabAgentWorkEntry(workEntry: WorkLogEntry): boolean {
  // Collab-agent rows own their nested activity UI; do not re-expand them as
  // command or file-change detail boxes.
  return workEntry.itemType === "collab_agent_tool_call";
}

export function hasCommandWorkEntryDetails(workEntry: WorkLogEntry): boolean {
  if (!hasCommandWorkEntryMetadata(workEntry)) {
    return false;
  }
  if (isCollabAgentWorkEntry(workEntry)) {
    return false;
  }
  if (workEntry.itemType === "command_execution" || workEntry.requestKind === "command") {
    return true;
  }
  if (workEntry.itemType === "file_change" || workEntry.requestKind === "file-change") {
    return false;
  }
  if (workEntry.itemType) {
    return workEntry.itemType === "dynamic_tool_call";
  }
  return Boolean(workEntry.command || workEntry.rawCommand);
}

function hasCommandWorkEntryMetadata(workEntry: WorkLogEntry): boolean {
  return Boolean(
    workEntry.command ||
    workEntry.rawCommand ||
    workEntry.output ||
    workEntry.stdout ||
    workEntry.stderr ||
    workEntry.exitCode != null ||
    workEntry.durationMs != null,
  );
}

export interface DerivedCommandOutputSection {
  title: "Stdout" | "Stderr" | "Output";
  value: string;
  tone?: "default" | "error";
}

export interface DerivedCommandWorkEntryDetails {
  command: string | null;
  rawCommand: string | null;
  exitCodeLabel: string;
  durationLabel: string;
  outputs: ReadonlyArray<DerivedCommandOutputSection>;
}

export interface DerivedFileChangeWorkEntryDetails {
  id: string;
  patch: string | undefined;
  changedFiles: ReadonlyArray<string>;
}

export interface DerivedExpandableWorkEntryDetails {
  command: DerivedCommandWorkEntryDetails | null;
  fileChange: DerivedFileChangeWorkEntryDetails | null;
  supplementalDetail: string | null;
  genericDetail: string | null;
}

function deriveRawCommand(workEntry: Pick<WorkLogEntry, "command" | "rawCommand">): string | null {
  const rawCommand = workEntry.rawCommand?.trim();
  if (!rawCommand || !workEntry.command) {
    return null;
  }
  return rawCommand === workEntry.command.trim() ? null : rawCommand;
}

function buildGenericToolExpandedBody(
  workEntry: WorkLogEntry,
  workspaceRoot: string | undefined,
): string | null {
  const blocks: string[] = [];
  if (workEntry.itemType === "mcp_tool_call" && workEntry.toolData !== undefined) {
    blocks.push(`MCP call\n${JSON.stringify(workEntry.toolData, null, 2)}`);
  }
  const raw = deriveRawCommand(workEntry);
  if (raw?.trim()) {
    blocks.push(raw.trim());
  } else if (workEntry.command?.trim()) {
    blocks.push(workEntry.command.trim());
  }
  if (workEntry.detail?.trim()) {
    blocks.push(workEntry.detail.trim());
  }
  const changedFiles = workEntry.changedFiles ?? [];
  if (changedFiles.length > 0) {
    blocks.push(
      changedFiles
        .map((filePath) => formatWorkspaceRelativePath(filePath, workspaceRoot))
        .join("\n"),
    );
  }
  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

function hasGenericToolExpandedBody(workEntry: WorkLogEntry): boolean {
  if (workEntry.itemType === "mcp_tool_call" && workEntry.toolData !== undefined) {
    return true;
  }
  const raw = deriveRawCommand(workEntry);
  return Boolean(
    raw?.trim() ||
    workEntry.command?.trim() ||
    workEntry.detail?.trim() ||
    (workEntry.changedFiles?.length ?? 0) > 0,
  );
}

export function hasExpandableWorkEntryDetails(workEntry: WorkLogEntry): boolean {
  return (
    hasCommandWorkEntryDetails(workEntry) ||
    hasFileChangeWorkEntryDetails(workEntry) ||
    hasGenericToolExpandedBody(workEntry)
  );
}

function deriveCommandWorkEntryDetails(workEntry: WorkLogEntry): DerivedCommandWorkEntryDetails {
  const command = workEntry.command ?? workEntry.rawCommand ?? null;
  const rawCommand =
    workEntry.rawCommand && workEntry.rawCommand !== command ? workEntry.rawCommand : null;
  const stdout = hasRenderableCommandOutput(workEntry.stdout) ? workEntry.stdout : null;
  const stderr = hasRenderableCommandOutput(workEntry.stderr) ? workEntry.stderr : null;
  const output =
    !stdout && !stderr && hasRenderableCommandOutput(workEntry.output) ? workEntry.output : null;
  const outputs: DerivedCommandOutputSection[] = [];
  if (stdout) {
    outputs.push({ title: "Stdout", value: stdout });
  }
  if (stderr) {
    outputs.push({ title: "Stderr", value: stderr, tone: "error" });
  }
  if (output) {
    outputs.push({ title: "Output", value: output });
  }

  return {
    command,
    rawCommand,
    exitCodeLabel: String(workEntry.exitCode ?? "unknown"),
    durationLabel:
      workEntry.durationMs !== undefined ? formatDuration(workEntry.durationMs) : "unknown",
    outputs,
  };
}

export function deriveExpandableWorkEntryDetails(
  workEntry: WorkLogEntry,
  workspaceRoot: string | undefined,
): DerivedExpandableWorkEntryDetails | null {
  const showCommandDetails = hasCommandWorkEntryDetails(workEntry);
  const showFileChangeDetails = hasFileChangeWorkEntryDetails(workEntry);
  const supplementalDetail =
    showCommandDetails || showFileChangeDetails
      ? buildSupplementalToolDetailBody(workEntry, {
          dedupeRenderedCommandOutput: showCommandDetails,
        })
      : null;

  if (showCommandDetails || showFileChangeDetails) {
    return {
      command: showCommandDetails ? deriveCommandWorkEntryDetails(workEntry) : null,
      fileChange: showFileChangeDetails
        ? {
            id: workEntry.id,
            patch: workEntry.patch,
            changedFiles: workEntry.changedFiles ?? [],
          }
        : null,
      supplementalDetail,
      genericDetail: null,
    };
  }

  const genericDetail = buildGenericToolExpandedBody(workEntry, workspaceRoot);
  return genericDetail
    ? {
        command: null,
        fileChange: null,
        supplementalDetail: null,
        genericDetail,
      }
    : null;
}

export function hasFileChangeWorkEntryDetails(workEntry: WorkLogEntry): boolean {
  if (isCollabAgentWorkEntry(workEntry)) {
    return false;
  }
  return Boolean(workEntry.patch || (workEntry.changedFiles?.length ?? 0) > 0);
}

export function filterChangedFilesWithoutInlineDiff(
  changedFiles: ReadonlyArray<string> | undefined,
  inlineDiffPaths: ReadonlyArray<string>,
): string[] {
  if (!changedFiles || changedFiles.length === 0) {
    return [];
  }
  if (inlineDiffPaths.length === 0) {
    return [...changedFiles];
  }
  const inlineDiffMatchers = inlineDiffPaths.map(createChangedFileDiffPathMatcher);
  return changedFiles.filter(
    (changedFile) => !inlineDiffMatchers.some((matchesDiffPath) => matchesDiffPath(changedFile)),
  );
}

export interface DerivedFileChangeDisplayFile {
  path: string;
  displayPath: string;
}

export function deriveFileChangeDisplayFiles(input: {
  changedFiles: ReadonlyArray<string> | undefined;
  inlineDiffPaths: ReadonlyArray<string>;
  workspaceRoot: string | undefined;
}): DerivedFileChangeDisplayFile[] {
  return filterChangedFilesWithoutInlineDiff(input.changedFiles, input.inlineDiffPaths).map(
    (filePath) => ({
      path: filePath,
      displayPath: formatWorkspaceRelativePath(filePath, input.workspaceRoot),
    }),
  );
}

export interface DerivedCommandOutputDisplay {
  isTruncated: boolean;
  visibleValue: string;
  suffix: string;
}

export function deriveCommandOutputDisplay(input: {
  value: string;
  showFull: boolean;
  maxVisibleLines?: number;
}): DerivedCommandOutputDisplay {
  const maxVisibleLines = input.maxVisibleLines ?? COMMAND_OUTPUT_TAIL_LINES;
  const lines = getRenderableCommandOutputLines(input.value);
  const isTruncated = lines.length > maxVisibleLines;
  const visibleValue =
    input.showFull || !isTruncated ? lines.join("\n") : lines.slice(-maxVisibleLines).join("\n");
  const suffix = isTruncated
    ? input.showFull
      ? `${lines.length.toLocaleString()} lines`
      : `last ${maxVisibleLines} of ${lines.length.toLocaleString()} lines`
    : `${lines.length.toLocaleString()} line${lines.length === 1 ? "" : "s"}`;

  return {
    isTruncated,
    visibleValue,
    suffix,
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

interface TurnFold {
  turnId: TurnId;
  anchorEntryId: string;
  createdAt: string;
  hiddenEntryIds: ReadonlySet<string>;
  label: string;
}

/**
 * The session's running turn is authoritative when latestTurn briefly lags or
 * regresses behind it. Otherwise, the latest turn counts as unsettled while it
 * is still running (or has not recorded a completion). This is deliberately
 * keyed on turn lifecycle rather than transient working state: right after the
 * user sends a message, the previous turn is still the "active" one until the
 * server creates the new turn, and folding must not flicker through that window.
 */
function deriveUnsettledTurnId(
  latestTurn: TimelineLatestTurn | null,
  runningTurnId: TurnId | null,
): TurnId | null {
  if (runningTurnId !== null) {
    return runningTurnId;
  }
  if (!latestTurn) {
    return null;
  }
  const isSettled = latestTurn.completedAt !== null && latestTurn.state !== "running";
  return isSettled ? null : latestTurn.turnId;
}

/**
 * Settled turns fold their commentary and tool activity behind a
 * "Worked for ..." row anchored at the turn's first foldable entry; the
 * terminal assistant message stays visible below the fold.
 */
function deriveTurnFolds(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  terminalAssistantMessageIds: ReadonlySet<string>;
  latestTurn: TimelineLatestTurn | null;
  unsettledTurnId: TurnId | null;
}): ReadonlyMap<string, TurnFold> {
  interface TurnGroup {
    entries: Array<TimelineEntry>;
    terminalEntry: Extract<TimelineEntry, { kind: "message" }> | null;
    hasStreamingMessage: boolean;
    /**
     * The user message that kicked the turn off. Entry timestamps alone
     * undercount the duration (the first entry appears only once the
     * provider starts producing output), and a turn cut short by a steer may
     * hold a single instantaneous commentary message.
     */
    startBoundary: string | null;
  }
  const groupsByTurnId = new Map<TurnId, TurnGroup>();

  let pendingUserBoundary: string | null = null;
  for (const entry of input.timelineEntries) {
    if (entry.kind === "message" && entry.message.role === "user") {
      pendingUserBoundary = entry.message.createdAt;
      continue;
    }
    const turnId =
      entry.kind === "message" && entry.message.role === "assistant"
        ? (entry.message.turnId ?? null)
        : entry.kind === "work"
          ? (entry.entry.turnId ?? null)
          : null;
    if (!turnId) {
      continue;
    }
    let group = groupsByTurnId.get(turnId);
    if (!group) {
      group = {
        entries: [],
        terminalEntry: null,
        hasStreamingMessage: false,
        // Each user boundary starts at most one turn; a second turn after the
        // same user message (e.g. a steer-superseded continuation) falls back
        // to its own first entry.
        startBoundary: pendingUserBoundary,
      };
      pendingUserBoundary = null;
      groupsByTurnId.set(turnId, group);
    }
    group.entries.push(entry);
    if (entry.kind === "message") {
      if (input.terminalAssistantMessageIds.has(entry.message.id)) {
        group.terminalEntry = entry;
      }
      if (entry.message.streaming) {
        group.hasStreamingMessage = true;
      }
    }
  }

  const foldsByAnchorEntryId = new Map<string, TurnFold>();
  for (const [turnId, group] of groupsByTurnId) {
    if (turnId === input.unsettledTurnId) {
      continue;
    }
    if (group.hasStreamingMessage) {
      continue;
    }
    const hiddenEntryIds = new Set<string>();
    for (const entry of group.entries) {
      if (entry.id !== group.terminalEntry?.id) {
        hiddenEntryIds.add(entry.id);
      }
    }
    if (hiddenEntryIds.size === 0) {
      continue;
    }

    const firstEntry = group.entries[0];
    const lastEntry = group.entries.at(-1);
    if (!firstEntry || !lastEntry) {
      continue;
    }

    const isLatestInterruptedTurn =
      input.latestTurn?.turnId === turnId && input.latestTurn.state === "interrupted";
    // A turn cut short by a steer leaves trailing work entries behind its
    // terminal message — take whichever ended last.
    const lastEntryEnd =
      lastEntry.kind === "message" ? lastEntry.message.updatedAt : lastEntry.createdAt;
    const elapsedMs =
      input.latestTurn?.turnId === turnId &&
      input.latestTurn.startedAt &&
      input.latestTurn.completedAt
        ? computeElapsedMs(input.latestTurn.startedAt, input.latestTurn.completedAt)
        : computeElapsedMs(
            group.startBoundary ?? firstEntry.createdAt,
            maxIsoTimestamp(group.terminalEntry?.message.updatedAt ?? null, lastEntryEnd) ??
              lastEntryEnd,
          );
    const duration = elapsedMs !== null ? formatDuration(elapsedMs) : null;
    const label = isLatestInterruptedTurn
      ? duration
        ? `You stopped after ${duration}`
        : "You stopped this response"
      : duration
        ? `Worked for ${duration}`
        : "Worked";

    foldsByAnchorEntryId.set(firstEntry.id, {
      turnId,
      anchorEntryId: firstEntry.id,
      createdAt: firstEntry.createdAt,
      hiddenEntryIds,
      label,
    });
  }
  return foldsByAnchorEntryId;
}

export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  latestTurn?: TimelineLatestTurn | null;
  runningTurnId?: TurnId | null;
  expandedTurnIds?: ReadonlySet<TurnId>;
  expandedWorkGroupIds?: ReadonlySet<string>;
  isWorking: boolean;
  activeTurnStartedAt: string | null;
  turnDiffSummaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary>;
  revertTurnCountByUserMessageId: ReadonlyMap<MessageId, number>;
}): MessagesTimelineRow[] {
  const nextRows: MessagesTimelineRow[] = [];
  const durationStartByMessageId = computeMessageDurationStart(
    input.timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
  );
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(input.timelineEntries);
  const unsettledTurnId = deriveUnsettledTurnId(
    input.latestTurn ?? null,
    input.runningTurnId ?? null,
  );
  const foldsByAnchorEntryId = deriveTurnFolds({
    timelineEntries: input.timelineEntries,
    terminalAssistantMessageIds,
    latestTurn: input.latestTurn ?? null,
    unsettledTurnId,
  });
  const collapsedEntryIds = new Set<string>();
  for (const fold of foldsByAnchorEntryId.values()) {
    if (!input.expandedTurnIds?.has(fold.turnId)) {
      for (const entryId of fold.hiddenEntryIds) {
        collapsedEntryIds.add(entryId);
      }
    }
  }

  for (let index = 0; index < input.timelineEntries.length; index += 1) {
    const timelineEntry = input.timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    const turnFold = foldsByAnchorEntryId.get(timelineEntry.id);
    if (turnFold) {
      nextRows.push({
        kind: "turn-fold",
        id: `turn-fold:${turnFold.turnId}`,
        createdAt: turnFold.createdAt,
        turnId: turnFold.turnId,
        label: turnFold.label,
        expanded: input.expandedTurnIds?.has(turnFold.turnId) ?? false,
      });
    }

    if (collapsedEntryIds.has(timelineEntry.id)) {
      continue;
    }

    if (timelineEntry.kind === "work") {
      const groupedEntries = [timelineEntry.entry];
      let cursor = index + 1;
      while (cursor < input.timelineEntries.length) {
        const nextEntry = input.timelineEntries[cursor];
        if (
          !nextEntry ||
          nextEntry.kind !== "work" ||
          collapsedEntryIds.has(nextEntry.id) ||
          foldsByAnchorEntryId.has(nextEntry.id)
        ) {
          break;
        }
        groupedEntries.push(nextEntry.entry);
        cursor += 1;
      }
      const visibleGroupedEntries = groupedEntries.filter(
        (entry) => !workEntryIndicatesToolNeutralStatus(entry),
      );
      if (visibleGroupedEntries.length > 0) {
        if (visibleGroupedEntries.length <= MAX_VISIBLE_WORK_LOG_ENTRIES) {
          nextRows.push({
            kind: "work",
            id: timelineEntry.id,
            createdAt: timelineEntry.createdAt,
            groupedEntries: visibleGroupedEntries,
          });
        } else {
          const groupId = `work-group:${timelineEntry.id}`;
          const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false;
          const hiddenEntries = visibleGroupedEntries.slice(0, -MAX_VISIBLE_WORK_LOG_ENTRIES);
          const visibleEntries = visibleGroupedEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES);
          const renderedEntries = expanded ? [...hiddenEntries, ...visibleEntries] : visibleEntries;

          for (const workEntry of renderedEntries) {
            nextRows.push({
              kind: "work",
              id: workEntry.id,
              createdAt: workEntry.createdAt,
              groupedEntries: [workEntry],
            });
          }

          nextRows.push({
            kind: "work-toggle",
            id: `work-toggle:${timelineEntry.id}`,
            createdAt: timelineEntry.createdAt,
            groupId,
            hiddenCount: hiddenEntries.length,
            expanded,
            onlyToolEntries: visibleGroupedEntries.every((entry) => workLogEntryIsToolLike(entry)),
          });
        }
      }
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

    const assistantTurnStillInProgress =
      timelineEntry.message.role === "assistant" &&
      unsettledTurnId !== null &&
      timelineEntry.message.turnId === unsettledTurnId;

    const durationStart =
      durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt;

    // While the turn is still running, the latest assistant message is only
    // provisionally terminal — withhold the metadata row until the turn
    // settles so commentary doesn't flash timestamps mid-work.
    const showAssistantMeta =
      timelineEntry.message.role === "assistant" &&
      terminalAssistantMessageIds.has(timelineEntry.message.id) &&
      !assistantTurnStillInProgress;

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      durationStart,
      showAssistantMeta,
      showAssistantCopyButton: showAssistantMeta,
      assistantCopyStreaming: timelineEntry.message.streaming || assistantTurnStillInProgress,
      assistantTurnDiffSummary:
        timelineEntry.message.role === "assistant"
          ? input.turnDiffSummaryByAssistantMessageId.get(timelineEntry.message.id)
          : undefined,
      revertTurnCount:
        timelineEntry.message.role === "user"
          ? input.revertTurnCountByUserMessageId.get(timelineEntry.message.id)
          : undefined,
    });
  }

  if (input.isWorking) {
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt,
    });
  }

  return nextRows;
}

export function computeStableMessagesTimelineRows(
  rows: MessagesTimelineRow[],
  previous: StableMessagesTimelineRowsState,
): StableMessagesTimelineRowsState {
  const next = new Map<string, MessagesTimelineRow>();
  let anyChanged = rows.length !== previous.byId.size;

  const result = rows.map((row, index) => {
    const prevRow = previous.byId.get(row.id);
    const nextRow = prevRow && isRowUnchanged(prevRow, row) ? prevRow : row;
    next.set(row.id, nextRow);
    if (!anyChanged && previous.result[index] !== nextRow) {
      anyChanged = true;
    }
    return nextRow;
  });

  return anyChanged ? { byId: next, result } : previous;
}

/** Shallow field comparison per row variant — avoids deep equality cost. */
function isRowUnchanged(a: MessagesTimelineRow, b: MessagesTimelineRow): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;

  switch (a.kind) {
    case "working":
      return a.createdAt === (b as typeof a).createdAt;

    case "turn-fold": {
      const bf = b as typeof a;
      return a.createdAt === bf.createdAt && a.label === bf.label && a.expanded === bf.expanded;
    }

    case "proposed-plan":
      return a.proposedPlan === (b as typeof a).proposedPlan;

    case "work":
      return Equal.equals(a.groupedEntries, (b as typeof a).groupedEntries);

    case "work-toggle": {
      const bw = b as typeof a;
      return (
        a.createdAt === bw.createdAt &&
        a.groupId === bw.groupId &&
        a.hiddenCount === bw.hiddenCount &&
        a.expanded === bw.expanded &&
        a.onlyToolEntries === bw.onlyToolEntries
      );
    }

    case "message": {
      const bm = b as typeof a;
      return (
        a.message === bm.message &&
        a.durationStart === bm.durationStart &&
        a.showAssistantMeta === bm.showAssistantMeta &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantCopyStreaming === bm.assistantCopyStreaming &&
        a.assistantTurnDiffSummary === bm.assistantTurnDiffSummary &&
        a.revertTurnCount === bm.revertTurnCount
      );
    }
  }
}
