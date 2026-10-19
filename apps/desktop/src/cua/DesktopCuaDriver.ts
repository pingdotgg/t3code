import { CuaDriverMcpConfiguration, type DesktopCuaDriverRequest } from "@t3tools/contracts";
import type { EmbeddedCuaDriverHost, EmbeddedDriverConnection } from "@trycua/cua-driver/embedded";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";

type NativeHost = Pick<EmbeddedCuaDriverHost, "start" | "stop" | "waitForExit" | "uniffiDestroy">;

export interface DesktopCuaDriverDependencies {
  readonly loadEmbedded: () => Promise<{
    readonly EmbeddedCuaDriverHost: new (path: string, bundleId: string) => NativeHost;
  }>;
  readonly loadElectron: () => Promise<
    Pick<
      typeof import("@trycua/cua-driver/electron"),
      "requestMacOSPermissions" | "hasRequiredMacOSPermissions"
    >
  >;
}

const dependencies: DesktopCuaDriverDependencies = {
  loadEmbedded: () => import("@trycua/cua-driver/embedded"),
  loadElectron: () => import("@trycua/cua-driver/electron"),
};

interface OwnedHost {
  readonly host: NativeHost;
  readonly abort: AbortController;
  readonly started: Promise<EmbeddedDriverConnection>;
  monitor?: Promise<void>;
  cleanup?: Promise<void>;
}

export class DesktopCuaDriver extends Context.Service<
  DesktopCuaDriver,
  {
    readonly listen: Effect.Effect<void, never, import("effect/Scope").Scope>;
    readonly restart: Effect.Effect<void>;
  }
>()("@t3tools/desktop/cua/DesktopCuaDriver") {}

const decodeMcp = Schema.decodeEffect(CuaDriverMcpConfiguration);
const settle = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    () => undefined,
  );

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.fn("desktop.cua.make")(function* (
  native: DesktopCuaDriverDependencies = dependencies,
) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const publisher = yield* DesktopTelemetryPublisher.DesktopTelemetryPublisher;
  const mutex = yield* Semaphore.make(1);
  const crashes = yield* Queue.unbounded<OwnedHost>();
  let owned: OwnedHost | undefined;
  let currentRequest: DesktopCuaDriverRequest | undefined;
  let closed = false;

  // UniFFI calls can outlive cancellation. Retain the host until every native
  // promise settles, even after the public shutdown deadline has elapsed.
  const retire = (entry: OwnedHost): Promise<void> => {
    if (!entry.cleanup) {
      entry.cleanup = (async () => {
        await settle(entry.started);
        entry.abort.abort();
        await settle(Promise.resolve().then(() => entry.host.stop()));
        if (entry.monitor) await entry.monitor;
        entry.host.uniffiDestroy();
        if (owned === entry) owned = undefined;
      })();
    }
    return entry.cleanup;
  };
  const stop = Effect.suspend(() =>
    owned
      ? Effect.tryPromise(() => retire(owned!)).pipe(
          Effect.timeoutOption("2 seconds"),
          Effect.map(Option.isSome),
          Effect.orElseSucceed(() => false),
        )
      : Effect.succeed(true),
  );
  const report = (requestId: string, status: "stopped" | "unavailable", message?: string) =>
    closed
      ? Effect.void
      : publisher.publishCuaReport({
          version: 1,
          type: "cuaDriverReport",
          requestId,
          status,
          ...(message === undefined ? {} : { message }),
        });
  const unavailable = (requestId: string) =>
    report(
      requestId,
      "unavailable",
      "Computer use is unavailable. Try again after the driver has stopped.",
    );

  const restart = mutex.withPermits(1)(
    Effect.gen(function* () {
      const request = owned ? currentRequest : undefined;
      currentRequest = undefined;
      const stopped = yield* stop;
      if (request)
        yield* stopped ? report(request.requestId, "stopped") : unavailable(request.requestId);
    }),
  );

  const handleRequest = Effect.fn("desktop.cua.request")(function* (
    request: DesktopCuaDriverRequest,
  ) {
    if (closed) return;
    currentRequest = request;
    if (!request.enabled) {
      const stopped = yield* stop;
      yield* stopped ? report(request.requestId, "stopped") : unavailable(request.requestId);
      return;
    }
    if (owned?.cleanup) {
      yield* unavailable(request.requestId);
      return;
    }
    const path = environment.isPackaged
      ? environment.platform === "darwin"
        ? environment.path.join(environment.resourcesPath, "cua-driver")
        : environment.path.join(
            environment.resourcesPath,
            "cua-driver",
            environment.platform === "win32" ? "cua-driver.exe" : "cua-driver",
          )
      : process.env.T3CODE_CUA_DRIVER_PATH?.trim();
    if (!path) {
      yield* report(
        request.requestId,
        "unavailable",
        "Set T3CODE_CUA_DRIVER_PATH for development computer use.",
      );
      return;
    }

    yield* Effect.gen(function* () {
      if (!owned) {
        if (environment.platform === "darwin") {
          const permissions = yield* Effect.tryPromise(() => native.loadElectron());
          const granted = yield* Effect.try(() =>
            permissions.hasRequiredMacOSPermissions(permissions.requestMacOSPermissions()),
          );
          if (!granted) {
            yield* report(
              request.requestId,
              "unavailable",
              "Allow Accessibility and Screen Recording in System Settings, then restart computer use.",
            );
            return;
          }
        }
        const sdk = yield* Effect.tryPromise(() => native.loadEmbedded());
        // Scope closure may have happened while the lazy module was loading.
        if (closed) return;
        const host = yield* Effect.try(
          () => new sdk.EmbeddedCuaDriverHost(path, environment.appUserModelId),
        );
        const entry: OwnedHost = {
          host,
          abort: new AbortController(),
          started: Promise.resolve().then(() => host.start()),
        };
        owned = entry;
        void entry.started.then(
          (connection) => {
            entry.monitor = settle(
              Promise.resolve().then(() =>
                host.waitForExit(connection.generation, { signal: entry.abort.signal }),
              ),
            ).then(() => {
              if (!entry.cleanup && !closed) Queue.offerUnsafe(crashes, entry);
            });
          },
          () => undefined,
        );
      }
      const entry = owned;
      const connection = yield* Effect.tryPromise(() => entry.started).pipe(
        Effect.timeout("20 seconds"),
      );
      const mcp = yield* decodeMcp({ ...connection.mcp, socketPath: connection.socketPath });
      if (!closed)
        yield* publisher.publishCuaReport({
          version: 1,
          type: "cuaDriverReport",
          requestId: request.requestId,
          status: "ready",
          mcp,
        });
    }).pipe(Effect.catch(() => stop.pipe(Effect.andThen(unavailable(request.requestId)))));
  }, mutex.withPermits(1));

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closed = true;
      yield* stop;
    }),
  );

  return DesktopCuaDriver.of({
    restart,
    listen: Effect.gen(function* () {
      yield* Stream.runForEach(publisher.cuaRequests, handleRequest).pipe(Effect.forkScoped);
      yield* Effect.forever(
        Queue.take(crashes).pipe(
          Effect.flatMap((entry) =>
            mutex.withPermits(1)(
              Effect.gen(function* () {
                if (owned !== entry || entry.cleanup || closed) return;
                const request = currentRequest;
                yield* stop;
                if (request) yield* unavailable(request.requestId);
              }),
            ),
          ),
        ),
      ).pipe(Effect.forkScoped);
    }),
  });
});

export const layer = Layer.effect(DesktopCuaDriver, make());
