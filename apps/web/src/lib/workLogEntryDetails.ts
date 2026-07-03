import { formatDuration, type WorkLogEntry } from "../session-logic";
import { formatWorkspaceRelativePath } from "../filePathDisplay";
import { createChangedFileDiffPathMatcher } from "./diffRendering";

export const COMMAND_OUTPUT_TAIL_LINES = 40;

export function hasRenderableCommandOutput(value: string | null | undefined): value is string {
  return typeof value === "string" && /\S/u.test(value);
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

function collectRenderableCommandOutputLineSummary(
  value: string | null | undefined,
  maxTailLines: number,
): { lineCount: number; tailLines: string[] } {
  if (typeof value !== "string" || value.length === 0) {
    return { lineCount: 0, tailLines: [] };
  }

  let lineCount = 0;
  const tailLines: string[] = [];
  const pendingBlankLines: string[] = [];
  let sawRenderableLine = false;

  const appendLine = (line: string) => {
    lineCount += 1;
    if (maxTailLines <= 0) {
      return;
    }
    tailLines.push(line);
    if (tailLines.length > maxTailLines) {
      tailLines.shift();
    }
  };

  const processLine = (line: string) => {
    if (line.trim().length === 0) {
      if (sawRenderableLine) {
        pendingBlankLines.push(line);
      }
      return;
    }

    sawRenderableLine = true;
    for (const pendingLine of pendingBlankLines.splice(0)) {
      appendLine(pendingLine);
    }
    appendLine(line);
  };

  let lineStartIndex = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 10) {
      continue;
    }
    const lineEndIndex =
      index > lineStartIndex && value.charCodeAt(index - 1) === 13 ? index - 1 : index;
    processLine(value.slice(lineStartIndex, lineEndIndex));
    lineStartIndex = index + 1;
  }
  processLine(value.slice(lineStartIndex));

  return { lineCount, tailLines };
}

function normalizeMaxVisibleLines(value: number | undefined): number {
  if (value === undefined) {
    return COMMAND_OUTPUT_TAIL_LINES;
  }
  if (!Number.isFinite(value)) {
    return COMMAND_OUTPUT_TAIL_LINES;
  }
  return Math.max(1, Math.floor(value));
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
  if (!hasRenderableCommandOutput(detail)) {
    return false;
  }
  const normalizedDetailLines = getRenderableCommandOutputLines(detail).map((line) => line.trim());
  const hasStreamOutput =
    hasRenderableCommandOutput(workEntry.stdout) || hasRenderableCommandOutput(workEntry.stderr);
  const outputCandidates = hasStreamOutput
    ? [workEntry.stdout, workEntry.stderr]
    : [workEntry.output];

  return outputCandidates.some((value) =>
    commandOutputTextMatchesNormalizedLines(value, normalizedDetailLines),
  );
}

function commandOutputTextMatchesNormalizedLines(
  value: string | null | undefined,
  normalizedDetailLines: ReadonlyArray<string>,
): boolean {
  if (!hasRenderableCommandOutput(value)) {
    return false;
  }

  let expectedIndex = 0;
  let pendingBlankLineCount = 0;
  let sawRenderableLine = false;

  const consumeExpectedLine = (normalizedLine: string): boolean => {
    if (normalizedDetailLines[expectedIndex] !== normalizedLine) {
      return false;
    }
    expectedIndex += 1;
    return expectedIndex <= normalizedDetailLines.length;
  };

  const processLine = (line: string): boolean => {
    const normalizedLine = line.trim();
    if (normalizedLine.length === 0) {
      if (sawRenderableLine) {
        pendingBlankLineCount += 1;
      }
      return true;
    }

    sawRenderableLine = true;
    while (pendingBlankLineCount > 0) {
      if (!consumeExpectedLine("")) {
        return false;
      }
      pendingBlankLineCount -= 1;
    }
    return consumeExpectedLine(normalizedLine);
  };

  let lineStartIndex = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 10) {
      continue;
    }
    const lineEndIndex =
      index > lineStartIndex && value.charCodeAt(index - 1) === 13 ? index - 1 : index;
    if (!processLine(value.slice(lineStartIndex, lineEndIndex))) {
      return false;
    }
    lineStartIndex = index + 1;
  }

  return processLine(value.slice(lineStartIndex)) && expectedIndex === normalizedDetailLines.length;
}

function isCollabAgentWorkEntry(workEntry: WorkLogEntry): boolean {
  // Collab-agent rows own their nested activity UI; do not re-expand them as
  // command or file-change detail boxes.
  return workEntry.itemType === "collab_agent_tool_call";
}

const SENSITIVE_TOOL_DATA_KEY_PATTERN =
  /(?:api[-_]?key|authorization|bearer|credential|password|secret|token)/iu;
const MAX_TOOL_DATA_STRING_LENGTH = 2_000;

function serializeToolDataForDisplay(toolData: unknown): string {
  const ancestors: object[] = [];
  try {
    return JSON.stringify(
      toolData,
      function serializeToolDataValue(this: unknown, key: string, value: unknown) {
        if (SENSITIVE_TOOL_DATA_KEY_PATTERN.test(key)) {
          return "[redacted]";
        }
        if (typeof value === "string" && value.length > MAX_TOOL_DATA_STRING_LENGTH) {
          return `${value.slice(0, MAX_TOOL_DATA_STRING_LENGTH)}... [truncated]`;
        }
        if (typeof value !== "object" || value === null) {
          return value;
        }
        while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) {
          ancestors.pop();
        }
        if (ancestors.includes(value)) {
          return "[Circular]";
        }
        ancestors.push(value);
        return value;
      },
      2,
    );
  } catch {
    return "[unserializable tool data]";
  }
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
  if (!rawCommand) {
    return null;
  }
  const command = workEntry.command?.trim();
  return rawCommand === command ? null : rawCommand;
}

