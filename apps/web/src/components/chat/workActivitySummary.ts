import { type WorkLogEntry } from "../../session-logic";
import { type TimelineActivityEntry } from "./MessagesTimeline.logic";

export type WorkActivityCategory =
  | "search"
  | "file"
  | "edit"
  | "command"
  | "tool"
  | "info"
  | "error";

export interface WorkActivitySummaryItem {
  id: string;
  label: string;
  title?: string;
  debugText?: string;
  turnId?: WorkLogEntry["turnId"];
  changedFilePath?: string;
}

export interface WorkActivitySummary {
  id: string;
  category: WorkActivityCategory;
  label: string;
  items: ReadonlyArray<WorkActivitySummaryItem>;
  debugText?: string;
}

export type WorkActivityDisplayEntry =
  | {
      kind: "assistant-message";
      id: string;
      entry: Extract<TimelineActivityEntry, { kind: "assistant-message" }>;
    }
  | {
      kind: "work-summary";
      id: string;
      summary: WorkActivitySummary;
    };

interface ClassifiedWorkEntry {
  category: WorkActivityCategory;
  entry: WorkLogEntry;
  item: WorkActivitySummaryItem;
  workspaceRoot: string | undefined;
}

export function deriveWorkActivityDisplayEntries(
  entries: ReadonlyArray<TimelineActivityEntry>,
  workspaceRoot: string | undefined,
): WorkActivityDisplayEntry[] {
  const displayEntries: WorkActivityDisplayEntry[] = [];
  let pendingWorkEntries: WorkLogEntry[] = [];

  const flushWorkEntries = () => {
    if (pendingWorkEntries.length === 0) {
      return;
    }
    for (const summary of summarizeWorkActivityEntries(pendingWorkEntries, workspaceRoot)) {
      displayEntries.push({
        kind: "work-summary",
        id: `work-summary:${summary.id}`,
        summary,
      });
    }
    pendingWorkEntries = [];
  };

  for (const entry of entries) {
    if (entry.kind === "assistant-message") {
      flushWorkEntries();
      displayEntries.push({
        kind: "assistant-message",
        id: `assistant-message:${entry.id}`,
        entry,
      });
      continue;
    }
    pendingWorkEntries.push(entry.workEntry);
  }

  flushWorkEntries();
  return displayEntries;
}

export function summarizeWorkActivityEntries(
  entries: ReadonlyArray<WorkLogEntry>,
  workspaceRoot: string | undefined,
): WorkActivitySummary[] {
  const classifiedEntries = entries.map((entry) => classifyWorkEntry(entry, workspaceRoot));
  const summaries: WorkActivitySummary[] = [];
  let pending: ClassifiedWorkEntry[] = [];

  const flush = () => {
    if (pending.length === 0) {
      return;
    }
    summaries.push(buildSummary(pending));
    pending = [];
  };

  for (const entry of classifiedEntries) {
    const previous = pending.at(-1);
    if (previous && previous.category !== entry.category) {
      flush();
    }
    pending.push(entry);
  }

  flush();
  return summaries;
}

function classifyWorkEntry(
  entry: WorkLogEntry,
  workspaceRoot: string | undefined,
): ClassifiedWorkEntry {
  const category = resolveWorkCategory(entry);
  return {
    category,
    entry,
    item: buildSummaryItem(entry, category, workspaceRoot),
    workspaceRoot,
  };
}

function resolveWorkCategory(entry: WorkLogEntry): WorkActivityCategory {
  if (entry.tone === "error") {
    return "error";
  }
  if (entry.requestKind === "file-change" || entry.itemType === "file_change") {
    return "edit";
  }
  if ((entry.changedFiles?.length ?? 0) > 0 && !entry.command) {
    return "edit";
  }
  if (entry.itemType === "web_search" || isSearchCommand(entry)) {
    return "search";
  }
  if (
    entry.requestKind === "file-read" ||
    entry.itemType === "image_view" ||
    isFileExploreCommand(entry)
  ) {
    return "file";
  }
  if (
    commandText(entry) &&
    (entry.requestKind === "command" || entry.itemType === "command_execution" || entry.command)
  ) {
    return "command";
  }
  if (
    entry.itemType === "mcp_tool_call" ||
    entry.itemType === "dynamic_tool_call" ||
    entry.itemType === "collab_agent_tool_call"
  ) {
    return "tool";
  }
  return entry.tone === "info" ? "info" : "tool";
}

function buildSummary(pending: ReadonlyArray<ClassifiedWorkEntry>): WorkActivitySummary {
  const first = pending[0]!;
  const items = pending.flatMap((entry) => expandSummaryItems(entry));
  return {
    id: `${first.category}:${first.entry.id}`,
    category: first.category,
    label: summaryLabel(first.category, items.length),
    items,
    debugText: buildSummaryDebugText(first.category, pending),
  };
}

