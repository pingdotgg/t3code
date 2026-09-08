import { loadInternalWorker } from "../../internal/internal-worker.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
const SecretsStoreStoreWorker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-core-worker/bindings/secrets-store/SecretsStore.worker",
    ),
};
const SecretsStoreSecretWorker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-core-worker/bindings/secrets-store/SecretsStoreSecret.worker",
    ),
};
import * as Storage from "../../globals/Storage.ts";
import { formatInternalWorkerModules } from "../../internal/internal-modules.ts";
import * as Plugin from "../../Plugin.ts";
import type { BindingHook } from "../../PluginContext.ts";
import { makeRemoteBinding } from "../../remote-bindings/RemoteBindings.ts";
import { ConfigError } from "../../RuntimeError.shared.ts";
import type * as WorkerdConfig from "../../workerd/Config.ts";
import {
  BINDING_KV_BLOBS,
  BINDING_KV_ENABLE_CONTROL_ENDPOINTS,
  BINDING_KV_OBJECT,
} from "../kv-namespace/KvNamespaceOptions.shared.ts";
import type {
  SecretsStoreSecretProps,
  SecretsStoreSecretServiceProps,
  SecretsStoreStoreServiceProps,
} from "./SecretsStoreOptions.shared.ts";
import {
  BINDING_SECRETS_STORE_STORE,
  SECRETS_STORE_OBJECT_CLASS_NAME,
  SECRETS_STORE_SECRET_ENTRYPOINT,
  SERVICE_SECRETS_STORE,
  SERVICE_SECRETS_STORE_SECRET,
  SERVICE_SECRETS_STORE_STORAGE,
} from "./SecretsStoreOptions.shared.ts";

export class SecretsStore extends Plugin.Service<
  SecretsStore,
  {
    /**
     * Record that a local `secrets_store_secret` binding is in use (so the
     * secrets-store services are only emitted when at least one binding
     * exists) and resolve the service designator the binding should target:
     * the shared `secrets-store:secret` service's `SecretsStoreSecret`
     * entrypoint, with the store/secret identity carried via designator
     * props.
     */
    readonly register: (
      props: SecretsStoreSecretServiceProps,
    ) => Effect.Effect<WorkerdConfig.ServiceDesignator>;
    /**
     * Resolve a designator addressing a store directly as a raw KV
     * namespace — the admin/seeding surface (`admin`) that deploy-time
     * tooling uses to write secret values into the local store.
     */
    readonly registerStore: (
      props: SecretsStoreStoreServiceProps,
    ) => Effect.Effect<WorkerdConfig.ServiceDesignator>;
  }
>()("cloudflare-runtime/plugin/SecretsStore") {}

