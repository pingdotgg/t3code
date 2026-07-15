/**
 * Canonical identity for a tool invocation.
 *
 * Providers hand us raw tool names (`mcp__cloudflare__docs`, `Skill`,
 * `computer`, `Bash`) that are wire identifiers, not something a human wants to
 * read in a chat log. This module turns a raw name (plus its input, when the
 * name alone is not specific enough) into the family + display name that every
 * surface — server titles, mac rows, mobile work log — renders from, so the
 * parsing lives in exactly one place.
 */

/** Broad origin of a tool, used to pick an icon and a natural title. */
export type ToolFamily = "mcp" | "skill" | "computer_use" | "builtin";

export interface ToolIdentity {
  readonly family: ToolFamily;
  /** Raw provider-supplied tool name. */
  readonly toolName: string;
  /** Human-facing label, e.g. `Cloudflare · Docs`. */
  readonly displayName: string;
  /** MCP server, plugin owning a skill, or computer-use provider. */
  readonly provider?: string;
  /** Specific operation: MCP tool, skill name, computer action. */
  readonly action?: string;
}

const MCP_PREFIXES = ["mcp__", "mcp_", "mcp:", "mcp."];
const SKILL_TOOL_NAMES = new Set(["skill", "skills", "useskill", "runskill", "invokeskill"]);
const COMPUTER_USE_PATTERN = /^computer(?:[\s._-]?use)?$/u;
const COMPUTER_USE_PROVIDER_PATTERN = /computer[\s._-]?use/u;

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

function words(value: string): string[] {
  return value
    .split(/[\s._-]+/u)
    .map((word) => word.trim())
    .filter((word) => word.length > 0);
}

/** `cloudflare` -> `Cloudflare`; `claude_ai` -> `Claude Ai`; `Gmail` -> `Gmail`. */
function titleCase(value: string): string {
  const parts = words(value);
  if (parts.length === 0) {
    return value.trim();
  }
  return parts
    .map((word) => (/[A-Z]/u.test(word) ? word : `${word.charAt(0).toUpperCase()}${word.slice(1)}`))
    .join(" ");
}

/** `get_message` -> `Get message`; `listEvents` -> `List events`. */
function sentenceCase(value: string): string {
  const spaced = words(value)
    .join(" ")
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2");
  const trimmed = spaced.trim();
  if (trimmed.length === 0) {
    return value.trim();
  }
  const lowered = trimmed
    .split(" ")
    .map((word) => (/^[A-Z][a-z]+$/u.test(word) ? word.toLowerCase() : word))
    .join(" ");
  return `${lowered.charAt(0).toUpperCase()}${lowered.slice(1)}`;
}

function joinDisplay(parts: ReadonlyArray<string | undefined>): string {
  return parts.filter((part): part is string => part !== undefined && part.length > 0).join(" · ");
}

/** Split `mcp__server__tool` (and `mcp_server_tool` variants) into its segments. */
function splitMcpName(toolName: string): { server?: string; tool?: string } | undefined {
  const normalized = toolName.trim();
  const lowered = normalized.toLowerCase();
  const prefix = MCP_PREFIXES.find((candidate) => lowered.startsWith(candidate));
  if (prefix === undefined) {
    return undefined;
  }
  const rest = normalized.slice(prefix.length);
  if (rest.length === 0) {
    return {};
  }
  // Canonical MCP naming is `mcp__<server>__<tool>`; fall back to a single
  // separator when a provider only uses one.
  const doubleSplit = rest.split("__");
  if (doubleSplit.length >= 2) {
    const [server, ...toolParts] = doubleSplit;
    return {
      ...(asTrimmedString(server) ? { server: server as string } : {}),
      ...(asTrimmedString(toolParts.join("__")) ? { tool: toolParts.join("__") } : {}),
    };
  }
  const singleSplit = rest.split(/[._:-]/u);
  if (singleSplit.length >= 2) {
    const [server, ...toolParts] = singleSplit;
    return {
      ...(asTrimmedString(server) ? { server: server as string } : {}),
      ...(asTrimmedString(toolParts.join("_")) ? { tool: toolParts.join("_") } : {}),
    };
  }
  return { server: rest };
}

/** Skill invocations name the skill in their input, not in the tool name. */
function skillNameFromInput(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) {
    return undefined;
  }
  return (
    asTrimmedString(input.skill) ??
    asTrimmedString(input.skill_name) ??
    asTrimmedString(input.skillName) ??
    asTrimmedString(input.name) ??
    asTrimmedString(input.command)
  );
}

function computerActionFromInput(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) {
    return undefined;
  }
  return asTrimmedString(input.action) ?? asTrimmedString(input.type);
}

function mcpIdentity(
  toolName: string,
  server: string | undefined,
  tool: string | undefined,
): ToolIdentity {
  const provider = server ? titleCase(server) : undefined;
  const action = tool ? sentenceCase(tool) : undefined;
  const isComputerUse = server !== undefined && COMPUTER_USE_PROVIDER_PATTERN.test(server);
  return {
    family: isComputerUse ? "computer_use" : "mcp",
    toolName,
    displayName: joinDisplay([provider ?? "MCP tool", action]),
    ...(provider ? { provider } : {}),
    ...(action ? { action } : {}),
  };
}

