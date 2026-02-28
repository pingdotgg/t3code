interface CacheEntry<T> {
  value: T;
  approximateSize: number;
}

export class LRUCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private totalSize = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxMemoryBytes: number,
  ) {}

  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) {
      return null;
    }

    this.promote(key, entry);
    return entry.value;
  }

  set(key: string, value: T, approximateSize: number): void {
    const existing = this.cache.get(key);
    if (existing) {
      this.totalSize -= existing.approximateSize;
      this.cache.delete(key);
    }

    this.evictIfNeeded(approximateSize);
    this.cache.set(key, { value, approximateSize });
    this.totalSize += approximateSize;
  }

  clear(): void {
    this.cache.clear();
    this.totalSize = 0;
  }

  private promote(key: string, entry: CacheEntry<T>): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
  }

  private evictIfNeeded(incomingSize: number): void {
    while (
      (this.cache.size >= this.maxEntries || this.totalSize + incomingSize > this.maxMemoryBytes) &&
      this.cache.size > 0
    ) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }

      const oldestEntry = this.cache.get(oldestKey);
      if (oldestEntry) {
        this.totalSize -= oldestEntry.approximateSize;
      }
      this.cache.delete(oldestKey);
    }
  }
}
