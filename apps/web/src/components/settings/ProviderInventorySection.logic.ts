import type {
  ProviderDisabledInventory,
  ProviderInventoryItem,
  ProviderInventoryKind,
  ProviderInventoryStatus,
} from "@t3tools/contracts";

const INVENTORY_KINDS = [
  "connectors",
  "mcpServers",
  "plugins",
  "skills",
] as const satisfies ReadonlyArray<ProviderInventoryKind>;

export function countDisabledInventory(disabled: ProviderDisabledInventory | undefined): number {
  return INVENTORY_KINDS.reduce((total, kind) => total + (disabled?.[kind]?.length ?? 0), 0);
}

const STATUS_LABELS: Record<ProviderInventoryStatus, string> = {
  connected: "Connected",
  needsAuth: "Needs sign-in",
  failed: "Failed",
  pending: "Connecting",
  disabled: "Off in provider settings",
};

export function inventoryItemDetail(item: ProviderInventoryItem): string | null {
  const parts = [
    item.status ? STATUS_LABELS[item.status] : null,
    item.toolCount === undefined
      ? null
      : `${item.toolCount} tool${item.toolCount === 1 ? "" : "s"}`,
    item.plugin ? `from ${item.plugin}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}
