// Pool registry for multiple backend processes. This file is the entry
// point for the concurrent-Windows+WSL-backend feature; see the design
// notes below before extending it.
//
// Current state:
//   - `DesktopBackendManager.ts` exposes a per-instance factory
//     (`makeBackendInstance(spec)`); the pool calls it once for the
//     Windows primary at startup, and `DesktopWslBackend.reconcile`
//     calls it through `pool.register` to bring up the WSL instance
//     when the user enables it.
//   - The primary spec wires `configResolve` to
//     `DesktopBackendConfiguration.resolvePrimary` and the
//     `onReady`/`onShutdown` callbacks to the window service. WSL
//     instances wire `configResolve: configuration.resolveWsl(...)`
//     and skip onReady/onShutdown — the window only follows the primary.
//   - The pool exposes `register(spec)` and `unregister(id)`. Each
//     registered instance gets its own child scope, so unregister can
//     stop it cleanly without tearing down the pool. The primary's id
//     refuses unregister.
//   - Settings: `wslBackendEnabled: boolean` + `wslDistro: string | null`.
//     The legacy `wslMode: "local" | "wsl"` swap setting is migrated on
//     load. IPC surface is `setWslBackendEnabled(boolean)` +
//     `setWslDistro(string | null)`; both persist and then call the
//     orchestrator's reconcile. No swap, no rollback, primary stays up.
//   - `getLocalEnvironmentBootstraps()` (plural) returns one entry per
//     pool instance currently registered with bootstrap info. The
//     primary keeps the "primary" id; WSL instances are "wsl:default"
//     or "wsl:<distro>".
//   - `pickFolder` accepts an optional `targetEnvironmentId`. Omitting
//     it gives the Windows picker — what every existing caller gets,
//     and what non-WSL users see. WSL targets route to the wsl helpers.
//   - Web settings UX: a plain toggle for "WSL backend" plus a distro
//     picker that shows up when the toggle is on. Default-off, so
//     users who never opted in see the same surface as before.
//
// Renderer-side wiring (apps/web/src/environments/local/):
//   - reconcileLocalSecondaryEnvironments() runs at app boot and after
//     WSL settings changes. It reads getLocalEnvironmentBootstraps(),
//     skips the primary (which the existing primary/ runtime owns),
//     and for every other entry POSTs the shared bootstrap token to
//     /api/auth/bootstrap/bearer on that backend's URL, fetches the
//     descriptor, builds a SavedEnvironmentRecord marked desktopLocal,
//     writes the bearer to the secret store, and opens a connection
//     through the same saved-env path remote envs use.
//   - The desktopLocal marker filters records out of saved-env
//     persistence, so toggling WSL off or switching distros doesn't
//     pollute the user's settings file. The sidebar, CommandPalette,
//     env switcher, and project-id routing all read the saved-env
//     registry, so the WSL backend shows up there without any
//     per-surface changes.
//
// Browser validation (2026-05-17, dev:desktop with wslBackendEnabled=true,
// wslDistro="Ubuntu"):
//   - Two backends listening on distinct loopback ports
//     (server.log: 13773 primary, 13774 wsl).
//   - Per-instance log files: server-child.log + server-child-wsl_Ubuntu.log.
//   - Distinct environment ids reported by each backend's
//     /.well-known/t3/environment (Windows vs Linux platform).
//   - Renderer completes the bearer-token bootstrap against the WSL
//     backend (POST /api/auth/bootstrap/bearer 200), obtains a
//     ws-token (POST /api/auth/ws-token 200), and holds an
//     ESTABLISHED WebSocket connection to both ports (netstat).
//
// Migration history (commits):
//   1. Reshape `DesktopBackendManager` into an instance factory and route
//      consumers through the pool. Pool held a single instance. (a8fc7845)
//   2. Drop `DesktopState.backendReady`. The window owns its own
//      readiness latch via onReady / onShutdown callbacks. (425c7d0b)
//   3. Per-instance log routing via DesktopBackendOutputLogFactory. (563820ed)
//   4. Add register/unregister to the pool. (a0eaf560)
//   5. Wire WSL through the pool: settings rename, BackendConfiguration
//      split, DesktopWslBackend orchestrator, new IPC, web compat.
//      (b1622191 + 31ce3add + 627c80cb)
//   6. Widen getLocalEnvironmentBootstrap to *Bootstraps (plural). (bad66041)
//   7. pickFolder takes optional targetEnvironmentId. (5d80468d)
//   8. Settings UX: toggle + distro picker, no swap dialog. (eb5a03ea)
//   9. Register WSL backend as desktop-local saved env via
//      reconcileLocalSecondaryEnvironments. (1c7e7873 + c17897bd)
//   10. CommandPalette enables file-manager picker for desktop-local
//       envs, routes pickFolder by env id. (38e8477a)

