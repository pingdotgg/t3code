/**
 * Deploy-time Cloudflare KV sink for prerender seed.
 *
 * Runtime Workers use {@link kvAdapter} (`env.VINEXT_KV_CACHE` binding).
 * Deploy cannot call that binding — it talks the distilled KV HTTP API
 * with `accountId` + `namespaceId` from the Worker env. Both write the
 * same {@link DataCacheStore} shape (`putText`) so Redis / S3 / KV seed
 * through one function.
 */
import * as kv from "@distilled.cloud/cloudflare/kv";
import * as Effect from "effect/Effect";
import { vinextCacheNamespaceFromEnv } from "../PrerenderCache.ts";
import type { SeedSink } from "./seed.ts";

/** Cloudflare KV rejects expirationTtl below 60 seconds. */
const MIN_KV_TTL_SECONDS = 60;

export type KvHttpNamespace = {
  readonly accountId: string;
  readonly namespaceId: string;
};

export const kvHttpNamespaceFromEnv = (
  env: Record<string, unknown>,
): KvHttpNamespace | undefined => {
  const namespace = vinextCacheNamespaceFromEnv(env);
  if (namespace === undefined || namespace.accountId === undefined) {
    return undefined;
  }
  return {
    accountId: namespace.accountId,
    namespaceId: namespace.namespaceId,
  };
};

const ttlSeconds = (ttlMs: number | undefined): number | undefined => {
  if (ttlMs === undefined || ttlMs <= 0) return undefined;
  return Math.max(MIN_KV_TTL_SECONDS, Math.ceil(ttlMs / 1000));
};

/**
 * Effect sink over distilled `putNamespaceValue`. Requires the Worker
 * provider's Cloudflare KV layer (same as the previous inline seed).
 */
export const kvHttpSink = (
  namespace: KvHttpNamespace,
): SeedSink<kv.PutNamespaceValueError, kv.CloudflareOpContext> => ({
  putText: (key, value, ttlMs) => {
    const expirationTtl = ttlSeconds(ttlMs);
    return kv.putNamespaceValue({
      accountId: namespace.accountId,
      namespaceId: namespace.namespaceId,
      keyName: key,
      value,
      ...(expirationTtl !== undefined ? { expirationTtl } : {}),
    });
  },
});
