/** @internal */

/**
 * Inserts refreshing the key's recency, then evicts the oldest entry once the
 * map exceeds `capacity`.
 *
 * @internal
 */
export const setWithEviction = <K, V>(map: Map<K, V>, key: K, value: V, capacity: number): void => {
  map.delete(key)
  map.set(key, value)
  if (map.size <= capacity) return
  const oldest = map.keys().next().value
  if (oldest !== undefined) map.delete(oldest)
}