function expandSummaryItems(entry: ClassifiedWorkEntry): WorkActivitySummaryItem[] {
  if (entry.category !== "edit" || (entry.entry.changedFiles?.length ?? 0) <= 1) {
    return [entry.item];
  }

  const title = rawEntryTitle(entry.entry);
  const debugText = workEntryDebugText(entry.entry, entry.category);
  return entry.entry.changedFiles!.map((filePath, index) => ({
    id: `${entry.entry.id}:changed-file:${index}`,
    label: `${editVerb(entry.entry)} ${displayPath(filePath, entry.workspaceRoot)}`,
    turnId: entry.entry.turnId,
    changedFilePath: displayPath(filePath, entry.workspaceRoot),
    ...(title ? { title } : {}),
    debugText,
  }));
}

function summaryLabel(category: WorkActivityCategory, count: number): string {
  switch (category) {
    case "search":
      return `Explored ${formatCount(count, "search", "searches")}`;
    case "file":
      return `Explored ${formatCount(count, "file")}`;
    case "edit":
      return `Edited ${formatCount(count, "file")}`;
    case "command":
      return `Ran ${formatCount(count, "command")}`;
    case "tool":
      return `Used ${formatCount(count, "tool")}`;
    case "info":
      return `Noted ${formatCount(count, "update")}`;
    case "error":
      return `Encountered ${formatCount(count, "error")}`;
  }
}

function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  const safeCount = Math.max(1, count);
  return `${safeCount.toLocaleString()} ${safeCount === 1 ? singular : plural}`;
}

function buildSummaryItem(
  entry: WorkLogEntry,
  category: WorkActivityCategory,
  workspaceRoot: string | undefined,
): WorkActivitySummaryItem {
  const title = rawEntryTitle(entry);
  const label = itemLabel(entry, category, workspaceRoot);
  return {
    id: entry.id,
    label,
    ...(category === "edit" && entry.turnId ? { turnId: entry.turnId } : {}),
    ...(category === "edit" && entry.changedFiles?.length === 1
      ? { changedFilePath: displayPath(entry.changedFiles[0]!, workspaceRoot) }
      : {}),
    ...(title && title !== label ? { title } : {}),
    debugText: workEntryDebugText(entry, category),
  };
}

function itemLabel(
  entry: WorkLogEntry,
  category: WorkActivityCategory,
  workspaceRoot: string | undefined,
): string {
  switch (category) {
    case "search":
      return `Searched for ${extractSearchQuery(entry) ?? compactEntryLabel(entry)}`;
    case "file":
      return fileExploreLabel(entry, workspaceRoot);
    case "edit":
      return editLabel(entry, workspaceRoot);
    case "command":
      return `Ran ${compactCommandLabel(entry)}`;
    case "tool":
      return compactEntryLabel(entry);
    case "info":
      return compactEntryLabel(entry);
    case "error":
      return compactEntryLabel(entry);
  }
}

function fileExploreLabel(entry: WorkLogEntry, workspaceRoot: string | undefined): string {
  const command = commandTokens(entry);
  const executable = commandExecutable(command);
  const pathFromCommand = extractFilePathFromCommand(command);
  const pathFromEntry =
    pathFromCommand ?? extractPathLikeText(entry.detail) ?? extractPathLikeText(entry.label);

  if (executable === "pwd") {
    return "Checked current directory";
  }
  if (executable === "ls" && !pathFromCommand) {
    return "Listed current directory";
  }
  if (executable === "rg" && command.includes("--files") && !pathFromCommand) {
    return "Listed files";
  }
  if (executable === "find" && !pathFromCommand) {
    return "Listed files";
  }

  const display = pathFromEntry
    ? displayPath(pathFromEntry, workspaceRoot)
    : compactEntryLabel(entry);

  if (executable === "ls" || executable === "find") {
    return `Listed ${display}`;
  }
  if (executable === "rg" && command.includes("--files")) {
    return `Listed ${display}`;
  }
  if (entry.itemType === "image_view") {
    return `Viewed ${display}`;
  }
  return `Read ${display}`;
}

function editLabel(entry: WorkLogEntry, workspaceRoot: string | undefined): string {
  const changedFiles = entry.changedFiles ?? [];
  const verb = editVerb(entry);
  if (changedFiles.length === 1) {
    return `${verb} ${displayPath(changedFiles[0]!, workspaceRoot)}`;
  }
  if (changedFiles.length > 1) {
    return `${verb} ${displayPath(changedFiles[0]!, workspaceRoot)} +${changedFiles.length - 1} more`;
  }
  return `${verb} ${compactEntryLabel(entry)}`;
}

