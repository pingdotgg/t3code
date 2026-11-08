import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ForwardCompatibleArray, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * MCP servers and skill switches that T3 applies to every provider session.
 *
 * A server here is injected into each session next to the built-in `t3-code`
 * server; T3 never writes a provider's own config files. Servers a provider
 * already loads from its own config keep working untouched.
 */

/**
 * Lowercase letters, digits, `-` and `_`, starting with a letter: the subset
 * every provider accepts as a server key and tool prefix (Claude names tools
 * `mcp__<server>__<tool>`, OpenCode `<server>_<tool>`).
 */
const MCP_SERVER_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;
const MCP_SERVER_NAME_MAX_CHARS = 48;
/** T3's own server, which every session already gets. */
export const T3_MCP_SERVER_NAME = "t3-code";
/** Reserved for T3's own servers: Codex also gets a direct-only `t3-code-direct`. */
const RESERVED_MCP_SERVER_NAMES: ReadonlySet<string> = new Set([
  T3_MCP_SERVER_NAME,
  "t3-code-direct",
]);

export const McpServerName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(MCP_SERVER_NAME_MAX_CHARS),
  Schema.isPattern(MCP_SERVER_NAME_PATTERN),
  Schema.makeFilter((name: string) =>
    RESERVED_MCP_SERVER_NAMES.has(name) ? `"${name}" is reserved for T3 Code.` : true,
  ),
);
export type McpServerName = typeof McpServerName.Type;

export const isValidMcpServerName: (name: unknown) => name is McpServerName =
  Schema.is(McpServerName);

/**
 * An environment variable or HTTP header. A `sensitive` value moves to the secret store;
 * clients see it empty with `valueRedacted`, and sending that back keeps it. After a rename
 * the client sends `storedAs`, the names it was saved under, so the save moves the secret.
 */
export const McpServerVariable = Schema.Struct({
  name: TrimmedNonEmptyString,
  value: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  sensitive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  valueRedacted: Schema.optionalKey(Schema.Boolean),
  storedAs: Schema.optionalKey(
    Schema.Struct({ server: TrimmedNonEmptyString, variable: TrimmedNonEmptyString }),
  ),
});
export type McpServerVariable = typeof McpServerVariable.Type;

export const McpStdioTransport = Schema.Struct({
  type: Schema.Literal("stdio"),
  command: TrimmedNonEmptyString,
  args: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  env: Schema.Array(McpServerVariable).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type McpStdioTransport = typeof McpStdioTransport.Type;

export const McpHttpTransport = Schema.Struct({
  type: Schema.Literal("http"),
  url: TrimmedNonEmptyString,
  headers: Schema.Array(McpServerVariable).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type McpHttpTransport = typeof McpHttpTransport.Type;

export const McpServerTransport = Schema.Union([McpStdioTransport, McpHttpTransport]);
export type McpServerTransport = typeof McpServerTransport.Type;

export const McpServerConfig = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  transport: McpServerTransport,
});
export type McpServerConfig = typeof McpServerConfig.Type;

/**
 * One server in a project's overrides. With a transport it adds a server to
 * the project, or replaces the environment's server of the same name. Without
 * one it only switches the inherited server on or off for the project.
 */
export const McpServerProjectOverride = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  transport: Schema.optionalKey(McpServerTransport),
});
export type McpServerProjectOverride = typeof McpServerProjectOverride.Type;

export const McpServers = Schema.Record(McpServerName, McpServerConfig);
export type McpServers = typeof McpServers.Type;

export const McpServerProjectOverrides = Schema.Record(McpServerName, McpServerProjectOverride);
export type McpServerProjectOverrides = typeof McpServerProjectOverrides.Type;

/**
 * Skills switched off on the environment, by the name agents invoke them
 * with. A name rather than a path: the same skill is reached through several
 * folders (symlinked into each provider's directory, or a worktree's copy of
 * the repo), and a provider only ever sees one of them.
 */
export const DisabledSkills = ForwardCompatibleArray(TrimmedNonEmptyString);
export type DisabledSkills = typeof DisabledSkills.Type;

/**
 * A project's per-skill switches, keyed by skill name. `true` turns a skill
 * off for the project; `false` turns one the environment disabled back on.
 * An absent name inherits.
 */
export const DisabledSkillsProjectOverride = Schema.Record(TrimmedNonEmptyString, Schema.Boolean);
export type DisabledSkillsProjectOverride = typeof DisabledSkillsProjectOverride.Type;

export const ToolPresetName = TrimmedNonEmptyString.check(Schema.isMaxLength(48));
export type ToolPresetName = typeof ToolPresetName.Type;

