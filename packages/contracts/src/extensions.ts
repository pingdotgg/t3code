// Fork: Kaluwa's Extensions page. User-level MCP servers, plugins and skills for each provider
// instance ("subscription"), read and changed through each provider's own CLI and config home.
import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

/** How an extension is doing in one subscription. `unknown` means nothing checked it yet. */
export const ExtensionHealth = Schema.Literals([
  "ok",
  "needsAuth",
  "failing",
  "disabled",
  "unknown",
]);
export type ExtensionHealth = typeof ExtensionHealth.Type;

export const ExtensionMcpTransport = Schema.Literals(["stdio", "http", "sse"]);
export type ExtensionMcpTransport = typeof ExtensionMcpTransport.Type;

export const ExtensionMcpServer = Schema.Struct({
  name: TrimmedNonEmptyString,
  transport: ExtensionMcpTransport,
  /** The command line for stdio servers, the URL otherwise. */
  target: Schema.String,
  /** Names of the env vars or headers it sets. Their values never leave the server. */
  secretNames: Schema.Array(Schema.String),
  enabled: Schema.Boolean,
  health: ExtensionHealth,
  /** Why it isn't `ok`, in the provider's words. */
  detail: Schema.NullOr(Schema.String),
  /** Account-level connectors (claude.ai) are listed but managed on the provider's website. */
  managedElsewhere: Schema.Boolean,
});
export type ExtensionMcpServer = typeof ExtensionMcpServer.Type;

export const ExtensionPlugin = Schema.Struct({
  /** `name@marketplace` */
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  marketplace: Schema.String,
  version: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  enabled: Schema.Boolean,
  health: ExtensionHealth,
  detail: Schema.NullOr(Schema.String),
});
export type ExtensionPlugin = typeof ExtensionPlugin.Type;

/** `library` skills are links to one shared copy; `local` ones live only in this subscription. */
export const ExtensionSkillSource = Schema.Literals(["library", "local"]);
export type ExtensionSkillSource = typeof ExtensionSkillSource.Type;

export const ExtensionSkill = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.NullOr(Schema.String),
  source: ExtensionSkillSource,
  path: Schema.String,
  health: ExtensionHealth,
  detail: Schema.NullOr(Schema.String),
});
export type ExtensionSkill = typeof ExtensionSkill.Type;

export const ExtensionKind = Schema.Literals(["mcp", "plugin", "skill"]);
export type ExtensionKind = typeof ExtensionKind.Type;

export const ExtensionsCapabilities = Schema.Struct({
  mcp: Schema.Boolean,
  mcpSignIn: Schema.Boolean,
  /** Claude and Codex CLIs can't turn a user-level server off; only removing it works there. */
  mcpSetEnabled: Schema.Boolean,
  plugins: Schema.Boolean,
  skills: Schema.Boolean,
});
export type ExtensionsCapabilities = typeof ExtensionsCapabilities.Type;

export const ExtensionsReadIssue = Schema.Struct({
  kind: ExtensionKind,
  message: Schema.String,
});
export type ExtensionsReadIssue = typeof ExtensionsReadIssue.Type;

export const ExtensionsSubscription = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  displayName: Schema.String,
  accentColor: Schema.NullOr(Schema.String),
  /** The config home this subscription reads and writes, with `~` for the user's home. */
  configHome: Schema.String,
  capabilities: ExtensionsCapabilities,
  mcpServers: Schema.Array(ExtensionMcpServer),
  plugins: Schema.Array(ExtensionPlugin),
  skills: Schema.Array(ExtensionSkill),
  /** Parts that couldn't be read, such as a missing CLI. */
  issues: Schema.Array(ExtensionsReadIssue),
});
export type ExtensionsSubscription = typeof ExtensionsSubscription.Type;

export const ExtensionsLibrarySkill = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.NullOr(Schema.String),
});
export type ExtensionsLibrarySkill = typeof ExtensionsLibrarySkill.Type;

