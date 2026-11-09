import type { ToolLifecycleItemType } from "@t3tools/contracts";

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

export function claudeSkillInvocation(
  toolName: string | null | undefined,
  input: unknown,
): { readonly name: string; readonly args: string | undefined } | undefined {
  if (toolName !== "Skill") return undefined;
  const record = asRecord(input);
  const name = asTrimmedString(record?.skill);
  return name === undefined ? undefined : { name, args: asTrimmedString(record?.args) };
}

export function isJavaScriptReplTool(toolName: string | null | undefined): boolean {
  return toolName === "js" || toolName === "cua_repl.js" || toolName === "node_repl.js";
}

export const COMPUTER_USE_TOOL_SOURCE = {
  key: "computer-use",
  name: "Computer Use",
  kind: "computer",
} as const;

/**
 * Screen-control tools that computer-use MCP servers expose. Compared after separators and case
 * are stripped, so `computer_click`, `computer.click`, and `ComputerClick` all match.
 */
const COMPUTER_USE_TOOL_TOKENS = new Set([
  "computer",
  "computeruse",
  "cua",
  "screenshot",
  "takescreenshot",
  "capturescreen",
  "capturescreenshot",
  "screencapture",
]);

function computerUseToolToken(toolName: string | null | undefined): string | undefined {
  const trimmed = asTrimmedString(toolName);
  if (!trimmed) {
    return undefined;
  }
  // Harnesses namespace MCP tools as `mcp__server__tool`; the action is the last segment.
  const leaf = trimmed.includes("__") ? trimmed.slice(trimmed.lastIndexOf("__") + 2) : trimmed;
  const token = toolNameToken(leaf);
  if (token) {
    return token;
  }
  return leaf === trimmed ? undefined : toolNameToken(trimmed);
}

/** A computer-use MCP server's namespace, e.g. `mcp__computer-use__left_click`. */
const COMPUTER_USE_SERVER = /(?:^|[^a-z])(?:computer[-_ ]?use|cua)(?:[^a-z]|$)/iu;

function isComputerUseToolName(toolName: string | null | undefined): boolean {
  const token = computerUseToolToken(toolName);
  if (token !== undefined) {
    if (COMPUTER_USE_TOOL_TOKENS.has(token)) {
      return true;
    }
    if (token.startsWith("computer") || (token.startsWith("cua") && token.length > "cua".length)) {
      return true;
    }
  }
  const trimmed = asTrimmedString(toolName);
  return trimmed !== undefined && COMPUTER_USE_SERVER.test(trimmed);
}

