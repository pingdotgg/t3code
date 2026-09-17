/**
 * Service designator props passed to the cache service entrypoint
 * (`ctx.props`) via the user worker's `cacheApiOutbound` designator. A single
 * `cache` service hosts every cache (default and named); when `enabled` is
 * false, the entry handler responds with no-ops instead of touching storage.
 */
export interface CacheServiceProps {
  readonly enabled: boolean;
}

export const SERVICE_CACHE = "cache";
export const SERVICE_CACHE_STORAGE = "cache:storage";
export const CACHE_OBJECT_CLASS_NAME = "CacheObject";

export const BINDING_CACHE_OBJECT = "OBJECT";
export const BINDING_CACHE_BLOBS = "BLOBS";
export const BINDING_CACHE_ENABLE_CONTROL_ENDPOINTS =
  "ENABLE_CONTROL_ENDPOINTS";

/**
 * Header set by workerd on Cache API requests made through `caches.open(<n>)`
 * carrying the cache name; absent for `caches.default`.
 */
export const HEADER_CACHE_NAMESPACE = "cf-cache-namespace";
/** Cache status (`HIT`/`MISS`) response header, observed by workerd. */
export const HEADER_CACHE_STATUS = "cf-cache-status";
/**
 * Internal header carrying the cache object name (URI-encoded) from the entry
 * `fetch` handler to the Durable Object, which needs it to namespace blob
 * paths on disk.
 */
export const HEADER_CACHE_OBJECT_NAME = "CF-Runtime-Cache-Name";
/**
 * Internal header marking a control operation (fake timers, storage
 * inspection). The request body is JSON `{ name, args }`. Only honoured when
 * control endpoints are enabled; used by tests.
 */
export const HEADER_CACHE_CONTROL_OP = "CF-Runtime-Cache-Control-Op";
