import type { ToolLifecycleItemType } from "@t3tools/contracts";
import {
  extractNormalizedChangedFilePathsFromToolPayload,
  normalizeChangedFilePath,
} from "./toolChangedFiles.ts";

type FileChangeOperation = "edit" | "create" | "delete" | "rename" | "mixed";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeCommandValue(value: unknown): string | undefined {
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value
    .map((entry) => asTrimmedString(entry))
    .filter((entry): entry is string => entry !== undefined);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function stripTrailingExitCode(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const match = /^(?<output>[\s\S]*?)(?:\s*<exited with exit code \d+>)\s*$/iu.exec(trimmed);
  const output = match?.groups?.output?.trim() ?? trimmed;
  return output.length > 0 ? output : undefined;
}

function extractCommandFromTitle(title: string | undefined): string | undefined {
  if (!title) {
    return undefined;
  }
  const backtickMatch = /`([^`]+)`/u.exec(title);
  return backtickMatch?.[1]?.trim() || undefined;
}

export function extractToolCommandInput(
  data: Record<string, unknown> | undefined,
): string | unknown[] | undefined {
  const item = asRecord(data?.item);
  const itemInput = asRecord(item?.input);
  const itemResult = asRecord(item?.result);
  const rawInput = asRecord(data?.rawInput);
  const input = asRecord(data?.input);
  const stateInput = asRecord(asRecord(data?.state)?.input);
  const candidates = [
    item?.command,
    itemInput?.command,
    itemResult?.command,
    data?.command,
    rawInput?.command,
    input?.command,
    stateInput?.command,
  ];
  for (const candidate of candidates) {
    if (
      (typeof candidate === "string" || Array.isArray(candidate)) &&
      normalizeCommandValue(candidate)
    )
      return candidate;
  }
  const executable = asTrimmedString(rawInput?.executable);
  const args = normalizeCommandValue(rawInput?.args);
  if (executable && args) {
    return `${executable} ${args}`;
  }
  if (executable) {
    return executable;
  }
  return undefined;
}

function extractToolCommand(data: Record<string, unknown> | undefined, title: string | undefined) {
  return normalizeCommandValue(extractToolCommandInput(data)) ?? extractCommandFromTitle(title);
}

function maybePathLike(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (
    value.includes("/") ||
    value.includes("\\") ||
    value.startsWith(".") ||
    /\.(?:[a-z0-9]{1,12})$/iu.test(value)
  ) {
    return value;
  }
  return undefined;
}

function collectPaths(value: unknown, paths: string[], seen: Set<string>, depth: number): void {
  if (depth > 4 || paths.length >= 8) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectPaths(entry, paths, seen, depth + 1);
      if (paths.length >= 8) {
        return;
      }
    }
    return;
  }
  const record = asRecord(value);
  if (!record) {
    return;
  }
  for (const key of ["path", "filePath", "relativePath", "filename", "newPath", "oldPath"]) {
    const candidate = maybePathLike(asTrimmedString(record[key]));
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    paths.push(candidate);
    if (paths.length >= 8) {
      return;
    }
  }
  for (const nestedKey of ["locations", "item", "input", "result", "rawInput", "data", "changes"]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectPaths(record[nestedKey], paths, seen, depth + 1);
    if (paths.length >= 8) {
      return;
    }
  }
}

function extractPrimaryPath(data: Record<string, unknown> | undefined): string | undefined {
  const paths: string[] = [];
  collectPaths(data, paths, new Set<string>(), 0);
  return paths[0];
}

function normalizeEquivalentValue(value: string | undefined): string | undefined {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    return undefined;
  }
  return trimmed
    .replace(/\s+/gu, " ")
    .replace(/\s+(?:complete|completed|started)\s*$/iu, "")
    .trim();
}

function isEquivalent(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = normalizeEquivalentValue(left)?.toLowerCase();
  const normalizedRight = normalizeEquivalentValue(right)?.toLowerCase();
  return normalizedLeft !== undefined && normalizedLeft === normalizedRight;
}

function collectSearchableText(value: unknown, chunks: string[], depth: number): void {
  if (depth > 4 || chunks.length >= 80) {
    return;
  }
  if (typeof value === "string") {
    chunks.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectSearchableText(entry, chunks, depth + 1);
      if (chunks.length >= 80) return;
    }
    return;
  }
  const record = asRecord(value);
  if (!record) {
    return;
  }
  for (const entry of Object.values(record)) {
    collectSearchableText(entry, chunks, depth + 1);
    if (chunks.length >= 80) return;
  }
}

function inferPatchOperation(text: string): FileChangeOperation | undefined {
  const operations = new Set<FileChangeOperation>();
  if (/^\*\*\*\s+Add\s+File:/gmu.test(text)) operations.add("create");
  if (/^\*\*\*\s+Delete\s+File:/gmu.test(text)) operations.add("delete");
  if (/^\*\*\*\s+(?:Move|Rename)\s+File:/gmu.test(text)) operations.add("rename");
  if (/^\*\*\*\s+Update\s+File:/gmu.test(text)) operations.add("edit");
  if (operations.size === 0) {
    return undefined;
  }
  return operations.size === 1 ? [...operations][0] : "mixed";
}

function inferFileChangeOperation(input: {
  readonly title?: string | undefined;
  readonly data?: Record<string, unknown> | undefined;
}): FileChangeOperation {
  const kind = asTrimmedString(input.data?.kind)?.toLowerCase();
  switch (kind) {
    case "delete":
      return "delete";
    case "move":
      return "rename";
    case "write":
      break;
    case "edit":
      return "edit";
  }

  const chunks: string[] = [];
  collectSearchableText(input.title, chunks, 0);
  collectSearchableText(input.data, chunks, 0);
  const text = chunks.join(" ").toLowerCase();
  const patchOperation = inferPatchOperation(chunks.join("\n"));
  if (patchOperation) {
    return patchOperation;
  }
  if (/\b(?:delete|remove)\b/u.test(text)) return "delete";
  if (/\b(?:move|rename)\b/u.test(text)) return "rename";
  if (/\b(?:create|create_file|add file|new file)\b/u.test(text)) return "create";
  return kind === "write" ? "create" : "edit";
}

function fileNoun(count: number): string {
  return count === 1 ? "file" : "files";
}

function fileChangeVerb(operation: FileChangeOperation): string {
  switch (operation) {
    case "create":
      return "Created";
    case "delete":
      return "Deleted";
    case "rename":
      return "Renamed";
    case "edit":
      return "Edited";
    case "mixed":
      return "Changed";
  }
}

function fileChangeCount(operation: FileChangeOperation, pathCount: number): number {
  if (operation === "rename") {
    return Math.max(1, Math.ceil(pathCount / 2));
  }
  return pathCount;
}

function deriveFileChangeSummary(operation: FileChangeOperation, pathCount: number): string {
  const verb = fileChangeVerb(operation);
  if (pathCount === 0) {
    return `${verb} files`;
  }
  const count = fileChangeCount(operation, pathCount);
  if (operation === "create" || operation === "delete" || operation === "rename") {
    return count === 1 ? `${verb} file` : `${verb} ${count} files`;
  }
  return `${verb} ${count} ${fileNoun(count)}`;
}

function findNormalizedPathByKey(
  value: unknown,
  key: "oldPath" | "newPath",
  depth: number,
): string | undefined {
  if (depth > 4) {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const result = findNormalizedPathByKey(entry, key, depth + 1);
      if (result) return result;
    }
    return undefined;
  }
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const direct = asTrimmedString(record[key]);
  if (direct) {
    const normalized = normalizeChangedFilePath(direct);
    if (normalized) return normalized;
  }
  for (const nestedKey of ["item", "result", "input", "data", "rawInput", "changes", "files"]) {
    const result = findNormalizedPathByKey(record[nestedKey], key, depth + 1);
    if (result) return result;
  }
  return undefined;
}

function deriveFileChangeDetail(
  operation: FileChangeOperation,
  paths: ReadonlyArray<string>,
  fallbackPrimaryPath: string | undefined,
  data: Record<string, unknown> | undefined,
): string | undefined {
  if (operation === "rename" && paths.length >= 2) {
    const oldPath = findNormalizedPathByKey(data, "oldPath", 0) ?? paths[0];
    const newPath = findNormalizedPathByKey(data, "newPath", 0) ?? paths[1];
    const renameCount = fileChangeCount(operation, paths.length);
    return renameCount === 1
      ? `${oldPath} -> ${newPath}`
      : `${oldPath} -> ${newPath} +${renameCount - 1} more`;
  }
  const [firstPath] = paths;
  if (firstPath) {
    return paths.length === 1 ? firstPath : `${firstPath} +${paths.length - 1} more`;
  }
  return fallbackPrimaryPath;
}

function classifyToolAction(input: {
  readonly itemType?: ToolLifecycleItemType | null | undefined;
  readonly title?: string | undefined;
  readonly data?: Record<string, unknown> | undefined;
}): "command" | "read" | "file_change" | "search" | "other" {
  const itemType = input.itemType ?? undefined;
  const kind = asTrimmedString(input.data?.kind)?.toLowerCase();
  const title = asTrimmedString(input.title)?.toLowerCase();
  if (itemType === "command_execution" || kind === "execute" || title === "terminal") {
    return "command";
  }
  if (kind === "read" || title === "read file") {
    return "read";
  }
  if (
    itemType === "file_change" ||
    kind === "edit" ||
    kind === "move" ||
    kind === "delete" ||
    kind === "write"
  ) {
    return "file_change";
  }
  if (itemType === "web_search" || kind === "search" || title === "find" || title === "grep") {
    return "search";
  }
  return "other";
}

export interface ToolActivityPresentationInput {
  readonly itemType?: ToolLifecycleItemType | null | undefined;
  readonly title?: string | null | undefined;
  readonly detail?: string | null | undefined;
  readonly data?: unknown;
  readonly fallbackSummary?: string | null | undefined;
}

export interface ToolActivityPresentation {
  readonly summary: string;
  readonly detail?: string | undefined;
}

export function deriveToolActivityPresentation(
  input: ToolActivityPresentationInput,
): ToolActivityPresentation {
  const title = asTrimmedString(input.title);
  const detail = stripTrailingExitCode(asTrimmedString(input.detail));
  const fallbackSummary = asTrimmedString(input.fallbackSummary) ?? "Tool";
  const data = asRecord(input.data);
  const command = extractToolCommand(data, title);
  const primaryPath = extractPrimaryPath(data);
  const action = classifyToolAction({
    itemType: input.itemType,
    title,
    data,
  });

  if (action === "command") {
    return {
      summary: "Ran command",
      ...(command ? { detail: command } : {}),
    };
  }

  if (action === "read") {
    if (primaryPath) {
      return {
        summary: "Read file",
        detail: primaryPath,
      };
    }
    return {
      summary: "Read file",
    };
  }

  if (action === "file_change") {
    const changedPaths = extractNormalizedChangedFilePathsFromToolPayload(data, {
      maxDepth: 4,
      maxPaths: 12,
    });
    const operation = inferFileChangeOperation({ title, data });
    const detail = deriveFileChangeDetail(operation, changedPaths, primaryPath, data);
    return {
      summary: deriveFileChangeSummary(operation, changedPaths.length),
      ...(detail ? { detail } : {}),
    };
  }

  if (action === "search") {
    const query =
      asTrimmedString(asRecord(data?.rawInput)?.query) ??
      asTrimmedString(asRecord(data?.rawInput)?.pattern) ??
      asTrimmedString(asRecord(data?.rawInput)?.searchTerm);
    return {
      summary: "Searched files",
      ...(query ? { detail: query } : {}),
    };
  }

  if (detail && !isEquivalent(detail, title) && !isEquivalent(detail, fallbackSummary)) {
    return {
      summary: title ?? fallbackSummary,
      detail,
    };
  }

  return {
    summary: title ?? fallbackSummary,
  };
}