import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as FileSystem from "effect/FileSystem";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

export type BackendInstanceId = DesktopBackendManager.BackendInstanceId;
export const BackendInstanceId = DesktopBackendManager.BackendInstanceId;
export const PRIMARY_INSTANCE_ID = DesktopBackendManager.PRIMARY_INSTANCE_ID;
export type DesktopBackendInstance = DesktopBackendManager.DesktopBackendInstance;
export type BackendInstanceSpec = DesktopBackendManager.BackendInstanceSpec;

// Caller tried to register an id that's already in the pool. The pool
// refuses overwrites so two independent orchestrators racing on the
// same id surface as a typed failure instead of one silently winning.
export class DesktopBackendPoolInstanceAlreadyRegisteredError extends Data.TaggedError(
  "DesktopBackendPoolInstanceAlreadyRegisteredError",
)<{
  readonly id: BackendInstanceId;
}> {
  override get message() {
    return `Backend instance "${this.id}" is already registered in the pool.`;
  }
}

// Primary instance is registered for the pool's lifetime. Unregister is
// a no-op for it today (no real callers), but if someone wires it up
// later it's a clear bug rather than something to "handle".
export class DesktopBackendPoolCannotUnregisterPrimaryError extends Data.TaggedError(
  "DesktopBackendPoolCannotUnregisterPrimaryError",
)<{}> {
  override get message() {
    return "Refusing to unregister the primary backend from the pool.";
  }
}

export interface DesktopBackendPoolShape {
  // Look up a registered instance. None when no backend with that id is
  // currently registered (e.g. WSL backend disabled).
  readonly get: (id: BackendInstanceId) => Effect.Effect<Option.Option<DesktopBackendInstance>>;
  // Snapshot of all currently-registered instances. Order is unspecified;
  // callers that need a canonical "primary first" view should sort by id.
  readonly list: Effect.Effect<readonly DesktopBackendInstance[]>;
  // Convenience accessor for the always-registered primary instance.
  // Currently equivalent to `get(PRIMARY_INSTANCE_ID)` unwrapped, but
  // exposed as a typed effect so consumers don't have to handle the
  // Option for the case that's guaranteed to be present.
  readonly primary: Effect.Effect<DesktopBackendInstance>;
  // Build a fresh DesktopBackendInstance from `spec` and add it to the
  // registry. The pool owns the instance's scope: unregister(id) or pool
  // teardown closes it and runs the instance's auto-stop finalizer. The
  // returned instance has not been started — callers decide when to
  // start it (and can call start more than once if a retry-after-failure
  // story makes sense for them).
  readonly register: (
    spec: BackendInstanceSpec,
  ) => Effect.Effect<DesktopBackendInstance, DesktopBackendPoolInstanceAlreadyRegisteredError>;
  // Stop the named instance and remove it from the registry. Closing the
  // instance's scope triggers its auto-stop finalizer; the registry is
  // updated atomically with the scope close so subsequent get(id) calls
  // observe the unregister before the underlying child process has fully
  // exited.
  readonly unregister: (
    id: BackendInstanceId,
  ) => Effect.Effect<void, DesktopBackendPoolCannotUnregisterPrimaryError>;
}

export class DesktopBackendPool extends Context.Service<
  DesktopBackendPool,
  DesktopBackendPoolShape
>()("t3/desktop/BackendPool") {}

// Services required by makeBackendInstance — exported so caller
// orchestrators that build their own specs can confirm the layer graph
// satisfies them at compile time.
export type BackendInstanceFactoryRequirements =
  | FileSystem.FileSystem
  | ChildProcessSpawner.ChildProcessSpawner
  | HttpClient.HttpClient
  | DesktopObservability.DesktopBackendOutputLogFactory;

interface RegisteredInstance {
  readonly instance: DesktopBackendInstance;
  // None for the primary (which lives in the pool's own layer scope and
  // is never unregistered); Some for instances added via register, whose
  // scope unregister closes to stop them.
  readonly scope: Option.Option<Scope.Closeable>;
}

