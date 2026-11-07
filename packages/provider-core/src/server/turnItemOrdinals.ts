/**
 * Allocates turn item ordinals: turn ordinals reserve a 100-item band, so an
 * overflowing turn continues past the band instead of handing the next turn
 * colliding ordinals. Values match the band scheme whenever no turn
 * overflows.
 */
export interface TurnItemOrdinalAllocator {
  readonly resolve: (
    providerTurnOrdinal: number,
    turnItems: Map<string, number>,
    nativeItemId: string,
  ) => number;
}

export const createTurnItemOrdinalAllocator = (): TurnItemOrdinalAllocator => {
  let lastAllocated = 0;
  return {
    resolve: (providerTurnOrdinal, turnItems, nativeItemId) => {
      const existing = turnItems.get(nativeItemId);
      if (existing !== undefined) return existing;
      const ordinal = Math.max(lastAllocated + 1, providerTurnOrdinal * 100 + turnItems.size + 1);
      turnItems.set(nativeItemId, ordinal);
      lastAllocated = ordinal;
      return ordinal;
    },
  };
};
