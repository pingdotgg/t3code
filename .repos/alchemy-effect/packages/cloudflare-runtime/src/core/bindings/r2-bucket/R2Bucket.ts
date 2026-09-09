import { loadInternalWorker } from "../../internal/internal-worker.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
const R2BucketWorker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-core-worker/bindings/r2-bucket/R2Bucket.worker",
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
  R2BucketProps,
  R2ServiceProps,
} from "./R2BucketOptions.shared.ts";
import {
  BINDING_R2_BLOBS,
  BINDING_R2_ENABLE_CONTROL_ENDPOINTS,
  BINDING_R2_OBJECT,
  R2_OBJECT_CLASS_NAME,
  SERVICE_R2,
  SERVICE_R2_STORAGE,
} from "./R2BucketOptions.shared.ts";

export class R2Bucket extends Plugin.Service<
  R2Bucket,
  {
    /**
     * Record that a bucket is in use (so the R2 services are only emitted
     * when at least one binding exists) and resolve the service designator
     * the binding should target: the shared `r2` service, with the bucket
     * name carried via designator props.
     */
    readonly register: (
      props: R2ServiceProps,
    ) => Effect.Effect<WorkerdConfig.ServiceDesignator>;
  }
>()("cloudflare-runtime/plugin/R2Bucket") {}

export const R2BucketLive = Layer.effect(
  R2Bucket,
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
          subtag: "R2Bucket",
          message:
            "Cannot configure R2 persistence: the Storage service has no disk path.",
          hint: "Configure a disk-backed storage layer (`Storage.layerDisk` or `Storage.layerTemp`).",
        });
      }
      const persistPath = path.join(storageDiskPath, "r2");
      yield* fs.makeDirectory(persistPath, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new ConfigError({
              subtag: "R2Bucket",
              message: `Failed to create R2 persistence directory "${persistPath}": ${cause.message}`,
              hint: "Ensure the storage directory is writable.",
              detail: { persistPath },
              cause,
            }),
        ),
      );
      return {
        name: SERVICE_R2_STORAGE,
        disk: { path: persistPath, writable: true },
      } satisfies WorkerdConfig.Service;
    });

    return R2Bucket.of(
      Effect.sync(() => {
        let used = false;

        return {
          api: {
            register: (props) =>
              Effect.sync(() => {
                used = true;
                return {
                  name: SERVICE_R2,
                  props: { json: JSON.stringify(props) },
                };
              }),
          },
          defer: Effect.gen(function* () {
            if (!used) return {};
            const storageService = yield* makeStorageService;
            const r2Service: WorkerdConfig.Service = {
              name: SERVICE_R2,
              worker: {
                compatibilityDate: "2025-01-01",
                // `node:crypto` is used to synchronously compute multipart etags
                compatibilityFlags: ["nodejs_compat"],
                modules: formatInternalWorkerModules(
                  yield* Effect.promise(R2BucketWorker.worker),
                ),
                durableObjectNamespaces: [
                  {
                    className: R2_OBJECT_CLASS_NAME,
                    enableSql: true,
                    uniqueKey: `cloudflare-runtime-${R2_OBJECT_CLASS_NAME}`,
                    preventEviction: true,
                  },
                ],
                durableObjectStorage: { localDisk: SERVICE_R2_STORAGE },
                bindings: [
                  {
                    name: BINDING_R2_OBJECT,
                    durableObjectNamespace: { className: R2_OBJECT_CLASS_NAME },
                  },
                  {
                    name: BINDING_R2_BLOBS,
                    service: { name: SERVICE_R2_STORAGE },
                  },
                  ...(enableControlEndpoints
                    ? [
                        {
                          name: BINDING_R2_ENABLE_CONTROL_ENDPOINTS,
                          json: "true",
                        },
                      ]
                    : []),
                ],
              },
            };
            return { services: [storageService, r2Service] };
          }),
        };
      }),
    );
  }),
);

/**
 * Bind a local R2 bucket (`env.<binding>.get()` / `.put()` / `.list()` /
 * `.delete()` / multipart uploads).
 *
 * Data is persisted under `{storage}/r2`, keyed by the bucket id, so bindings
 * with the same `id` share data (including across workers and restarts when
 * disk-backed storage is configured).
 */
export const local = (props: R2BucketProps): BindingHook<R2Bucket> =>
  Plugin.use(R2Bucket, (r2) =>
    Effect.map(
      r2.api.register({ bucketName: props.id ?? props.binding }),
      (service): WorkerdConfig.Worker_Binding => ({
        name: props.binding,
        r2Bucket: service,
      }),
    ),
  );

export const remote = (
  binding: string,
  bucketName: string,
  jurisdiction?: string,
) =>
  makeRemoteBinding(
    { name: binding, type: "r2_bucket", bucketName, jurisdiction, raw: true },
    (service) => ({
      name: binding,
      r2Bucket: service,
    }),
  );
