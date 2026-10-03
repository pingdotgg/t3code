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

/** A Claude `Skill` call: the skill it loads and the arguments it passes, if any. */
export function claudeSkillInvocation(
  toolName: string | null | undefined,
  input: unknown,
): { readonly name: string; readonly args: string | undefined } | undefined {
  if (toolName !== "Skill") return undefined;
  const record = asRecord(input);
  const name = asTrimmedString(record?.skill);
  return name === undefined ? undefined : { name, args: asTrimmedString(record?.args) };
}

/**
 * Activity log heading a dynamic tool derives from its input: CUA's `title`,
 * or the skill a Claude `Skill` call loads.
 */
export function dynamicToolTitle(
  toolName: string | null | undefined,
  input: unknown,
): string | undefined {
  if (toolName === "cua_repl.js") return asTrimmedString(asRecord(input)?.title);
  const skill = claudeSkillInvocation(toolName, input);
  return skill === undefined ? undefined : `Skill: ${skill.name}`;
}

/** A Claude `SendMessage` call: who it goes to and what it says. */
export interface ClaudeAgentMessage {
  /** Agent id, session name, `main`, or `*`, as the agent wrote it. */
  readonly to: string | undefined;
  readonly summary: string | undefined;
  readonly message: string | undefined;
  /** One line for a collapsed row: the summary, else the body's first line. */
  readonly preview: string | undefined;
  /** Asks to hear when the recipient goes idle. */
  readonly notifyWhenIdle: boolean;
}

/**
 * Reads a Claude `SendMessage` call. Structured protocol messages (a non-text
 * `message`) and inputs the server summarized for transport are left to the
 * generic tool view.
 */
export function claudeAgentMessage(
  toolName: string | null | undefined,
  input: unknown,
): ClaudeAgentMessage | undefined {
  if (toolName !== "SendMessage") return undefined;
  const record = asRecord(input);
  if (record === undefined) return undefined;
  // The CLI echoes a truncated `content` preview beside `message`; older
  // team messages carried their text in `content` alone.
  const body = record.message ?? record.content;
  if (body !== undefined && typeof body !== "string") return undefined;
  const to =
    record.type === "broadcast"
      ? "*"
      : (asTrimmedString(record.to) ?? asTrimmedString(record.recipient));
  const summary = asTrimmedString(record.summary);
  const message = asTrimmedString(body);
  return {
    to,
    summary,
    message,
    preview:
      summary ??
      // Strip a leading Markdown heading marker; the body renders as Markdown.
      asTrimmedString(message?.split("\n", 1)[0]?.replace(/^#{1,6}\s+/u, "")),
    notifyWhenIdle: record.notify_when_idle === true,
  };
}

/**
 * Whether a tool call is a Claude agent message, including one whose input the
 * server summarized to a string for transport. Structured protocol messages
 * such as shutdown requests are not.
 */
export function isClaudeAgentMessageItem(
  toolName: string | null | undefined,
  input: unknown,
): boolean {
  if (toolName !== "SendMessage") return false;
  return typeof input === "string" || claudeAgentMessage(toolName, input) !== undefined;
}

const CLAUDE_AGENT_ID_PATTERN = /^a[0-9a-f]{16}$/u;

/**
 * Names a `SendMessage` recipient for a heading. Claude's subagent ids are
 * shortened the way Claude Code shortens them; peers addressed by socket
 * path are just another session.
 */
function agentMessageRecipientLabel(to: string): string {
  if (to === "main") return "main agent";
  if (to === "*") return "everyone";
  if (to.startsWith("uds:")) return "another session";
  if (CLAUDE_AGENT_ID_PATTERN.test(to)) return `agent ${to.slice(0, 7)}`;
  // Peers can be addressed as `name [ref]`; the ref only disambiguates.
  return to.replace(/\s*\[[^\]]*\]$/u, "") || to;
}

/**
 * Heading for a Claude `SendMessage` call. The adapter passes the name of the
 * subagent it resolved the recipient to; clients fall back to the raw address.
 */
export function claudeAgentMessageTitle(
  toolName: string | null | undefined,
  input: unknown,
  recipientName?: string,
): string | undefined {
  const message = claudeAgentMessage(toolName, input);
  if (message === undefined) return undefined;
  const recipient =
    recipientName ??
    (message.to === undefined ? undefined : agentMessageRecipientLabel(message.to));
  if (recipient === undefined) return "Message";
  if (message.message === undefined && message.notifyWhenIdle) {
    return `Notify when ${recipient} is idle`;
  }
  return `Message to ${recipient}`;
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

/** Structured paths from tool input, never file-body text. */
export function collectToolFilePaths(data: unknown): string[] {
  const paths: string[] = [];
  collectPaths(data, paths, new Set<string>(), 0);
  return paths;
}

function extractPrimaryPath(data: Record<string, unknown> | undefined): string | undefined {
  return collectToolFilePaths(data)[0];
}

/**
 * Later ACP updates often resend `rawInput: {}`. Keep the first object that
 * actually carried keys so a parsed path is not wiped out.
 */
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
  // Server-prefixed MCP names (`github.read_file`, `mcp__db__find`) are not local reads or searches.
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

/** Cursor-style row: "Searched files *.{ts,tsx} in t3chat-new". */
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

/** Work-log heading for a file read: verb plus the structured path, never the path alone. */
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