function editVerb(entry: WorkLogEntry): "Created" | "Deleted" | "Edited" {
  const source = [entry.label, entry.toolTitle, entry.detail, entry.command, entry.rawCommand]
    .filter(Boolean)
    .join("\n");
  if (/\b(?:created|create|added|add)\b/i.test(source)) {
    return "Created";
  }
  if (/\b(?:deleted|delete|removed|remove)\b/i.test(source)) {
    return "Deleted";
  }
  return "Edited";
}

function compactCommandLabel(entry: WorkLogEntry): string {
  const command = commandText(entry);
  if (!command) {
    return compactEntryLabel(entry);
  }
  const tokens = commandTokens(entry);
  const executable = commandExecutable(tokens);
  if (!executable) {
    return compact(command);
  }
  const executableIndex = commandExecutableIndex(tokens);
  if (
    executable === "pnpm" ||
    executable === "bun" ||
    executable === "npm" ||
    executable === "yarn"
  ) {
    return compact(tokens.slice(executableIndex).join(" "));
  }
  if (executable === "vp") {
    return compact(tokens.slice(executableIndex).join(" "));
  }
  return compact(command);
}

function compactEntryLabel(entry: WorkLogEntry): string {
  const label = entry.toolTitle ?? entry.detail ?? entry.command ?? entry.label;
  if (/^tool updated$/iu.test(label.trim())) {
    return "Updated tool";
  }
  return compact(label);
}

function rawEntryTitle(entry: WorkLogEntry): string | null {
  return entry.rawCommand ?? entry.command ?? entry.detail ?? null;
}

function buildSummaryDebugText(
  category: WorkActivityCategory,
  entries: ReadonlyArray<ClassifiedWorkEntry>,
): string {
  return [
    `category: ${category}`,
    `entries: ${entries.length}`,
    ...entries.map((entry, index) => {
      const debugText = workEntryDebugText(entry.entry, entry.category);
      return `\n[${index + 1}]\n${debugText}`;
    }),
  ].join("\n");
}

function workEntryDebugText(entry: WorkLogEntry, category: WorkActivityCategory): string {
  const lines = [
    `category: ${category}`,
    `id: ${entry.id}`,
    `label: ${entry.label}`,
    `tone: ${entry.tone}`,
  ];
  if (entry.toolTitle) {
    lines.push(`toolTitle: ${entry.toolTitle}`);
  }
  if (entry.itemType) {
    lines.push(`itemType: ${entry.itemType}`);
  }
  if (entry.requestKind) {
    lines.push(`requestKind: ${entry.requestKind}`);
  }
  if (entry.command) {
    lines.push(`command: ${entry.command}`);
  }
  if (entry.rawCommand) {
    lines.push(`rawCommand: ${entry.rawCommand}`);
  }
  if (entry.detail) {
    lines.push(`detail: ${entry.detail}`);
  }
  if ((entry.changedFiles?.length ?? 0) > 0) {
    lines.push(
      `changedFiles:\n${entry.changedFiles!.map((filePath) => `- ${filePath}`).join("\n")}`,
    );
  }
  return lines.join("\n");
}

function commandText(entry: Pick<WorkLogEntry, "rawCommand" | "command">): string | null {
  return entry.rawCommand?.trim() || entry.command?.trim() || null;
}

function isSearchCommand(entry: WorkLogEntry): boolean {
  const tokens = commandTokens(entry);
  const executable = commandExecutable(tokens);
  if (!executable) {
    return /\b(search|searched|web_search)\b/i.test(`${entry.toolTitle ?? ""} ${entry.label}`);
  }
  if (executable === "rg" && tokens.includes("--files")) {
    return false;
  }
  return executable === "rg" || executable === "grep" || executable === "ag";
}

function isFileExploreCommand(entry: WorkLogEntry): boolean {
  const tokens = commandTokens(entry);
  const executable = commandExecutable(tokens);
  if (!executable) {
    return /\b(read|opened|viewed|listed)\b/i.test(`${entry.toolTitle ?? ""} ${entry.label}`);
  }
  return (
    (executable === "rg" && tokens.includes("--files")) ||
    ["cat", "sed", "nl", "head", "tail", "less", "find", "ls", "wc", "pwd", "tree"].includes(
      executable,
    )
  );
}

function extractSearchQuery(entry: WorkLogEntry): string | null {
  const tokens = commandTokens(entry);
  const executableIndex = commandExecutableIndex(tokens);
  if (executableIndex === -1) {
    return compactSearchText(entry.detail ?? entry.command ?? entry.label);
  }

  for (let index = executableIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--") {
      continue;
    }
    if (isFlagWithValue(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    return compactSearchText(token);
  }

  return compactSearchText(entry.detail ?? entry.command ?? entry.label);
}

function compactSearchText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }
  return compact(normalized, 96);
}

