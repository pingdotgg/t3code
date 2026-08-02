import * as Schema from "effect/Schema";

import { ForwardCompatibleArray, IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
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
  /** Harness-reported runtime state, e.g. Codex auth status. */
  status: Schema.optional(TrimmedNonEmptyString),
  /**
   * Whether the harness will actually load this server. Codex reports its own
   * `enabled` flag; Claude has no per-server switch, so its entries are always
   * enabled.
   */
  enabled: Schema.Boolean,
});
export type McpServerInventoryEntry = typeof McpServerInventoryEntry.Type;

export const McpServerInventory = Schema.Struct({
  scannedAt: IsoDateTime,
  /**
   * Forward compatible: `transport` and `scope` are closed literal unions that
   * will grow (MCP keeps adding transports). A client one release behind drops
   * the rows it cannot decode instead of failing the whole page.
   */
  servers: ForwardCompatibleArray(McpServerInventoryEntry),
});
export type McpServerInventory = typeof McpServerInventory.Type;
