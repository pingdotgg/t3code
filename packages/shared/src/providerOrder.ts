import type { ServerSettings } from "@t3tools/contracts";

export type ProviderOrderSettings = Pick<ServerSettings, "providerOrder" | "providerInstances">;

/** Listed ids first in saved order; the rest keep their incoming order. A repeated id ranks by its first position. */
export function sortByProviderOrder<T>(
  items: readonly T[],
  order: readonly string[],
  idOf: (item: T) => string,
): T[] {
  if (order.length === 0) return [...items];
  const rank = new Map<string, number>();
  for (const [index, id] of order.entries()) {
    if (!rank.has(id)) rank.set(id, index);
  }
  // Hermes lacks Array#toSorted.
  return [...items].sort(
    (left, right) =>
      (rank.get(idOf(left)) ?? order.length) - (rank.get(idOf(right)) ?? order.length),
  );
}

/** Driver kinds in saved order, each ranked by its first listed instance. */
export function providerDriverOrder(settings: ProviderOrderSettings): string[] {
  return settings.providerOrder.map((id) => {
    const instance = Object.hasOwn(settings.providerInstances, id)
      ? settings.providerInstances[id]
      : undefined;
    // Default instance ids are the driver slug.
    return instance?.driver ?? id;
  });
}

/** The first saved order; callers that merge environments list the primary first. */
export function firstProviderOrderSettings(
  candidates: Iterable<ProviderOrderSettings | null | undefined>,
): ProviderOrderSettings | null {
  for (const settings of candidates) {
    if (settings && settings.providerOrder.length > 0) return settings;
  }
  return null;
}
