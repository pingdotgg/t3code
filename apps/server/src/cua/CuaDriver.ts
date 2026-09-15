import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";

import type { CuaDriverMcpConfiguration, DesktopCuaDriverReport } from "@t3tools/contracts";
import type { EmbeddedCuaDriverHost, EmbeddedDriverConnection } from "@trycua/cua-driver/embedded";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as ServerSettings from "../serverSettings.ts";

export class CuaDriverBusyError extends Schema.TaggedError<CuaDriverBusyError>()(
  "CuaDriverBusyError",
  {},
) {
  override get message() {
    return "The previous Cua Driver is still stopping.";
  }
}

export class CuaDriverSdkLoadError extends Schema.TaggedError<CuaDriverSdkLoadError>()(
  "CuaDriverSdkLoadError",
  {
    cause: Schema.Unknown,
  },
) {
  override get message() {
    return "Could not load the Cua Driver SDK.";
  }
}

export class CuaDriverHostCreateError extends Schema.TaggedError<CuaDriverHostCreateError>()(
  "CuaDriverHostCreateError",
  {
    binaryPath: Schema.String,
    cause: Schema.Unknown,
  },
) {
  override get message() {
    return "Could not create the Cua Driver host.";
  }
}

export class CuaDriverStopError extends Schema.TaggedError<CuaDriverStopError>()(
  "CuaDriverStopError",
  {
    binaryPath: Schema.String,
    cause: Schema.Unknown,
  },
) {
  override get message() {
    return "Could not stop Cua Driver.";
  }
}

export class CuaDriverStartError extends Schema.TaggedError<CuaDriverStartError>()(
  "CuaDriverStartError",
  {
    binaryPath: Schema.String,
    cause: Schema.Unknown,
  },
) {
  override get message() {
    return "Could not start Cua Driver.";
  }
}

export class CuaDriverExitError extends Schema.TaggedError<CuaDriverExitError>()(
  "CuaDriverExitError",
  {
    binaryPath: Schema.String,
    cause: Schema.Unknown,
  },
) {
  override get message() {
    return "Cua Driver exited unexpectedly.";
  }
}

export class CuaDriverDesktopRequestError extends Schema.TaggedError<CuaDriverDesktopRequestError>()(
  "CuaDriverDesktopRequestError",
  {
    requestId: Schema.String,
    cause: Schema.Unknown,
  },
) {
  override get message() {
    return "Could not request desktop Cua Driver.";
  }
}

export class CuaDriverDesktopStopError extends Schema.TaggedError<CuaDriverDesktopStopError>()(
  "CuaDriverDesktopStopError",
  {
    requestId: Schema.String,
    cause: Schema.Unknown,
  },
) {
  override get message() {
    return "Could not stop desktop Cua Driver.";
  }
}

export class CuaDriverDesktopUnavailableError extends Schema.TaggedError<CuaDriverDesktopUnavailableError>()(
  "CuaDriverDesktopUnavailableError",
  {
    requestId: Schema.String,
    detail: Schema.optional(Schema.String),
  },
) {
  override get message() {
    return this.detail ?? "Desktop Cua Driver is unavailable.";
  }
}

export class CuaDriverNotConfiguredError extends Schema.TaggedError<CuaDriverNotConfiguredError>()(
  "CuaDriverNotConfiguredError",
  {},
) {
  override get message() {
    return "No Cua Driver host configured.";
  }
}

export type CuaDriverError =
  | CuaDriverBusyError
  | CuaDriverSdkLoadError
  | CuaDriverHostCreateError
  | CuaDriverStopError
  | CuaDriverStartError
  | CuaDriverExitError
  | CuaDriverDesktopRequestError
  | CuaDriverDesktopStopError
  | CuaDriverDesktopUnavailableError
  | CuaDriverNotConfiguredError;

export class CuaDriver extends Context.Service<
  CuaDriver,
  {
    readonly enabled: Effect.Effect<boolean>;
    readonly acquire: Effect.Effect<Option.Option<CuaDriverMcpConfiguration>>;
    /** Why the last start failed, until a later start succeeds. */
    readonly lastFailure: Effect.Effect<Option.Option<string>>;
  }
>()("t3/cua/CuaDriver") {}

