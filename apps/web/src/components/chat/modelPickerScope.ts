import { type ProviderInstanceId } from "@t3tools/contracts";

import { providerModelKey } from "../../modelOrdering";

export function isModelPickerItemInSelectedScope(
  item: {
    readonly instanceId: ProviderInstanceId;
    readonly slug: string;
  },
  selectedInstanceId: ProviderInstanceId | "favorites",
  favoriteModelKeys: ReadonlySet<string>,
): boolean {
  return selectedInstanceId === "favorites"
    ? favoriteModelKeys.has(providerModelKey(item.instanceId, item.slug))
    : item.instanceId === selectedInstanceId;
}
