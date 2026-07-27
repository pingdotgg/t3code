import type {
  McpServerInventory,
  McpServerInventoryEntry,
  ProviderDriverKind,
} from "@t3tools/contracts";

/** Matches a POSIX or Windows home directory so paths can read as `~/...`. */
const HOME_DIRECTORY_PREFIX = /^(?:\/(?:home|Users)\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=[/\\]|$)/;

/**
 * Shortens a config path for display: home-relative, and elided to its last few
 * segments when deep. The full path stays available in the tooltip.
 */
export function formatMcpConfigPath(path: string): string {
  const homeRelative = path.replace(HOME_DIRECTORY_PREFIX, "~");
  const segments = homeRelative.split(/[/\\]/).filter(Boolean);
  if (segments.length <= 4) return homeRelative;
  return `…/${segments.slice(-3).join("/")}`;
}

export function filterMcpInventory(
  inventory: McpServerInventory,
  query: string,
): McpServerInventory {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return inventory;
  return {
    ...inventory,
    servers: inventory.servers.filter((server) =>
      [
        server.name,
        server.detail ?? "",
        server.configPath ?? "",
        server.harnessDisplayName,
        server.transport,
      ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery)),
    ),
  };
}

export interface McpHarnessGroup {
  readonly key: string;
  readonly harness: ProviderDriverKind;
  readonly harnessDisplayName: string;
  readonly servers: ReadonlyArray<McpServerInventoryEntry>;
}

/** Stable identity for a single server row, unique within an inventory. */
export function mcpServerKey(server: McpServerInventoryEntry): string {
  return `${server.providerInstanceId}:${server.name}`;
}

/**
 * Buckets servers by the harness that loads them, preserving inventory order so
 * the list renders deterministically across refreshes.
 */
export function groupMcpServersByHarness(
  servers: ReadonlyArray<McpServerInventoryEntry>,
): ReadonlyArray<McpHarnessGroup> {
  const groups = new Map<string, McpServerInventoryEntry[]>();
  for (const server of servers) {
    const key = `${server.providerInstanceId}\0${server.harnessDisplayName}`;
    const existing = groups.get(key);
    if (existing) existing.push(server);
    else groups.set(key, [server]);
  }
  return [...groups.entries()].map(([key, grouped]) => ({
    key,
    harness: grouped[0]!.harness,
    harnessDisplayName: grouped[0]?.harnessDisplayName ?? key,
    servers: grouped,
  }));
}

/**
 * Apply a toggle locally so the switch responds before the refreshed inventory
 * lands. The server response still replaces this optimistic state.
 */
export function withServerEnabled(
  inventory: McpServerInventory,
  target: { readonly providerInstanceId: string; readonly name: string },
  enabled: boolean,
): McpServerInventory {
  return {
    ...inventory,
    servers: inventory.servers.map((server) =>
      server.providerInstanceId === target.providerInstanceId && server.name === target.name
        ? { ...server, enabled }
        : server,
    ),
  };
}
