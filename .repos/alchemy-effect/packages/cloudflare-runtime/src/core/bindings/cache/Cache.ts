import { loadInternalWorker } from "../../internal/internal-worker.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
const CacheWorker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-core-worker/bindings/cache/Cache.worker",
    ),
};
import * as Storage from "../../globals/Storage.ts";
import { formatInternalWorkerModules } from "../../internal/internal-modules.ts";
import * as Plugin from "../../Plugin.ts";
import * as PluginContext from "../../PluginContext.ts";
import { ConfigError } from "../../RuntimeError.shared.ts";
import type * as WorkerdConfig from "../../workerd/Config.ts";
import type { CacheServiceProps } from "./CacheOptions.shared.ts";
import {
  BINDING_CACHE_BLOBS,
  BINDING_CACHE_ENABLE_CONTROL_ENDPOINTS,
  BINDING_CACHE_OBJECT,
  CACHE_OBJECT_CLASS_NAME,
  SERVICE_CACHE,
  SERVICE_CACHE_STORAGE,
} from "./CacheOptions.shared.ts";

export class Cache extends Plugin.Service<Cache>()(
  "cloudflare-runtime/plugin/Cache",
) {}

/**
 * Always-on plugin implementing the Cache API (`caches.default` /
 * `caches.open()`) for the user worker, by pointing the worker's
 * `cacheApiOutbound` at a local simulator service.
 *
 * Data is persisted under `{storage}/cache`, keyed by the cache name
 * (`default` or `named:<n>`), so caches survive restarts when disk-backed
 * storage is configured. Setting `cache: false` on the `RuntimeWorker` turns
 * every operation into a no-op (matching production behaviour on
 * `workers.dev` subdomains).
 */
export const CacheLive = Layer.effect(
  Cache,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const storage = yield* Storage.Storage;
    const enableControlEndpoints = yield* Plugin.UnsafeEnableControlEndpoints;

    const makeStorageService = Effect.gen(function* () {
      const storageDiskPath =
        "disk" in storage ? storage.disk?.path : undefined;
      if (!storageDiskPath) {
        return yield* new ConfigError({
          subtag: "Cache",
          message:
            "Cannot configure Cache persistence: the Storage service has no disk path.",
          hint: "Configure a disk-backed storage layer (`Storage.layerDisk` or `Storage.layerTemp`).",
        });
      }
      const persistPath = path.join(storageDiskPath, "cache");
      yield* fs.makeDirectory(persistPath, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new ConfigError({
              subtag: "Cache",
              message: `Failed to create Cache persistence directory "${persistPath}": ${cause.message}`,
              hint: "Ensure the storage directory is writable.",
              detail: { persistPath },
              cause,
            }),
        ),
      );
      return {
        name: SERVICE_CACHE_STORAGE,
        disk: { path: persistPath, writable: true },
      } satisfies WorkerdConfig.Service;
    });

    return Cache.of(
      Effect.gen(function* () {
        const context = yield* PluginContext.PluginContext;
        const enabled = context.worker.cache ?? true;

        return {
          defer: Effect.gen(function* () {
            const storageService = yield* makeStorageService;
            const cacheService: WorkerdConfig.Service = {
              name: SERVICE_CACHE,
              worker: {
                compatibilityDate: "2025-01-01",
                modules: formatInternalWorkerModules(
                  yield* Effect.promise(CacheWorker.worker),
                ),
                durableObjectNamespaces: [
                  {
                    className: CACHE_OBJECT_CLASS_NAME,
                    enableSql: true,
                    uniqueKey: `cloudflare-runtime-${CACHE_OBJECT_CLASS_NAME}`,
                    preventEviction: true,
                  },
                ],
                durableObjectStorage: { localDisk: SERVICE_CACHE_STORAGE },
                bindings: [
                  {
                    name: BINDING_CACHE_OBJECT,
                    durableObjectNamespace: {
                      className: CACHE_OBJECT_CLASS_NAME,
                    },
                  },
                  {
                    name: BINDING_CACHE_BLOBS,
                    service: { name: SERVICE_CACHE_STORAGE },
                  },
                  ...(enableControlEndpoints
                    ? [
                        {
                          name: BINDING_CACHE_ENABLE_CONTROL_ENDPOINTS,
                          json: "true",
                        },
                      ]
                    : []),
                ],
              },
            };
            return {
              services: [storageService, cacheService],
              userWorker: {
                cacheApiOutbound: {
                  name: SERVICE_CACHE,
                  props: {
                    json: JSON.stringify({
                      enabled,
                    } satisfies CacheServiceProps),
                  },
                },
              },
            };
          }),
        };
      }),
    );
  }),
);
