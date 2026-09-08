import { loadInternalWorker } from "../../internal/internal-worker.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
const KvNamespaceWorker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-core-worker/bindings/kv-namespace/KvNamespace.worker",
    ),
};
import * as Storage from "../../globals/Storage.ts";
import { formatInternalWorkerModules } from "../../internal/internal-modules.ts";
import * as Plugin from "../../Plugin.ts";
import type { BindingHook } from "../../PluginContext.ts";
import { makeRemoteBinding } from "../../remote-bindings/RemoteBindings.ts";
import { ConfigError } from "../../RuntimeError.shared.ts";
import type * as WorkerdConfig from "../../workerd/Config.ts";
import type {
  KvNamespaceProps,
  KvServiceProps,
} from "./KvNamespaceOptions.shared.ts";
import {
  BINDING_KV_BLOBS,
  BINDING_KV_ENABLE_CONTROL_ENDPOINTS,
  BINDING_KV_OBJECT,
  KV_OBJECT_CLASS_NAME,
  SERVICE_KV,
  SERVICE_KV_STORAGE,
} from "./KvNamespaceOptions.shared.ts";

export class KvNamespace extends Plugin.Service<
  KvNamespace,
  {
    /**
     * Record that a namespace is in use (so the KV services are only emitted
     * when at least one binding exists) and resolve the service designator
     * the binding should target: the shared `kv` service, with the namespace
     * id carried via designator props.
     */
    readonly register: (
      props: KvServiceProps,
    ) => Effect.Effect<WorkerdConfig.ServiceDesignator>;
  }
>()("cloudflare-runtime/plugin/KvNamespace") {}

export const KvNamespaceLive = Layer.effect(
  KvNamespace,
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
          subtag: "KvNamespace",
          message:
            "Cannot configure KV persistence: the Storage service has no disk path.",
          hint: "Configure a disk-backed storage layer (`Storage.layerDisk` or `Storage.layerTemp`).",
        });
      }
      const persistPath = path.join(storageDiskPath, "kv");
      yield* fs.makeDirectory(persistPath, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new ConfigError({
              subtag: "KvNamespace",
              message: `Failed to create KV persistence directory "${persistPath}": ${cause.message}`,
              hint: "Ensure the storage directory is writable.",
              detail: { persistPath },
              cause,
            }),
        ),
      );
      return {
        name: SERVICE_KV_STORAGE,
        disk: { path: persistPath, writable: true },
      } satisfies WorkerdConfig.Service;
    });

    return KvNamespace.of(
      Effect.sync(() => {
        let used = false;

        return {
          api: {
            register: (props) =>
              Effect.sync(() => {
                used = true;
                return {
                  name: SERVICE_KV,
                  props: { json: JSON.stringify(props) },
                };
              }),
          },
          defer: Effect.gen(function* () {
            if (!used) return {};
            const storageService = yield* makeStorageService;
            const kvService: WorkerdConfig.Service = {
              name: SERVICE_KV,
              worker: {
                compatibilityDate: "2025-01-01",
                modules: formatInternalWorkerModules(
                  yield* Effect.promise(KvNamespaceWorker.worker),
                ),
                durableObjectNamespaces: [
                  {
                    className: KV_OBJECT_CLASS_NAME,
                    enableSql: true,
                    uniqueKey: `cloudflare-runtime-${KV_OBJECT_CLASS_NAME}`,
                    preventEviction: true,
                  },
                ],
                durableObjectStorage: { localDisk: SERVICE_KV_STORAGE },
                bindings: [
                  {
                    name: BINDING_KV_OBJECT,
                    durableObjectNamespace: { className: KV_OBJECT_CLASS_NAME },
                  },
                  {
                    name: BINDING_KV_BLOBS,
                    service: { name: SERVICE_KV_STORAGE },
                  },
                  ...(enableControlEndpoints
                    ? [
                        {
                          name: BINDING_KV_ENABLE_CONTROL_ENDPOINTS,
                          json: "true",
                        },
                      ]
                    : []),
                ],
              },
            };
            return { services: [storageService, kvService] };
          }),
        };
      }),
    );
  }),
);

/**
 * Bind a local KV namespace (`env.<binding>.get()` / `.put()` / `.list()` /
 * `.delete()`).
 *
 * Data is persisted under `{storage}/kv`, keyed by the namespace id, so
 * bindings with the same `id` share data (including across workers and
 * restarts when disk-backed storage is configured).
 */
export const local = (props: KvNamespaceProps): BindingHook<KvNamespace> =>
  Plugin.use(KvNamespace, (kv) =>
    Effect.map(
      kv.api.register({ namespaceId: props.id ?? props.binding }),
      (service): WorkerdConfig.Worker_Binding => ({
        name: props.binding,
        kvNamespace: service,
      }),
    ),
  );

export const remote = (binding: string, namespaceId: string) =>
  makeRemoteBinding(
    { name: binding, type: "kv_namespace", namespaceId, raw: true },
    (service) => ({
      name: binding,
      kvNamespace: service,
    }),
  );