export interface CuaDriverHost {
  readonly start: Effect.Effect<CuaDriverMcpConfiguration, CuaDriverError>;
  readonly stop: Effect.Effect<void, CuaDriverError>;
  readonly waitForExit: Effect.Effect<void, CuaDriverError>;
}

const START_TIMEOUT = "30 seconds";
const STOP_TIMEOUT = "5 seconds";

/** One environment owns the host; cancelling a session only cancels its wait. */
export const make = Effect.fn("CuaDriver.make")(function* (
  createHost: Effect.Effect<CuaDriverHost, CuaDriverError>,
) {
  const settings = yield* ServerSettings.ServerSettingsService;
  const changes = yield* settings.subscribeChanges;
  const enabled = settings.getSettings.pipe(
    Effect.map((value) => value.enableCua),
    Effect.orElseSucceed(() => false),
  );
  const scope = yield* Effect.scope;
  const workers = yield* Scope.fork(scope);
  const mutex = yield* Semaphore.make(1);
  type Attempt = {
    readonly ready: Deferred.Deferred<Option.Option<CuaDriverMcpConfiguration>>;
    host?: CuaDriverHost;
    stopped?: boolean;
    /** Message of the typed error that ended this attempt, for the readiness signal. */
    failure?: string;
  };
  let current: Attempt | undefined;
  let closed = false;
  let lastFailure: string | undefined;

  const stop = (attempt: Attempt) =>
    Effect.suspend(() => {
      if (!attempt.host || attempt.stopped) return Effect.void;
      attempt.stopped = true;
      return attempt.host.stop.pipe(
        Effect.interruptible,
        Effect.timeout(STOP_TIMEOUT),
        Effect.catchCause(() => Effect.logWarning("Cua Driver host cleanup did not complete.")),
      );
    });

  const revoke = mutex.withPermits(1)(
    Effect.gen(function* () {
      const previous = current;
      current = undefined;
      if (previous) {
        yield* Deferred.succeed(previous.ready, Option.none());
        yield* stop(previous);
      }
    }),
  );

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
    }).pipe(Effect.andThen(revoke)),
  );
  yield* changes.pipe(
    Stream.map((value) => value.enableCua),
    Stream.runForEach((enabled) => (enabled ? Effect.void : revoke)),
    Effect.forkIn(workers, { startImmediately: true }),
  );

  const launch = Effect.fn("CuaDriver.launch")(
    function* (attempt: Attempt) {
      const rememberFailure = (error: { readonly message: string }) =>
        Effect.sync(() => {
          attempt.failure = error.message;
        });
      const host = yield* createHost.pipe(
        Effect.tapError(rememberFailure),
        Effect.timeout(START_TIMEOUT),
      );
      attempt.host = host;
      if (closed || current !== attempt) {
        yield* stop(attempt);
        return;
      }
      const mcp = yield* host.start.pipe(
        Effect.tapError(rememberFailure),
        Effect.timeout(START_TIMEOUT),
      );
      yield* mutex.withPermits(1)(
        Effect.gen(function* () {
          if (closed || current !== attempt || !(yield* enabled)) {
            yield* stop(attempt);
            yield* Deferred.succeed(attempt.ready, Option.none());
            if (current === attempt) current = undefined;
            return;
          }
          lastFailure = undefined;
          yield* Deferred.succeed(attempt.ready, Option.some(mcp));
        }),
      );
      if (current !== attempt) return;
      yield* host.waitForExit;
      yield* mutex.withPermits(1)(
        Effect.gen(function* () {
          if (current !== attempt) return;
          current = undefined;
          yield* stop(attempt);
        }),
      );
    },
    (effect, attempt) =>
      effect.pipe(
        Effect.catchCause(() =>
          mutex.withPermits(1)(
            Effect.gen(function* () {
              if (current === attempt) current = undefined;
              lastFailure = attempt.failure ?? "Cua Driver could not start.";
              yield* stop(attempt);
              yield* Deferred.succeed(attempt.ready, Option.none());
              yield* Effect.logWarning(
                "Cua Driver is unavailable; this coding session will continue without computer use.",
              );
            }),
          ),
        ),
      ),
  );

  const acquire = Effect.gen(function* () {
    const attempt = yield* mutex
      .withPermits(1)(
        Effect.gen(function* () {
          if (closed || !(yield* enabled)) return undefined;
          if (current) return current;
          const next: Attempt = {
            ready: yield* Deferred.make<Option.Option<CuaDriverMcpConfiguration>>(),
          };
          current = next;
          yield* launch(next).pipe(Effect.interruptible, Effect.forkIn(workers));
          return next;
        }),
      )
      .pipe(Effect.uninterruptible);
    return attempt ? yield* Deferred.await(attempt.ready) : Option.none();
  });

  return CuaDriver.of({
    enabled: enabled,
    acquire,
    lastFailure: Effect.sync(() => Option.fromNullishOr(lastFailure)),
  });
});

