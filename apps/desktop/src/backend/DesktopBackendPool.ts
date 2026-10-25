import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as FileSystem from "effect/FileSystem";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopBrowserHost from "../preview/DesktopBrowserHost.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";

const { logWarning: logBackendPoolWarning } =
  DesktopObservability.makeComponentLogger("desktop-backend-pool");

export type BackendInstanceId = DesktopBackendManager.BackendInstanceId;
export const BackendInstanceId = DesktopBackendManager.BackendInstanceId;
export const PRIMARY_INSTANCE_ID = DesktopBackendManager.PRIMARY_INSTANCE_ID;
export type DesktopBackendInstance = DesktopBackendManager.DesktopBackendInstance;
export type BackendInstanceSpec = DesktopBackendManager.BackendInstanceSpec;

export class DesktopBackendPoolInstanceAlreadyRegisteredError extends Schema.TaggedError<DesktopBackendPoolInstanceAlreadyRegisteredError>()(
  "DesktopBackendPoolInstanceAlreadyRegisteredError",
  {
    id: Schema.String,
  },
) {
  override get message() {
    return `Backend instance "${this.id}" is already registered in the pool.`;
  }
}

export class DesktopBackendPoolCannotUnregisterPrimaryError extends Schema.TaggedError<DesktopBackendPoolCannotUnregisterPrimaryError>()(
  "DesktopBackendPoolCannotUnregisterPrimaryError",
  {},
) {
  override get message() {
    return "Refusing to unregister the primary backend from the pool.";
  }
}

export class DesktopBackendPool extends Context.Service<
  DesktopBackendPool,
  {
    readonly get: (id: BackendInstanceId) => Effect.Effect<Option.Option<DesktopBackendInstance>>;
    readonly list: Effect.Effect<readonly DesktopBackendInstance[]>;
    readonly primary: Effect.Effect<DesktopBackendInstance>;
    readonly register: (
      spec: BackendInstanceSpec,
    ) => Effect.Effect<DesktopBackendInstance, DesktopBackendPoolInstanceAlreadyRegisteredError>;
    readonly unregister: (
      id: BackendInstanceId,
    ) => Effect.Effect<void, DesktopBackendPoolCannotUnregisterPrimaryError>;
  }
>()("@t3tools/desktop/backend/DesktopBackendPool") {}

export type BackendInstanceFactoryRequirements =
  | FileSystem.FileSystem
  | ChildProcessSpawner.ChildProcessSpawner
  | HttpClient.HttpClient
  | DesktopObservability.DesktopBackendOutputLogFactory
  | DesktopTelemetryPublisher.DesktopTelemetryPublisher
  | DesktopBrowserHost.DesktopBrowserHost
  | DesktopWslEnvironment.DesktopWslEnvironment;

interface ActiveRegisteredInstance {
  readonly _tag: "Active";
  readonly instance: DesktopBackendInstance;
  readonly scope: Option.Option<Scope.Closeable>;
}

interface ClosingRegisteredInstance {
  readonly _tag: "Closing";
  readonly done: Deferred.Deferred<void>;
}

type RegisteredInstance = ActiveRegisteredInstance | ClosingRegisteredInstance;

type RegisterAction =
  | { readonly _tag: "Registered"; readonly instance: DesktopBackendInstance }
  | { readonly _tag: "Wait"; readonly done: Deferred.Deferred<void> };

type UnregisterAction =
  | { readonly _tag: "Absent" }
  | { readonly _tag: "Wait"; readonly done: Deferred.Deferred<void> }
  | { readonly _tag: "Close"; readonly entry: ActiveRegisteredInstance };