function buildGenericToolExpandedBody(
  workEntry: WorkLogEntry,
  workspaceRoot: string | undefined,
): string | null {
  const blocks: string[] = [];
  if (workEntry.itemType === "mcp_tool_call" && workEntry.toolData !== undefined) {
    blocks.push(`MCP call\n${serializeToolDataForDisplay(workEntry.toolData)}`);
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
    durationLabel: workEntry.durationMs != null ? formatDuration(workEntry.durationMs) : "unknown",
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
  return Boolean(
    workEntry.patch ||
    workEntry.itemType === "file_change" ||
    workEntry.requestKind === "file-change",
  );
}

export function filterChangedFilesWithoutInlineDiff(
  changedFiles: ReadonlyArray<string> | undefined,
  inlineDiffPaths: ReadonlyArray<string>,
  workspaceRoot?: string,
): string[] {
  if (!changedFiles || changedFiles.length === 0) {
    return [];
  }
  if (inlineDiffPaths.length === 0) {
    return [...changedFiles];
  }
  const exactInlineDiffPaths = new Set(inlineDiffPaths);
  const inlineDiffMatchers = inlineDiffPaths
    .filter((inlineDiffPath) => inlineDiffPath.includes("/") || inlineDiffPath.includes("\\"))
    .map(createChangedFileDiffPathMatcher);
  const normalizedWorkspaceRoot = workspaceRoot
    ? normalizeWorkLogDiffComparisonPath(workspaceRoot).replace(/\/+$/u, "")
    : null;
  const workspaceRelativeInlineDiffPaths = normalizedWorkspaceRoot
    ? new Set(
        inlineDiffPaths.map((inlineDiffPath) =>
          normalizeWorkLogDiffComparisonPath(inlineDiffPath).toLowerCase(),
        ),
      )
    : null;
  return changedFiles.filter((changedFile) => {
    const workspaceRelativeChangedFile =
      normalizedWorkspaceRoot && workspaceRelativeInlineDiffPaths
        ? getWorkspaceRelativeChangedFile(changedFile, normalizedWorkspaceRoot)
        : null;
    const matchesWorkspaceRelativeInlineDiffPath =
      workspaceRelativeChangedFile !== null &&
      workspaceRelativeInlineDiffPaths?.has(workspaceRelativeChangedFile.toLowerCase()) === true;
    return (
      !exactInlineDiffPaths.has(changedFile) &&
      !matchesWorkspaceRelativeInlineDiffPath &&
      !inlineDiffMatchers.some((matchesDiffPath) => matchesDiffPath(changedFile))
    );
  });
}

function getWorkspaceRelativeChangedFile(
  changedFile: string,
  normalizedWorkspaceRoot: string,
): string | null {
  const normalizedChangedFile = normalizeWorkLogDiffComparisonPath(changedFile);
  const changedFileForCompare = normalizedChangedFile.toLowerCase();
  const workspaceRootForCompare = normalizedWorkspaceRoot.toLowerCase();
  if (changedFileForCompare === workspaceRootForCompare) {
    return "";
  }
  const workspaceRootPrefix = `${workspaceRootForCompare}/`;
  if (!changedFileForCompare.startsWith(workspaceRootPrefix)) {
    return null;
  }
  return normalizedChangedFile.slice(normalizedWorkspaceRoot.length + 1);
}

function normalizeWorkLogDiffComparisonPath(value: string): string {
  return value.replace(/\\/gu, "/").replace(/^\/([A-Za-z]:\/)/u, "$1");
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
  return filterChangedFilesWithoutInlineDiff(
    input.changedFiles,
    input.inlineDiffPaths,
    input.workspaceRoot,
  ).map((filePath) => ({
    path: filePath,
    displayPath: formatWorkspaceRelativePath(filePath, input.workspaceRoot),
  }));
}

export interface DerivedCommandOutputDisplay {
  isTruncated: boolean;
  visibleValue: string;
  suffix: string;
}

export function deriveCommandOutputDisplay(input: {
  value: string | null | undefined;
  showFull: boolean;
  maxVisibleLines?: number;
}): DerivedCommandOutputDisplay {
  const maxVisibleLines = normalizeMaxVisibleLines(input.maxVisibleLines);
  if (!input.showFull) {
    const { lineCount, tailLines } = collectRenderableCommandOutputLineSummary(
      input.value,
      maxVisibleLines,
    );
    const isTruncated = lineCount > maxVisibleLines;
    return {
      isTruncated,
      visibleValue: tailLines.join("\n"),
      suffix: isTruncated
        ? `last ${maxVisibleLines} of ${lineCount.toLocaleString()} lines`
        : `${lineCount.toLocaleString()} line${lineCount === 1 ? "" : "s"}`,
    };
  }

  const lines = getRenderableCommandOutputLines(input.value);
  const isTruncated = lines.length > maxVisibleLines;
  const visibleValue = lines.join("\n");
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
