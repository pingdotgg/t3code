import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const McpServerTransport = Schema.Literals(["stdio", "http", "sse"]);
export type McpServerTransport = typeof McpServerTransport.Type;

export const McpServerInventoryEntry = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  harness: ProviderDriverKind,
  harnessDisplayName: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  transport: McpServerTransport,
  /** Command line for stdio servers, URL for http/sse servers. Never carries env values. */
  detail: Schema.optional(TrimmedNonEmptyString),
  /** Config file the entry was declared in, when the harness reports one. */
  configPath: Schema.optional(TrimmedNonEmptyString),
  /** Claude scopes servers as user, project (`.mcp.json`), or local. */
  scope: Schema.optional(Schema.Literals(["user", "project", "local"])),
  /** Tools advertised by a running server. Absent when only declared config is known. */
  toolCount: Schema.optional(Schema.Number),
  /** Harness-reported runtime state, e.g. Codex auth status. */
  status: Schema.optional(TrimmedNonEmptyString),
  enabled: Schema.Boolean,
  /**
   * Whether T3 Code can actually suppress this server at session launch. False
   * where the harness gives no lever, so the UI never offers a dead switch.
   */
  toggleable: Schema.Boolean,
});
export type McpServerInventoryEntry = typeof McpServerInventoryEntry.Type;

export const McpServerInventory = Schema.Struct({
  scannedAt: TrimmedNonEmptyString,
  servers: Schema.Array(McpServerInventoryEntry),
});
export type McpServerInventory = typeof McpServerInventory.Type;

export const McpServerEnabledPatch = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  name: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
});
export type McpServerEnabledPatch = typeof McpServerEnabledPatch.Type;
