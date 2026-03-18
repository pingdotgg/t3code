// ── TTL Cache ─────────────────────────────────────────────────────────
// Simple in-memory TTL cache to reduce redundant API calls for data
// that changes infrequently.

interface TtlCacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface TtlCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  invalidate(key: string): void;
}

export function createTtlCache<T>(ttlMs: number): TtlCache<T> {
  const cache = new Map<string, TtlCacheEntry<T>>();
  return {
    get(key: string): T | undefined {
      const entry = cache.get(key);
      if (!entry) return undefined;
      if (Date.now() > entry.expiresAt) {
        cache.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key: string, value: T): void {
      cache.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
    invalidate(key: string): void {
      cache.delete(key);
    },
  };
}
