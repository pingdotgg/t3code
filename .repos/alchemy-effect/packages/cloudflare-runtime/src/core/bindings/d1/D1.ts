import { loadInternalWorker } from "../../internal/internal-worker.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
const D1Worker = {
  worker: () =>
    loadInternalWorker("#cloudflare-runtime-core-worker/bindings/d1/D1.worker"),
};
import * as Storage from "../../globals/Storage.ts";
import { formatInternalWorkerModules } from "../../internal/internal-modules.ts";
import * as Plugin from "../../Plugin.ts";
import type { BindingHook } from "../../PluginContext.ts";
import { makeRemoteBinding } from "../../remote-bindings/RemoteBindings.ts";
import { ConfigError } from "../../RuntimeError.shared.ts";
import type * as WorkerdConfig from "../../workerd/Config.ts";
import type { D1Props, D1ServiceProps } from "./D1Options.shared.ts";
import {
  BINDING_D1_OBJECT,
  D1_OBJECT_CLASS_NAME,
  SERVICE_D1,
  SERVICE_D1_STORAGE,
} from "./D1Options.shared.ts";

export class D1 extends Plugin.Service<
  D1,
  {
    /**
     * Record that a database is in use (so the D1 services are only emitted
     * when at least one binding exists) and resolve the service designator
     * the binding should target: the shared `d1` service, with the database
     * id carried via designator props.
     */
    readonly register: (
      props: D1ServiceProps,
    ) => Effect.Effect<WorkerdConfig.ServiceDesignator>;
  }
>()("cloudflare-runtime/plugin/D1") {}

export const D1Live = Layer.effect(
  D1,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const storage = yield* Storage.Storage;

    const makeStorageService = Effect.gen(function* () {
      const storageDiskPath =
        "disk" in storage ? storage.disk?.path : undefined;
      if (!storageDiskPath) {
        return yield* new ConfigError({
          subtag: "D1",
          message:
            "Cannot configure D1 persistence: the Storage service has no disk path.",
          hint: "Configure a disk-backed storage layer (`Storage.layerDisk` or `Storage.layerTemp`).",
        });
      }
      const persistPath = path.join(storageDiskPath, "d1");
      yield* fs.makeDirectory(persistPath, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new ConfigError({
              subtag: "D1",
              message: `Failed to create D1 persistence directory "${persistPath}": ${cause.message}`,
              hint: "Ensure the storage directory is writable.",
              detail: { persistPath },
              cause,
            }),
        ),
      );
      return {
        name: SERVICE_D1_STORAGE,
        disk: { path: persistPath, writable: true },
      } satisfies WorkerdConfig.Service;
    });

    return D1.of(
      Effect.sync(() => {
        let used = false;

        return {
          api: {
            register: (props) =>
              Effect.sync(() => {
                used = true;
                return {
                  name: SERVICE_D1,
                  props: { json: JSON.stringify(props) },
                };
              }),
          },
          defer: Effect.gen(function* () {
            if (!used) return {};
            const storageService = yield* makeStorageService;
            const d1Service: WorkerdConfig.Service = {
              name: SERVICE_D1,
              worker: {
                compatibilityDate: "2025-01-01",
                modules: formatInternalWorkerModules(
                  yield* Effect.promise(D1Worker.worker),
                ),
                durableObjectNamespaces: [
                  {
                    className: D1_OBJECT_CLASS_NAME,
                    enableSql: true,
                    uniqueKey: `cloudflare-runtime-${D1_OBJECT_CLASS_NAME}`,
                    preventEviction: true,
                  },
                ],
                durableObjectStorage: { localDisk: SERVICE_D1_STORAGE },
                bindings: [
                  {
                    name: BINDING_D1_OBJECT,
                    durableObjectNamespace: { className: D1_OBJECT_CLASS_NAME },
                  },
                ],
              },
            };
            return { services: [storageService, d1Service] };
          }),
        };
      }),
    );
  }),
);

/**
 * Bind a local D1 database (`env.<binding>.prepare()` / `.batch()` /
 * `.exec()`).
 *
 * The binding is the real `cloudflare-internal:d1-api` module wrapped around
 * a fetcher to the local simulator. Data lives in Durable Object SQLite,
 * persisted under `{storage}/d1` and keyed by the database id, so bindings
 * with the same `id` share data (including across workers and restarts when
 * disk-backed storage is configured).
 */
export const local = (props: D1Props): BindingHook<D1> =>
  Plugin.use(D1, (d1) =>
    Effect.map(
      d1.api.register({ databaseId: props.id ?? props.binding }),
      (service): WorkerdConfig.Worker_Binding => ({
        name: props.binding,
        wrapped: {
          moduleName: "cloudflare-internal:d1-api",
          innerBindings: [{ name: "fetcher", service }],
        },
      }),
    ),
  );

export const remote = (binding: string, id: string) =>
  makeRemoteBinding(
    { name: binding, type: "d1", id, raw: true },
    (service) => ({
      name: binding,
      wrapped: {
        moduleName: "cloudflare-internal:d1-api",
        innerBindings: [
          {
            name: "fetcher",
            service,
          },
        ],
      },
    }),
  );
