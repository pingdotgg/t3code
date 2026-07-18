import {
  isToolLifecycleItemType,
  type OrchestrationThreadActivity,
  type ToolLifecycleItemType,
} from "@t3tools/contracts";

export type WorkLogRequestKind = "command" | "file-read" | "file-change";

export interface ParsedWorkLogActivityPayload {
  readonly command: string | null;
  readonly rawCommand: string | null;
  readonly output: string | null;
  readonly stdout: string | null;
  readonly stderr: string | null;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  readonly patch: string | null;
  readonly changedFiles: ReadonlyArray<string>;
  readonly title: string | null;
  readonly strippedDetail: string | null;
  readonly detail: string | null;
  readonly toolCallId: string | null;
  readonly itemType: ToolLifecycleItemType | undefined;
  readonly requestKind: WorkLogRequestKind | undefined;
  readonly toolData: unknown;
}

export interface WorkLogActivityIdentity {
  readonly toolCallId: string | null;
  readonly itemType: ToolLifecycleItemType | undefined;
  readonly title: string | null;
}

const MAX_PATCH_SEARCH_DEPTH = 4;
const MAX_PATCH_STRINGS = 4;
const MAX_INLINE_PATCH_CHARS = 200_000;

export function requestKindFromRequestType(requestType: unknown): WorkLogRequestKind | null {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
    case "dynamic_tool_call":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    default:
      return null;
  }
}

export function parseWorkLogActivityPayload(
  payload: Record<string, unknown> | null,
  options: {
    readonly heading: string;
    readonly preserveBlankRawOutputStreams?: boolean;
  },
): ParsedWorkLogActivityPayload {
  const command = extractToolCommand(payload);
  const commandResult = extractCommandResult(payload, options);
  const itemType = extractWorkLogItemType(payload);
  const title = extractToolTitle(payload);
  const data = asRecord(payload?.data);

  return {
    ...command,
    ...commandResult,
    patch: extractToolPatch(payload),
    changedFiles: extractChangedFiles(payload),
    title,
    strippedDetail:
      typeof payload?.detail === "string" ? stripTrailingExitCode(payload.detail).output : null,
    detail: extractToolDetail(payload, title ?? options.heading),
    toolCallId: extractToolCallId(payload),
    itemType,
    requestKind: extractWorkLogRequestKind(payload),
    toolData: itemType === "mcp_tool_call" ? data?.item : undefined,
  };
}

export function extractWorkLogActivityIdentity(value: unknown): WorkLogActivityIdentity {
  const payload = asRecord(value);
  return {
    toolCallId: extractToolCallId(payload),
    itemType: extractWorkLogItemType(payload),
    title: extractToolTitle(payload),
  };
}

export function mergeCumulativePatch(
  previous: string | undefined,
  next: string | undefined,
): string | undefined {
  if (!previous) {
    return next;
  }
  if (!next || next === previous) {
    return previous;
  }
  const previousSnapshot = previous.trim();
  const nextSnapshot = next.trim();
  if (nextSnapshot.startsWith(previousSnapshot)) {
    return next;
  }
  if (previousSnapshot.startsWith(nextSnapshot)) {
    return previous;
  }
  return `${previous.trimEnd()}\n\n${next.trimStart()}`;
}

export function mergeCumulativeOutput(
  previous: string | undefined,
  next: string | undefined,
  nextActivityKind: OrchestrationThreadActivity["kind"],
): string | undefined {
  if (!previous) {
    return next;
  }
  if (!next) {
    return previous;
  }
  if (previous === next) {
    return next;
  }
  if (next.startsWith(previous)) {
    return next;
  }
  if (previous.startsWith(next)) {
    if (shouldKeepLongerOutputSnapshot(previous, next, nextActivityKind)) {
      return previous;
    }
    if (nextActivityKind === "tool.updated" && (next.length === 1 || previous.includes("\n"))) {
      return `${previous}${next}`;
    }
    return next;
  }
  return `${previous}${next}`;
}

