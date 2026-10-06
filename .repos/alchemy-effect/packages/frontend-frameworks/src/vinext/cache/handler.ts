/**
 * Shared vinext CacheHandler over a string KV-shaped store.
 *
 * Redis and S3 adapters only differ in how they persist strings. The
 * ISR / `"use cache"` codec (tags, stale-while-revalidate, ArrayBuffers)
 * lives here once so the three runtimes cannot drift.
 */
import {
  isUnknownRecord,
  keySpace,
  readCacheControlNumberField,
  readPositiveNumberField,
  readStringArrayField,
  restoreArrayBuffers,
  serializeForJSON,
  validateCacheEntry,
  validateTag,
  validUniqueTags,
  type StoredCacheControl,
} from "./shared.ts";

export interface DataCacheStore {
  getText(key: string): Promise<string | undefined>;
  putText(key: string, value: string, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface DataCacheHandlerOptions {
  readonly appPrefix?: string;
  /** Default key TTL in seconds. @default 2592000 (30 days) */
  readonly ttlSeconds?: number;
  readonly tagCacheTtlMs?: number;
}

const DEFAULT_TTL_SECONDS = 2592000;

export const makeDataCacheHandler = (
  store: DataCacheStore,
  options?: DataCacheHandlerOptions,
) => {
  const keys = keySpace(options?.appPrefix);
  const ttlSeconds = options?.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const tagCacheTtl = options?.tagCacheTtlMs ?? 5_000;
  const tagCache = new Map<string, { timestamp: number; fetchedAt: number }>();

  const ttlMsFor = (expireAt: number | null, now: number) =>
    expireAt !== null ? Math.max(expireAt - now, 1000) : ttlSeconds * 1000;

  const hasRevalidatedTag = async (
    tags: Array<string>,
    lastModified: number,
  ) => {
    if (tags.length === 0) return false;
    const now = Date.now();
    const uncached: Array<string> = [];
    for (const tag of tags) {
      const cached = tagCache.get(tag);
      if (cached && now - cached.fetchedAt < tagCacheTtl) {
        if (
          Number.isNaN(cached.timestamp) ||
          cached.timestamp >= lastModified
        ) {
          return true;
        }
      } else {
        uncached.push(tag);
      }
    }
    if (uncached.length === 0) return false;
    const results = await Promise.all(
      uncached.map((tag) => store.getText(keys.tagKey(tag))),
    );
    for (let i = 0; i < uncached.length; i++) {
      const raw = results[i];
      const timestamp = raw !== undefined ? Number(raw) : 0;
      tagCache.set(uncached[i]!, { timestamp, fetchedAt: now });
      if (
        timestamp !== 0 &&
        (Number.isNaN(timestamp) || timestamp >= lastModified)
      ) {
        return true;
      }
    }
    return false;
  };

  return {
    async get(key: string, ctx?: Record<string, unknown>) {
      const storageKey = keys.entryKey(key);
      const raw = await store.getText(storageKey);
      if (raw === undefined) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        await store.delete(storageKey);
        return null;
      }
      const entry = validateCacheEntry(parsed);
      if (!entry) {
        await store.delete(storageKey);
        return null;
      }
      let restoredValue = null;
      if (entry.value && isUnknownRecord(entry.value)) {
        restoredValue = restoreArrayBuffers(entry.value);
        if (!restoredValue) {
          await store.delete(storageKey);
          return null;
        }
      }
      if (
        await hasRevalidatedTag(validUniqueTags(entry.tags), entry.lastModified)
      ) {
        await store.delete(storageKey);
        return null;
      }
      const softTags = validUniqueTags(readStringArrayField(ctx, "softTags"));
      if (await hasRevalidatedTag(softTags, entry.lastModified)) return null;
      if (entry.expireAt !== null && Date.now() > entry.expireAt) {
        await store.delete(storageKey);
        return null;
      }
      const now = Date.now();
      const requestedRevalidate = readPositiveNumberField(ctx, "revalidate");
      const requestedRevalidateAt =
        requestedRevalidate === undefined
          ? null
          : entry.lastModified + requestedRevalidate * 1000;
      if (
        (entry.revalidateAt !== null && now > entry.revalidateAt) ||
        (requestedRevalidateAt !== null && now > requestedRevalidateAt)
      ) {
        return {
          lastModified: entry.lastModified,
          value: restoredValue,
          cacheState: "stale",
          cacheControl: entry.cacheControl,
        };
      }
      return {
        lastModified: entry.lastModified,
        value: restoredValue,
        cacheControl: entry.cacheControl,
      };
    },

    async set(
      key: string,
      data: Record<string, unknown> | null,
      ctx?: Record<string, unknown>,
    ) {
      const tagSet = new Set<string>();
      if (data && Array.isArray(data.tags)) {
        for (const tag of data.tags) {
          if (typeof tag === "string") {
            const valid = validateTag(tag);
            if (valid) tagSet.add(valid);
          }
        }
      }
      if (ctx && Array.isArray(ctx.tags)) {
        for (const tag of ctx.tags) {
          if (typeof tag === "string") {
            const valid = validateTag(tag);
            if (valid) tagSet.add(valid);
          }
        }
      }
      let effectiveRevalidate = readCacheControlNumberField(ctx, "revalidate");
      const effectiveExpire = readCacheControlNumberField(ctx, "expire");
      const effectiveStale = readCacheControlNumberField(ctx, "stale");
      if (data && typeof data.revalidate === "number") {
        effectiveRevalidate = data.revalidate;
      }
      if (effectiveRevalidate === 0) return;
      const now = Date.now();
      const revalidateAt =
        typeof effectiveRevalidate === "number" && effectiveRevalidate > 0
          ? now + effectiveRevalidate * 1000
          : null;
      const expireAt =
        typeof effectiveExpire === "number" && effectiveExpire > 0
          ? now + effectiveExpire * 1000
          : null;
      const cacheControl: StoredCacheControl | undefined =
        typeof effectiveRevalidate === "number"
          ? {
              revalidate: effectiveRevalidate,
              ...(effectiveExpire === undefined
                ? {}
                : { expire: effectiveExpire }),
              ...(effectiveStale === undefined
                ? {}
                : { stale: effectiveStale }),
            }
          : undefined;
      const entry = {
        value: data ? serializeForJSON(data) : null,
        tags: [...tagSet],
        lastModified: now,
        revalidateAt,
        expireAt,
        cacheControl,
      };
      await store.putText(
        keys.entryKey(key),
        JSON.stringify(entry),
        ttlMsFor(expireAt, now),
      );
    },

    async revalidateTag(tags: string | Array<string>) {
      const tagList = Array.isArray(tags) ? tags : [tags];
      const now = Date.now();
      const validTags = tagList.filter((tag) => validateTag(tag) !== null);
      const ttlMs = ttlSeconds * 1000;
      await Promise.all(
        validTags.map((tag) =>
          store.putText(keys.tagKey(tag), String(now), ttlMs),
        ),
      );
      for (const tag of validTags) {
        tagCache.set(tag, { timestamp: now, fetchedAt: now });
      }
    },

    resetRequestCache() {
      tagCache.clear();
    },
  };
};
