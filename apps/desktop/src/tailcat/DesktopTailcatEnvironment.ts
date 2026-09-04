import type {
  DesktopTailcatEnvironmentBootstrap,
  DesktopTailcatEnvironmentEnsureInput,
  TailcatAddress,
  TailcatConnectionDiagnostics,
  TailcatFailure,
  TailcatFailureCode,
  TailcatForwardStatus,
  TailcatPathProbe,
  TailcatRuntimeAvailability,
  TailcatRuntimeInfo,
} from "@t3tools/contracts";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import * as NetService from "@t3tools/shared/Net";
import { tailcatBackoffDelayMs, TAILCAT_BACKOFF_RESET_AFTER_MS } from "@t3tools/tailcat/backoff";
import type { TailcatRuntimeError } from "@t3tools/tailcat/errors";
import * as TailcatRuntime from "@t3tools/tailcat/runtime";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/unstable/http/HttpClient";

import * as DesktopTailcatIdentity from "./DesktopTailcatIdentity.ts";

/**
 * Desktop-side Tailcat transport: one `tailcat forward` per saved Tailcat
 * environment, bound to a reserved loopback port, supervised for the lifetime
 * of the app. The renderer only ever sees `http://127.0.0.1:<port>`; T3 auth,
 * pairing, and RPC run over that unchanged.
 *
 * Failure policy: a forward that exits on its own is restarted with jittered
 * exponential backoff; a forward that starts but never passes the readiness
 * probe (typical for "not trusted yet" or "server offline") fails the
 * `ensure` call so the connection supervisor in the client can decide, and the
 * probe result is kept for diagnostics.
 */

export const TAILCAT_FORWARD_READINESS_TIMEOUT = Duration.seconds(20);
export const TAILCAT_FORWARD_MAX_RESTARTS = 8;

export class DesktopTailcatEnvironmentError extends Schema.TaggedErrorClass<DesktopTailcatEnvironmentError>()(
  "DesktopTailcatEnvironmentError",
  {
    code: Schema.Literals([
      "binary-missing",
      "binary-not-executable",
      "version-incompatible",
      "identity-failed",
      "startup-failed",
      "process-exited",
      "timeout",
      "address-invalid",
      "port-in-use",
      "remote-unavailable",
      "unknown",
    ]),
    detail: Schema.String,
    connectionId: Schema.optionalKey(Schema.String),
  },
) {
  /**
   * The message crosses the IPC boundary as plain text, so it carries a
   * machine-readable prefix the renderer can map back to a failure code.
   */
  override get message(): string {
    return `[tailcat:${this.code}] ${this.detail}`;
  }
}

export class DesktopTailcatEnvironment extends Context.Service<
  DesktopTailcatEnvironment,
  {
    readonly runtimeAvailability: Effect.Effect<TailcatRuntimeAvailability>;
    readonly ensureEnvironment: (
      input: DesktopTailcatEnvironmentEnsureInput,
    ) => Effect.Effect<DesktopTailcatEnvironmentBootstrap, DesktopTailcatEnvironmentError>;
    readonly restartEnvironment: (
      connectionId: string,
    ) => Effect.Effect<DesktopTailcatEnvironmentBootstrap, DesktopTailcatEnvironmentError>;
    readonly disconnectEnvironment: (connectionId: string) => Effect.Effect<void>;
    readonly diagnostics: (
      connectionId: string,
    ) => Effect.Effect<Option.Option<TailcatConnectionDiagnostics>>;
    readonly probePath: (
      connectionId: string,
    ) => Effect.Effect<Option.Option<TailcatConnectionDiagnostics>, DesktopTailcatEnvironmentError>;
  }
>()("@t3tools/desktop/tailcat/DesktopTailcatEnvironment") {}

interface RunningForward {
  readonly scope: Scope.Closeable;
  readonly handle: TailcatRuntime.TailcatForwardHandle;
  readonly startedAt: string;
  readonly monitor: Fiber.Fiber<void>;
}