type StandaloneHostModule = {
  readonly EmbeddedCuaDriverHost: new (
    path: string,
    hostBundleId: string,
  ) => Pick<EmbeddedCuaDriverHost, "start" | "stop" | "waitForExit" | "uniffiDestroy">;
};

// The SDK stays external to the CLI bundle because it dlopens a native
// library. Inside a Node single-executable, `import()` cannot load files from
// disk, while `require` reads the real filesystem. The package only exposes
// `import` conditions, so `require` cannot resolve its specifier; locate the
// package through the same lookup paths and require its entry file directly.
const requireForCuaDriver = NodeModule.createRequire(import.meta.url);

const loadEmbeddedCuaDriver = Effect.fn("CuaDriver.loadEmbeddedSdk")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const lookupPath of requireForCuaDriver.resolve.paths("@trycua/cua-driver") ?? []) {
    const packageDir = path.join(lookupPath, "@trycua", "cua-driver");
    if (
      yield* fs
        .exists(path.join(packageDir, "package.json"))
        .pipe(Effect.orElseSucceed(() => false))
    ) {
      return yield* Effect.try({
        try: () =>
          requireForCuaDriver(path.join(packageDir, "dist", "embedded.js")) as StandaloneHostModule,
        catch: (cause) => new CuaDriverSdkLoadError({ cause }),
      });
    }
  }
  return yield* new CuaDriverSdkLoadError({
    cause: "@trycua/cua-driver is not installed beside this server.",
  });
});

/** A timed-out native cleanup still owns the factory until every call settles. */
export const makeStandaloneHostFactory = Effect.fn("CuaDriver.standaloneHostFactory")(function* (
  binaryPath: string,
  loadEmbedded: Effect.Effect<StandaloneHostModule, CuaDriverSdkLoadError>,
) {
  const mutex = yield* Semaphore.make(1);
  let occupied = false;
  // Return a lazy acquisition effect so one factory owns all subsequent host attempts.
  // @effect-diagnostics-next-line returnEffectInGen:off
  return mutex.withPermits(1)(
    Effect.gen(function* () {
      if (occupied) {
        return yield* new CuaDriverBusyError({});
      }
      const { EmbeddedCuaDriverHost } = yield* loadEmbedded;
      const host = yield* Effect.try({
        try: () => new EmbeddedCuaDriverHost(binaryPath, "com.t3tools.t3code.server"),
        catch: (cause) => new CuaDriverHostCreateError({ binaryPath, cause }),
      });
      occupied = true;
      const abort = new AbortController();
      let starting: Promise<EmbeddedDriverConnection> | undefined;
      let monitoring: Promise<unknown> | undefined;
      let releasing: Promise<void> | undefined;
      let retired = false;
      const stop = Effect.tryPromise({
        try: () => {
          if (!releasing) {
            retired = true;
            abort.abort();
            releasing = (async () => {
              try {
                await starting;
              } catch {
                /* Failed starts still own a host. */
              }
              try {
                await host.stop();
              } catch {
                /* Destruction must still run. */
              }
              try {
                await monitoring;
              } catch {
                /* Cancellation ends the monitor. */
              }
              try {
                host.uniffiDestroy();
              } finally {
                occupied = false;
              }
            })();
          }
          return releasing;
        },
        catch: (cause) => new CuaDriverStopError({ binaryPath, cause }),
      });
      return {
        start: Effect.tryPromise({
          try: async (signal) => {
            if (retired) throw new Error("Cua Driver start was revoked.");
            signal.addEventListener("abort", () => abort.abort(), { once: true });
            starting ??= (async () => {
              const connection = await host.start({ signal: abort.signal });
              if (retired) throw new Error("Cua Driver start was revoked.");
              monitoring = host.waitForExit(connection.generation, { signal: abort.signal });
              void monitoring.catch(() => undefined);
              return connection;
            })();
            const connection = await starting;
            return { ...connection.mcp, socketPath: connection.socketPath };
          },
          catch: (cause) => new CuaDriverStartError({ binaryPath, cause }),
        }),
        stop,
        waitForExit: Effect.tryPromise({
          try: async () => {
            await monitoring;
          },
          catch: (cause) => new CuaDriverExitError({ binaryPath, cause }),
        }),
      } satisfies CuaDriverHost;
    }),
  );
});