export const ExtensionsListInput = Schema.Struct({
  /** Connect to each MCP server to report its health. Slower, and only on request. */
  checkHealth: Schema.Boolean,
});
export type ExtensionsListInput = typeof ExtensionsListInput.Type;

export const ExtensionsListResult = Schema.Struct({
  subscriptions: Schema.Array(ExtensionsSubscription),
  library: Schema.Struct({
    path: Schema.String,
    skills: Schema.Array(ExtensionsLibrarySkill),
  }),
  checkedAt: IsoDateTime,
  healthChecked: Schema.Boolean,
});
export type ExtensionsListResult = typeof ExtensionsListResult.Type;

const StringRecord = Schema.Record(Schema.String, Schema.String);

export const ExtensionMcpServerSpec = Schema.Union([
  Schema.TaggedStruct("stdio", {
    command: TrimmedNonEmptyString,
    args: Schema.Array(Schema.String),
    env: StringRecord,
  }),
  Schema.TaggedStruct("remote", {
    transport: Schema.Literals(["http", "sse"]),
    url: TrimmedNonEmptyString,
    headers: StringRecord,
  }),
]);
export type ExtensionMcpServerSpec = typeof ExtensionMcpServerSpec.Type;

export const ExtensionsMutation = Schema.Union([
  Schema.TaggedStruct("McpAdd", {
    instanceIds: Schema.Array(ProviderInstanceId),
    name: TrimmedNonEmptyString,
    spec: ExtensionMcpServerSpec,
  }),
  /** Copies a server, secrets included, without sending them to the client. */
  Schema.TaggedStruct("McpCopy", {
    fromInstanceId: ProviderInstanceId,
    toInstanceIds: Schema.Array(ProviderInstanceId),
    name: TrimmedNonEmptyString,
  }),
  Schema.TaggedStruct("McpRemove", {
    instanceId: ProviderInstanceId,
    name: TrimmedNonEmptyString,
  }),
  Schema.TaggedStruct("McpSetEnabled", {
    instanceId: ProviderInstanceId,
    name: TrimmedNonEmptyString,
    enabled: Schema.Boolean,
  }),
  Schema.TaggedStruct("McpSignIn", {
    instanceId: ProviderInstanceId,
    name: TrimmedNonEmptyString,
  }),
  Schema.TaggedStruct("PluginInstall", {
    instanceIds: Schema.Array(ProviderInstanceId),
    pluginId: TrimmedNonEmptyString,
  }),
  Schema.TaggedStruct("PluginSetEnabled", {
    instanceId: ProviderInstanceId,
    pluginId: TrimmedNonEmptyString,
    enabled: Schema.Boolean,
  }),
  Schema.TaggedStruct("PluginUninstall", {
    instanceId: ProviderInstanceId,
    pluginId: TrimmedNonEmptyString,
  }),
  Schema.TaggedStruct("SkillLink", {
    instanceIds: Schema.Array(ProviderInstanceId),
    name: TrimmedNonEmptyString,
  }),
  Schema.TaggedStruct("SkillUnlink", {
    instanceId: ProviderInstanceId,
    name: TrimmedNonEmptyString,
  }),
  /** Moves a subscription's own skill into the shared library and links it back. */
  Schema.TaggedStruct("SkillMoveToLibrary", {
    instanceId: ProviderInstanceId,
    name: TrimmedNonEmptyString,
  }),
]);
export type ExtensionsMutation = typeof ExtensionsMutation.Type;

export const ExtensionsMutationOutcome = Schema.Struct({
  instanceId: ProviderInstanceId,
  ok: Schema.Boolean,
  message: Schema.NullOr(Schema.String),
});
export type ExtensionsMutationOutcome = typeof ExtensionsMutationOutcome.Type;

export const ExtensionsMutationResult = Schema.Struct({
  outcomes: Schema.Array(ExtensionsMutationOutcome),
});
export type ExtensionsMutationResult = typeof ExtensionsMutationResult.Type;

export class ExtensionsError extends Schema.TaggedError<ExtensionsError>()("ExtensionsError", {
  message: Schema.String,
}) {}
