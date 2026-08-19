import * as Schema from "effect/Schema";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PluginMarketplaceHarnessId = Schema.Literals(["codex", "claude", "cursor"]);
export type PluginMarketplaceHarnessId = typeof PluginMarketplaceHarnessId.Type;

export const PluginMarketplaceHarnessSupport = Schema.Struct({
  harness: PluginMarketplaceHarnessId,
  mcp: Schema.Boolean,
  skills: Schema.Boolean,
  apps: Schema.Boolean,
});
export type PluginMarketplaceHarnessSupport = typeof PluginMarketplaceHarnessSupport.Type;

export const PluginMarketplaceContents = Schema.Struct({
  skillCount: Schema.Number,
  mcpServerCount: Schema.Number,
  appCount: Schema.Number,
  commandCount: Schema.Number,
  agentCount: Schema.Number,
  ruleCount: Schema.Number,
  hookCount: Schema.Number,
  hasHooks: Schema.Boolean,
});
export type PluginMarketplaceContents = typeof PluginMarketplaceContents.Type;

export const PluginMarketplacePlugin = Schema.Struct({
  id: TrimmedNonEmptyString,
  sourceHarness: PluginMarketplaceHarnessId,
  packageName: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  summary: Schema.String,
  developer: Schema.String,
  category: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  marketplaceName: TrimmedNonEmptyString,
  marketplaceSourceType: Schema.Literals(["local", "git", "unknown"]),
  installPolicy: Schema.String,
  authPolicy: Schema.String,
  installed: Schema.Boolean,
  enabled: Schema.Boolean,
  brandColor: Schema.NullOr(Schema.String),
  hasLocalLogo: Schema.Boolean,
  logoDataUrl: Schema.NullOr(Schema.String),
  logoUrl: Schema.NullOr(Schema.String),
  contents: PluginMarketplaceContents,
  support: Schema.Array(PluginMarketplaceHarnessSupport),
});
export type PluginMarketplacePlugin = typeof PluginMarketplacePlugin.Type;

export const PluginMarketplaceCatalog = Schema.Struct({
  plugins: Schema.Array(PluginMarketplacePlugin),
});
export type PluginMarketplaceCatalog = typeof PluginMarketplaceCatalog.Type;

export const PluginMarketplaceSkill = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  description: Schema.String,
  invocation: TrimmedNonEmptyString,
});
export type PluginMarketplaceSkill = typeof PluginMarketplaceSkill.Type;

export const PluginMarketplaceMcpServer = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  transport: Schema.Literals(["http", "stdio", "unknown"]),
  url: Schema.NullOr(Schema.String),
  oauthResource: Schema.NullOr(Schema.String),
  note: Schema.NullOr(Schema.String),
  toolTimeoutSeconds: Schema.NullOr(Schema.Number),
  environmentVariables: Schema.Array(TrimmedNonEmptyString),
});
export type PluginMarketplaceMcpServer = typeof PluginMarketplaceMcpServer.Type;

export const PluginMarketplaceApp = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  connectorId: Schema.NullOr(Schema.String),
});
export type PluginMarketplaceApp = typeof PluginMarketplaceApp.Type;

export const PluginMarketplaceExtensionKind = Schema.Literals([
  "command",
  "agent",
  "rule",
  "hook",
  "lsp",
  "monitor",
]);
export type PluginMarketplaceExtensionKind = typeof PluginMarketplaceExtensionKind.Type;

export const PluginMarketplaceExtension = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  kind: PluginMarketplaceExtensionKind,
  description: Schema.String,
  sourceUrl: Schema.NullOr(Schema.String),
});
export type PluginMarketplaceExtension = typeof PluginMarketplaceExtension.Type;

export const PluginMarketplaceInstallTarget = Schema.Struct({
  pluginId: TrimmedNonEmptyString,
  harness: PluginMarketplaceHarnessId,
  marketplaceName: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  installed: Schema.Boolean,
  enabled: Schema.Boolean,
  installPolicy: Schema.String,
  marketplaceUrl: Schema.NullOr(Schema.String),
  contents: PluginMarketplaceContents,
});
export type PluginMarketplaceInstallTarget = typeof PluginMarketplaceInstallTarget.Type;

export const PluginMarketplaceDetail = Schema.Struct({
  ...PluginMarketplacePlugin.fields,
  description: Schema.String,
  marketplaceUrl: Schema.NullOr(Schema.String),
  homepage: Schema.NullOr(Schema.String),
  repository: Schema.NullOr(Schema.String),
  capabilities: Schema.Array(Schema.String),
  defaultPrompts: Schema.Array(Schema.String),
  skills: Schema.Array(PluginMarketplaceSkill),
  mcpServers: Schema.Array(PluginMarketplaceMcpServer),
  apps: Schema.Array(PluginMarketplaceApp),
  extensions: Schema.Array(PluginMarketplaceExtension),
  installTargets: Schema.Array(PluginMarketplaceInstallTarget),
});
export type PluginMarketplaceDetail = typeof PluginMarketplaceDetail.Type;

export const PluginMarketplacePluginParams = Schema.Struct({
  pluginId: TrimmedNonEmptyString,
});
export type PluginMarketplacePluginParams = typeof PluginMarketplacePluginParams.Type;

export const PluginMarketplaceLogo = Schema.Struct({
  dataUrl: Schema.NullOr(Schema.String),
});
export type PluginMarketplaceLogo = typeof PluginMarketplaceLogo.Type;

export const PluginMarketplaceMutationResult = Schema.Struct({
  pluginId: TrimmedNonEmptyString,
  installed: Schema.Boolean,
});
export type PluginMarketplaceMutationResult = typeof PluginMarketplaceMutationResult.Type;