function extractFilePathFromCommand(tokens: ReadonlyArray<string>): string | null {
  const executable = commandExecutable(tokens);
  if (!executable) {
    return null;
  }
  const pipeIndex = tokens.indexOf("|");
  const endIndex = pipeIndex === -1 ? tokens.length : pipeIndex;
  const fileTokens: string[] = [];
  const commandArgs = tokens.slice(commandExecutableIndex(tokens) + 1, endIndex);
  for (let index = 0; index < commandArgs.length; index += 1) {
    const token = commandArgs[index]!;
    if (isFlagWithValue(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-") || isLikelySearchPattern(token) || isLikelyRangeExpression(token)) {
      continue;
    }
    fileTokens.push(token);
  }
  return fileTokens.findLast(looksLikePath) ?? null;
}

function extractPathLikeText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }
  const [firstLine] = normalized.split(/\r?\n/u);
  if (!firstLine) {
    return null;
  }
  const withoutPrefix = firstLine.replace(/^(?:read|opened|viewed|listed)\s+/i, "").trim();
  return looksLikePath(withoutPrefix) ? withoutPrefix : null;
}

function commandExecutable(tokens: ReadonlyArray<string>): string | null {
  const index = commandExecutableIndex(tokens);
  return index === -1 ? null : basename(tokens[index]!).toLowerCase();
}

function commandExecutableIndex(tokens: ReadonlyArray<string>): number {
  return tokens.findIndex((token) => !isEnvironmentAssignment(token) && token !== "env");
}

function isEnvironmentAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function commandTokens(entry: Pick<WorkLogEntry, "rawCommand" | "command">): string[] {
  return normalizeShellTokens(shellTokens(commandText(entry) ?? ""));
}

function normalizeShellTokens(tokens: string[]): string[] {
  if (tokens.length === 0) {
    return tokens;
  }

  const controlIndex = tokens.findLastIndex(
    (token) => token === "&&" || token === "||" || token === ";",
  );
  if (controlIndex !== -1 && controlIndex < tokens.length - 1) {
    return normalizeShellTokens(tokens.slice(controlIndex + 1));
  }

  const executableIndex = commandExecutableIndex(tokens);
  if (executableIndex === -1) {
    return tokens;
  }

  const executable = basename(tokens[executableIndex]!).toLowerCase();
  if (executable !== "sh" && executable !== "bash" && executable !== "zsh") {
    return tokens;
  }

  for (let index = executableIndex + 1; index < tokens.length - 1; index += 1) {
    const token = tokens[index]!;
    if (token === "-c" || token === "-lc" || token === "-ilc") {
      return normalizeShellTokens(shellTokens(tokens[index + 1]!));
    }
  }

  return tokens;
}

function basename(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

function isFlagWithValue(token: string): boolean {
  return [
    "-e",
    "-f",
    "-g",
    "--glob",
    "--type",
    "--context",
    "--before-context",
    "--after-context",
  ].includes(token);
}

function isLikelySearchPattern(token: string): boolean {
  return token.includes("|") || token.includes("*") || token.includes("[") || token.includes("(");
}

function isLikelyRangeExpression(token: string): boolean {
  return /^(?:\d+)?(?:,\d+)?p?$/u.test(token);
}

function looksLikePath(value: string): boolean {
  const trimmed = trimOuterQuotes(value);
  if (trimmed === "." || trimmed === "..") {
    return true;
  }
  return trimmed.includes("/") || trimmed.includes("\\") || /\.[A-Za-z0-9][^/\s]*$/u.test(trimmed);
}

function displayPath(value: string, workspaceRoot: string | undefined): string {
  const normalizedPath = trimOuterQuotes(value).replaceAll("\\", "/");
  if (!workspaceRoot) {
    return stripRelativePrefixes(normalizedPath);
  }

  const normalizedWorkspaceRoot = workspaceRoot.replaceAll("\\", "/").replace(/\/+$/u, "");
  const pathForCompare = normalizedPath.toLowerCase();
  const workspaceForCompare = normalizedWorkspaceRoot.toLowerCase();
  if (pathForCompare === workspaceForCompare) {
    return ".";
  }
  if (pathForCompare.startsWith(`${workspaceForCompare}/`)) {
    return normalizedPath.slice(normalizedWorkspaceRoot.length + 1);
  }
  return stripRelativePrefixes(normalizedPath);
}

function compact(value: string, maxLength = 110): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function trimOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function stripRelativePrefixes(value: string): string {
  return value.replace(/^\.\/+/u, "").replace(/^\/+/u, "");
}

function shellTokens(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}
