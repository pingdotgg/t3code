import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { loadInternalWorker } from "../../internal/internal-worker.ts";
const FlagshipWorker = {
  worker: () =>
    loadInternalWorker("#cloudflare-runtime-core-worker/bindings/flagship/Flagship.worker"),
};
import * as Storage from "../../globals/Storage.ts";
import { DEFAULT_COMPATIBILITY_DATE } from "../../internal/constants.ts";
import { formatInternalWorkerModules } from "../../internal/internal-modules.ts";
import * as Plugin from "../../Plugin.ts";
import type { BindingHook } from "../../PluginContext.ts";
import { makeRemoteBinding } from "../../remote-bindings/RemoteBindings.ts";
import { ConfigError } from "../../RuntimeError.shared.ts";
import type * as WorkerdConfig from "../../workerd/Config.ts";
import {
  evaluateFlag,
  type FlagshipDetails,
  type FlagshipValueType,
} from "./FlagshipEvaluate.shared.ts";
import type {
  FlagshipFlagDefinition,
  FlagshipProps,
  FlagshipServiceProps,
} from "./FlagshipOptions.shared.ts";
import {
  BINDING_FLAGSHIP_DISK,
  encodeSegment,
  FLAGSHIP_ENTRYPOINT,
  FLAGSHIP_STORAGE_DIRECTORY,
  flagFileSegments,
  SERVICE_FLAGSHIP,
  SERVICE_FLAGSHIP_STORAGE,
} from "./FlagshipOptions.shared.ts";

export class Flagship extends Plugin.Service<
  Flagship,
  {
    /**
     * Record that a local Flagship binding is in use (so the flagship
     * services are only emitted when at least one binding exists) and
     * resolve the designator targeting the `Flagship` evaluation
     * entrypoint for an app.
     */
    readonly register: (
      props: FlagshipServiceProps,
    ) => Effect.Effect<WorkerdConfig.ServiceDesignator>;
  }
>()("cloudflare-runtime/plugin/Flagship") {}

export const FlagshipLive = Layer.effect(
  Flagship,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const storage = yield* Storage.Storage;

    const makeStorageService = Effect.gen(function* () {
      const storageDiskPath = "disk" in storage ? storage.disk?.path : undefined;
      if (!storageDiskPath) {
        return yield* ConfigError.make({
          subtag: "Flagship",
          message: "Cannot configure Flagship persistence: the Storage service has no disk path.",
          hint: "Configure a disk-backed storage layer (`Storage.layerDisk` or `Storage.layerTemp`).",
        });
      }
      const persistPath = path.join(storageDiskPath, FLAGSHIP_STORAGE_DIRECTORY);
      yield* fs.makeDirectory(persistPath, { recursive: true }).pipe(
        Effect.mapError((cause) =>
          ConfigError.make({
            subtag: "Flagship",
            message: `Failed to create Flagship persistence directory "${persistPath}": ${cause.message}`,
            hint: "Ensure the storage directory is writable.",
            detail: { persistPath },
            cause,
          }),
        ),
      );
      return {
        name: SERVICE_FLAGSHIP_STORAGE,
        disk: { path: persistPath, writable: false },
      } satisfies WorkerdConfig.Service;
    });

    return Flagship.of(
      Effect.sync(() => {
        let used = false;

        return {
          api: {
            register: (props: FlagshipServiceProps) =>
              Effect.sync(() => {
                used = true;
                return {
                  name: SERVICE_FLAGSHIP,
                  entrypoint: FLAGSHIP_ENTRYPOINT,
                  props: { json: JSON.stringify(props) },
                };
              }),
          },
          defer: Effect.gen(function* () {
            if (!used) return {};
            const storageService = yield* makeStorageService;
            const flagshipService: WorkerdConfig.Service = {
              name: SERVICE_FLAGSHIP,
              worker: {
                compatibilityDate: DEFAULT_COMPATIBILITY_DATE,
                modules: formatInternalWorkerModules(yield* Effect.promise(FlagshipWorker.worker)),
                bindings: [
                  {
                    name: BINDING_FLAGSHIP_DISK,
                    service: { name: SERVICE_FLAGSHIP_STORAGE },
                  },
                ],
              },
            };
            return { services: [storageService, flagshipService] };
          }),
        };
      }),
    );
  }),
);

