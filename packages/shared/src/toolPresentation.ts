import type {
  ProviderDriverKind,
  ToolExecutionState,
  ToolInputField,
  ToolInputFieldKind,
  ToolLifecycleItemType,
  ToolOrigin,
  ToolPermission,
  ToolPresentation,
  ToolProvenance,
  ToolResultPreview,
  ToolSurface,
} from "@t3tools/contracts";

/**
 * Derives the typed native presentation (contracts `ToolPresentation`) for a
 * tool, skill, or plugin invocation from the untyped provider `data` bag that
 * rides on `ItemLifecyclePayload`.
 *
 * Provider adapters each shape `data` differently:
 * - Claude / OpenCode: `{ toolName, input, result }`
 * - Codex: the raw notification, i.e. `{ item: { type, command, server, tool, ... } }`
 * - ACP (Cursor, Grok, ...): `{ toolCallId, kind, command, rawInput, rawOutput, locations }`
 *
 * Everything here is best-effort and total: an unrecognized tool always lands
 * on `surface: "generic"` with a usable title, so the UI degrades instead of
 * dropping the row.
 */

const MAX_INPUT_FIELDS = 6;
const MAX_INPUT_VALUE_CHARS = 400;
const MAX_RESULT_CHARS = 2000;
const MAX_PATHS = 8;

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Codex/ACP commands arrive either as a string or as an argv array. */
export function normalizeCommandValue(value: unknown): string | undefined {
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

/** Codex appends `<exited with exit code N>` to aggregated command output. */
export function stripTrailingExitCode(value: string | undefined): string | undefined {
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

export function extractToolCommand(
  data: Record<string, unknown> | undefined,
  title?: string | undefined,
): string | undefined {
  const item = asRecord(data?.item);
  const itemInput = asRecord(item?.input);
  const itemResult = asRecord(item?.result);
  const rawInput = asRecord(data?.rawInput);
  const input = asRecord(data?.input);
  const candidates = [
    normalizeCommandValue(item?.command),
    normalizeCommandValue(itemInput?.command),
    normalizeCommandValue(itemResult?.command),
    normalizeCommandValue(data?.command),
    normalizeCommandValue(input?.command),
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
  if (depth > 4 || paths.length >= MAX_PATHS) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectPaths(entry, paths, seen, depth + 1);
      if (paths.length >= MAX_PATHS) {
        return;
      }
    }
    return;
  }
  const record = asRecord(value);
  if (!record) {
    return;
  }
  for (const key of [
    "path",
    "filePath",
    "file_path",
    "relativePath",
    "filename",
    "newPath",
    "oldPath",
  ]) {
    const candidate = maybePathLike(asTrimmedString(record[key]));
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    paths.push(candidate);
    if (paths.length >= MAX_PATHS) {
      return;
    }
  }
  for (const nestedKey of ["locations", "item", "input", "result", "rawInput", "data", "changes"]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectPaths(record[nestedKey], paths, seen, depth + 1);
    if (paths.length >= MAX_PATHS) {
      return;
    }
  }
}

export function extractPaths(data: Record<string, unknown> | undefined): ReadonlyArray<string> {
  const paths: string[] = [];
  collectPaths(data, paths, new Set<string>(), 0);
  return paths;
}

export function extractPrimaryPath(data: Record<string, unknown> | undefined): string | undefined {
  return extractPaths(data)[0];
}

/** `WebSearch`, `web_search`, and `web search` all collapse to `websearch`. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

const BUILTIN_TOOL_SURFACES: ReadonlyMap<string, ToolSurface> = new Map([
  ["bash", "command"],
  ["shell", "command"],
  ["terminal", "command"],
  ["exec", "command"],
  ["execcommand", "command"],
  ["executecommand", "command"],
  ["runcommand", "command"],
  ["localshell", "command"],
  ["read", "file_read"],
  ["readfile", "file_read"],
  ["view", "file_read"],
  ["notebookread", "file_read"],
  ["write", "file_change"],
  ["writefile", "file_change"],
  ["edit", "file_change"],
  ["editfile", "file_change"],
  ["multiedit", "file_change"],
  ["notebookedit", "file_change"],
  ["createfile", "file_change"],
  ["applypatch", "file_change"],
  ["strreplaceeditor", "file_change"],
  ["strreplacebasededittool", "file_change"],
  ["patch", "file_change"],
  ["grep", "file_search"],
  ["glob", "file_search"],
  ["find", "file_search"],
  ["ls", "file_search"],
  ["filesearch", "file_search"],
  ["codebasesearch", "file_search"],
  ["websearch", "web_search"],
  ["webfetch", "web_fetch"],
  ["fetch", "web_fetch"],
  ["todowrite", "todo"],
  ["updateplan", "todo"],
  ["task", "subagent"],
  ["agent", "subagent"],
  ["skill", "skill"],
]);

const ITEM_TYPE_SURFACES: ReadonlyMap<ToolLifecycleItemType, ToolSurface> = new Map([
  ["command_execution", "command"],
  ["file_change", "file_change"],
  ["mcp_tool_call", "mcp"],
  ["collab_agent_tool_call", "subagent"],
  ["web_search", "web_search"],
  ["image_view", "image"],
  ["dynamic_tool_call", "generic"],
]);

/** ACP `kind` values (`AcpRuntimeModel.ts`). */
const ACP_KIND_SURFACES: ReadonlyMap<string, ToolSurface> = new Map([
  ["execute", "command"],
  ["read", "file_read"],
  ["edit", "file_change"],
  ["move", "file_change"],
  ["delete", "file_change"],
  ["write", "file_change"],
  ["search", "file_search"],
  ["fetch", "web_fetch"],
  ["think", "generic"],
  ["other", "generic"],
]);

export interface ToolIdentity {
  readonly provenance: ToolProvenance;
  /** Surface implied by the tool's identity alone, when it is authoritative. */
  readonly surface?: ToolSurface | undefined;
}

/**
 * Splits a provider tool name into typed identity.
 *
 * Recognizes the MCP wire convention (`mcp__<server>__<tool>`), skill
 * invocations (the `Skill` tool, whose input names the skill), plugin-scoped
 * skills (`<plugin>:<skill>`), and subagent spawns.
 */
export function parseToolIdentity(input: {
  readonly toolName?: string | undefined;
  readonly toolInput?: Record<string, unknown> | undefined;
  readonly data?: Record<string, unknown> | undefined;
  readonly provider?: ProviderDriverKind | undefined;
}): ToolIdentity {
  const provider = input.provider;
  const toolInput = input.toolInput;
  const item = asRecord(input.data?.item);
  const toolName = asTrimmedString(input.toolName);

  // Codex models MCP calls as a typed item rather than a prefixed tool name.
  const codexServer = asTrimmedString(item?.server);
  const codexTool = asTrimmedString(item?.tool);
  if (codexServer && codexTool) {
    return {
      surface: "mcp",
      provenance: {
        origin: "mcp",
        serverName: codexServer,
        displayName: codexTool,
        ...(toolName ? { toolName } : { toolName: `${codexServer}__${codexTool}` }),
        ...(provider ? { provider } : {}),
      },
    };
  }

  if (!toolName) {
    return { provenance: { origin: "unknown", ...(provider ? { provider } : {}) } };
  }

  const base: { readonly toolName: string; readonly provider?: ProviderDriverKind } = {
    toolName,
    ...(provider ? { provider } : {}),
  };

  const mcpMatch = /^mcp__(?<server>[^_](?:[^_]|_(?!_))*)(?:__(?<tool>.+))?$/u.exec(toolName);
  const mcpServer = asTrimmedString(mcpMatch?.groups?.server);
  if (mcpServer) {
    const mcpTool = asTrimmedString(mcpMatch?.groups?.tool);
    return {
      surface: "mcp",
      provenance: {
        ...base,
        origin: "mcp",
        serverName: mcpServer,
        ...(mcpTool ? { displayName: mcpTool } : {}),
      },
    };
  }

  const normalized = normalizeName(toolName);

  if (normalized === "skill") {
    const skillRef =
      asTrimmedString(toolInput?.skill) ??
      asTrimmedString(toolInput?.skill_name) ??
      asTrimmedString(toolInput?.name) ??
      asTrimmedString(toolInput?.command);
    const scoped = splitPluginScopedName(skillRef);
    return {
      surface: "skill",
      provenance: {
        ...base,
        ...scoped,
        displayName: scoped.skillName ?? "Skill",
      },
    };
  }

  if (normalized === "task" || normalized === "agent") {
    const subagentType =
      asTrimmedString(toolInput?.subagent_type) ??
      asTrimmedString(toolInput?.subagentType) ??
      asTrimmedString(toolInput?.agentType);
    return {
      surface: "subagent",
      provenance: {
        ...base,
        origin: "subagent",
        displayName: toolName,
        ...(subagentType ? { subagentType } : {}),
      },
    };
  }

  // Plugin-scoped capabilities keep their `<plugin>:<name>` namespace.
  if (toolName.includes(":")) {
    const scoped = splitPluginScopedName(toolName);
    if (scoped.pluginName) {
      return {
        provenance: {
          ...base,
          origin: "plugin",
          pluginName: scoped.pluginName,
          ...(scoped.skillName ? { displayName: scoped.skillName } : {}),
        },
      };
    }
  }

  const builtinSurface = BUILTIN_TOOL_SURFACES.get(normalized);
  return {
    ...(builtinSurface ? { surface: builtinSurface } : {}),
    provenance: {
      ...base,
      origin: builtinSurface ? "builtin" : "unknown",
      displayName: toolName,
    },
  };
}

/**
 * `caveman:cavecrew` → plugin `caveman`, skill `cavecrew`. A bare name has no
 * plugin, so it stays a plain skill.
 */
function splitPluginScopedName(name: string | undefined): {
  readonly origin: ToolOrigin;
  readonly pluginName?: string;
  readonly skillName?: string;
} {
  if (!name) {
    return { origin: "skill" };
  }
  const separator = name.indexOf(":");
  if (separator <= 0 || separator >= name.length - 1) {
    return { origin: "skill", skillName: name };
  }
  const pluginName = name.slice(0, separator).trim();
  const skillName = name.slice(separator + 1).trim();
  if (!pluginName || !skillName) {
    return { origin: "skill", skillName: name };
  }
  return { origin: "plugin", pluginName, skillName };
}

function toolInputOf(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return (
    asRecord(data?.input) ??
    asRecord(data?.rawInput) ??
    asRecord(asRecord(data?.item)?.input) ??
    asRecord(data?.arguments)
  );
}

function toolNameOf(data: Record<string, unknown> | undefined): string | undefined {
  return (
    asTrimmedString(data?.toolName) ??
    asTrimmedString(data?.tool_name) ??
    asTrimmedString(asRecord(data?.item)?.toolName) ??
    asTrimmedString(data?.name)
  );
}

/**
 * ACP agents that send no tool `kind` still send a human title; these are the
 * titles Cursor/Grok emit today.
 */
const TITLE_SURFACES: ReadonlyMap<string, ToolSurface> = new Map([
  ["terminal", "command"],
  ["read file", "file_read"],
  ["find", "file_search"],
  ["grep", "file_search"],
]);

export function classifyToolSurface(input: {
  readonly identity: ToolIdentity;
  readonly itemType?: ToolLifecycleItemType | undefined;
  readonly title?: string | undefined;
  readonly data?: Record<string, unknown> | undefined;
}): ToolSurface {
  // A recognized tool name beats the adapters' substring-matched item type,
  // which cannot tell a `Skill` call from any other dynamic tool.
  if (input.identity.surface) {
    return input.identity.surface;
  }
  const acpKind = asTrimmedString(input.data?.kind)?.toLowerCase();
  const acpSurface = acpKind ? ACP_KIND_SURFACES.get(acpKind) : undefined;
  if (acpSurface && acpSurface !== "generic") {
    return acpSurface;
  }
  const itemSurface = input.itemType ? ITEM_TYPE_SURFACES.get(input.itemType) : undefined;
  if (itemSurface && itemSurface !== "generic") {
    return itemSurface;
  }
  const titleSurface = TITLE_SURFACES.get(asTrimmedString(input.title)?.toLowerCase() ?? "");
  if (titleSurface) {
    return titleSurface;
  }
  if (input.identity.provenance.origin === "plugin") {
    return "plugin";
  }
  return "generic";
}

function truncate(
  value: string,
  max: number,
): { readonly value: string; readonly truncated: boolean } {
  if (value.length <= max) {
    return { value, truncated: false };
  }
  return { value: `${value.slice(0, max - 1)}…`, truncated: true };
}

function inputField(
  label: string,
  rawValue: string,
  kind: ToolInputFieldKind,
): ToolInputField | undefined {
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const { value, truncated } = truncate(trimmed, MAX_INPUT_VALUE_CHARS);
  return { label, value, kind, ...(truncated ? { truncated } : {}) };
}

function inputFieldKindForKey(key: string): ToolInputFieldKind {
  const normalized = normalizeName(key);
  if (normalized === "command" || normalized === "cmd" || normalized === "script") {
    return "command";
  }
  if (normalized.includes("path") || normalized.includes("file") || normalized === "cwd") {
    return "path";
  }
  if (normalized.includes("url") || normalized.includes("uri")) {
    return "url";
  }
  if (normalized.includes("query") || normalized.includes("pattern") || normalized === "q") {
    return "query";
  }
  return "text";
}

/** Flattens the raw tool input into bounded, labelled fields. */
function genericInputFields(toolInput: Record<string, unknown> | undefined): ToolInputField[] {
  if (!toolInput) {
    return [];
  }
  const fields: ToolInputField[] = [];
  for (const [key, value] of Object.entries(toolInput)) {
    if (fields.length >= MAX_INPUT_FIELDS) {
      break;
    }
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === "object") {
      const field = inputField(key, safeJson(value), "json");
      if (field) {
        fields.push(field);
      }
      continue;
    }
    const field = inputField(key, String(value), inputFieldKindForKey(key));
    if (field) {
      fields.push(field);
    }
  }
  return fields;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function firstString(
  toolInput: Record<string, unknown> | undefined,
  keys: ReadonlyArray<string>,
): string | undefined {
  if (!toolInput) {
    return undefined;
  }
  for (const key of keys) {
    const value = asTrimmedString(toolInput[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function extractResultText(data: Record<string, unknown> | undefined): string | undefined {
  if (!data) {
    return undefined;
  }
  const item = asRecord(data.item);
  const direct =
    asTrimmedString(data.result) ??
    asTrimmedString(data.rawOutput) ??
    asTrimmedString(data.output) ??
    asTrimmedString(item?.aggregatedOutput) ??
    asTrimmedString(item?.output);
  if (direct) {
    return direct;
  }
  const result = asRecord(data.result) ?? asRecord(data.rawOutput) ?? asRecord(item?.result);
  if (!result) {
    return collectContentText(data.content);
  }
  return (
    asTrimmedString(result.text) ??
    asTrimmedString(result.output) ??
    asTrimmedString(result.stdout) ??
    collectContentText(result.content) ??
    collectContentText(data.content)
  );
}

/** Anthropic/ACP content blocks: `[{ type: "text", text }]`. */
function collectContentText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return asTrimmedString(value);
  }
  if (!Array.isArray(value)) {
    const record = asRecord(value);
    return record ? asTrimmedString(record.text) : undefined;
  }
  const parts: string[] = [];
  for (const entry of value) {
    const text =
      asTrimmedString(entry) ??
      asTrimmedString(asRecord(entry)?.text) ??
      asTrimmedString(asRecord(asRecord(entry)?.content)?.text);
    if (text) {
      parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function asInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function extractExitCode(data: Record<string, unknown> | undefined): number | undefined {
  const item = asRecord(data?.item);
  return (
    asInt(data?.exitCode) ??
    asInt(item?.exitCode) ??
    asInt(asRecord(data?.result)?.exitCode) ??
    asInt(asRecord(data?.rawOutput)?.exitCode)
  );
}

function isErrorResult(data: Record<string, unknown> | undefined): boolean {
  const result = asRecord(data?.result);
  return result?.is_error === true || result?.isError === true || data?.isError === true;
}

function buildResult(
  data: Record<string, unknown> | undefined,
  state: ToolExecutionState,
  surface: ToolSurface,
): ToolResultPreview | undefined {
  if (state === "pending" || state === "running") {
    return undefined;
  }
  const rawText = extractResultText(data);
  const text = surface === "command" ? stripTrailingExitCode(rawText) : rawText;
  const exitCode = extractExitCode(data);
  const paths = surface === "file_change" ? extractPaths(data) : [];
  const failed = state === "failed" || isErrorResult(data);

  if (text === undefined && exitCode === undefined && paths.length === 0 && !failed) {
    return undefined;
  }

  const bounded = text !== undefined ? truncate(text, MAX_RESULT_CHARS) : undefined;
  return {
    ...(bounded ? { text: bounded.value } : {}),
    ...(bounded?.truncated ? { truncated: true } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(failed && bounded ? { error: truncate(bounded.value, 400).value } : {}),
    paths: [...paths],
  };
}

const ITEM_STATUS_STATES: ReadonlyMap<string, ToolExecutionState> = new Map([
  ["inProgress", "running"],
  ["in_progress", "running"],
  ["pending", "pending"],
  ["completed", "succeeded"],
  ["failed", "failed"],
  ["declined", "declined"],
]);

function resolveState(
  status: string | undefined,
  fallback: ToolExecutionState,
): ToolExecutionState {
  if (!status) {
    return fallback;
  }
  return ITEM_STATUS_STATES.get(status) ?? fallback;
}

function buildPermission(
  data: Record<string, unknown> | undefined,
  state: ToolExecutionState,
): ToolPermission | undefined {
  const permission = asRecord(data?.permission);
  const decisionValue =
    asTrimmedString(permission?.decision) ??
    asTrimmedString(data?.permissionDecision) ??
    asTrimmedString(data?.decision);
  const reason =
    asTrimmedString(permission?.reason) ??
    asTrimmedString(data?.permissionReason) ??
    asTrimmedString(asRecord(data?.result)?.denialReason);

  if (state === "declined") {
    return { decision: "denied", ...(reason ? { reason } : {}) };
  }
  if (!decisionValue) {
    return undefined;
  }
  const normalized = decisionValue.toLowerCase();
  const decision =
    normalized.startsWith("deny") || normalized.startsWith("reject") || normalized === "denied"
      ? "denied"
      : normalized.startsWith("approve") ||
          normalized.startsWith("accept") ||
          normalized === "allow" ||
          normalized === "allowed"
        ? "approved"
        : "pending";
  return { decision, ...(reason ? { reason } : {}) };
}

function titleFor(surface: ToolSurface, provenance: ToolProvenance, fallback: string): string {
  switch (surface) {
    case "command":
      return "Ran command";
    case "file_read":
      return "Read file";
    case "file_change":
      return "Changed files";
    case "file_search":
      return "Searched files";
    case "web_search":
      return "Web search";
    case "web_fetch":
      return "Fetched page";
    case "image":
      return "Viewed image";
    case "todo":
      return "Updated plan";
    case "skill": {
      const name = provenance.skillName ?? provenance.displayName;
      return name ? `Skill: ${name}` : "Skill";
    }
    case "plugin": {
      const name = provenance.pluginName;
      return name ? `Plugin: ${name}` : "Plugin";
    }
    case "mcp": {
      const server = provenance.serverName;
      const tool = provenance.displayName;
      if (server && tool) {
        return `${server} · ${tool}`;
      }
      return server ?? tool ?? "MCP tool call";
    }
    case "subagent":
      return "Subagent task";
    default:
      return provenance.displayName ?? fallback;
  }
}

function subtitleFor(input: {
  readonly surface: ToolSurface;
  readonly provenance: ToolProvenance;
  readonly toolInput: Record<string, unknown> | undefined;
  readonly data: Record<string, unknown> | undefined;
  readonly title: string | undefined;
}): string | undefined {
  const { surface, toolInput, data } = input;
  switch (surface) {
    case "command":
      return extractToolCommand(data, input.title);
    case "file_read":
    case "file_change":
    case "image":
      return extractPrimaryPath(data);
    case "file_search":
      return (
        firstString(toolInput, ["query", "pattern", "searchTerm", "search_term", "q"]) ??
        extractPrimaryPath(data)
      );
    case "web_search":
      return firstString(toolInput, ["query", "pattern", "searchTerm", "search_term", "q"]);
    case "web_fetch":
      return firstString(toolInput, ["url", "uri", "link"]);
    case "skill":
      return firstString(toolInput, ["args", "arguments", "input", "prompt"]);
    case "subagent":
      return (
        input.provenance.subagentType ?? firstString(toolInput, ["description", "prompt", "task"])
      );
    case "mcp":
    case "plugin":
    case "generic":
      return undefined;
    default:
      return undefined;
  }
}

function inputsFor(input: {
  readonly surface: ToolSurface;
  readonly toolInput: Record<string, unknown> | undefined;
  readonly data: Record<string, unknown> | undefined;
  readonly title: string | undefined;
}): ToolInputField[] {
  const { surface, toolInput, data } = input;
  if (surface === "command") {
    const command = extractToolCommand(data, input.title);
    const cwd = firstString(toolInput, ["cwd", "workdir", "working_directory"]);
    return [
      ...(command ? [inputField("command", command, "command")].filter(isField) : []),
      ...(cwd ? [inputField("cwd", cwd, "path")].filter(isField) : []),
    ];
  }
  if (surface === "file_read" || surface === "file_change" || surface === "image") {
    const paths = extractPaths(data).slice(0, MAX_INPUT_FIELDS);
    if (paths.length > 0) {
      return paths.map((path) => inputField("path", path, "path")).filter(isField);
    }
  }
  return genericInputFields(toolInput);
}

function isField(field: ToolInputField | undefined): field is ToolInputField {
  return field !== undefined;
}

export interface ToolPresentationInput {
  readonly itemType?: ToolLifecycleItemType | null | undefined;
  readonly status?: string | null | undefined;
  readonly title?: string | null | undefined;
  readonly detail?: string | null | undefined;
  readonly data?: unknown;
  readonly provider?: ProviderDriverKind | undefined;
  /** State to assume when the provider sent no status (e.g. `item.started`). */
  readonly fallbackState?: ToolExecutionState | undefined;
}

/**
 * Normalizes one tool/skill/plugin invocation into the typed native
 * presentation. Total: unrecognized tools land on `surface: "generic"`.
 */
export function deriveToolPresentation(input: ToolPresentationInput): ToolPresentation {
  const data = asRecord(input.data);
  const itemType = input.itemType ?? undefined;
  const title = asTrimmedString(input.title);
  const toolInput = toolInputOf(data);
  const toolName = toolNameOf(data);

  const identity = parseToolIdentity({
    ...(toolName ? { toolName } : {}),
    ...(toolInput ? { toolInput } : {}),
    ...(data ? { data } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
  });
  const surface = classifyToolSurface({
    identity,
    ...(itemType ? { itemType } : {}),
    ...(title ? { title } : {}),
    ...(data ? { data } : {}),
  });
  const state = resolveState(asTrimmedString(input.status), input.fallbackState ?? "running");
  const provenance = identity.provenance;

  const resolvedTitle = titleFor(surface, provenance, title ?? "Tool");
  const subtitle =
    subtitleFor({ surface, provenance, toolInput, data, title }) ??
    (surface === "generic" ? asTrimmedString(input.detail) : undefined);
  const result = buildResult(data, state, surface);
  const permission = buildPermission(data, state);

  return {
    surface,
    title: resolvedTitle,
    ...(subtitle ? { subtitle: truncate(subtitle, MAX_INPUT_VALUE_CHARS).value } : {}),
    state,
    provenance,
    inputs: inputsFor({ surface, toolInput, data, title }),
    ...(result ? { result } : {}),
    ...(permission ? { permission } : {}),
    ...(itemType ? { itemType } : {}),
  };
}
