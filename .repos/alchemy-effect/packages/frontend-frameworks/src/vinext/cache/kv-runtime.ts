/**
 * vinext data-cache adapter backed by a Cloudflare KV namespace.
 * Default export is the factory `virtual:vinext-cache-adapters` calls as
 * `({ env, options }) => CacheHandler`.
 *
 * Reads `env[binding]` (default `VINEXT_KV_CACHE`). Same codec as Redis
 * and S3 via {@link makeDataCacheHandler}. Prerender pairs are uploaded
 * at `alchemy deploy` — this runtime does not walk the filesystem.
 */
import { makeDataCacheHandler, type DataCacheStore } from "./handler.ts";

export interface KvAdapterOptions extends Record<string, unknown> {
  /** Worker binding name. @default "VINEXT_KV_CACHE" */
  readonly binding?: string;
  readonly appPrefix?: string;
  readonly ttlSeconds?: number;
  readonly tagCacheTtlMs?: number;
}

const DEFAULT_BINDING = "VINEXT_KV_CACHE";
/** Cloudflare KV rejects expirationTtl below 60 seconds. */
const MIN_KV_TTL_SECONDS = 60;

interface KvNamespaceLike {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

const isKvNamespace = (value: unknown): value is KvNamespaceLike =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as KvNamespaceLike).get === "function" &&
  typeof (value as KvNamespaceLike).put === "function" &&
  typeof (value as KvNamespaceLike).delete === "function";

const kvStore = (ns: KvNamespaceLike): DataCacheStore => ({
  async getText(key) {
    return (await ns.get(key)) ?? undefined;
  },
  async putText(key, value, ttlMs) {
    const expirationTtl =
      ttlMs !== undefined && ttlMs > 0
        ? Math.max(MIN_KV_TTL_SECONDS, Math.ceil(ttlMs / 1000))
        : undefined;
    await ns.put(
      key,
      value,
      expirationTtl !== undefined ? { expirationTtl } : undefined,
    );
  },
  async delete(key) {
    await ns.delete(key);
  },
});

const createKvDataCacheAdapter = ({
  env,
  options,
}: {
  env?: Record<string, unknown>;
  options?: KvAdapterOptions;
}) => {
  const binding = options?.binding ?? DEFAULT_BINDING;
  const ns = env?.[binding];
  if (!isKvNamespace(ns)) {
    throw new Error(
      `[vinext] The KV data cache adapter requires Worker binding \`${binding}\`.`,
    );
  }
  return makeDataCacheHandler(kvStore(ns), options);
};

export default createKvDataCacheAdapter;