interface ForwardEntry {
  readonly connectionId: string;
  readonly address: TailcatAddress;
  readonly remotePort: number;
  readonly localPort: number;
  readonly status: TailcatForwardStatus;
  readonly running: RunningForward | null;
  readonly restartCount: number;
  readonly consecutiveFailures: number;
  readonly lastError: TailcatFailure | null;
  readonly path: TailcatPathProbe | null;
  /** Set while a disconnect is in progress so the monitor does not restart. */
  readonly stopping: boolean;
  /** Bumped per spawned forward so a stale exit monitor never acts on a newer one. */
  readonly generation: number;
}

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const isDesktopTailcatEnvironmentError = Schema.is(DesktopTailcatEnvironmentError);

function failureCodeOf(
  error: TailcatRuntimeError | DesktopTailcatIdentity.DesktopTailcatIdentityError,
): TailcatFailureCode {
  switch (error._tag) {
    case "TailcatBinaryMissingError":
      return "binary-missing";
    case "TailcatBinaryNotExecutableError":
      return "binary-not-executable";
    case "TailcatVersionIncompatibleError":
      return "version-incompatible";
    case "TailcatAddressInvalidError":
      return "address-invalid";
    case "TailcatPortInUseError":
      return "port-in-use";
    case "TailcatStartupError":
      return "startup-failed";
    case "TailcatTimeoutError":
      return "timeout";
    case "TailcatProcessExitedError":
      return "process-exited";
    case "TailcatCommandError":
      return "unknown";
    case "DesktopTailcatIdentityError":
      return "identity-failed";
  }
}

