import type { ToolLifecycleItemType } from "@marcode/contracts";

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

function classifyToolAction(input: {
  readonly itemType?: ToolLifecycleItemType | null | undefined;
  readonly title?: string | undefined;
  readonly data?: Record<string, unknown> | undefined;
}): "command" | "read" | "file_change" | "search" | "other" {
  // Prefer the canonical `itemType` — by the time we get here it has already
  // been classified by `classifyToolLifecycleItemType` (or by provider-specific
  // emission), so trust it over ad-hoc `kind`/`title` heuristics that only
  // recognize Claude/Codex vocabulary.
  switch (input.itemType) {
    case "command_execution":
      return "command";
    case "file_read":
      return "read";
    case "file_change":
      return "file_change";
    case "web_search":
    case "web_fetch":
      return "search";
  }
  const kind = asTrimmedString(input.data?.kind)?.toLowerCase();
  const title = asTrimmedString(input.title)?.toLowerCase();
  if (kind === "execute" || title === "terminal") return "command";
  if (kind === "read" || title === "read file") return "read";
  if (kind === "edit" || kind === "move" || kind === "delete" || kind === "write") {
    return "file_change";
  }
  if (kind === "search" || kind === "fetch" || title === "find" || title === "grep") {
    return "search";
  }
  return "other";
}

/**
 * Plan step shape matching the `turn.plan.updated` runtime event payload.
 * Matches ACP's plan entry statuses after normalization.
 */
export type PlanStep = {
  readonly step: string;
  readonly status: "pending" | "inProgress" | "completed";
};

/**
 * Detect a TodoWrite-family tool. Claude calls it `TodoWrite`, OpenCode calls
 * it `todowrite`, and Cursor (via ACP) can surface it under any casing. The
 * match is deliberately lenient so custom agents using similar naming work too.
 */
export function isTodoWriteTool(toolName: string | null | undefined): boolean {
  if (!toolName) return false;
  const normalized = toolName.toLowerCase().replace(/[_\-.\s]/g, "");
  return normalized.includes("todowrite") || normalized === "todos";
}

/**
 * Normalize a TodoWrite input (`{ todos: [{ content, status, ... }] }`) into
 * the plan-step shape that `turn.plan.updated` consumers expect. Returns null
 * when the input is missing or the todos list is empty.
 */
export function extractPlanStepsFromTodos(
  input: Record<string, unknown> | null | undefined,
): PlanStep[] | null {
  if (!input) return null;
  const todos = input.todos;
  if (!Array.isArray(todos) || todos.length === 0) return null;
  const steps: PlanStep[] = [];
  for (const raw of todos) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const todo = raw as Record<string, unknown>;
    const content = asTrimmedString(todo.content) ?? asTrimmedString(todo.activeForm) ?? "Task";
    const rawStatus = asTrimmedString(todo.status)?.toLowerCase();
    const status: PlanStep["status"] =
      rawStatus === "completed" || rawStatus === "done"
        ? "completed"
        : rawStatus === "in_progress" || rawStatus === "inprogress" || rawStatus === "in-progress"
          ? "inProgress"
          : "pending";
    steps.push({ step: content, status });
  }
  return steps.length > 0 ? steps : null;
}

/**
 * Classify a tool invocation into a canonical ToolLifecycleItemType that the
 * web timeline card router understands. Provider-agnostic: accepts any subset
 * of hints a provider adapter can supply. Matches in order: toolName prefix,
 * toolName substring, ACP kind literal, title substring, then dynamic_tool_call.
 */
export function classifyToolLifecycleItemType(input: {
  readonly toolName?: string | null | undefined;
  readonly kind?: string | null | undefined;
  readonly title?: string | null | undefined;
}): ToolLifecycleItemType {
  const toolName = asTrimmedString(input.toolName)?.toLowerCase();
  const kind = asTrimmedString(input.kind)?.toLowerCase();
  const title = asTrimmedString(input.title)?.toLowerCase();

  if (toolName) {
    if (toolName.startsWith("mcp__") || toolName.startsWith("mcp_")) {
      return "mcp_tool_call";
    }
    const byTool = matchToolLifecycleItemType(toolName);
    if (byTool) return byTool;
  }

  switch (kind) {
    case "execute":
      return "command_execution";
    case "read":
      return "file_read";
    case "edit":
    case "delete":
    case "move":
    case "write":
      return "file_change";
    case "search":
      return "file_read";
    case "fetch":
      return "web_fetch";
  }

  if (title) {
    const byTitle = matchToolLifecycleItemType(title);
    if (byTitle) return byTitle;
  }

  return "dynamic_tool_call";
}

/** Token-based matcher shared between `toolName` and `title` classification. */
function matchToolLifecycleItemType(value: string): ToolLifecycleItemType | undefined {
  const tokens = value.split(/[\s_\-./]+/).filter((part) => part.length > 0);
  const hasToken = (...candidates: ReadonlyArray<string>): boolean =>
    tokens.some((token) => candidates.includes(token));
  const hasSubstring = (substring: string): boolean => value.includes(substring);

  if (hasToken("task", "subtask", "subagent") || hasSubstring("agent_") || hasSubstring("agent-")) {
    return "collab_agent_tool_call";
  }
  if (hasToken("image") || hasSubstring("view_image") || hasSubstring("image_view")) {
    return "image_view";
  }
  if (
    hasSubstring("web_fetch") ||
    hasSubstring("webfetch") ||
    hasSubstring("fetch_url") ||
    hasSubstring("fetchurl")
  ) {
    return "web_fetch";
  }
  if (hasSubstring("web_search") || hasSubstring("websearch")) {
    return "web_search";
  }
  if (
    hasToken("bash", "shell", "terminal") ||
    hasSubstring("run_command") ||
    hasSubstring("runcommand") ||
    hasSubstring("run_terminal") ||
    hasSubstring("runterminal") ||
    hasSubstring("execute_command") ||
    hasSubstring("executecommand")
  ) {
    return "command_execution";
  }
  if (
    hasToken(
      "write",
      "edit",
      "multiedit",
      "patch",
      "notebookedit",
      "create",
      "replace",
      "delete",
      "remove",
      "move",
      "rename",
    ) ||
    hasSubstring("str_replace") ||
    hasSubstring("apply_patch")
  ) {
    return "file_change";
  }
  if (hasToken("read", "view", "cat")) {
    return "file_read";
  }
  if (
    hasToken("ls", "list", "glob", "tree", "grep", "ripgrep", "rg") ||
    hasSubstring("codebase_search") ||
    hasSubstring("codebasesearch") ||
    hasSubstring("file_search") ||
    hasSubstring("filesearch") ||
    hasSubstring("find_files") ||
    hasSubstring("findfiles")
  ) {
    return "file_read";
  }
  return undefined;
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
    return {
      summary: "Changed files",
      ...(primaryPath ? { detail: primaryPath } : {}),
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
