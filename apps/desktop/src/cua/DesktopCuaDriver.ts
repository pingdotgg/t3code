import { CuaDriverMcpConfiguration, type DesktopCuaDriverRequest } from "@t3tools/contracts";
import type { EmbeddedCuaDriverHost, EmbeddedDriverConnection } from "@trycua/cua-driver/embedded";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { DesktopTelemetryPublisher } from "../telemetry/DesktopTelemetryPublisher.ts";

export interface DesktopCuaDriverDependencies {
  readonly loadEmbedded: () => Promise<{
    readonly EmbeddedCuaDriverHost: new (
      path: string,
      hostBundleId: string,
    ) => Pick<EmbeddedCuaDriverHost, "start" | "stop" | "waitForExit" | "uniffiDestroy">;
  }>;
  readonly loadElectron: () => Promise<
    Pick<
      typeof import("@trycua/cua-driver/electron"),
      "requestMacOSPermissions" | "hasRequiredMacOSPermissions"
    >
  >;
}
const decodeMcpConfiguration = Schema.decodeEffect(CuaDriverMcpConfiguration);

const defaultDependencies: DesktopCuaDriverDependencies = {
  loadEmbedded: () => import("@trycua/cua-driver/embedded"),
  loadElectron: () => import("@trycua/cua-driver/electron"),
};

export const resolveEmbeddedDriverPath = (
  environment: NodeJS.ProcessEnv,
  desktop: Pick<
    DesktopEnvironment.DesktopEnvironment["Service"],
    "isPackaged" | "platform" | "resourcesPath" | "path"
  >,
): Option.Option<string> =>
  desktop.isPackaged
    ? Option.some(
        desktop.platform === "darwin"
          ? desktop.path.join(desktop.resourcesPath, "cua-driver")
          : desktop.path.join(
              desktop.resourcesPath,
              "cua-driver",
              desktop.platform === "win32" ? "cua-driver.exe" : "cua-driver",
            ),
      )
    : Option.fromNullishOr(environment.T3CODE_CUA_DRIVER_PATH).pipe(
        Option.map((value) => value.trim()),
        Option.filter((value) => value.length > 0),
      );

interface OwnedHost {
  readonly host: Pick<EmbeddedCuaDriverHost, "start" | "stop" | "waitForExit" | "uniffiDestroy">;
  readonly abort: AbortController;
  startPromise?: Promise<EmbeddedDriverConnection>;
  monitorPromise?: Promise<unknown>;
  releasePromise?: Promise<void>;
}

interface HostedDriver {
  readonly owned: OwnedHost;
  readonly connection: EmbeddedDriverConnection;
  requestId: string;
}