/**
 * Skills and MCP servers, by name, that a thread turns on or off together.
 * A name the environment doesn't have is skipped, so one preset can serve
 * projects with different servers.
 */
export const ToolPreset = Schema.Struct({
  skills: Schema.Array(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  mcpServers: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type ToolPreset = typeof ToolPreset.Type;

export const ToolPresets = Schema.Record(ToolPresetName, ToolPreset);
export type ToolPresets = typeof ToolPresets.Type;

/**
 * A thread's preset switches: `true` turns a preset's tools on for the
 * thread, `false` turns them off. An absent preset leaves its tools as
 * settings have them.
 */
export const ThreadToolPresets = Schema.Record(ToolPresetName, Schema.Boolean);
export type ThreadToolPresets = typeof ThreadToolPresets.Type;

/** An MCP server as a provider session receives it: secrets materialized, enabled only. */
export interface ResolvedMcpServer {
  readonly name: McpServerName;
  readonly transport: McpServerTransport;
}

/** Variables as a provider needs them; a redacted value that never materialized is dropped. */
export function mcpServerVariableRecord(
  variables: ReadonlyArray<McpServerVariable>,
): Record<string, string> {
  const record: Record<string, string> = {};
  for (const variable of variables) {
    if (variable.valueRedacted === true && variable.value.length === 0) continue;
    record[variable.name] = variable.value;
  }
  return record;
}

/** What a row shows for a server: its command line or URL, never a secret. */
export function mcpServerTransportSummary(transport: McpServerTransport): string {
  return transport.type === "stdio"
    ? [transport.command, ...transport.args].join(" ")
    : transport.url;
}

// ── A server's tools ─────────────────────────────────────────────────

export const McpServerToolsInput = Schema.Struct({
  /** A server from Settings → Tools, or `t3-code` for T3's own. */
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(MCP_SERVER_NAME_MAX_CHARS)),
  /** A project's checkout: the server as that project's agents get it. */
  cwd: Schema.optional(TrimmedNonEmptyString),
});
export type McpServerToolsInput = typeof McpServerToolsInput.Type;

/** One top-level property of a tool's input schema. */
export const McpServerToolParameter = Schema.Struct({
  name: Schema.String,
  /** A short reading of its JSON Schema type, such as `string`, `number[]` or `"a" | "b"`. */
  type: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  required: Schema.Boolean,
});
export type McpServerToolParameter = typeof McpServerToolParameter.Type;

export const McpServerTool = Schema.Struct({
  name: Schema.String,
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  parameters: Schema.Array(McpServerToolParameter),
});
export type McpServerTool = typeof McpServerTool.Type;

export const McpServerToolsResult = Schema.Struct({
  /** What the server called itself when it started, if it said. */
  serverInfo: Schema.optionalKey(
    Schema.Struct({ name: Schema.String, version: Schema.optionalKey(Schema.String) }),
  ),
  tools: Schema.Array(McpServerTool),
});
export type McpServerToolsResult = typeof McpServerToolsResult.Type;

export const McpServerToolsErrorReason = Schema.Literals([
  /** No server of that name at this scope. */
  "not-found",
  /** The folder isn't one of this environment's projects. */
  "unknown-project",
  /** The command couldn't be run at all. */
  "spawn-failed",
  /** The command ran but stopped before it listed its tools. */
  "exited",
  /** The URL couldn't be reached. */
  "unreachable",
  /** The URL answered 401 or 403: it wants a sign-in T3 can't do here. */
  "unauthorized",
  /** The server answered, with an error. */
  "request-failed",
  "timed-out",
]);
export type McpServerToolsErrorReason = typeof McpServerToolsErrorReason.Type;

export class McpServerToolsError extends Schema.TaggedError<McpServerToolsError>()(
  "McpServerToolsError",
  {
    server: Schema.String,
    reason: McpServerToolsErrorReason,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-found":
        return `There's no MCP server named "${this.server}" here.`;
      case "unknown-project":
        return "That folder isn't a project on this environment.";
      case "spawn-failed":
        return "The server's command couldn't be run. Check that it's installed on this environment.";
      case "exited":
        return "The server stopped before it listed its tools. Check its command, arguments and environment variables.";
      case "unreachable":
        return "The server's URL couldn't be reached.";
      case "unauthorized":
        return "The server wants a sign-in, which listing its tools can't do here. Add an access token as a header, or sign in from an agent.";
      case "request-failed":
        return "The server returned an error when asked for its tools.";
      case "timed-out":
        return "The server didn't list its tools within 30 seconds.";
    }
  }
}
