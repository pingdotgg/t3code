import * as NodeCrypto from "node:crypto";

import type { CuaDriverMcpConfiguration, DesktopCuaDriverReport } from "@t3tools/contracts";
import type { EmbeddedCuaDriverHost, EmbeddedDriverConnection } from "@trycua/cua-driver/embedded";
import { Context, Deferred, Effect, Layer, Option, Schema, Scope, Semaphore, Stream } from "effect";

import { ServerConfig } from "../config.ts";
import { DesktopTelemetryReceiver } from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import { ServerSettingsService } from "../serverSettings.ts";

export class CuaDriver extends Context.Service<
  CuaDriver,
  {
    readonly enabled: Effect.Effect<boolean>;
    readonly acquire: Effect.Effect<Option.Option<CuaDriverMcpConfiguration>>;
  }
>()("t3/cua/CuaDriver") {}

export class CuaDriverError extends Schema.TaggedError<CuaDriverError>()("CuaDriverError", {
  message: Schema.String,
}) {}

export interface CuaDriverHost {
  readonly start: Effect.Effect<CuaDriverMcpConfiguration, CuaDriverError>;
  readonly stop: Effect.Effect<void, CuaDriverError>;
  readonly waitForExit: Effect.Effect<void, CuaDriverError>;
}

export interface CuaDriverOptions {
  readonly createHost: Effect.Effect<CuaDriverHost, CuaDriverError>;
  readonly enabled: Effect.Effect<boolean>;
  readonly changes: Stream.Stream<boolean>;
}

const START_TIMEOUT = "30 seconds";
const STOP_TIMEOUT = "5 seconds";

/** One environment owns the host; cancelling a session only cancels its wait. */
export const makeCuaDriver = Effect.fn("CuaDriver.make")(function* (options: CuaDriverOptions) {
  const scope = yield* Effect.scope;
  const workers = yield* Scope.fork(scope);
  const mutex = yield* Semaphore.make(1);
  type Attempt = {
    readonly ready: Deferred.Deferred<Option.Option<CuaDriverMcpConfiguration>>;
    host?: CuaDriverHost;
    stopped?: boolean;
  };
  let current: Attempt | undefined;
  let closed = false;

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
  yield* options.changes.pipe(
    Stream.runForEach((enabled) => (enabled ? Effect.void : revoke)),
    Effect.forkIn(workers, { startImmediately: true }),
  );

  const launch = Effect.fn("CuaDriver.launch")(
    function* (attempt: Attempt) {
      const host = yield* options.createHost.pipe(Effect.timeout(START_TIMEOUT));
      attempt.host = host;
      if (closed || current !== attempt) {
        yield* stop(attempt);
        return;
      }
      const mcp = yield* host.start.pipe(Effect.timeout(START_TIMEOUT));
      yield* mutex.withPermits(1)(
        Effect.gen(function* () {
          if (closed || current !== attempt || !(yield* options.enabled)) {
            yield* stop(attempt);
            yield* Deferred.succeed(attempt.ready, Option.none());
            if (current === attempt) current = undefined;
            return;
          }
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
          if (closed || !(yield* options.enabled)) return undefined;
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

  return CuaDriver.of({ enabled: options.enabled, acquire });
});

type StandaloneHostModule = {
  readonly EmbeddedCuaDriverHost: new (
    path: string,
    hostBundleId: string,
  ) => Pick<EmbeddedCuaDriverHost, "start" | "stop" | "waitForExit" | "uniffiDestroy">;
};

/** A timed-out native cleanup still owns the factory until every call settles. */
export const makeStandaloneHostFactory = Effect.fn("CuaDriver.standaloneHostFactory")(function* (
  binaryPath: string,
  loadEmbedded: () => Promise<StandaloneHostModule> = () => import("@trycua/cua-driver/embedded"),
) {
  const mutex = yield* Semaphore.make(1);
  let occupied = false;
  // @effect-diagnostics-next-line returnEffectInGen:off
  return mutex.withPermits(1)(
    Effect.gen(function* () {
      if (occupied) {
        return yield* new CuaDriverError({ message: "The previous Cua Driver is still stopping." });
      }
      const { EmbeddedCuaDriverHost } = yield* Effect.tryPromise({
        try: loadEmbedded,
        catch: () => new CuaDriverError({ message: "Could not load the Cua Driver SDK." }),
      });
      const host = yield* Effect.try({
        try: () => new EmbeddedCuaDriverHost(binaryPath, "com.t3tools.t3code.server"),
        catch: () => new CuaDriverError({ message: "Could not create the Cua Driver host." }),
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
              host.uniffiDestroy();
              occupied = false;
            })();
          }
          return releasing;
        },
        catch: () => new CuaDriverError({ message: "Could not stop Cua Driver." }),
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
            return (await starting).mcp;
          },
          catch: () => new CuaDriverError({ message: "Could not start Cua Driver." }),
        }),
        stop,
        waitForExit: Effect.tryPromise({
          try: async () => {
            await monitoring;
          },
          catch: () => new CuaDriverError({ message: "Cua Driver exited unexpectedly." }),
        }),
      } satisfies CuaDriverHost;
    }),
  );
});

export const makeDesktopHostFactory = Effect.fn("CuaDriver.desktopHostFactory")(function* (
  receiver: Pick<DesktopTelemetryReceiver["Service"], "cuaReports" | "requestCuaDriver">,
) {
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
          .pipe(
            Effect.mapError(
              () => new CuaDriverError({ message: "Could not request desktop Cua Driver." }),
            ),
          );
        const report = yield* Deferred.await(ready);
        if (report.status === "ready") return report.mcp;
        if (report.message)
          yield* Effect.logWarning("Cua Driver host reported unavailable.", {
            message: report.message,
          });
        return yield* new CuaDriverError({ message: "Desktop Cua Driver is unavailable." });
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
          Effect.mapError(
            () => new CuaDriverError({ message: "Could not stop desktop Cua Driver." }),
          ),
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
    const config = yield* ServerConfig;
    const settings = yield* ServerSettingsService;
    const receiver = yield* DesktopTelemetryReceiver;
    const changes = yield* settings.subscribeChanges;
    const binaryPath = process.env.T3CODE_CUA_DRIVER_PATH?.trim();
    const createHost =
      config.mode === "desktop" && config.desktopTelemetryControlFd !== undefined
        ? yield* makeDesktopHostFactory(receiver)
        : binaryPath
          ? yield* makeStandaloneHostFactory(binaryPath)
          : Effect.logWarning(
              "Cua Driver requires the T3 desktop host or an explicit T3CODE_CUA_DRIVER_PATH on this server.",
            ).pipe(
              Effect.andThen(
                Effect.fail(new CuaDriverError({ message: "No Cua Driver host configured." })),
              ),
            );
    return yield* makeCuaDriver({
      createHost,
      enabled: settings.getSettings.pipe(
        Effect.map((value) => value.enableCua),
        Effect.orElseSucceed(() => false),
      ),
      changes: changes.pipe(Stream.map((value) => value.enableCua)),
    });
  }),
);