export class DesktopCuaDriver extends Context.Service<
  DesktopCuaDriver,
  {
    readonly listen: Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/cua/DesktopCuaDriver") {}

export const make = Effect.fn("desktop.cuaDriver.make")(function* (
  dependencies: DesktopCuaDriverDependencies = defaultDependencies,
) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const publisher = yield* DesktopTelemetryPublisher;
  const scope = yield* Scope.Scope;
  const mutex = yield* Semaphore.make(1);
  let active: HostedDriver | undefined;
  const hosts = new Set<OwnedHost>();

  const cleanup = (owned: OwnedHost) =>
    Effect.suspend(() => {
      if (active?.owned === owned) active = undefined;
      if (!owned.releasePromise) {
        owned.abort.abort();
        // A native call may ignore cancellation. Keep its host alive until it
        // settles, then stop it and destroy it exactly once, even after timeout.
        owned.releasePromise = (async () => {
          try {
            await owned.startPromise;
          } catch {
            /* Failed starts still own a host. */
          }
          try {
            await owned.host.stop();
          } catch {
            /* Destruction must still run. */
          }
          try {
            await owned.monitorPromise;
          } catch {
            /* Cancellation ends the monitor. */
          }
          try {
            owned.host.uniffiDestroy();
          } catch {
            /* Cleanup cannot crash Electron. */
          }
          hosts.delete(owned);
        })();
      }
      return Effect.tryPromise(() => owned.releasePromise!).pipe(
        Effect.interruptible,
        Effect.timeout("3 seconds"),
        Effect.ignoreCause,
      );
    });
  const stop = Effect.suspend(() => {
    const current = [...hosts];
    active = undefined;
    return Effect.forEach(current, cleanup, { concurrency: "unbounded", discard: true });
  });
  const retireNewHosts = Effect.suspend(() => {
    active = undefined;
    return Effect.forEach(
      [...hosts].filter((owned) => !owned.releasePromise),
      cleanup,
      { concurrency: "unbounded", discard: true },
    );
  });
  yield* Effect.addFinalizer(() => retireNewHosts);

  const unavailable = (requestId: string, message: string) =>
    publisher.publishCuaReport({
      version: 1,
      type: "cuaDriverReport",
      requestId,
      status: "unavailable",
      message,
    });
  const handle = Effect.fn("desktop.cuaDriver.handle")(function* (
    request: DesktopCuaDriverRequest,
  ) {
    if (!request.enabled) {
      yield* stop;
      yield* hosts.size === 0
        ? publisher.publishCuaReport({
            version: 1,
            type: "cuaDriverReport",
            requestId: request.requestId,
            status: "stopped",
          })
        : unavailable(
            request.requestId,
            "Cua Driver is still stopping. Wait for it to exit before starting another session.",
          );
      return;
    }
    if (active) {
      active.requestId = request.requestId;
      yield* publisher.publishCuaReport({
        version: 1,
        type: "cuaDriverReport",
        requestId: request.requestId,
        status: "ready",
        mcp: active.connection.mcp,
      });
      return;
    }
    if (hosts.size > 0) {
      yield* unavailable(
        request.requestId,
        "The previous Cua Driver is still stopping. Try a new agent session after it exits.",
      );
      return;
    }
    const binaryPath = resolveEmbeddedDriverPath(process.env, environment);
    if (Option.isNone(binaryPath)) {
      yield* unavailable(
        request.requestId,
        "Cua Driver is not configured for this desktop installation.",
      );
      return;
    }
    if (environment.platform === "darwin") {
      const helpers = yield* Effect.tryPromise(dependencies.loadElectron);
      const allowed = yield* Effect.try(() =>
        helpers.hasRequiredMacOSPermissions(helpers.requestMacOSPermissions()),
      );
      if (!allowed) {
        yield* unavailable(
          request.requestId,
          "T3 Code needs Accessibility and Screen Recording access before Cua Driver can start.",
        );
        return;
      }
    }
    const module = yield* Effect.tryPromise(dependencies.loadEmbedded);
    const owned = yield* Effect.try(() => {
      const owned: OwnedHost = {
        host: new module.EmbeddedCuaDriverHost(binaryPath.value, environment.appUserModelId),
        abort: new AbortController(),
      };
      hosts.add(owned);
      return owned;
    });
    yield* Effect.gen(function* () {
      const connection = yield* Effect.tryPromise((signal) => {
        signal.addEventListener("abort", () => owned.abort.abort(), { once: true });
        owned.startPromise = owned.host.start({ signal: owned.abort.signal });
        return owned.startPromise;
      });
      const mcp = yield* decodeMcpConfiguration(connection.mcp);
      yield* Effect.try(() => {
        owned.monitorPromise = owned.host.waitForExit(connection.generation, {
          signal: owned.abort.signal,
        });
        void owned.monitorPromise.catch(() => undefined);
      });
      const hosted: HostedDriver = { owned, connection, requestId: request.requestId };
      active = hosted;
      yield* publisher.publishCuaReport({
        version: 1,
        type: "cuaDriverReport",
        requestId: request.requestId,
        status: "ready",
        mcp,
      });
      yield* Effect.tryPromise(() => owned.monitorPromise!).pipe(
        Effect.ignore,
        Effect.andThen(
          mutex.withPermits(1)(
            Effect.suspend(() => {
              if (active !== hosted) return Effect.void;
              active = undefined;
              return cleanup(owned).pipe(
                Effect.andThen(
                  unavailable(
                    hosted.requestId,
                    "Cua Driver exited. A new agent session can try starting it again.",
                  ),
                ),
              );
            }),
          ),
        ),
        Effect.forkIn(scope),
      );
    }).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? cleanup(owned) : Effect.void)));
  });
  return DesktopCuaDriver.of({
    listen: publisher.cuaRequests.pipe(
      Stream.runForEach((request) =>
        mutex.withPermits(1)(
          handle(request).pipe(
            Effect.timeout("20 seconds"),
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.failCause(cause)
                : retireNewHosts.pipe(
                    Effect.andThen(
                      unavailable(
                        request.requestId,
                        "Cua Driver could not start. Check its installation and operating system permissions.",
                      ),
                    ),
                  ),
            ),
          ),
        ),
      ),
      Effect.forkScoped,
      Effect.asVoid,
    ),
  });
});

export const layer = Layer.effect(DesktopCuaDriver, make());