export const PluginMarketplaceSetupAction = Schema.Literals([
  "permissions",
  "accessibility",
  "automation",
]);
export type PluginMarketplaceSetupAction = typeof PluginMarketplaceSetupAction.Type;

export const PluginMarketplaceSetupInput = Schema.Struct({
  action: PluginMarketplaceSetupAction,
});
export type PluginMarketplaceSetupInput = typeof PluginMarketplaceSetupInput.Type;

export const PluginMarketplaceSetupResult = Schema.Struct({
  pluginId: TrimmedNonEmptyString,
  action: PluginMarketplaceSetupAction,
  opened: Schema.Boolean,
});
export type PluginMarketplaceSetupResult = typeof PluginMarketplaceSetupResult.Type;

export const PluginMarketplaceMcpAuthStatus = Schema.Literals([
  "unsupported",
  "not_connected",
  "connecting",
  "connected",
  "failed",
  "unavailable",
  "external",
]);
export type PluginMarketplaceMcpAuthStatus = typeof PluginMarketplaceMcpAuthStatus.Type;

export const PluginMarketplaceMcpAuthConnection = Schema.Struct({
  harness: PluginMarketplaceHarnessId,
  serverId: TrimmedNonEmptyString,
  serverName: TrimmedNonEmptyString,
  endpoint: Schema.NullOr(Schema.String),
  status: PluginMarketplaceMcpAuthStatus,
  detail: Schema.NullOr(Schema.String),
  authorizationUrl: Schema.NullOr(Schema.String),
  callbackRequired: Schema.Boolean,
  canConnect: Schema.Boolean,
  canDisconnect: Schema.Boolean,
  marketplaceUrl: Schema.NullOr(Schema.String),
});
export type PluginMarketplaceMcpAuthConnection = typeof PluginMarketplaceMcpAuthConnection.Type;

export const PluginMarketplaceMcpAuthState = Schema.Struct({
  pluginId: TrimmedNonEmptyString,
  connections: Schema.Array(PluginMarketplaceMcpAuthConnection),
});
export type PluginMarketplaceMcpAuthState = typeof PluginMarketplaceMcpAuthState.Type;

export const PluginMarketplaceMcpAuthTargetInput = Schema.Struct({
  harness: PluginMarketplaceHarnessId,
  serverId: TrimmedNonEmptyString,
});
export type PluginMarketplaceMcpAuthTargetInput = typeof PluginMarketplaceMcpAuthTargetInput.Type;

export const PluginMarketplaceMcpAuthCompleteInput = Schema.Struct({
  harness: PluginMarketplaceHarnessId,
  serverId: TrimmedNonEmptyString,
  callbackUrl: TrimmedNonEmptyString,
});
export type PluginMarketplaceMcpAuthCompleteInput =
  typeof PluginMarketplaceMcpAuthCompleteInput.Type;

export const PluginMarketplaceMcpAuthStartResult = Schema.Struct({
  pluginId: TrimmedNonEmptyString,
  harness: PluginMarketplaceHarnessId,
  serverId: TrimmedNonEmptyString,
  status: PluginMarketplaceMcpAuthStatus,
  authorizationUrl: Schema.NullOr(Schema.String),
  callbackRequired: Schema.Boolean,
});
export type PluginMarketplaceMcpAuthStartResult = typeof PluginMarketplaceMcpAuthStartResult.Type;

export const PluginMarketplaceMcpAuthMutationResult = Schema.Struct({
  pluginId: TrimmedNonEmptyString,
  harness: PluginMarketplaceHarnessId,
  serverId: TrimmedNonEmptyString,
  status: PluginMarketplaceMcpAuthStatus,
});
export type PluginMarketplaceMcpAuthMutationResult =
  typeof PluginMarketplaceMcpAuthMutationResult.Type;

export const PluginMarketplaceUnavailableReason = Schema.Literals([
  "codex_unavailable",
  "marketplaces_unavailable",
  "catalog_invalid",
]);
export type PluginMarketplaceUnavailableReason = typeof PluginMarketplaceUnavailableReason.Type;

export class PluginMarketplaceUnavailableError extends Schema.TaggedErrorClass<PluginMarketplaceUnavailableError>()(
  "PluginMarketplaceUnavailableError",
  {
    reason: PluginMarketplaceUnavailableReason,
    cause: Schema.optional(Schema.Defect()),
    exitCode: Schema.optional(Schema.Number),
  },
  { httpApiStatus: 503 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(PluginMarketplaceUnavailableError)(this, { status: 503 });
  }

  override get message(): string {
    return this.reason === "catalog_invalid"
      ? "A configured plugin marketplace returned an invalid catalog."
      : "No supported plugin marketplace is available on this environment.";
  }
}

export class PluginMarketplaceNotFoundError extends Schema.TaggedErrorClass<PluginMarketplaceNotFoundError>()(
  "PluginMarketplaceNotFoundError",
  { pluginId: TrimmedNonEmptyString },
  { httpApiStatus: 404 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(PluginMarketplaceNotFoundError)(this, { status: 404 });
  }

  override get message(): string {
    return `Plugin '${this.pluginId}' is not available from the configured marketplaces.`;
  }
}

export class PluginMarketplaceOperationError extends Schema.TaggedErrorClass<PluginMarketplaceOperationError>()(
  "PluginMarketplaceOperationError",
  {
    operation: Schema.Literals(["install", "remove", "setup", "authenticate"]),
    pluginId: TrimmedNonEmptyString,
    detail: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
    exitCode: Schema.optional(Schema.Number),
  },
  { httpApiStatus: 502 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(PluginMarketplaceOperationError)(this, { status: 502 });
  }

  override get message(): string {
    return `Could not ${this.operation} '${this.pluginId}': ${this.detail}`;
  }
}