export const SecretsStoreLive = Layer.effect(
  SecretsStore,
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
          subtag: "SecretsStore",
          message:
            "Cannot configure Secrets Store persistence: the Storage service has no disk path.",
          hint: "Configure a disk-backed storage layer (`Storage.layerDisk` or `Storage.layerTemp`).",
        });
      }
      const persistPath = path.join(storageDiskPath, "secrets-store");
      yield* fs.makeDirectory(persistPath, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new ConfigError({
              subtag: "SecretsStore",
              message: `Failed to create Secrets Store persistence directory "${persistPath}": ${cause.message}`,
              hint: "Ensure the storage directory is writable.",
              detail: { persistPath },
              cause,
            }),
        ),
      );
      return {
        name: SERVICE_SECRETS_STORE_STORAGE,
        disk: { path: persistPath, writable: true },
      } satisfies WorkerdConfig.Service;
    });

    return SecretsStore.of(
      Effect.sync(() => {
        let used = false;

        return {
          api: {
            register: (props: SecretsStoreSecretServiceProps) =>
              Effect.sync(() => {
                used = true;
                return {
                  name: SERVICE_SECRETS_STORE_SECRET,
                  entrypoint: SECRETS_STORE_SECRET_ENTRYPOINT,
                  props: { json: JSON.stringify(props) },
                };
              }),
            registerStore: (props: SecretsStoreStoreServiceProps) =>
              Effect.sync(() => {
                used = true;
                return {
                  name: SERVICE_SECRETS_STORE,
                  props: { json: JSON.stringify(props) },
                };
              }),
          },
          defer: Effect.gen(function* () {
            if (!used) return {};
            const storageService = yield* makeStorageService;
            const storeService: WorkerdConfig.Service = {
              name: SERVICE_SECRETS_STORE,
              worker: {
                compatibilityDate: "2025-01-01",
                modules: formatInternalWorkerModules(
                  yield* Effect.promise(SecretsStoreStoreWorker.worker),
                ),
                durableObjectNamespaces: [
                  {
                    className: SECRETS_STORE_OBJECT_CLASS_NAME,
                    enableSql: true,
                    uniqueKey: `cloudflare-runtime-secrets-store-${SECRETS_STORE_OBJECT_CLASS_NAME}`,
                    preventEviction: true,
                  },
                ],
                durableObjectStorage: {
                  localDisk: SERVICE_SECRETS_STORE_STORAGE,
                },
                bindings: [
                  {
                    name: BINDING_KV_OBJECT,
                    durableObjectNamespace: {
                      className: SECRETS_STORE_OBJECT_CLASS_NAME,
                    },
                  },
                  {
                    name: BINDING_KV_BLOBS,
                    service: { name: SERVICE_SECRETS_STORE_STORAGE },
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
            const secretService: WorkerdConfig.Service = {
              name: SERVICE_SECRETS_STORE_SECRET,
              worker: {
                compatibilityDate: "2025-01-01",
                modules: formatInternalWorkerModules(
                  yield* Effect.promise(SecretsStoreSecretWorker.worker),
                ),
                bindings: [
                  {
                    name: BINDING_SECRETS_STORE_STORE,
                    service: { name: SERVICE_SECRETS_STORE },
                  },
                ],
              },
            };
            return { services: [storageService, storeService, secretService] };
          }),
        };
      }),
    );
  }),
);

/**
 * Bind a local Secrets Store secret (`env.<binding>.get()`).
 *
 * Data is persisted under `{storage}/secrets-store`, keyed by the store id,
 * so bindings with the same `storeId` share data (including across workers
 * and restarts when disk-backed storage is configured). `get()` throws
 * `Secret "<secretName>" not found` (matching Miniflare) until a value is
 * seeded through the {@link admin} surface.
 */
export const local = (
  props: SecretsStoreSecretProps,
): BindingHook<SecretsStore> =>
  Plugin.use(SecretsStore, (secretsStore) =>
    Effect.map(
      secretsStore.api.register({
        storeId: props.storeId,
        secretName: props.secretName,
      }),
      (service): WorkerdConfig.Worker_Binding => ({
        name: props.binding,
        service,
      }),
    ),
  );

/**
 * Bind a local Secrets Store *store* as a raw KV namespace
 * (`env.<binding>.put(secretName, value)` / `.delete()` / `.list()`).
 *
 * This is the admin/seeding surface — the equivalent of Miniflare's
 * `getSecretsStoreSecretAPI`. Deploy-time tooling (e.g. alchemy's local
 * Secret provider, through the platform proxy) uses it to write secret
 * values into the same store the `secrets_store_secret` bindings read.
 */
export const admin = (props: {
  binding: string;
  storeId: string;
}): BindingHook<SecretsStore> =>
  Plugin.use(SecretsStore, (secretsStore) =>
    Effect.map(
      secretsStore.api.registerStore({ storeId: props.storeId }),
      (service): WorkerdConfig.Worker_Binding => ({
        name: props.binding,
        kvNamespace: service,
      }),
    ),
  );

/** Bind to a deployed Secrets Store secret via the remote bindings proxy. */
export const remote = (binding: string, storeId: string, secretName: string) =>
  makeRemoteBinding(
    {
      name: binding,
      type: "secrets_store_secret",
      storeId,
      secretName,
    },
    (service) => ({
      name: binding,
      service,
    }),
  );