export const make = Effect.gen(function* () {
  const runtime = yield* TailcatRuntime.TailcatRuntime;
  const identity = yield* DesktopTailcatIdentity.DesktopTailcatIdentity;
  const net = yield* NetService.NetService;
  const httpClient = yield* HttpClient.HttpClient;
  const serviceScope = yield* Scope.Scope;
  const entries = yield* Ref.make<ReadonlyMap<string, ForwardEntry>>(new Map());
  const locks = yield* Ref.make<ReadonlyMap<string, Semaphore.Semaphore>>(new Map());

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const lockFor = (connectionId: string) =>
    Effect.gen(function* () {
      const current = (yield* Ref.get(locks)).get(connectionId);
      if (current !== undefined) {
        return current;
      }
      const created = yield* Semaphore.make(1);
      yield* Ref.update(locks, (map) => new Map(map).set(connectionId, created));
      return created;
    });

  const withLock = <A, E>(connectionId: string, effect: Effect.Effect<A, E>) =>
    lockFor(connectionId).pipe(Effect.flatMap((lock) => lock.withPermits(1)(effect)));

  const getEntry = (connectionId: string) =>
    Ref.get(entries).pipe(Effect.map((map) => Option.fromUndefinedOr(map.get(connectionId))));

  const setEntry = (entry: ForwardEntry) =>
    Ref.update(entries, (map) => new Map(map).set(entry.connectionId, entry));

  const patchEntry = (connectionId: string, patch: (entry: ForwardEntry) => ForwardEntry) =>
    Ref.update(entries, (map) => {
      const current = map.get(connectionId);
      return current === undefined ? map : new Map(map).set(connectionId, patch(current));
    });

  const failure = (code: TailcatFailureCode, message: string): Effect.Effect<TailcatFailure> =>
    nowIso.pipe(Effect.map((at) => ({ code, message, at })));

  const runtimeAvailability: DesktopTailcatEnvironment["Service"]["runtimeAvailability"] =
    runtime.resolve.pipe(
      Effect.map((info): TailcatRuntimeAvailability => ({ available: true, runtime: info })),
      Effect.catch((error) =>
        Effect.succeed<TailcatRuntimeAvailability>({
          available: false,
          code: failureCodeOf(error),
          message: error.message,
        }),
      ),
    );

  const runtimeInfo: Effect.Effect<TailcatRuntimeInfo | null> = runtime.resolve.pipe(
    Effect.map((info): TailcatRuntimeInfo | null => info),
    Effect.orElseSucceed(() => null),
  );

  const readiness = (endpoint: { readonly httpBaseUrl: string }) =>
    fetchRemoteEnvironmentDescriptor({ httpBaseUrl: endpoint.httpBaseUrl, timeoutMs: 4_000 }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.asVoid,
      Effect.mapError(
        (cause) =>
          new DesktopTailcatEnvironmentError({
            code: "remote-unavailable",
            detail: `The T3 server did not answer through the tunnel: ${describe(cause)}`,
          }),
      ),
    );

  const stopRunning = (running: RunningForward) =>
    Fiber.interrupt(running.monitor).pipe(
      Effect.andThen(Scope.close(running.scope, Exit.void).pipe(Effect.ignore)),
    );

  /** Starts (or restarts) the forward for an entry; the entry must be locked. */
  const startForward = (
    entry: ForwardEntry,
  ): Effect.Effect<ForwardEntry, DesktopTailcatEnvironmentError> =>
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      yield* setEntry({ ...entry, status: "starting", running: null, stopping: false });
      const started = yield* identity
        .withKeyFile((keyPath) =>
          runtime.forward({
            keyPath,
            address: entry.address,
            remotePort: entry.remotePort,
            localPort: entry.localPort,
            readiness,
            readinessTimeout: TAILCAT_FORWARD_READINESS_TIMEOUT,
          }),
        )
        .pipe(
          Scope.provide(scope),
          Effect.mapError((error) =>
            isDesktopTailcatEnvironmentError(error)
              ? new DesktopTailcatEnvironmentError({
                  code: error.code,
                  detail: `${error.detail} The environment may be offline, or this device is not trusted yet: redeem a fresh connection code.`,
                  connectionId: entry.connectionId,
                })
              : new DesktopTailcatEnvironmentError({
                  code: failureCodeOf(error),
                  detail: error.message,
                  connectionId: entry.connectionId,
                }),
          ),
          Effect.onError(() => Scope.close(scope, Exit.void).pipe(Effect.ignore)),
          Effect.tapError((error) =>
            failure(error.code, error.detail).pipe(
              Effect.flatMap((recorded) =>
                patchEntry(entry.connectionId, (current) => ({
                  ...current,
                  status: "failed",
                  running: null,
                  consecutiveFailures: current.consecutiveFailures + 1,
                  lastError: recorded,
                })),
              ),
            ),
          ),
        );
      const startedAt = yield* nowIso;
      const generation = entry.generation + 1;
      // The monitor only starts watching once the ready entry is published, so
      // an immediate exit cannot be recorded and then overwritten by "ready".
      const published = yield* Deferred.make<void>();
      const monitor = yield* Deferred.await(published).pipe(
        Effect.andThen(started.exit),
        Effect.flatMap((exitCode) => onForwardExit(entry.connectionId, generation, exitCode)),
        Effect.forkIn(serviceScope),
      );
      const next: ForwardEntry = {
        ...entry,
        status: "ready",
        running: { scope, handle: started, startedAt, monitor },
        stopping: false,
        lastError: null,
        generation,
      };
      yield* setEntry(next);
      yield* Deferred.succeed(published, undefined);
      yield* Effect.logInfo("Tailcat forward ready.", {
        connectionId: entry.connectionId,
        localPort: entry.localPort,
        remotePort: entry.remotePort,
        pid: started.pid,
      });
      return next;
    });

  /**
   * Unexpected exit: record it and restart with backoff unless stopping. The
   * generation guard makes a monitor from an older forward a no-op once the
   * connection was re-ensured or restarted.
   */
  const onForwardExit = (
    connectionId: string,
    generation: number,
    exitCode: Option.Option<number>,
  ) =>
    Effect.gen(function* () {
      const current = yield* getEntry(connectionId);
      if (
        Option.isNone(current) ||
        current.value.stopping ||
        current.value.generation !== generation
      ) {
        return;
      }
      const recorded = yield* failure(
        "process-exited",
        `The Tailcat forwarder exited${Option.isSome(exitCode) ? ` with code ${exitCode.value}` : ""}.`,
      );
      // This exit is the connection's next consecutive failure (1 = first).
      const failures = current.value.consecutiveFailures + 1;
      yield* patchEntry(connectionId, (entry) => ({
        ...entry,
        status: "failed",
        running: null,
        consecutiveFailures: failures,
        lastError: recorded,
      }));
      yield* Effect.logWarning("Tailcat forward exited unexpectedly.", {
        connectionId,
        exitCode: Option.getOrNull(exitCode),
        failures,
      });
      if (failures > TAILCAT_FORWARD_MAX_RESTARTS) {
        yield* Effect.logWarning("Tailcat forward gave up restarting; waiting for the client.", {
          connectionId,
          failures,
        });
        return;
      }
      const random = yield* Random.next;
      yield* Effect.sleep(Duration.millis(tailcatBackoffDelayMs(failures, random)));
      yield* withLock(
        connectionId,
        Effect.gen(function* () {
          const latest = yield* getEntry(connectionId);
          if (
            Option.isNone(latest) ||
            latest.value.stopping ||
            latest.value.running !== null ||
            latest.value.generation !== generation
          ) {
            return;
          }
          yield* startForward({
            ...latest.value,
            restartCount: latest.value.restartCount + 1,
          }).pipe(Effect.ignore);
        }),
      );
    });

  const bootstrapOf = (entry: ForwardEntry, running: RunningForward) =>
    identity.nodeKey.pipe(
      Effect.mapError(
        (error) =>
          new DesktopTailcatEnvironmentError({
            code: "identity-failed",
            detail: error.message,
            connectionId: entry.connectionId,
          }),
      ),
      Effect.map((clientNodeKey): DesktopTailcatEnvironmentBootstrap => ({
        connectionId: entry.connectionId,
        address: entry.address,
        remotePort: entry.remotePort,
        localPort: entry.localPort,
        httpBaseUrl: running.handle.httpBaseUrl,
        wsBaseUrl: running.handle.wsBaseUrl,
        clientNodeKey,
      })),
    );

  const ensureEnvironment: DesktopTailcatEnvironment["Service"]["ensureEnvironment"] = (input) =>
    withLock(
      input.connectionId,
      Effect.gen(function* () {
        const existing = yield* getEntry(input.connectionId);
        const running = Option.isSome(existing) ? existing.value.running : null;
        if (Option.isSome(existing) && running !== null) {
          const entry = existing.value;
          const sameTarget =
            entry.address === input.address && entry.remotePort === input.remotePort;
          const alive = yield* running.handle.isRunning;
          if (sameTarget && alive) {
            // A healthy forward stays; a stale readiness only costs one probe.
            const healthy = yield* readiness({ httpBaseUrl: running.handle.httpBaseUrl }).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            );
            if (healthy) {
              // Fresh use resets the failure budget for the supervisor.
              yield* patchEntry(input.connectionId, (current) => ({
                ...current,
                consecutiveFailures: 0,
              }));
              return yield* bootstrapOf(entry, running);
            }
          }
          yield* patchEntry(input.connectionId, (current) => ({ ...current, stopping: true }));
          yield* stopRunning(running);
        }
        const localPort =
          Option.isSome(existing) && existing.value.address === input.address
            ? existing.value.localPort
            : yield* net.reserveLoopbackPort().pipe(
                Effect.mapError(
                  (error) =>
                    new DesktopTailcatEnvironmentError({
                      code: "port-in-use",
                      detail: `Could not reserve a loopback port: ${error.message}`,
                      connectionId: input.connectionId,
                    }),
                ),
              );
        const resetFailures =
          Option.isSome(existing) &&
          existing.value.lastError !== null &&
          DateTime.toEpochMillis(DateTime.makeUnsafe(existing.value.lastError.at)) +
            TAILCAT_BACKOFF_RESET_AFTER_MS <
            (yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis)));
        const base: ForwardEntry = {
          connectionId: input.connectionId,
          address: input.address,
          remotePort: input.remotePort,
          localPort,
          status: "starting",
          running: null,
          restartCount: Option.isSome(existing) ? existing.value.restartCount : 0,
          consecutiveFailures:
            Option.isSome(existing) && !resetFailures ? existing.value.consecutiveFailures : 0,
          lastError: Option.isSome(existing) ? existing.value.lastError : null,
          path: Option.isSome(existing) ? existing.value.path : null,
          stopping: false,
          generation: Option.isSome(existing) ? existing.value.generation : 0,
        };
        const started = yield* startForward(base);
        return yield* bootstrapOf(started, started.running!);
      }),
    );

  const restartEnvironment: DesktopTailcatEnvironment["Service"]["restartEnvironment"] = (
    connectionId,
  ) =>
    withLock(
      connectionId,
      Effect.gen(function* () {
        const existing = yield* getEntry(connectionId);
        if (Option.isNone(existing)) {
          return yield* new DesktopTailcatEnvironmentError({
            code: "unknown",
            detail: "This Tailcat environment has no active tunnel to restart.",
            connectionId,
          });
        }
        if (existing.value.running !== null) {
          yield* patchEntry(connectionId, (current) => ({ ...current, stopping: true }));
          yield* stopRunning(existing.value.running);
        }
        const started = yield* startForward({
          ...existing.value,
          restartCount: existing.value.restartCount + 1,
          consecutiveFailures: 0,
        });
        return yield* bootstrapOf(started, started.running!);
      }),
    );

  const disconnectEnvironment: DesktopTailcatEnvironment["Service"]["disconnectEnvironment"] = (
    connectionId,
  ) =>
    withLock(
      connectionId,
      Effect.gen(function* () {
        const existing = yield* getEntry(connectionId);
        if (Option.isNone(existing)) {
          return;
        }
        yield* patchEntry(connectionId, (current) => ({ ...current, stopping: true }));
        if (existing.value.running !== null) {
          yield* stopRunning(existing.value.running);
        }
        yield* Ref.update(entries, (map) => {
          const next = new Map(map);
          next.delete(connectionId);
          return next;
        });
        yield* Effect.logInfo("Tailcat forward stopped.", { connectionId });
      }),
    );

  const diagnosticsOf = (entry: ForwardEntry) =>
    Effect.gen(function* () {
      const recentOutput = entry.running === null ? [] : yield* entry.running.handle.recentOutput;
      const clientNodeKey = yield* identity.nodeKey.pipe(Effect.option);
      return {
        connectionId: entry.connectionId,
        address: entry.address,
        remotePort: entry.remotePort,
        status: entry.status,
        localEndpoint: entry.running === null ? null : entry.running.handle.httpBaseUrl,
        pid: entry.running === null ? null : entry.running.handle.pid,
        runtime: yield* runtimeInfo,
        clientNodeKey: Option.getOrNull(clientNodeKey),
        path: entry.path,
        startedAt: entry.running === null ? null : entry.running.startedAt,
        restartCount: entry.restartCount,
        lastError: entry.lastError,
        recentOutput,
      } satisfies TailcatConnectionDiagnostics;
    });

  const diagnostics: DesktopTailcatEnvironment["Service"]["diagnostics"] = (connectionId) =>
    getEntry(connectionId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none()),
          onSome: (entry) => diagnosticsOf(entry).pipe(Effect.map(Option.some)),
        }),
      ),
    );

  const probePath: DesktopTailcatEnvironment["Service"]["probePath"] = (connectionId) =>
    Effect.gen(function* () {
      const existing = yield* getEntry(connectionId);
      if (Option.isNone(existing)) {
        return Option.none();
      }
      const probe = yield* identity
        .withKeyFile((keyPath) => runtime.ping({ keyPath, address: existing.value.address }))
        .pipe(
          Effect.mapError(
            (error) =>
              new DesktopTailcatEnvironmentError({
                code: failureCodeOf(error),
                detail: error.message,
                connectionId,
              }),
          ),
        );
      yield* patchEntry(connectionId, (entry) => ({ ...entry, path: probe }));
      return yield* diagnostics(connectionId);
    });

  // App shutdown takes every forwarder down with it.
  yield* Effect.addFinalizer(() =>
    Ref.get(entries).pipe(
      Effect.flatMap((map) =>
        Effect.forEach(
          map.values(),
          (entry) =>
            entry.running === null
              ? Effect.void
              : Scope.close(entry.running.scope, Exit.void).pipe(Effect.ignore),
          { discard: true },
        ),
      ),
    ),
  );

  return DesktopTailcatEnvironment.of({
    runtimeAvailability,
    ensureEnvironment,
    restartEnvironment,
    disconnectEnvironment,
    diagnostics,
    probePath,
  });
});

export const layer = Layer.effect(DesktopTailcatEnvironment, make);
