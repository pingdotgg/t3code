import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

export interface ModelSlugItem {
  readonly slug: string;
}

export interface ProviderModelItem extends ModelSlugItem {
  readonly instanceId: ProviderInstanceId;
}

export interface FavoriteModelEntry {
  readonly provider: ProviderInstanceId;
  readonly model: string;
}

export function providerModelKey(instanceId: ProviderInstanceId, slug: string): string {
  return `${instanceId}:${slug}`;
}

export function favoriteModelKey(entry: FavoriteModelEntry): string {
  return providerModelKey(entry.provider, entry.model);
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

export function sortProviderModelItems<T extends ProviderModelItem>(
  items: ReadonlyArray<T>,
  options?: {
    readonly favoriteModelKeys?: ReadonlySet<string> | ReadonlyArray<string>;
    readonly favoriteOrder?: ReadonlyArray<string>;
    readonly groupFavorites?: boolean;
    readonly instanceOrder?: ReadonlyArray<ProviderInstanceId>;
  },
): T[] {
  const favoriteModelKeys = toSet(options?.favoriteModelKeys);
  const favoriteOrder = rankByValue(options?.favoriteOrder ?? []);
  const instanceOrder = new Map(
    Arr.map(options?.instanceOrder ?? [], (instanceId, index) => [instanceId, index] as const),
  );
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
    ...(favoriteOrder.size > 0
      ? [
          byOptionalRank<T>((item) =>
            favoriteOrder.get(providerModelKey(item.instanceId, item.slug)),
          ),
        ]
      : []),
    byOptionalRank((item) => instanceOrder.get(item.instanceId)),
    byOptionalRank((item) => originalOrder.get(providerModelKey(item.instanceId, item.slug))),
  ];

  return Arr.sort(items, Order.combineAll(orders));
}

export function reorderVisibleFavorites<T extends FavoriteModelEntry>(
  allFavorites: ReadonlyArray<T>,
  visibleKeys: ReadonlyArray<string>,
  fromIndex: number,
  toIndex: number,
): T[] {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= visibleKeys.length ||
    toIndex >= visibleKeys.length
  ) {
    return [...allFavorites];
  }

  const visibleKeySet = new Set(visibleKeys);
  const byVisibleKey = new Map<string, T>();
  for (const favorite of allFavorites) {
    const key = favoriteModelKey(favorite);
    if (visibleKeySet.has(key) && !byVisibleKey.has(key)) {
      byVisibleKey.set(key, favorite);
    }
  }

  const nextVisibleKeys = [...visibleKeys];
  const [moved] = nextVisibleKeys.splice(fromIndex, 1);
  if (moved === undefined) return [...allFavorites];
  nextVisibleKeys.splice(toIndex, 0, moved);

  const nextVisibleEntries: T[] = [];
  const placedVisibleKeys = new Set<string>();
  for (const key of nextVisibleKeys) {
    const entry = byVisibleKey.get(key);
    if (!entry || placedVisibleKeys.has(key)) continue;
    placedVisibleKeys.add(key);
    nextVisibleEntries.push(entry);
  }

  const seenVisibleKeys = new Set<string>();
  let visibleCursor = 0;
  const result: T[] = [];
  for (const entry of allFavorites) {
    const key = favoriteModelKey(entry);
    if (!placedVisibleKeys.has(key)) {
      result.push(entry);
      continue;
    }
    if (seenVisibleKeys.has(key)) continue;
    seenVisibleKeys.add(key);
    result.push(nextVisibleEntries[visibleCursor++]!);
  }
  return result;
}

export function pendingFavoriteOrder<T extends FavoriteModelEntry>(
  pending: ReadonlyArray<T> | null,
  saved: ReadonlyArray<T>,
): ReadonlyArray<T> | null {
  if (pending === null || pending.length !== saved.length) return null;
  const savedKeys = saved.map(favoriteModelKey);
  const pendingKeys = pending.map(favoriteModelKey);
  const savedKeySet = new Set(savedKeys);
  const pendingKeySet = new Set(pendingKeys);
  if (savedKeySet.size !== pendingKeySet.size) return null;
  if (!pendingKeys.every((key) => savedKeySet.has(key))) return null;
  return pendingKeys.some((key, index) => key !== savedKeys[index]) ? pending : null;
}