/**
 * Bind a local Flagship app (`env.<binding>.getBooleanValue()` / ...).
 *
 * Flags are evaluated locally against the definitions written with
 * {@link writeFlag} under `{storage}/flagship`, keyed by the app id, so
 * bindings with the same `appId` share flags (including across workers,
 * processes and restarts when disk-backed storage is configured). A flag
 * without a definition evaluates to the default value with
 * `errorCode: "FLAG_NOT_FOUND"`.
 */
export const local = (props: FlagshipProps): BindingHook<Flagship> =>
  Plugin.use(Flagship, (flagship) =>
    Effect.map(
      flagship.api.register({ appId: props.appId }),
      (service): WorkerdConfig.Worker_Binding => ({
        name: props.binding,
        service,
      }),
    ),
  );

/** Bind to a deployed Flagship app via the remote bindings proxy. */
export const remote = (binding: string, appId: string) =>
  makeRemoteBinding(
    {
      name: binding,
      type: "flagship",
      appId,
    },
    (service) => ({
      name: binding,
      service,
    }),
  );

// -----------------------------------------------------------------------------
// Node-side store: flag definitions are plain JSON files, so deploy-time
// tooling reads and writes them directly — no workerd instance needed — and
// running local bindings see every change on their next evaluation.
// -----------------------------------------------------------------------------

/** Location of the local Flagship store under a runtime storage directory. */
export interface FlagshipStore {
  /** The runtime's storage directory (`RuntimeConfig.storage.directory`). */
  readonly storageDirectory: string;
  readonly appId: string;
}

const flagFile = Effect.fn(function* (store: FlagshipStore, flagKey: string) {
  const path = yield* Path.Path;
  return path.join(
    store.storageDirectory,
    FLAGSHIP_STORAGE_DIRECTORY,
    ...flagFileSegments(store.appId, flagKey),
  );
});

/**
 * Write a flag definition into a local app (idempotent overwrite). The file
 * is replaced atomically, so a concurrent evaluation reads either the old or
 * the new definition.
 */
export const writeFlag = Effect.fn("Flagship.writeFlag")(function* (
  store: FlagshipStore,
  flagKey: string,
  definition: FlagshipFlagDefinition,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = yield* flagFile(store, flagKey);
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  const temp = `${file}.${yield* Effect.sync(() => crypto.randomUUID())}.tmp`;
  yield* fs.writeFileString(temp, JSON.stringify(definition));
  yield* fs.rename(temp, file);
});

/** Remove a flag from a local app (idempotent). */
export const deleteFlag = Effect.fn("Flagship.deleteFlag")(function* (
  store: FlagshipStore,
  flagKey: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(yield* flagFile(store, flagKey), { force: true });
});

/** Remove every flag of a local app (idempotent). */
export const deleteApp = Effect.fn("Flagship.deleteApp")(function* (store: FlagshipStore) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.remove(
    path.join(store.storageDirectory, FLAGSHIP_STORAGE_DIRECTORY, encodeSegment(store.appId)),
    { recursive: true, force: true },
  );
});

/**
 * Evaluate a flag of a local app from Node, with the same rules a local
 * binding applies (`expectedType` is the typed method's value type, or
 * `undefined` for the untyped `get`).
 */
export const evaluate = Effect.fn("Flagship.evaluate")(function* (
  store: FlagshipStore,
  input: {
    readonly flagKey: string;
    readonly defaultValue: unknown;
    readonly expectedType: FlagshipValueType | undefined;
    readonly context: unknown;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* flagFile(store, input.flagKey);
  const text = yield* fs
    .readFileString(file)
    .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
  let flag: FlagshipFlagDefinition | undefined;
  if (text !== undefined) {
    const parsed = yield* Effect.try(() => JSON.parse(text) as FlagshipFlagDefinition).pipe(
      Effect.option,
    );
    if (parsed._tag === "None") {
      return {
        flagKey: input.flagKey,
        value: input.defaultValue,
        reason: "ERROR",
        errorCode: "PARSE_ERROR",
        errorMessage: `Flag "${input.flagKey}" has an invalid definition`,
      } satisfies FlagshipDetails;
    }
    flag = parsed.value;
  }
  return evaluateFlag({ ...input, flag });
});
