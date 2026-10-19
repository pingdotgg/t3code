import * as NodeModule from "node:module";

import { CuaDriverMcpConfiguration } from "@t3tools/contracts";
import type { EmbeddedCuaDriverHost, EmbeddedDriverConnection } from "@trycua/cua-driver/embedded";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CuaDriverInstallation from "./CuaDriverInstallation.ts";

export class CuaDriverStartError extends Schema.TaggedError<CuaDriverStartError>()(
  "CuaDriverStartError",
  { binaryPath: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return "Failed to start Cua Driver.";
  }
}

export class CuaDriverHostError extends Schema.TaggedError<CuaDriverHostError>()(
  "CuaDriverHostError",
  {
    operation: Schema.Literals(["busy", "start", "stop", "exit", "desktop", "timeout"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Cua Driver host failed during ${this.operation}.`;
  }
}

export type CuaDriverError = CuaDriverStartError | CuaDriverHostError;

const decodeMcp = Schema.decodeEffect(CuaDriverMcpConfiguration);
const isStartError = Schema.is(CuaDriverStartError);

export interface CuaDriverHost {
  readonly start: Effect.Effect<CuaDriverMcpConfiguration, CuaDriverError>;
  readonly stop: Effect.Effect<void, CuaDriverError>;
  readonly waitForExit: Effect.Effect<void, CuaDriverError>;
}

export class CuaDriver extends Context.Service<
  CuaDriver,
  {
    readonly acquire: Effect.Effect<Option.Option<CuaDriverMcpConfiguration>>;
    readonly enabled: Effect.Effect<boolean>;
    readonly lastFailure: Effect.Effect<Option.Option<CuaDriverError>>;
  }
>()("t3/cua/CuaDriver") {}

interface Acquisition {
  readonly result: Deferred.Deferred<Option.Option<CuaDriverMcpConfiguration>>;
  host?: CuaDriverHost;
  cleanup?: Fiber.Fiber<void>;
  watcher?: Fiber.Fiber<void> | undefined;
  revoked: boolean;
}

export const make = Effect.fn("CuaDriver.make")(function* (
  factory: Effect.Effect<CuaDriverHost, CuaDriverError>,
) {
  const settings = yield* ServerSettings.ServerSettingsService;
  const changes = yield* settings.subscribeChanges;
  let active: Acquisition | undefined;
  let closed = false;
  let failure = Option.none<CuaDriverError>();

  const stop = Effect.fnUntraced(function* (entry: Acquisition) {
    if (entry.watcher) yield* Fiber.interrupt(entry.watcher).pipe(Effect.forkDetach);
    if (!entry.cleanup && entry.host) {
      entry.cleanup = yield* entry.host.stop.pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            if (active === entry || active === undefined) failure = Option.some(error);
          }),
        ),
        Effect.ignoreCause({ log: true }),
        Effect.forkDetach({ startImmediately: true }),
      );
    }
    if (entry.cleanup) yield* Fiber.join(entry.cleanup).pipe(Effect.timeoutOption("4 seconds"));
  });

  const revoke = Effect.fnUntraced(function* (entry: Acquisition) {
    entry.revoked = true;
    if (active === entry) active = undefined;
    yield* Deferred.succeed(entry.result, Option.none());
    yield* stop(entry);
  });

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closed = true;
      if (active) yield* revoke(active);
    }),
  );
  yield* changes.pipe(
    Stream.runForEach((value) =>
      Effect.gen(function* () {
        if (!value.enableCua && active) yield* revoke(active);
      }),
    ),
    Effect.forkScoped,
  );

  const start = Effect.fnUntraced(
    function* (entry: Acquisition) {
      if (entry.revoked) return;
      entry.host = yield* factory;
      if (entry.revoked) {
        yield* stop(entry);
        return;
      }
      const mcp = yield* entry.host.start.pipe(
        Effect.timeoutOrElse({
          duration: "30 seconds",
          orElse: () => Effect.fail(new CuaDriverHostError({ operation: "timeout" })),
        }),
      );
      if (entry.revoked) return;
      failure = Option.none();
      yield* Deferred.succeed(entry.result, Option.some(mcp));
      entry.watcher = yield* entry.host.waitForExit.pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => new CuaDriverHostError({ operation: "exit" }),
        }),
        Effect.flatMap((error) =>
          Effect.gen(function* () {
            if (active !== entry) return;
            failure = Option.some(error);
            // The watcher must not interrupt itself while retiring its host.
            entry.watcher = undefined;
            yield* revoke(entry);
          }),
        ),
        Effect.forkDetach,
      );
    },
    (effect, entry) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (active !== entry) return;
            failure = Option.some(
              Option.getOrElse(
                Cause.findErrorOption(cause),
                () => new CuaDriverHostError({ operation: "start", cause: Cause.squash(cause) }),
              ),
            );
            yield* stop(entry);
            yield* revoke(entry);
          }),
        ),
      ),
  );

  const enabled = settings.getSettings.pipe(
    Effect.map((value) => !closed && value.enableCua),
    Effect.catch((cause) =>
      Effect.sync(() => {
        failure = Option.some(new CuaDriverHostError({ operation: "start", cause }));
        return false;
      }),
    ),
  );
  const acquire = Effect.gen(function* () {
    if (!(yield* enabled)) {
      if (active) yield* revoke(active);
      return Option.none<CuaDriverMcpConfiguration>();
    }
    let entry = active;
    if (!entry) {
      entry = {
        result: yield* Deferred.make<Option.Option<CuaDriverMcpConfiguration>>(),
        revoked: false,
      };
      active = entry;
      yield* start(entry).pipe(Effect.forkDetach);
    }
    return yield* Deferred.await(entry.result);
  });
  return CuaDriver.of({ acquire, enabled, lastFailure: Effect.sync(() => failure) });
});

type NativeModule = {
  readonly EmbeddedCuaDriverHost: new (
    binaryPath: string,
    bundleId: string,
  ) => Pick<EmbeddedCuaDriverHost, "start" | "stop" | "waitForExit" | "uniffiDestroy">;
};

// SEA can load file-backed SDKs through require. This SDK only exports import
// conditions, so resolve its package directory and require the entry file directly.
const requireForCuaDriver = NodeModule.createRequire(import.meta.url);

export const makeStandaloneHostFactory = Effect.fn("CuaDriver.makeStandaloneHostFactory")(
  function* <E, M>(executable: Effect.Effect<string, E>, module?: Effect.Effect<NativeModule, M>) {
    const environment = yield* HostProcess.Environment;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    let owned = false;
    return Effect.gen(function* () {
      if (owned) return yield* new CuaDriverHostError({ operation: "busy" });
      const binaryPath =
        environment.T3CODE_CUA_DRIVER_PATH?.trim() ||
        (yield* executable.pipe(
          Effect.mapError((cause) => new CuaDriverHostError({ operation: "start", cause })),
        ));
      const sdk = yield* module === undefined
        ? Effect.gen(function* () {
            for (const lookup of requireForCuaDriver.resolve.paths("@trycua/cua-driver") ?? []) {
              const directory = path.join(lookup, "@trycua", "cua-driver");
              if (yield* fs.exists(path.join(directory, "package.json"))) {
                return yield* Effect.try({
                  try: () =>
                    requireForCuaDriver(
                      path.join(directory, "dist", "embedded.js"),
                    ) as NativeModule,
                  catch: (cause) => new CuaDriverStartError({ binaryPath, cause }),
                });
              }
            }
            return yield* new CuaDriverStartError({
              binaryPath,
              cause: "@trycua/cua-driver is not installed beside this server.",
            });
          }).pipe(
            Effect.mapError((cause) =>
              isStartError(cause) ? cause : new CuaDriverStartError({ binaryPath, cause }),
            ),
          )
        : module.pipe(Effect.mapError((cause) => new CuaDriverStartError({ binaryPath, cause })));
      // Acquisition can suspend during installation/loading, so check ownership again.
      if (owned) return yield* new CuaDriverHostError({ operation: "busy" });
      const native = yield* Effect.try({
        try: () => new sdk.EmbeddedCuaDriverHost(binaryPath, "com.t3tools.t3code.server"),
        catch: (cause) => new CuaDriverStartError({ binaryPath, cause }),
      });
      owned = true;
      let starting: Promise<EmbeddedDriverConnection> | undefined;
      let stopping: Promise<void> | undefined;
      const watchers = new Map<AbortController, Promise<unknown>>();

      const start = Effect.tryPromise({
        try: () => {
          if (stopping) return Promise.reject(new CuaDriverHostError({ operation: "start" }));
          starting ??= native.start();
          return starting;
        },
        catch: (cause) => new CuaDriverStartError({ binaryPath, cause }),
      }).pipe(
        Effect.flatMap((connection) =>
          decodeMcp({
            ...connection.mcp,
            socketPath: connection.socketPath,
          }),
        ),
        Effect.mapError((cause) =>
          isStartError(cause) ? cause : new CuaDriverStartError({ binaryPath, cause }),
        ),
      );

      const stop = Effect.tryPromise({
        try: () =>
          (stopping ??= (async () => {
            // UniFFI cancellation ends the JS wait before native work necessarily settles.
            // Retain the owner until every owned operation has settled, even after public shutdown.
            await starting?.catch(() => undefined);
            for (const controller of watchers.keys()) controller.abort();
            await Promise.allSettled(watchers.values());
            try {
              await native.stop();
            } finally {
              owned = false;
              native.uniffiDestroy();
            }
          })()),
        catch: (cause) => new CuaDriverHostError({ operation: "stop", cause }),
      });
      const waitForExit = Effect.tryPromise({
        try: async (signal) => {
          const connection = await starting;
          if (!connection || stopping) return;
          const controller = new AbortController();
          const abort = () => controller.abort();
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) controller.abort();
          const waiting = native.waitForExit(connection.generation, { signal: controller.signal });
          watchers.set(controller, waiting);
          try {
            await waiting;
          } finally {
            watchers.delete(controller);
            signal.removeEventListener("abort", abort);
          }
        },
        catch: (cause) => new CuaDriverHostError({ operation: "exit", cause }),
      });
      return { start, stop, waitForExit } satisfies CuaDriverHost;
    });
  },
);

export const makeDesktopHostFactory = Effect.fn("CuaDriver.makeDesktopHostFactory")(function* () {
  const receiver = yield* DesktopTelemetryReceiver.DesktopTelemetryReceiver;
  const crypto = yield* Crypto.Crypto;
  return Effect.gen(function* () {
    const requestId = yield* crypto
      .randomUUIDv4()
      .pipe(Effect.mapError((cause) => new CuaDriverHostError({ operation: "desktop", cause })));
    const scope = yield* Scope.make();
    const ready = yield* Deferred.make<CuaDriverMcpConfiguration, CuaDriverError>();
    const stopped = yield* Deferred.make<void>();
    let requested = false;
    let retired = false;
    const unavailable = new CuaDriverHostError({ operation: "desktop" });
    const start = Effect.gen(function* () {
      // Start the subscription before writing: the desktop may reply synchronously.
      yield* receiver.cuaReports.pipe(
        Stream.runForEach((report) =>
          Effect.gen(function* () {
            if (report.requestId !== requestId) return;
            if (report.status === "ready") yield* Deferred.succeed(ready, report.mcp);
            else {
              yield* Deferred.fail(ready, unavailable);
              yield* Deferred.succeed(stopped, undefined);
            }
          }),
        ),
        Effect.ensuring(
          Deferred.fail(ready, unavailable).pipe(
            Effect.andThen(Deferred.succeed(stopped, undefined)),
          ),
        ),
        Effect.forkIn(scope, { startImmediately: true }),
      );
      const health = yield* receiver.subscribeHealth.pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      if (health.latest.status === "unavailable" || health.latest.status === "stopped")
        return yield* unavailable;
      yield* health.changes.pipe(
        Stream.runForEach((value) =>
          value.status === "stopped" || value.status === "unavailable"
            ? Deferred.fail(ready, unavailable).pipe(
                Effect.andThen(Deferred.succeed(stopped, undefined)),
              )
            : Effect.void,
        ),
        Effect.forkIn(scope, { startImmediately: true }),
      );
      if (retired) return yield* unavailable;
      requested = true;
      yield* receiver
        .requestCuaDriver(requestId, true)
        .pipe(Effect.mapError((cause) => new CuaDriverHostError({ operation: "desktop", cause })));
      return yield* Deferred.await(ready);
    });
    const stop = Effect.gen(function* () {
      retired = true;
      if (!requested) return;
      yield* receiver
        .requestCuaDriver(requestId, false)
        .pipe(Effect.mapError((cause) => new CuaDriverHostError({ operation: "desktop", cause })));
      yield* Deferred.await(stopped).pipe(Effect.timeoutOption("3 seconds"));
    }).pipe(Effect.ensuring(Scope.close(scope, Exit.void)));
    return { start, stop, waitForExit: Deferred.await(stopped) } satisfies CuaDriverHost;
  });
});

export const layer = Layer.effect(
  CuaDriver,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const factory =
      config.mode === "desktop"
        ? yield* makeDesktopHostFactory()
        : yield* Effect.gen(function* () {
            const installation = yield* CuaDriverInstallation.makeCuaDriverInstallation({
              baseDir: config.baseDir,
            });
            return yield* makeStandaloneHostFactory(installation.executable);
          });
    return yield* make(factory);
  }),
);
