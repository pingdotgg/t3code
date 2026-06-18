import * as Schema from "effect/Schema";

import { PortSchema, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const MIN_MCP_TOOL_TIMEOUT_SEC = 5;

export const DesktopBootstrapWorkspaceFolder = Schema.Struct({
  key: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
  uriScheme: TrimmedNonEmptyString,
  // File URIs legitimately have an empty authority; remote and virtual hosts fill this in.
  uriAuthority: Schema.String,
});
export type DesktopBootstrapWorkspaceFolder = typeof DesktopBootstrapWorkspaceFolder.Type;

export const DesktopBootstrapMcpServer = Schema.Struct({
  name: TrimmedNonEmptyString,
  socketPath: TrimmedNonEmptyString,
  toolTimeoutSec: Schema.optional(
    Schema.Int.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(MIN_MCP_TOOL_TIMEOUT_SEC)),
  ),
});
export type DesktopBootstrapMcpServer = typeof DesktopBootstrapMcpServer.Type;

export const DESKTOP_BACKEND_ADVERTISEMENT_VERSION = 1;

export const DesktopBackendAdvertisement = Schema.Struct({
  version: Schema.Literal(DESKTOP_BACKEND_ADVERTISEMENT_VERSION),
  backendId: TrimmedNonEmptyString,
  updatedAt: TrimmedNonEmptyString,
  expiresAt: TrimmedNonEmptyString,
  httpBaseUrl: TrimmedNonEmptyString,
});
export type DesktopBackendAdvertisement = typeof DesktopBackendAdvertisement.Type;

export const HOST_MCP_ADVERTISEMENT_VERSION = 1;

export const HostMcpAdvertisement = Schema.Struct({
  version: Schema.Literal(HOST_MCP_ADVERTISEMENT_VERSION),
  hostId: TrimmedNonEmptyString,
  hostKind: Schema.Literal("vscode"),
  updatedAt: TrimmedNonEmptyString,
  expiresAt: TrimmedNonEmptyString,
  mcpServer: DesktopBootstrapMcpServer,
  workspaceFolders: Schema.Array(DesktopBootstrapWorkspaceFolder),
  activeWorkspaceFolderKey: Schema.optional(TrimmedNonEmptyString),
});
export type HostMcpAdvertisement = typeof HostMcpAdvertisement.Type;

export const DesktopBackendBootstrap = Schema.Struct({
  mode: Schema.Literal("desktop"),
  hostIntegration: Schema.optional(Schema.Literal("vscode")),
  noBrowser: Schema.Boolean,
  port: PortSchema,
  t3Home: Schema.String,
  host: Schema.String,
  desktopBootstrapToken: Schema.String,
  tailscaleServeEnabled: Schema.Boolean,
  tailscaleServePort: PortSchema,
  otlpTracesUrl: Schema.optional(Schema.String),
  otlpMetricsUrl: Schema.optional(Schema.String),
  workspaceFolders: Schema.optional(Schema.Array(DesktopBootstrapWorkspaceFolder)),
  // Consuming code must ignore this when it does not match a workspace folder key.
  activeWorkspaceFolderKey: Schema.optional(TrimmedNonEmptyString),
  mcpServers: Schema.optional(Schema.Array(DesktopBootstrapMcpServer)),
});

export type DesktopBackendBootstrap = typeof DesktopBackendBootstrap.Type;
