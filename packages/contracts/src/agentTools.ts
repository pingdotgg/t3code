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
/** Reserved for T3's own server, which every session already gets. */
const RESERVED_MCP_SERVER_NAMES: ReadonlySet<string> = new Set(["t3-code"]);

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
 * An environment variable or HTTP header. A `sensitive` value is moved into
 * the environment's secret store on save; settings and clients then see an
 * empty value with `valueRedacted` set, and sending that back keeps it.
 * A client that renamed the server or the variable sends `storedAs`, the
 * names the secret was saved under, so the save moves it instead of losing it.
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