export const layer = Layer.effect(
  DesktopBackendPool,
  Effect.gen(function* () {
    const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    const settings = yield* DesktopAppSettings.DesktopAppSettings;
    // Anchor the pool's lifetime to its layer scope so registered
    // instance scopes can be forked off it. Without this, instance
    // scopes are orphaned: they only close via explicit unregister()
    // calls, so on app shutdown the WSL backend child process gets
    // hard-killed by the OS instead of receiving the graceful
    // SIGTERM + grace period the instance's stop finalizer would
    // otherwise run.
    const layerScope = yield* Scope.Scope;
    // Capture the services needed to build any future instance from the
    // pool's layer scope. register() runs `makeBackendInstance` against
    // a fresh child scope but reuses these services so the instance gets
    // the same FileSystem, spawner, HTTP client and log factory the
    // primary instance uses.
    const factoryContext = yield* Effect.context<BackendInstanceFactoryRequirements>();

    // Primary label is captured once per process. When wsl-only mode
    // is active, the primary's configResolve actually returns the WSL
    // backend config (see DesktopBackendConfiguration.resolvePrimary),
    // so the label needs to match. We don't try to react to runtime
    // setting changes here: the wsl-only switch requires an app
    // restart so the label reflects the mode the user is actually in.
    const initialSettings = yield* settings.get;
    const primaryLabel =
      initialSettings.wslOnly && initialSettings.wslBackendEnabled
        ? initialSettings.wslDistro
          ? `WSL (${initialSettings.wslDistro})`
          : "WSL"
        : "Windows";

    const primary = yield* DesktopBackendManager.makeBackendInstance({
      id: DesktopBackendManager.PRIMARY_INSTANCE_ID,
      label: primaryLabel,
      configResolve: configuration.resolvePrimary,
      // Window creation errors propagating out of handleBackendReady are
      // swallowed here on purpose: they're logged by the window service
      // and we don't want a stuck splash window to block the readiness
      // callback (which would prevent restartAttempt from being reset).
      onReady: (httpBaseUrl) =>
        desktopWindow.handleBackendReady(httpBaseUrl).pipe(Effect.catch(() => Effect.void)),
      onShutdown: () => desktopWindow.handleBackendNotReady,
    });

    const instancesRef = yield* SynchronizedRef.make<
      ReadonlyMap<BackendInstanceId, RegisteredInstance>
    >(
      new Map([
        [DesktopBackendManager.PRIMARY_INSTANCE_ID, { instance: primary, scope: Option.none() }],
      ]),
    );

    const register: DesktopBackendPoolShape["register"] = (spec) =>
      SynchronizedRef.modifyEffect(instancesRef, (current) => {
        if (current.has(spec.id)) {
          return Effect.fail(new DesktopBackendPoolInstanceAlreadyRegisteredError({ id: spec.id }));
        }
        return Effect.gen(function* () {
          // Forked from the pool's layer scope so the registered
          // instance auto-stops on layer teardown. unregister() still
          // closes the scope eagerly when invoked.
          const instanceScope = yield* Scope.fork(layerScope, "sequential");
          const instance = yield* DesktopBackendManager.makeBackendInstance(spec).pipe(
            Scope.provide(instanceScope),
            Effect.provide(factoryContext),
          );
          const next = new Map(current);
          next.set(spec.id, { instance, scope: Option.some(instanceScope) });
          return [instance, next as ReadonlyMap<BackendInstanceId, RegisteredInstance>] as const;
        });
      });

    const unregister: DesktopBackendPoolShape["unregister"] = (id) =>
      Effect.gen(function* () {
        if (id === DesktopBackendManager.PRIMARY_INSTANCE_ID) {
          return yield* new DesktopBackendPoolCannotUnregisterPrimaryError();
        }
        // modifyEffect atomically pulls the entry out of the registry
        // and yields the scope handle; closing the scope below runs the
        // instance's auto-stop finalizer.
        const removed = yield* SynchronizedRef.modifyEffect(instancesRef, (current) => {
          const entry = current.get(id);
          if (entry === undefined) {
            return Effect.succeed([Option.none<Scope.Closeable>(), current] as const);
          }
          const next = new Map(current);
          next.delete(id);
          return Effect.succeed([
            entry.scope,
            next as ReadonlyMap<BackendInstanceId, RegisteredInstance>,
          ] as const);
        });
        yield* Option.match(removed, {
          onNone: () => Effect.void,
          onSome: (scope) => Scope.close(scope, Exit.void).pipe(Effect.ignore),
        });
      });

    return DesktopBackendPool.of({
      get: (id) =>
        SynchronizedRef.get(instancesRef).pipe(
          Effect.map((instances) => Option.fromNullishOr(instances.get(id)?.instance)),
        ),
      list: SynchronizedRef.get(instancesRef).pipe(
        Effect.map((instances) => Array.from(instances.values(), (entry) => entry.instance)),
      ),
      primary: Effect.succeed(primary),
      register,
      unregister,
    });
  }),
);

// Test layer for unit tests that want to assert against a known pool
// composition without standing up the full manager. Each provided
// instance is registered under its own id; the first one is also
// surfaced as `primary` so callers can stub a single-instance pool.
// `register` and `unregister` are stubbed to die so tests that
// accidentally exercise pool registration fail loudly instead of
// silently noop'ing.
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