export const layer = Layer.effect(
  DesktopBackendPool,
  Effect.gen(function* () {
    const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    const electronDialog = yield* ElectronDialog.ElectronDialog;
    const electronApp = yield* ElectronApp.ElectronApp;
    const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
    // Parent instance scopes to the pool so shutdown runs stop finalizers before the OS kills backends.
    const layerScope = yield* Scope.Scope;
    const factoryContext = yield* Effect.context<BackendInstanceFactoryRequirements>();

    // Persist fatal Windows fallbacks; transient transport failures must preserve the user's WSL preference.
    const handlePrimaryPreflightFailure = Effect.fn("desktop.backendPool.primaryPreflightFailed")(
      function* (failure: DesktopBackendManager.PreflightFailure) {
        const { reason, fatal } = failure;
        if (!fatal) {
          yield* logBackendPoolWarning(
            "primary WSL preflight retry window exhausted; using Windows for this launch",
            { reason },
          );
          yield* electronDialog.showErrorBox(
            "WSL backend is still unavailable",
            `${reason}\n\nT3 Code will use the Windows backend for this launch and retry WSL the next time the app starts.`,
          );
          yield* appSettings.applyWslWindowsFallbackInMemory;
          return true;
        }

        yield* logBackendPoolWarning("primary WSL preflight failed; falling back to Windows", {
          reason,
        });
        yield* electronDialog.showErrorBox(
          "WSL backend couldn't start",
          `${reason}\n\nFalling back to the Windows backend so T3 Code can open. Re-enable the WSL backend from Settings > Connections once the WSL distro is fixed.`,
        );
        // Clear wslOnly too so enabling WSL cannot restore a failed mode.
        // Keep the in-memory fallback if persistence fails.
        yield* appSettings.applyWslWindowsFallback.pipe(
          Effect.catch((error) =>
            logBackendPoolWarning(
              "failed to persist Windows fallback after WSL preflight failure",
              {
                error: error.message,
              },
            ).pipe(Effect.andThen(appSettings.applyWslWindowsFallbackInMemory)),
          ),
        );
        return true;
      },
    );

    const primary = yield* DesktopBackendManager.makeBackendInstance({
      id: DesktopBackendManager.PRIMARY_INSTANCE_ID,
      // Resolve lazily: startup loads persisted settings after pool initialization.
      label: configuration.resolvePrimaryLabel,
      configResolve: configuration.resolvePrimary,
      // Absorb window errors so readiness can reset restartAttempt.
      onReady: (httpBaseUrl) =>
        desktopWindow.handleBackendReady(httpBaseUrl).pipe(
          Effect.catch((error) =>
            logBackendPoolWarning("failed to open main window after backend readiness", {
              error: error.message,
            }),
          ),
        ),
      onShutdown: () => desktopWindow.handleBackendNotReady,
      onPreflightFailed: handlePrimaryPreflightFailure,
      onStateDirOwned: () =>
        electronDialog
          .showErrorBox(
            "This T3 home is unavailable",
            "Another T3 Code server, such as the background service, is using this data directory, or an older background service is set up for it. Stop that server or try `t3 update`. If the older launcher cannot update, run `t3 service uninstall` and optionally reinstall with `t3 service install` from a current CLI. Use `npx t3@latest` if `t3` is missing or outdated, and pass `--base-dir` with the service's T3 home to each command. Then reopen T3 Code. You can also set a separate T3CODE_HOME and pair with the running server.",
          )
          .pipe(Effect.andThen(electronApp.quit)),
    });

    const instancesRef = yield* SynchronizedRef.make<
      ReadonlyMap<BackendInstanceId, RegisteredInstance>
    >(
      new Map([
        [
          DesktopBackendManager.PRIMARY_INSTANCE_ID,
          { _tag: "Active", instance: primary, scope: Option.none() },
        ],
      ]),
    );

    const register: DesktopBackendPool["Service"]["register"] = (spec) =>
      Effect.suspend(() =>
        SynchronizedRef.modifyEffect(
          instancesRef,
          (
            current,
          ): Effect.Effect<
            readonly [RegisterAction, ReadonlyMap<BackendInstanceId, RegisteredInstance>],
            DesktopBackendPoolInstanceAlreadyRegisteredError
          > => {
            const existing = current.get(spec.id);
            if (existing?._tag === "Active") {
              return Effect.fail(
                new DesktopBackendPoolInstanceAlreadyRegisteredError({ id: spec.id }),
              );
            }
            if (existing?._tag === "Closing") {
              return Effect.succeed([
                { _tag: "Wait", done: existing.done } as const,
                current,
              ] as const);
            }
            return Effect.gen(function* () {
              // Provide the child Scope last so the captured pool Scope cannot shadow it and orphan stop/restart finalizers.
              const instanceScope = yield* Scope.fork(layerScope, "sequential");
              const instance = yield* DesktopBackendManager.makeBackendInstance(spec).pipe(
                Scope.provide(instanceScope),
                Effect.provide(factoryContext),
              );
              const next = new Map(current);
              next.set(spec.id, {
                _tag: "Active",
                instance,
                scope: Option.some(instanceScope),
              });
              return [
                { _tag: "Registered", instance } as const,
                next as ReadonlyMap<BackendInstanceId, RegisteredInstance>,
              ] as const;
            });
          },
        ).pipe(
          Effect.flatMap((result) =>
            result._tag === "Registered"
              ? Effect.succeed(result.instance)
              : Deferred.await(result.done).pipe(Effect.andThen(register(spec))),
          ),
        ),
      );

    const unregister: DesktopBackendPool["Service"]["unregister"] = Effect.fn(
      "DesktopBackendPool.unregister",
    )(function* (id) {
      if (id === DesktopBackendManager.PRIMARY_INSTANCE_ID) {
        return yield* new DesktopBackendPoolCannotUnregisterPrimaryError();
      }
      const done = yield* Deferred.make<void>();
      const action = yield* SynchronizedRef.modifyEffect(
        instancesRef,
        (
          current,
        ): Effect.Effect<
          readonly [UnregisterAction, ReadonlyMap<BackendInstanceId, RegisteredInstance>]
        > => {
          const entry = current.get(id);
          if (entry === undefined) {
            return Effect.succeed([{ _tag: "Absent" } as const, current] as const);
          }
          if (entry._tag === "Closing") {
            return Effect.succeed([{ _tag: "Wait", done: entry.done } as const, current] as const);
          }
          const next = new Map(current);
          next.set(id, { _tag: "Closing", done });
          return Effect.succeed([
            { _tag: "Close", entry } as const,
            next as ReadonlyMap<BackendInstanceId, RegisteredInstance>,
          ] as const);
        },
      );

      if (action._tag === "Absent") return;
      if (action._tag === "Wait") {
        yield* Deferred.await(action.done);
        return;
      }

      const finish = SynchronizedRef.modifyEffect(instancesRef, (current) => {
        const closing = current.get(id);
        if (closing?._tag !== "Closing" || closing.done !== done) {
          return Effect.succeed([undefined, current] as const);
        }
        const next = new Map(current);
        next.delete(id);
        return Effect.succeed([
          undefined,
          next as ReadonlyMap<BackendInstanceId, RegisteredInstance>,
        ] as const);
      }).pipe(Effect.andThen(Deferred.succeed(done, undefined)), Effect.asVoid);
      yield* Option.match(action.entry.scope, {
        onNone: () => Effect.void,
        onSome: (scope) => Scope.close(scope, Exit.void).pipe(Effect.ignore),
      }).pipe(Effect.ensuring(finish));
    });

    return DesktopBackendPool.of({
      get: (id) =>
        SynchronizedRef.get(instancesRef).pipe(
          Effect.map((instances) => {
            const entry = instances.get(id);
            return entry?._tag === "Active" ? Option.some(entry.instance) : Option.none();
          }),
        ),
      list: SynchronizedRef.get(instancesRef).pipe(
        Effect.map((instances) =>
          Array.from(instances.values()).flatMap((entry) =>
            entry._tag === "Active" ? [entry.instance] : [],
          ),
        ),
      ),
      primary: Effect.succeed(primary),
      register,
      unregister,
    });
  }),
);

export const layerTest = (
  instances: readonly DesktopBackendInstance[],
): Layer.Layer<DesktopBackendPool> =>
  Layer.effect(
    DesktopBackendPool,
    Effect.gen(function* () {
      if (instances.length === 0) {
        return yield* Effect.die("DesktopBackendPool.layerTest requires at least one instance");
      }
      const byId = new Map<BackendInstanceId, DesktopBackendInstance>(
        instances.map((instance) => [instance.id, instance] as const),
      );
      const primary = instances[0]!;
      return DesktopBackendPool.of({
        get: (id) => Effect.succeed(Option.fromNullishOr(byId.get(id))),
        list: Effect.succeed(Array.from(byId.values())),
        primary: Effect.succeed(primary),
        register: () => Effect.die("DesktopBackendPool.layerTest does not support register"),
        unregister: () => Effect.die("DesktopBackendPool.layerTest does not support unregister"),
      });
    }),
  );