export function dynamicToolSurface(toolName: string | null | undefined, input: unknown) {
  if (toolName === "cua_repl.js") return "computer" as const;
  const code = asRecord(input)?.code;
  if (
    isJavaScriptReplTool(toolName) &&
    typeof code === "string" &&
    (/\bsky\s*\./u.test(code) || /["']@oai\/sky["']/u.test(code))
  ) {
    return "computer" as const;
  }
  return isComputerUseToolName(toolName) ? ("computer" as const) : undefined;
}

function roundedNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined;
}

/** Screen coordinates from the shapes computer-use servers accept: a pair or a named point. */
function computerUsePoint(input: unknown): string | undefined {
  const record = asRecord(input);
  if (!record) {
    return undefined;
  }
  const pair = [record.coordinate, record.position, record.point].find(Array.isArray);
  const nested =
    [record.coordinate, record.position, record.point, record.to]
      .map(asRecord)
      .find(recordHasKeys) ?? record;
  const x = roundedNumber(nested.x) ?? (pair ? roundedNumber(pair[0]) : undefined);
  const y = roundedNumber(nested.y) ?? (pair ? roundedNumber(pair[1]) : undefined);
  return x === undefined || y === undefined ? undefined : `${x}, ${y}`;
}

function shortTypedText(input: unknown): string | undefined {
  const text = asTrimmedString(asRecord(input)?.text);
  if (!text) {
    return undefined;
  }
  const singleLine = text.replace(/\s+/gu, " ");
  return `“${singleLine.length > 40 ? `${singleLine.slice(0, 40)}…` : singleLine}”`;
}

/** Longest match first, so `doubleclick` wins over `click`. */
const COMPUTER_USE_VERBS: ReadonlyArray<readonly [string, string]> = [
  ["doubleclick", "Double-clicked"],
  ["rightclick", "Right-clicked"],
  ["screenshot", "Viewed the screen"],
  ["capture", "Viewed the screen"],
  ["scroll", "Scrolled"],
  ["launch", "Opened"],
  ["click", "Clicked"],
  ["press", "Pressed"],
  ["write", "Typed"],
  ["focus", "Focused"],
  ["move", "Moved to"],
  ["drag", "Dragged to"],
  ["type", "Typed"],
  ["open", "Opened"],
  ["zoom", "Zoomed"],
  ["wait", "Waited"],
  ["key", "Pressed"],
];

/**
 * A short sentence for what a screen-control tool call did, so computer-use rows read as actions
 * rather than raw argument JSON.
 */
export function computerUseActionLabel(
  toolName: string | null | undefined,
  input: unknown,
): string | undefined {
  if (!isComputerUseToolName(toolName)) {
    return undefined;
  }
  const token = computerUseToolToken(toolName);
  if (token === undefined) {
    return undefined;
  }
  const verb = COMPUTER_USE_VERBS.find(([needle]) => token.includes(needle))?.[1];
  if (verb === undefined) {
    return "Used the computer";
  }
  const point = computerUsePoint(input);
  if (verb === "Typed") {
    return [verb, shortTypedText(input)].filter(Boolean).join(" ");
  }
  if (verb === "Pressed") {
    return [verb, asTrimmedString(asRecord(input)?.key)].filter(Boolean).join(" ");
  }
  return point === undefined ? verb : `${verb} ${point}`;
}

export function dynamicToolTitle(
  toolName: string | null | undefined,
  input: unknown,
  retainedTitle?: string | null,
): string | undefined {
  if (isJavaScriptReplTool(toolName)) {
    const title = asTrimmedString(retainedTitle);
    const meaningfulTitle =
      title && title.toLowerCase() !== "js" && title.toLowerCase() !== toolName?.toLowerCase()
        ? title
        : undefined;
    return (
      asTrimmedString(asRecord(input)?.title) ??
      meaningfulTitle ??
      (dynamicToolSurface(toolName, input) === "computer" ? "Computer use" : "Run JavaScript")
    );
  }
  const skill = claudeSkillInvocation(toolName, input);
  return skill === undefined ? undefined : `Skill: ${skill.name}`;
}

function recordHasKeys(
  value: Record<string, unknown> | undefined,
): value is Record<string, unknown> {
  return value !== undefined && Object.keys(value).length > 0;
}

function normalizeCommandValue(value: unknown): string | undefined {
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const entry of value) {
    const part = asTrimmedString(entry);
    if (part !== undefined) {
      parts.push(part);
    }
  }
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

function extractToolCommand(data: Record<string, unknown> | undefined, title: string | undefined) {
  const item = asRecord(data?.item);
  const itemInput = asRecord(item?.input);
  const itemResult = asRecord(item?.result);
  const rawInput = asRecord(data?.rawInput);
  const candidates = [
    normalizeCommandValue(item?.command),
    normalizeCommandValue(itemInput?.command),
    normalizeCommandValue(itemResult?.command),
    normalizeCommandValue(data?.command),
    normalizeCommandValue(rawInput?.command),
  ];
  const direct = candidates.find((candidate) => candidate !== undefined);
  if (direct) {
    return direct;
  }
  const executable = asTrimmedString(rawInput?.executable);
  const args = normalizeCommandValue(rawInput?.args);
  if (executable && args) {
    return `${executable} ${args}`;
  }
  if (executable) {
    return executable;
  }
  return extractCommandFromTitle(title);
}

const PATH_KEYS = [
  "path",
  "filePath",
  "file_path",
  "relativePath",
  "filename",
  "fileName",
  "newPath",
  "oldPath",
] as const;

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
  for (const key of PATH_KEYS) {
    const candidate = asTrimmedString(record[key]);
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

export function collectToolFilePaths(data: unknown): string[] {
  const paths: string[] = [];
  collectPaths(data, paths, new Set<string>(), 0);
  return paths;
}

function extractPrimaryPath(data: Record<string, unknown> | undefined): string | undefined {
  return collectToolFilePaths(data)[0];
}

/** Preserve the first nonempty rawInput; later ACP updates often resend an empty object. */
export function mergeToolActivityData(
  previous: unknown,
  next: unknown,
): Record<string, unknown> | undefined {
  const previousRecord = asRecord(previous);
  const nextRecord = asRecord(next);
  if (!nextRecord) {
    return previousRecord;
  }
  if (!previousRecord) {
    return nextRecord;
  }
  const previousInput = asRecord(previousRecord.rawInput);
  const nextInput = asRecord(nextRecord.rawInput);
  const rawInput = recordHasKeys(nextInput)
    ? { ...previousInput, ...nextInput }
    : (previousInput ?? nextInput);
  const merged = { ...previousRecord, ...nextRecord };
  if (recordHasKeys(rawInput)) {
    merged.rawInput = rawInput;
  } else {
    delete merged.rawInput;
  }
  return merged;
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

export type ToolActivityAction = "command" | "read" | "file_change" | "search" | "other";

function toolNameToken(value: string | undefined): string | undefined {
  const trimmed = asTrimmedString(value);
  if (!trimmed || /__|[./]/u.test(trimmed)) {
    return undefined;
  }
  return trimmed.replace(/[_\s-]/gu, "").toLowerCase();
}

export function classifyToolActivity(input: {
  readonly itemType?: ToolLifecycleItemType | string | null | undefined;
  readonly requestKind?: string | null | undefined;
  readonly title?: string | undefined;
  readonly data?: Record<string, unknown> | undefined;
}): ToolActivityAction {
  const itemType = input.itemType ?? undefined;
  const requestKind = asTrimmedString(input.requestKind)?.toLowerCase();
  const kind = asTrimmedString(input.data?.kind)?.toLowerCase();
  const toolName = toolNameToken(
    asTrimmedString(input.data?.toolName) ?? asTrimmedString(asRecord(input.data?.item)?.tool),
  );

  if (itemType === "command_execution") {
    return "command";
  }
  if (itemType === "image_view") {
    return "read";
  }
  if (itemType === "file_change") {
    return "file_change";
  }
  if (itemType === "web_search") {
    return "search";
  }
  if (requestKind === "command" || kind === "execute") {
    return "command";
  }
  if (
    requestKind === "file-change" ||
    kind === "edit" ||
    kind === "move" ||
    kind === "delete" ||
    kind === "write"
  ) {
    return "file_change";
  }
  if (
    kind === "search" ||
    toolName === "find" ||
    toolName === "grep" ||
    toolName === "glob" ||
    toolName === "rg" ||
    toolName === "ls"
  ) {
    return "search";
  }
  if (requestKind === "file-read" || kind === "read") {
    return "read";
  }
  if (toolName === "terminal" || toolName === "bash" || toolName === "shell") {
    return "command";
  }
  if (toolName === "read" || toolName === "readfile") {
    return "read";
  }
  return "other";
}

const SEARCH_QUERY_KEYS = ["pattern", "query", "searchTerm", "regex", "grep", "needle"] as const;
const SEARCH_GLOB_KEYS = [
  "glob",
  "globPattern",
  "glob_pattern",
  "include",
  "filePattern",
  "file_pattern",
] as const;
const SEARCH_TARGET_KEYS = [
  "path",
  "target_directory",
  "targetDirectory",
  "directory",
  "cwd",
  "root",
] as const;

function firstInputString(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = asTrimmedString(record[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function searchInputRecord(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return (
    [data?.rawInput, data?.input, asRecord(data?.item)?.input]
      .map(asRecord)
      .find((record) => recordHasKeys(record ?? undefined)) ?? data
  );
}

function searchTargetName(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.split(/[\\/]/u).findLast((part) => part.length > 0 && part !== ".");
}

export function formatSearchToolLabel(
  data: Record<string, unknown> | undefined,
): string | undefined {
  const input = searchInputRecord(data);
  const query = firstInputString(input, SEARCH_QUERY_KEYS);
  const glob = firstInputString(input, SEARCH_GLOB_KEYS);
  const target = searchTargetName(firstInputString(input, SEARCH_TARGET_KEYS));
  if (query && target) {
    return `Searched ${query} in ${target}`;
  }
  if (glob && target) {
    return `Searched files ${glob} in ${target}`;
  }
  if (glob) {
    return `Searched files ${glob}`;
  }
  if (query) {
    return `Searched ${query}`;
  }
  if (target) {
    return `Searched in ${target}`;
  }
  return undefined;
}

export function formatReadToolLabel(path: string, extraCount = 0): string {
  const trimmed = path.trim();
  const suffix = extraCount > 0 ? ` +${extraCount} more` : "";
  if (!trimmed) {
    return `Read file${suffix}`;
  }
  return `Read ${trimmed}${suffix}`;
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
  const action = classifyToolActivity({
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
        summary: formatReadToolLabel(primaryPath),
      };
    }
    return {
      summary: "Read file",
    };
  }

  if (action === "file_change") {
    return {
      summary: "Changed files",
      ...(primaryPath ? { detail: primaryPath } : {}),
    };
  }

  if (action === "search") {
    const searchLabel = formatSearchToolLabel(data);
    if (searchLabel) {
      return { summary: searchLabel };
    }
    return {
      summary: "Searched files",
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