export const makeDesktopHostFactory = Effect.fn("CuaDriver.desktopHostFactory")(function* () {
  const receiver = yield* DesktopTelemetryReceiver.DesktopTelemetryReceiver;
  const pending = new Map<string, Deferred.Deferred<DesktopCuaDriverReport>>();
  const exits = new Map<string, Deferred.Deferred<void>>();
  yield* receiver.cuaReports.pipe(
    Stream.runForEach((report) =>
      Effect.gen(function* () {
        const reply = pending.get(report.requestId);
        if (reply) yield* Deferred.succeed(reply, report);
        if (report.status !== "ready") {
          const exit = exits.get(report.requestId);
          if (exit) yield* Deferred.succeed(exit, undefined);
        }
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );

  // Subscribe once for the service, then allocate a fresh request for each lazy start.
  // @effect-diagnostics-next-line returnEffectInGen:off
  return Effect.gen(function* () {
    const requestId = NodeCrypto.randomUUID();
    const ready = yield* Deferred.make<DesktopCuaDriverReport>();
    const exit = yield* Deferred.make<void>();
    let requested = false;
    pending.set(requestId, ready);
    exits.set(requestId, exit);
    return {
      start: Effect.gen(function* () {
        requested = true;
        yield* receiver
          .requestCuaDriver(requestId, true)
          .pipe(Effect.mapError((cause) => new CuaDriverDesktopRequestError({ requestId, cause })));
        const report = yield* Deferred.await(ready);
        if (report.status === "ready") return report.mcp;
        if (report.message)
          yield* Effect.logWarning("Cua Driver host reported unavailable.", {
            message: report.message,
          });
        return yield* new CuaDriverDesktopUnavailableError({
          requestId,
          ...(report.message ? { detail: report.message } : {}),
        });
      }),
      stop: Effect.gen(function* () {
        if (!requested) {
          pending.delete(requestId);
          exits.delete(requestId);
          return;
        }
        const stopId = NodeCrypto.randomUUID();
        const stopped = yield* Deferred.make<DesktopCuaDriverReport>();
        pending.set(stopId, stopped);
        yield* receiver.requestCuaDriver(stopId, false).pipe(
          Effect.mapError((cause) => new CuaDriverDesktopStopError({ requestId: stopId, cause })),
          Effect.andThen(Deferred.await(stopped)),
          Effect.ensuring(
            Effect.sync(() => {
              pending.delete(stopId);
              pending.delete(requestId);
              exits.delete(requestId);
            }),
          ),
        );
      }),
      waitForExit: Deferred.await(exit),
    } satisfies CuaDriverHost;
  });
});

export const layer = Layer.effect(
  CuaDriver,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binaryPath = process.env.T3CODE_CUA_DRIVER_PATH?.trim();
    const createHost =
      config.mode === "desktop" && config.desktopTelemetryControlFd !== undefined
        ? yield* makeDesktopHostFactory()
        : binaryPath
          ? yield* makeStandaloneHostFactory(
              binaryPath,
              loadEmbeddedCuaDriver().pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, path),
              ),
            )
          : Effect.logWarning(
              "Cua Driver requires the T3 desktop host or an explicit T3CODE_CUA_DRIVER_PATH on this server.",
            ).pipe(Effect.andThen(Effect.fail(new CuaDriverNotConfiguredError({}))));
    return yield* make(createHost);
  }),
);
