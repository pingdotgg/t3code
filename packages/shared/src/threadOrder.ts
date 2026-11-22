import { generateSpreadPinOrderKeys, pinOrderKeyBetween } from "./pinOrderKey.ts";

export function toSortableTimestamp(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function activeThreadAnchorTimestampMs(thread: {
  readonly createdAt: string;
  readonly unsettledAt?: string | null | undefined;
}): number {
  return Math.max(
    toSortableTimestamp(thread.createdAt) ?? 0,
    toSortableTimestamp(thread.unsettledAt ?? undefined) ?? 0,
  );
}

export function planPinnedReorder(input: {
  readonly orderedIds: readonly string[];
  /** Include retained keys from hidden rows; only orderedIds receive writes. */
  readonly keysById: ReadonlyMap<string, string | null | undefined>;
  readonly movedId: string;
}): ReadonlyArray<{ readonly id: string; readonly orderKey: string }> {
  const { orderedIds, keysById, movedId } = input;
  const visibleIds = new Set(orderedIds);
  const reservedKeys = new Set(
    [...keysById].flatMap(([id, key]) => (!visibleIds.has(id) && key != null ? [key] : [])),
  );
  const movedIndex = orderedIds.indexOf(movedId);
  if (movedIndex === -1) return [];
  const beforeId = movedIndex > 0 ? orderedIds[movedIndex - 1] : null;
  const afterId = movedIndex < orderedIds.length - 1 ? orderedIds[movedIndex + 1] : null;
  const beforeKey = beforeId != null ? (keysById.get(beforeId) ?? null) : null;
  const afterKey = afterId != null ? (keysById.get(afterId) ?? null) : null;
  const beforeUsable = beforeId === null || beforeKey != null;
  const afterUsable = afterId === null || afterKey != null;
  if (beforeUsable && afterUsable) {
    let key = pinOrderKeyBetween(beforeKey, afterKey);
    while (key !== null && reservedKeys.has(key)) key = pinOrderKeyBetween(key, afterKey);
    if (key !== null) return [{ id: movedId, orderKey: key }];
  }
  const keys = generateSpreadPinOrderKeys(orderedIds.length + reservedKeys.size)
    .filter((key) => !reservedKeys.has(key))
    .slice(0, orderedIds.length);
  return orderedIds.flatMap((id, index) => {
    const key = keys[index]!;
    return keysById.get(id) === key ? [] : [{ id, orderKey: key }];
  });
}

export function sortActiveThreadsByOrderKey<
  T extends {
    readonly id: string;
    readonly createdAt: string;
    readonly unsettledAt?: string | null | undefined;
    readonly activeOrderKey?: string | null | undefined;
    readonly environmentId?: string | undefined;
  },
>(threads: readonly T[]): T[] {
  if (threads.length < 2) return [...threads];
  const timestamps = new Map<T, number>();
  for (const thread of threads) {
    if (thread.activeOrderKey == null) {
      timestamps.set(thread, activeThreadAnchorTimestampMs(thread));
    }
  }
  return [...threads].sort((left, right) => {
    const leftKey = left.activeOrderKey;
    const rightKey = right.activeOrderKey;
    if (leftKey == null && rightKey != null) return -1;
    if (leftKey != null && rightKey == null) return 1;
    let order = 0;
    if (leftKey != null && rightKey != null) {
      order = leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    } else {
      order = timestamps.get(right)! - timestamps.get(left)!;
    }
    return (
      order ||
      left.id.localeCompare(right.id) ||
      (left.environmentId ?? "").localeCompare(right.environmentId ?? "")
    );
  });
}
