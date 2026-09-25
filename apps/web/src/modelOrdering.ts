import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

export interface ModelSlugItem {
  readonly slug: string;
}

export interface ProviderModelItem extends ModelSlugItem {
  readonly instanceId: ProviderInstanceId;
}

export function providerModelKey(instanceId: ProviderInstanceId, slug: string): string {
  return `${instanceId}:${slug}`;
}

function rankByValue(values: ReadonlyArray<string>): ReadonlyMap<string, number> {
  return new Map(Arr.map(values, (value, index) => [value, index] as const));
}

function toSet(
  values: ReadonlySet<string> | ReadonlyArray<string> | undefined,
): ReadonlySet<string> {
  return values instanceof Set ? values : new Set(values ?? []);
}

function byOptionalRank<T>(rank: (item: T) => number | undefined): Order.Order<T> {
  return Order.mapInput(Order.Number, (item: T) => rank(item) ?? Number.POSITIVE_INFINITY);
}

function byTrueFirst<T>(predicate: (item: T) => boolean): Order.Order<T> {
  return Order.mapInput(Order.flip(Order.Boolean), predicate);
}

export function sortModelsForProviderInstance<T extends ModelSlugItem>(
  models: ReadonlyArray<T>,
  options?: {
    readonly modelOrder?: ReadonlyArray<string>;
    readonly favoriteModels?: ReadonlySet<string> | ReadonlyArray<string>;
    readonly groupFavorites?: boolean;
  },
): T[] {
  const modelOrder = options?.modelOrder ?? [];
  const favoriteModels = toSet(options?.favoriteModels);
  const orderBySlug = rankByValue(modelOrder);
  const originalOrder = rankByValue(Arr.map(models, (model) => model.slug));
  const orders: Array<Order.Order<T>> = [
    ...(options?.groupFavorites === true
      ? [byTrueFirst<T>((model) => favoriteModels.has(model.slug))]
      : []),
    byOptionalRank((model) => orderBySlug.get(model.slug)),
    byOptionalRank((model) => originalOrder.get(model.slug)),
  ];

  return Arr.sort(models, Order.combineAll(orders));
}

/**
 * Orders picker items. `favoriteOrder` ranks items by their key's position in
 * the user's favorites list, which is how the favorites view is ordered.
 */
export function sortProviderModelItems<T extends ProviderModelItem>(
  items: ReadonlyArray<T>,
  options?: {
    readonly favoriteModelKeys?: ReadonlySet<string> | ReadonlyArray<string>;
    readonly groupFavorites?: boolean;
    readonly favoriteOrder?: ReadonlyArray<string>;
  },
): T[] {
  const favoriteModelKeys = toSet(options?.favoriteModelKeys);
  const favoriteOrder = rankByValue(options?.favoriteOrder ?? []);
  const originalOrder = rankByValue(
    Arr.map(items, (item) => providerModelKey(item.instanceId, item.slug)),
  );
  const orders: Array<Order.Order<T>> = [
    ...(options?.groupFavorites === true
      ? [
          byTrueFirst<T>((item) =>
            favoriteModelKeys.has(providerModelKey(item.instanceId, item.slug)),
          ),
        ]
      : []),
    byOptionalRank((item) => favoriteOrder.get(providerModelKey(item.instanceId, item.slug))),
    byOptionalRank((item) => originalOrder.get(providerModelKey(item.instanceId, item.slug))),
  ];

  return Arr.sort(items, Order.combineAll(orders));
}

export interface ModelFavorite {
  readonly provider: ProviderInstanceId;
  readonly model: string;
}

/**
 * Moves the favorite at `from` to `to` within `visibleKeys`, the favorites
 * view in display order. Only the favorites the view shows trade places;
 * favorites it hides (a disabled provider, a locked thread) keep their slots.
 */
export function moveFavoriteModel<T extends ModelFavorite>(
  favorites: ReadonlyArray<T>,
  visibleKeys: ReadonlyArray<string>,
  from: number,
  to: number,
): ReadonlyArray<T> {
  if (from === to || !visibleKeys[from] || !visibleKeys[to]) return favorites;
  const moved = [...visibleKeys];
  moved.splice(to, 0, ...moved.splice(from, 1));
  const visible = new Set(visibleKeys);
  const favoriteByKey = new Map(
    Arr.map(favorites, (favorite) => [
      providerModelKey(favorite.provider, favorite.model),
      favorite,
    ]),
  );
  let next = 0;
  return Arr.map(favorites, (favorite) =>
    visible.has(providerModelKey(favorite.provider, favorite.model))
      ? (favoriteByKey.get(moved[next++] ?? "") ?? favorite)
      : favorite,
  );
}

/**
 * Replaces one provider instance's favorites. Kept favorites stay where the
 * user ordered them, duplicates collapse to their first slot, and new ones go
 * to the end.
 */
export function replaceInstanceFavorites(
  favorites: ReadonlyArray<ModelFavorite>,
  instanceId: ProviderInstanceId,
  models: ReadonlyArray<string>,
): ModelFavorite[] {
  const added = new Set(models);
  const kept = favorites.filter((favorite) => {
    if (favorite.provider !== instanceId) return true;
    return added.delete(favorite.model);
  });
  return [...kept, ...Arr.map([...added], (model) => ({ provider: instanceId, model }))];
}