function skillIdentity(toolName: string, skill: string | undefined): ToolIdentity {
  if (!skill) {
    return { family: "skill", toolName, displayName: "Skill" };
  }
  // Plugin-provided skills are namespaced `plugin:skill`.
  const [maybePlugin, ...rest] = skill.split(":");
  const plugin = rest.length > 0 ? asTrimmedString(maybePlugin) : undefined;
  const skillName = rest.length > 0 ? rest.join(":") : skill;
  return {
    family: "skill",
    toolName,
    displayName: joinDisplay(["Skill", plugin ? `${plugin}:${skillName}` : skillName]),
    ...(plugin ? { provider: plugin } : {}),
    action: skillName,
  };
}

function computerUseIdentity(toolName: string, action: string | undefined): ToolIdentity {
  const label = action ? sentenceCase(action) : undefined;
  return {
    family: "computer_use",
    toolName,
    displayName: joinDisplay(["Computer use", label]),
    ...(label ? { action: label } : {}),
  };
}

/**
 * Resolve the family + display name of a tool call. `input` is optional: it is
 * only consulted for tools whose name is a generic dispatcher (`Skill`,
 * `computer`) and whose real identity lives in the arguments.
 */
export function parseToolIdentity(
  toolName: string,
  input?: Record<string, unknown> | undefined,
): ToolIdentity {
  const raw = toolName.trim();
  if (raw.length === 0) {
    return { family: "builtin", toolName, displayName: "Tool" };
  }
  const normalized = raw.toLowerCase();

  const mcp = splitMcpName(raw);
  if (mcp) {
    return mcpIdentity(raw, mcp.server, mcp.tool);
  }

  if (SKILL_TOOL_NAMES.has(normalized.replace(/[\s._-]+/gu, ""))) {
    return skillIdentity(raw, skillNameFromInput(input));
  }

  if (COMPUTER_USE_PATTERN.test(normalized)) {
    return computerUseIdentity(raw, computerActionFromInput(input));
  }

  return { family: "builtin", toolName: raw, displayName: raw };
}

/** True when the identity is worth rendering with its own title/icon. */
export function isNativeToolFamily(family: ToolFamily): boolean {
  return family !== "builtin";
}

/**
 * Best-effort identity from an activity payload's `data` blob, for surfaces
 * that only see the persisted activity (all providers, not just Claude).
 * Prefers an identity the adapter already resolved.
 */
export function deriveToolIdentityFromData(data: unknown): ToolIdentity | undefined {
  const record = asRecord(data);
  if (!record) {
    return undefined;
  }
  const existing = asRecord(record.tool);
  const existingFamily = asTrimmedString(existing?.family);
  const existingDisplay = asTrimmedString(existing?.displayName);
  if (existing && existingFamily && existingDisplay) {
    return {
      family: existingFamily as ToolFamily,
      toolName: asTrimmedString(existing.toolName) ?? existingDisplay,
      displayName: existingDisplay,
      ...(asTrimmedString(existing.provider) ? { provider: existing.provider as string } : {}),
      ...(asTrimmedString(existing.action) ? { action: existing.action as string } : {}),
    };
  }

  const item = asRecord(record.item);
  // Codex reports MCP calls structurally instead of via a namespaced name.
  const server = asTrimmedString(item?.server) ?? asTrimmedString(record.server);
  const serverTool = asTrimmedString(item?.tool) ?? asTrimmedString(record.tool);
  if (server && serverTool) {
    return mcpIdentity(`mcp__${server}__${serverTool}`, server, serverTool);
  }

  const toolName =
    asTrimmedString(record.toolName) ??
    asTrimmedString(item?.toolName) ??
    asTrimmedString(item?.name) ??
    asTrimmedString(record.name);
  if (!toolName) {
    return undefined;
  }
  const input =
    asRecord(record.input) ?? asRecord(item?.input) ?? asRecord(record.rawInput) ?? undefined;
  const identity = parseToolIdentity(toolName, input);
  return isNativeToolFamily(identity.family) ? identity : undefined;
}

/**
 * Compact `key=value` rendering of tool arguments — readable where a raw JSON
 * blob is not (MCP calls, skills, computer actions).
 */
export function summarizeToolArguments(
  input: Record<string, unknown> | undefined,
  maxLength = 180,
): string | undefined {
  if (!input) {
    return undefined;
  }
  const parts: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) {
      continue;
    }
    let rendered: string;
    if (typeof value === "string") {
      rendered = value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      rendered = String(value);
    } else if (Array.isArray(value)) {
      rendered = `[${value.length}]`;
    } else {
      rendered = "{…}";
    }
    const collapsed = rendered.replace(/\s+/gu, " ").trim();
    if (collapsed.length === 0) {
      continue;
    }
    parts.push(`${key}=${collapsed}`);
  }
  if (parts.length === 0) {
    return undefined;
  }
  const joined = parts.join(", ");
  return joined.length <= maxLength ? joined : `${joined.slice(0, Math.max(0, maxLength - 1))}…`;
}