export function mergeChangedFiles(
  previous: ReadonlyArray<string> | undefined,
  next: ReadonlyArray<string> | undefined,
): string[] {
  const merged = [...(previous ?? []), ...(next ?? [])];
  if (merged.length === 0) {
    return [];
  }
  return [...new Set(merged)];
}

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

function shouldKeepLongerOutputSnapshot(
  previous: string,
  next: string,
  nextActivityKind: OrchestrationThreadActivity["kind"],
): boolean {
  return (
    nextActivityKind === "tool.completed" ||
    next.endsWith("\n") ||
    isLikelyShorterOutputSnapshot(previous, next)
  );
}

function isLikelyShorterOutputSnapshot(previous: string, next: string): boolean {
  if (next.length <= 1) {
    return false;
  }
  // Shorter snapshots usually stop at a token or line boundary in the prior output.
  const following = previous[next.length];
  if (previous.includes("\n")) {
    return following === "\n" || following === "\r";
  }
  return following === " " || following === "\t" || following === "\n" || following === "\r";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function trimMatchingOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    const unquoted = trimmed.slice(1, -1).trim();
    return unquoted.length > 0 ? unquoted : trimmed;
  }
  return trimmed;
}

function executableBasename(value: string): string | null {
  const trimmed = trimMatchingOuterQuotes(value);
  if (trimmed.length === 0) {
    return null;
  }
  const normalized = trimmed.replace(/\\/g, "/");
  const segments = normalized.split("/");
  const last = segments.at(-1)?.trim() ?? "";
  return last.length > 0 ? last.toLowerCase() : null;
}

function splitExecutableAndRest(value: string): { executable: string; rest: string } | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed.charAt(0);
    const closeIndex = trimmed.indexOf(quote, 1);
    if (closeIndex <= 0) {
      return null;
    }
    return {
      executable: trimmed.slice(0, closeIndex + 1),
      rest: trimmed.slice(closeIndex + 1).trim(),
    };
  }

  const firstWhitespace = trimmed.search(/\s/);
  if (firstWhitespace < 0) {
    return {
      executable: trimmed,
      rest: "",
    };
  }

  return {
    executable: trimmed.slice(0, firstWhitespace),
    rest: trimmed.slice(firstWhitespace).trim(),
  };
}

const SHELL_WRAPPER_SPECS = [
  {
    executables: ["pwsh", "pwsh.exe", "powershell", "powershell.exe"],
    wrapperFlagPattern: /(?:^|\s)-command\s+/i,
  },
  {
    executables: ["cmd", "cmd.exe"],
    wrapperFlagPattern: /(?:^|\s)\/c\s+/i,
  },
  {
    executables: ["bash", "sh", "zsh"],
    wrapperFlagPattern: /(?:^|\s)-(?:l)?c\s+/i,
  },
] as const;

function findShellWrapperSpec(shell: string) {
  return SHELL_WRAPPER_SPECS.find((spec) =>
    (spec.executables as ReadonlyArray<string>).includes(shell),
  );
}

function unwrapCommandRemainder(value: string, wrapperFlagPattern: RegExp): string | null {
  const match = wrapperFlagPattern.exec(value);
  if (!match) {
    return null;
  }

  const command = value.slice(match.index + match[0].length).trim();
  if (command.length === 0) {
    return null;
  }

  const unwrapped = trimMatchingOuterQuotes(command);
  return unwrapped.length > 0 ? unwrapped : null;
}

function unwrapKnownShellCommandWrapper(value: string): string {
  const split = splitExecutableAndRest(value);
  if (!split || split.rest.length === 0) {
    return value;
  }

  const shell = executableBasename(split.executable);
  if (!shell) {
    return value;
  }

  const spec = findShellWrapperSpec(shell);
  if (!spec) {
    return value;
  }

  return unwrapCommandRemainder(split.rest, spec.wrapperFlagPattern) ?? value;
}

