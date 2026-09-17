import type { ProviderDriverKind, ProviderInstanceId, UnifiedSettings } from "@t3tools/contracts";

type Favorite = UnifiedSettings["favorites"][number];
type Identity = { instanceId: ProviderInstanceId; driverKind: ProviderDriverKind };

/** Untagged legacy favorites remain usable unless the visible catalogue is ambiguous. */
export function matchesProviderModelFavorite(
  favorite: Favorite,
  identity: Identity,
  allowLegacy = true,
) {
  return (
    favorite.provider === identity.instanceId &&
    (favorite.driver === identity.driverKind || (favorite.driver === undefined && allowLegacy))
  );
}

export function toggleProviderModelFavorite(
  favorites: ReadonlyArray<Favorite>,
  identity: Identity,
  model: string,
  allowLegacy = true,
): Favorite[] {
  const index = favorites.findIndex(
    (favorite) =>
      favorite.model === model && matchesProviderModelFavorite(favorite, identity, allowLegacy),
  );
  return index < 0
    ? [...favorites, { provider: identity.instanceId, driver: identity.driverKind, model }]
    : favorites.filter((_, i) => i !== index);
}