function formatCommandArrayPart(value: string): string {
  return /[\s"'`]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function formatCommandValue(value: unknown): string | null {
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const parts: Array<string> = [];
  for (const entry of value) {
    const part = asTrimmedString(entry);
    if (part !== null) {
      parts.push(part);
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.map((part) => formatCommandArrayPart(part)).join(" ");
}

function normalizeCommandValue(value: unknown): string | null {
  const formatted = formatCommandValue(value);
  return formatted ? unwrapKnownShellCommandWrapper(formatted) : null;
}

function toRawToolCommand(value: unknown, normalizedCommand: string | null): string | null {
  const formatted = formatCommandValue(value);
  if (!formatted || normalizedCommand === null) {
    return null;
  }
  return formatted === normalizedCommand ? null : formatted;
}

function extractToolCommand(payload: Record<string, unknown> | null): {
  command: string | null;
  rawCommand: string | null;
} {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const itemInput = asRecord(item?.input);
  const itemType = asTrimmedString(payload?.itemType);
  const detail = asTrimmedString(payload?.detail);
  const candidates: unknown[] = [
    item?.command,
    itemInput?.command,
    itemResult?.command,
    data?.command,
    itemType === "command_execution" && detail ? stripTrailingExitCode(detail).output : null,
  ];

  for (const candidate of candidates) {
    const command = normalizeCommandValue(candidate);
    if (!command) {
      continue;
    }
    return {
      command,
      rawCommand: toRawToolCommand(candidate, command),
    };
  }

  return {
    command: null,
    rawCommand: null,
  };
}

function firstNumberFromRecord(
  record: Record<string, unknown> | null,
  keys: ReadonlyArray<string>,
): number | null {
  if (!record) {
    return null;
  }
  for (const key of keys) {
    const value = asNumber(record[key]);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function firstIntegerFromRecord(
  record: Record<string, unknown> | null,
  keys: ReadonlyArray<string>,
): number | null {
  const value = firstNumberFromRecord(record, keys);
  return value !== null && Number.isInteger(value) ? value : null;
}

function extractCommandResult(
  payload: Record<string, unknown> | null,
  options: {
    readonly preserveBlankRawOutputStreams?: boolean;
  } = {},
): {
  output: string | null;
  stdout: string | null;
  stderr: string | null;
  exitCode: number | null;
  durationMs: number | null;
} {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const rawOutput = asRecord(data?.rawOutput);
  const rawOutputStdout = options.preserveBlankRawOutputStreams
    ? firstRawStringFromRecord(rawOutput, ["stdout"])
    : firstCommandOutputStringFromRecord(rawOutput, ["stdout"]);
  const stdout =
    rawOutputStdout ??
    firstCommandOutputStringFromRecord(itemResult, ["stdout"]) ??
    firstCommandOutputStringFromRecord(data, ["stdout"]) ??
    firstCommandOutputStringFromRecord(payload, ["stdout"]);
  const stderr =
    (options.preserveBlankRawOutputStreams
      ? firstRawStringFromRecord(rawOutput, ["stderr"])
      : firstCommandOutputStringFromRecord(rawOutput, ["stderr"])) ??
    firstCommandOutputStringFromRecord(itemResult, ["stderr"]) ??
    firstCommandOutputStringFromRecord(data, ["stderr"]) ??
    firstCommandOutputStringFromRecord(payload, ["stderr"]);
  const rawOutputContent = options.preserveBlankRawOutputStreams
    ? firstRawStringFromRecord(rawOutput, ["content", "output", "text", "result"])
    : firstCommandOutputStringFromRecord(rawOutput, ["content", "output", "text", "result"]);
  const content =
    stdout ??
    rawOutputContent ??
    firstCommandOutputStringFromRecord(itemResult, ["content", "output", "text", "result"]) ??
    firstCommandOutputStringFromRecord(item, ["aggregatedOutput", "output", "text", "result"]);
  const strippedContent = content ? stripTrailingExitCode(content) : null;
  const detailExit =
    typeof payload?.detail === "string" ? stripTrailingExitCode(payload.detail) : null;
  const exitCode =
    firstIntegerFromRecord(rawOutput, ["exitCode", "code"]) ??
    firstIntegerFromRecord(itemResult, ["exitCode", "code"]) ??
    firstIntegerFromRecord(item, ["exitCode", "code"]) ??
    firstIntegerFromRecord(data, ["exitCode", "code"]) ??
    firstIntegerFromRecord(payload, ["exitCode", "code"]) ??
    strippedContent?.exitCode ??
    detailExit?.exitCode ??
    null;
  const elapsedSeconds =
    firstNumberFromRecord(rawOutput, ["elapsedSeconds"]) ??
    firstNumberFromRecord(itemResult, ["elapsedSeconds"]) ??
    firstNumberFromRecord(item, ["elapsedSeconds"]) ??
    firstNumberFromRecord(data, ["elapsedSeconds"]) ??
    firstNumberFromRecord(payload, ["elapsedSeconds"]);
  const durationMs =
    firstNumberFromRecord(rawOutput, ["durationMs", "elapsedMs"]) ??
    firstNumberFromRecord(itemResult, ["durationMs", "elapsedMs"]) ??
    firstNumberFromRecord(item, ["durationMs", "elapsedMs"]) ??
    firstNumberFromRecord(data, ["durationMs", "elapsedMs"]) ??
    firstNumberFromRecord(payload, ["durationMs", "elapsedMs"]) ??
    (elapsedSeconds !== null ? elapsedSeconds * 1000 : null);
  const strippedStdout = stdout ? stripTrailingExitCode(stdout) : null;
  const normalizedOutput =
    strippedContent?.exitCode !== undefined ? strippedContent.output : (content ?? null);

  return {
    // `output` is the legacy fallback stream; callers should prefer stdout/stderr when present.
    output: normalizedOutput,
    stdout: strippedStdout?.exitCode !== undefined ? strippedStdout.output : stdout,
    stderr,
    exitCode,
    durationMs,
  };
}

function extractToolTitle(payload: Record<string, unknown> | null): string | null {
  return asTrimmedString(payload?.title);
}

function extractToolCallId(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  return asTrimmedString(data?.toolCallId);
}

function normalizeInlinePreview(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateInlinePreview(value: string, maxLength = 84): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function normalizePreviewForComparison(value: string | null | undefined): string | null {
  const normalized = asTrimmedString(value);
  if (!normalized) {
    return null;
  }
  return normalizeCompactToolLabel(normalizeInlinePreview(normalized)).toLowerCase();
}

function summarizeToolTextOutput(value: string): string | null {
  const lines: Array<string> = [];
  for (const rawLine of value.split(/\r?\n/u)) {
    const line = normalizeInlinePreview(rawLine);
    if (line.length > 0) {
      lines.push(line);
    }
  }
  const firstLine = lines.find((line) => line !== "```");
  if (firstLine) {
    return truncateInlinePreview(firstLine);
  }
  if (lines.length > 1) {
    return `${lines.length.toLocaleString()} lines`;
  }
  return null;
}

function summarizeToolRawOutput(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const rawOutput = asRecord(data?.rawOutput);
  if (!rawOutput) {
    return null;
  }

  const totalFiles = asNumber(rawOutput.totalFiles);
  if (totalFiles !== null) {
    const suffix = rawOutput.truncated === true ? "+" : "";
    return `${totalFiles.toLocaleString()} file${totalFiles === 1 ? "" : "s"}${suffix}`;
  }

  const content = asTrimmedString(rawOutput.content);
  if (content) {
    return summarizeToolTextOutput(content);
  }

  const stdout = asTrimmedString(rawOutput.stdout);
  if (stdout) {
    return summarizeToolTextOutput(stdout);
  }

  return null;
}

function isCommandToolDetail(payload: Record<string, unknown> | null, heading: string): boolean {
  const data = asRecord(payload?.data);
  const kind = asTrimmedString(data?.kind)?.toLowerCase();
  const title = asTrimmedString(payload?.title ?? heading)?.toLowerCase();
  return (
    extractWorkLogItemType(payload) === "command_execution" ||
    kind === "execute" ||
    title === "terminal" ||
    title === "ran command"
  );
}

function extractToolDetail(
  payload: Record<string, unknown> | null,
  heading: string,
): string | null {
  const rawDetail = asTrimmedString(payload?.detail);
  const detail = rawDetail ? stripTrailingExitCode(rawDetail).output : null;
  const normalizedHeading = normalizePreviewForComparison(heading);
  const normalizedDetail = normalizePreviewForComparison(detail);

  if (detail && normalizedHeading !== normalizedDetail) {
    return detail;
  }

  if (isCommandToolDetail(payload, heading)) {
    return null;
  }

  const rawOutputSummary = summarizeToolRawOutput(payload);
  if (rawOutputSummary) {
    const normalizedRawOutputSummary = normalizePreviewForComparison(rawOutputSummary);
    if (normalizedRawOutputSummary !== normalizedHeading) {
      return rawOutputSummary;
    }
  }

  return null;
}

function stripTrailingExitCode(value: string): {
  output: string | null;
  exitCode?: number | undefined;
} {
  const trimmed = value.trim();
  const match = /^(?<output>[\s\S]*?)(?:\s*<exited with exit code (?<code>\d+)>)\s*$/i.exec(
    trimmed,
  );
  if (!match?.groups) {
    return {
      output: trimmed.length > 0 ? trimmed : null,
    };
  }
  const exitCode = Number.parseInt(match.groups.code ?? "", 10);
  const normalizedOutput = match.groups.output?.trim() ?? "";
  return {
    output: normalizedOutput.length > 0 ? normalizedOutput : null,
    ...(Number.isInteger(exitCode) ? { exitCode } : {}),
  };
}

function firstRawStringFromRecord(
  record: Record<string, unknown> | null,
  keys: ReadonlyArray<string>,
): string | null {
  if (!record) {
    return null;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

function firstCommandOutputStringFromRecord(
  record: Record<string, unknown> | null,
  keys: ReadonlyArray<string>,
): string | null {
  const value = firstRawStringFromRecord(record, keys);
  return value !== null && /\S/u.test(value) ? value : null;
}

function looksLikeUnifiedDiff(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.startsWith("diff --git ") ||
    trimmed.startsWith("--- ") ||
    trimmed.startsWith("@@ ") ||
    /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/u.test(trimmed)
  );
}

function codexChangeKindType(record: Record<string, unknown>): string | null {
  const kind = record.kind;
  if (typeof kind === "string") {
    return asTrimmedString(kind)?.toLowerCase() ?? null;
  }
  const kindRecord = asRecord(kind);
  return asTrimmedString(kindRecord?.type)?.toLowerCase() ?? null;
}

function patchPathFromRecord(record: Record<string, unknown>): string | null {
  return (
    asTrimmedString(record.path) ??
    asTrimmedString(record.filePath) ??
    asTrimmedString(record.relativePath) ??
    asTrimmedString(record.filename) ??
    asTrimmedString(record.newPath) ??
    asTrimmedString(record.oldPath)
  );
}

function normalizeDiffHeaderPath(path: string): string {
  return path.replace(/\\/gu, "/");
}

function toUnifiedPatchFromRecordDiff(
  record: Record<string, unknown>,
  diff: string,
): string | null {
  if (diff.startsWith("diff --git ") || diff.startsWith("--- ")) {
    return diff;
  }
  const trimmed = diff.trimEnd();
  if (trimmed.length === 0) {
    return null;
  }

  const rawPath = patchPathFromRecord(record);
  if (!rawPath) {
    return looksLikeUnifiedDiff(trimmed) ? trimmed : null;
  }
  const path = normalizeDiffHeaderPath(rawPath);

  if (codexChangeKindType(record) === "add") {
    if (trimmed.startsWith("@@ ")) {
      return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n${trimmed}`;
    }
    const lines = trimmed.length > 0 ? trimmed.split(/\r?\n/u) : [];
    const addedLines = lines.map((line) => `+${line}`).join("\n");
    return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${addedLines}`;
  }

  if (codexChangeKindType(record) === "delete") {
    if (trimmed.startsWith("@@ ")) {
      return `diff --git a/${path} b/${path}\ndeleted file mode 100644\n--- a/${path}\n+++ /dev/null\n${trimmed}`;
    }
    const lines = trimmed.length > 0 ? trimmed.split(/\r?\n/u) : [];
    const removedLines = lines.map((line) => `-${line}`).join("\n");
    return `diff --git a/${path} b/${path}\ndeleted file mode 100644\n--- a/${path}\n+++ /dev/null\n@@ -1,${lines.length} +0,0 @@\n${removedLines}`;
  }

  if (trimmed.startsWith("@@ ")) {
    return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${trimmed}`;
  }

  return null;
}

function collectPatchStrings(
  value: unknown,
  patches: string[],
  seen: Set<string>,
  depth: number,
  includeNested = true,
): void {
  if (depth > MAX_PATCH_SEARCH_DEPTH || patches.length >= MAX_PATCH_STRINGS) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectPatchStrings(entry, patches, seen, depth + 1, includeNested);
      if (patches.length >= MAX_PATCH_STRINGS) {
        return;
      }
    }
    return;
  }
  const record = asRecord(value);
  if (!record) {
    return;
  }
  for (const key of ["patch", "diff", "unifiedDiff"]) {
    const rawCandidate = typeof record[key] === "string" ? record[key] : null;
    const candidate = rawCandidate ? toUnifiedPatchFromRecordDiff(record, rawCandidate) : null;
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    if (candidate.length > MAX_INLINE_PATCH_CHARS) {
      seen.add(candidate);
      continue;
    }
    if (!looksLikeUnifiedDiff(candidate)) {
      continue;
    }
    seen.add(candidate);
    patches.push(candidate);
  }
  if (!includeNested) {
    return;
  }
  for (const nestedKey of ["item", "result", "input", "data", "changes", "files", "edits"]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectPatchStrings(record[nestedKey], patches, seen, depth + 1, includeNested);
    if (patches.length >= MAX_PATCH_STRINGS) {
      return;
    }
  }
}

function extractToolPatch(payload: Record<string, unknown> | null): string | null {
  const patches: string[] = [];
  const seen = new Set<string>();
  if (payload) {
    collectPatchStrings(payload, patches, seen, 0, false);
  }
  const data = asRecord(payload?.data);
  // Keep traversal bounded; provider payloads can nest raw tool data deeply.
  collectPatchStrings(data, patches, seen, 0);
  return patches.length > 0 ? patches.join("\n\n") : null;
}

function extractWorkLogItemType(
  payload: Record<string, unknown> | null,
): ToolLifecycleItemType | undefined {
  if (typeof payload?.itemType === "string" && isToolLifecycleItemType(payload.itemType)) {
    return payload.itemType;
  }
  return undefined;
}

function extractWorkLogRequestKind(
  payload: Record<string, unknown> | null,
): WorkLogRequestKind | undefined {
  if (
    payload?.requestKind === "command" ||
    payload?.requestKind === "file-read" ||
    payload?.requestKind === "file-change"
  ) {
    return payload.requestKind;
  }
  return requestKindFromRequestType(payload?.requestType) ?? undefined;
}

function pushChangedFile(target: string[], seen: Set<string>, value: unknown) {
  const normalized = asTrimmedString(value);
  if (!normalized || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  target.push(normalized);
}

function collectChangedFiles(value: unknown, target: string[], seen: Set<string>, depth: number) {
  if (depth > 4 || target.length >= 12) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectChangedFiles(entry, target, seen, depth + 1);
      if (target.length >= 12) {
        return;
      }
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  pushChangedFile(target, seen, record.path);
  pushChangedFile(target, seen, record.filePath);
  pushChangedFile(target, seen, record.relativePath);
  pushChangedFile(target, seen, record.filename);
  pushChangedFile(target, seen, record.newPath);
  pushChangedFile(target, seen, record.oldPath);

  for (const nestedKey of [
    "item",
    "result",
    "input",
    "data",
    "changes",
    "files",
    "edits",
    "patch",
    "patches",
    "operations",
  ]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectChangedFiles(record[nestedKey], target, seen, depth + 1);
    if (target.length >= 12) {
      return;
    }
  }
}

function extractChangedFiles(payload: Record<string, unknown> | null): string[] {
  const changedFiles: string[] = [];
  const seen = new Set<string>();
  collectChangedFiles(asRecord(payload?.data), changedFiles, seen, 0);
  return changedFiles;
}
