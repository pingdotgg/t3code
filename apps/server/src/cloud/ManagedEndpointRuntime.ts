import type { RelayManagedEndpointRuntimeConfig } from "@t3tools/contracts/relay";
import * as RelayClient from "@t3tools/shared/relayClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

export type CloudManagedEndpointRuntimeStatus =
  | {
      readonly status: "disabled";
    }
  | {
      readonly status: "failed";
      readonly providerKind: RelayManagedEndpointRuntimeConfig["providerKind"];
      readonly failure: "unsupported-platform" | "not-installed" | "spawn-failed";
      readonly reason: string;
      readonly tunnelId?: string;
      readonly tunnelName?: string;
    }
  | {
      readonly status: "running";
      readonly providerKind: "cloudflare_tunnel";
      readonly pid: number;
      readonly tunnelId?: string;
      readonly tunnelName?: string;
    }
  | {
      readonly status: "unsupported";
      readonly providerKind: RelayManagedEndpointRuntimeConfig["providerKind"];
    };

export class CloudManagedEndpointRuntime extends Context.Service<
  CloudManagedEndpointRuntime,
  {
    readonly applyConfig: (
      config: RelayManagedEndpointRuntimeConfig | null,
    ) => Effect.Effect<CloudManagedEndpointRuntimeStatus>;
    readonly recoveryRequests: Stream.Stream<RelayManagedEndpointRuntimeConfig>;
    readonly requestRecovery: (config: RelayManagedEndpointRuntimeConfig) => Effect.Effect<void>;
    /** Emits when the connector registers a tunnel connection, i.e. the relay can reach us again. */
    readonly tunnelConnected: Stream.Stream<void>;
    readonly withLinkStateLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("t3/cloud/ManagedEndpointRuntime/CloudManagedEndpointRuntime") {}

interface ActiveConnector {
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly executable: RelayClient.AvailableRelayClient;
  readonly scope: Scope.Closeable;
  readonly configKey: string;
  readonly config: RelayManagedEndpointRuntimeConfig;
  readonly startedAtMillis: number;
  /** Completes when the connector first registers a tunnel connection. */
  readonly registered: Deferred.Deferred<void>;
}

// A connector that exits before running this long is treated as part of a
// crash loop; one that stays up at least this long earns an immediate restart
// again. Without the backoff below, a relay client that fails instantly (a
// stale version-manager shim, a bad binary) respawns ~100 times per second
// until the accumulated tracing exhausts the V8 heap.
const RELAY_RESTART_STABLE_UPTIME_MS = 30_000;
const RELAY_RESTART_BACKOFF_BASE_MS = 1_000;
const RELAY_RESTART_BACKOFF_MAX_MS = 60_000;
// Newly created tunnels can fail authorization briefly while Cloudflare propagates their token.
const TUNNEL_AUTHORIZATION_FAILURES_BEFORE_RECOVERY = 4;
// A connector that never registers a connection may hold a token for a tunnel
// that no longer exists, rejected in wording the output check does not know.
// Ask for recovery after this long, and again at this interval while it stays
// unconnected; the relay hands back the same tunnel when it is still live.
const CONNECTOR_REGISTRATION_TIMEOUT = Duration.minutes(3);
// A failed background install of the pinned relay client is retried no sooner
// than this, so a crash-looping connector or an offline host does not redownload
// on every reconcile.
const RELAY_CLIENT_INSTALL_RETRY_INTERVAL_MS = 10 * 60_000;

/**
 * A linked host converges on the pinned managed release when it has no relay
 * client or runs another managed release. A PATH binary or an explicit override
 * is the user's choice, and the CLI asks before downloading, so both stay put.
 */
function needsPinnedRelayClient(executable: RelayClient.RelayClientStatus): boolean {
  return (
    executable.status === "missing" ||
    (executable.status === "available" &&
      executable.source === "managed" &&
      !RelayClient.isPinnedManagedRelayClient(executable))
  );
}

export function classifyRelayClientOutput(line: string): "connected" | "warning" | "debug" {
  if (/\bRegistered tunnel connection\b/iu.test(line)) {
    return "connected";
  }
  // cloudflared uses zerolog level tokens. FTL (fatal) and PNC (panic) are more
  // severe than ERR, so they must surface at least as loudly — without them a
  // fatal connector failure would be logged at debug and hidden.
  return /\b(?:ERR|WRN|FTL|PNC)\b/u.test(line) ? "warning" : "debug";
}

/**
 * Cloudflare's edge rejects a connector whose tunnel was deleted or whose
 * token no longer matches. The edge words this differently over time
 * (`Failed to get tunnel`, `Tunnel not found`, ...), sometimes prefixed with
 * `Unauthorized:`. Treat any `Unauthorized:` registration error as a rejection,
 * plus the unprefixed messages seen so far. Transient rejections while a new
 * tunnel's token propagates are absorbed by requiring several in a row.
 */
export function isRejectedRelayClientTunnelOutput(line: string): boolean {
  return (
    /\bRegister tunnel error from server side\b/iu.test(line) &&
    /error="(?:Unauthorized:[^"]*|Failed to get tunnel|Tunnel not found|Record for tunnel not found|Invalid tunnel secret)"/iu.test(
      line,
    )
  );
}

/** Connector startup failures can clear after installation or a later spawn attempt. */
export function isRetryableManagedEndpointRuntimeStatus(status: unknown): boolean {
  if (typeof status !== "object" || status === null || !("status" in status)) {
    return false;
  }
  if (status.status !== "failed" || !("failure" in status)) {
    return false;
  }
  return status.failure === "not-installed" || status.failure === "spawn-failed";
}

function runtimeConfigKey(config: RelayManagedEndpointRuntimeConfig): string {
  return JSON.stringify({
    providerKind: config.providerKind,
    connectorToken: config.connectorToken,
    tunnelId: config.tunnelId ?? null,
    tunnelName: config.tunnelName ?? null,
  });
}

const stopConnector = (connector: ActiveConnector | null) =>
  connector
    ? Scope.close(connector.scope, Exit.void).pipe(
        Effect.tap(() =>
          Effect.logInfo("Relay client stopped", {
            pid: Number(connector.child.pid),
          }),
        ),
        Effect.ignore,
      )
    : Effect.void;

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const relayClient = yield* RelayClient.RelayClient;
  const activeRef = yield* Ref.make<ActiveConnector | null>(null);
  const desiredConfigRef = yield* Ref.make<RelayManagedEndpointRuntimeConfig | null>(null);
  const recoveryRequests = yield* Queue.sliding<RelayManagedEndpointRuntimeConfig>(1);
  const tunnelConnections = yield* Queue.sliding<void>(1);
  const reconcileSemaphore = yield* Semaphore.make(1);
  const restartDelayRef = yield* Ref.make(0);
  const linkStateSemaphore = yield* Semaphore.make(1);
  const runtimeScope = yield* Effect.scope;
  const installInFlightRef = yield* Ref.make(false);
  const lastInstallFailureAtRef = yield* Ref.make<number | null>(null);
  const prunedRef = yield* Ref.make(false);
  const retryLoopRunningRef = yield* Ref.make(false);
  let reconcileConfig: CloudManagedEndpointRuntime["Service"]["applyConfig"];

  const stopActive = Effect.gen(function* () {
    const active = yield* Ref.getAndSet(activeRef, null);
    yield* stopConnector(active);
  });

  const superviseConnector = (connector: ActiveConnector) =>
    Effect.gen(function* () {
      const result = yield* Effect.result(connector.child.exitCode);
      const activeAtExit = yield* Ref.get(activeRef);
      if (
        activeAtExit?.child.pid !== connector.child.pid ||
        activeAtExit.configKey !== connector.configKey
      ) {
        return;
      }
      const uptimeMillis = (yield* Clock.currentTimeMillis) - connector.startedAtMillis;
      // The first crash restarts immediately; every further crash inside the
      // stable-uptime window doubles the wait, up to the cap. The delay runs
      // before the semaphore so a user config change is never blocked behind
      // it, and reconcileConfig re-checks the desired config afterwards.
      const restartDelayMillis = yield* Ref.modify(restartDelayRef, (current) => {
        if (uptimeMillis >= RELAY_RESTART_STABLE_UPTIME_MS) {
          return [0, 0];
        }
        return [
          current,
          current === 0
            ? RELAY_RESTART_BACKOFF_BASE_MS
            : Math.min(current * 2, RELAY_RESTART_BACKOFF_MAX_MS),
        ];
      });
      if (restartDelayMillis > 0) {
        yield* Effect.logWarning("Relay client is crash-looping; delaying restart", {
          pid: Number(connector.child.pid),
          uptimeMillis,
          restartDelayMillis,
          tunnelId: connector.config.tunnelId,
          tunnelName: connector.config.tunnelName,
        });
        yield* Effect.sleep(Duration.millis(restartDelayMillis));
      }
      yield* reconcileSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const active = yield* Ref.get(activeRef);
          if (
            active?.child.pid !== connector.child.pid ||
            active.configKey !== connector.configKey
          ) {
            return;
          }
          yield* Ref.set(activeRef, null);
          yield* stopConnector(connector);

          const desiredConfig = yield* Ref.get(desiredConfigRef);
          if (
            !desiredConfig ||
            desiredConfig.providerKind !== "cloudflare_tunnel" ||
            runtimeConfigKey(desiredConfig) !== connector.configKey
          ) {
            return;
          }

          yield* Effect.logWarning("Relay client exited; restarting", {
            pid: Number(connector.child.pid),
            ...(Result.isSuccess(result)
              ? { exitCode: Number(result.success) }
              : { cause: result.failure }),
            tunnelId: connector.config.tunnelId,
            tunnelName: connector.config.tunnelName,
          });
          yield* Queue.offer(recoveryRequests, connector.config);
          yield* reconcileConfig(desiredConfig);
        }),
      );
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Relay client supervisor failed", { cause })),
    );

  // Installs the pinned relay client in the background, then moves the connector
  // to it. The new connector starts next to the old one on the same tunnel, and
  // the old one stops only once the new one registers, so clients never see the
  // relay lose this host during the swap.
  const installPinnedRelayClient = Effect.gen(function* () {
    if (yield* Ref.getAndSet(installInFlightRef, true)) return;
    yield* Effect.logInfo("Installing the pinned relay client", {
      version: RelayClient.CLOUDFLARED_VERSION,
    });
    yield* relayClient.install.pipe(
      Effect.tap(() => Ref.set(lastInstallFailureAtRef, null)),
      Effect.flatMap((installed) =>
        reconcileSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const desiredConfig = yield* Ref.get(desiredConfigRef);
            if (!desiredConfig || desiredConfig.providerKind !== "cloudflare_tunnel") return;
            const active = yield* Ref.get(activeRef);
            // A self-updated binary in the pinned folder shares the installed path,
            // so the version decides whether the running connector is current.
            if (
              active?.executable.executablePath === installed.executablePath &&
              active.executable.version === installed.version
            ) {
              return;
            }
            // A fresh binary can fail its probe while a scanner holds it; restarting
            // then would land on the same older binary, so leave it to the retry.
            const resolved = yield* relayClient.resolve;
            if (
              resolved.status !== "available" ||
              resolved.executablePath !== installed.executablePath ||
              resolved.version !== installed.version
            ) {
              return;
            }
            yield* Effect.logInfo("Relay client installed; moving the connector to it", {
              version: installed.version,
              previousVersion: active?.executable.version,
            });
            // Detach the old connector so the reconcile starts a new one beside it.
            const previous = yield* Ref.getAndSet(activeRef, null);
            const status = yield* reconcileConfig(desiredConfig);
            const next = yield* Ref.get(activeRef);
            if (!next) {
              yield* Effect.logWarning("Relay client did not start after the update", status);
              // A still-running old connector keeps serving and the retry loop
              // tries the pin again. One that exited while detached was skipped
              // by its supervisor, so ask for recovery like an exited connector.
              const previousRunning = previous
                ? yield* previous.child.isRunning.pipe(Effect.orElseSucceed(() => false))
                : false;
              if (previous && previousRunning) {
                yield* Ref.set(activeRef, previous);
              } else {
                yield* stopConnector(previous);
                yield* Queue.offer(recoveryRequests, desiredConfig);
              }
              return;
            }
            // Runs in the new connector's scope: the old one stops when the new
            // one registers, or as soon as the new one is stopped or replaced.
            if (previous) {
              yield* Deferred.await(next.registered).pipe(
                Effect.ensuring(stopConnector(previous)),
                Effect.forkIn(next.scope),
              );
            }
          }),
        ),
      ),
      Effect.catchTags({
        RelayClientInstallError: (error) =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((failedAt) => Ref.set(lastInstallFailureAtRef, failedAt)),
            Effect.andThen(
              Effect.logWarning("Could not install the pinned relay client", {
                reason: error.reason,
                message: error.message,
                cause: error.cause,
              }),
            ),
          ),
      }),
      Effect.ensuring(Ref.set(installInFlightRef, false)),
    );
  });

  // Reconciles call this; a recent failure skips the attempt so a crash-looping
  // connector or an offline host does not redownload on every restart.
  const ensurePinnedRelayClient = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const lastFailureAt = yield* Ref.get(lastInstallFailureAtRef);
    if (lastFailureAt !== null && now - lastFailureAt < RELAY_CLIENT_INSTALL_RETRY_INTERVAL_MS) {
      return;
    }
    yield* installPinnedRelayClient;
  }).pipe(Effect.forkIn(runtimeScope), Effect.asVoid);

  // Until the host runs the pinned release, retry the install every interval.
  // applyConfig returns early while an older connector is healthy, and some
  // activations never retry a missing client, so one runtime loop covers both.
  // It paces itself, so it skips the failure gate above.
  const retryPinnedRelayClientInstall = Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(Duration.millis(RELAY_CLIENT_INSTALL_RETRY_INTERVAL_MS));
      const desiredConfig = yield* Ref.get(desiredConfigRef);
      if (!desiredConfig || desiredConfig.providerKind !== "cloudflare_tunnel") return;
      // Stop only once a connector runs on the pin. The pin can be on disk while
      // an older connector still runs, or while none runs because a post-install
      // probe failed; another install call then finds it and starts the connector.
      const active = yield* Ref.get(activeRef);
      if (active && !needsPinnedRelayClient(active.executable)) return;
      yield* installPinnedRelayClient;
    }
  }).pipe(Effect.ensuring(Ref.set(retryLoopRunningRef, false)));

  const startPinnedRelayClientRetries = Effect.gen(function* () {
    if (yield* Ref.getAndSet(retryLoopRunningRef, true)) return;
    yield* Effect.forkIn(retryPinnedRelayClientInstall, runtimeScope);
  });

  // Requests recovery while the connector has not registered a connection,
  // once per timeout, until it connects or is replaced.
  const watchConnectorRegistration = (connector: ActiveConnector) =>
    Effect.gen(function* () {
      yield* Effect.sleep(CONNECTOR_REGISTRATION_TIMEOUT);
      if (yield* Deferred.isDone(connector.registered)) return true;
      yield* Effect.logWarning(
        "Relay client has not registered a tunnel connection; requesting recovery",
        {
          pid: Number(connector.child.pid),
          tunnelId: connector.config.tunnelId,
          tunnelName: connector.config.tunnelName,
        },
      );
      yield* Queue.offer(recoveryRequests, connector.config);
      return false;
    }).pipe(Effect.repeat({ until: (connected) => connected }));

  const observeConnectorOutput = (connector: ActiveConnector) => {
    let rejectedRegistrations = 0;

    return connector.child.all.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.map((line) => line.trim()),
      Stream.filter((line) => line.length > 0),
      Stream.runForEach((line) => {
        const output = line.replaceAll(connector.config.connectorToken, "<redacted>");
        const attributes = {
          pid: Number(connector.child.pid),
          tunnelId: connector.config.tunnelId,
          tunnelName: connector.config.tunnelName,
          output,
        };
        switch (classifyRelayClientOutput(line)) {
          case "connected":
            rejectedRegistrations = 0;
            return Deferred.succeed(connector.registered, undefined).pipe(
              Effect.andThen(
                Effect.logInfo("Relay client tunnel connection registered", attributes),
              ),
              Effect.andThen(Queue.offer(tunnelConnections, undefined)),
              Effect.andThen(
                RelayClient.isPinnedManagedRelayClient(connector.executable)
                  ? Ref.getAndSet(prunedRef, true).pipe(
                      Effect.flatMap((pruned) =>
                        pruned ? Effect.void : relayClient.pruneManagedVersions,
                      ),
                    )
                  : Effect.void,
              ),
              Effect.asVoid,
            );
          case "warning":
            if (isRejectedRelayClientTunnelOutput(line)) {
              rejectedRegistrations += 1;
              if (rejectedRegistrations >= TUNNEL_AUTHORIZATION_FAILURES_BEFORE_RECOVERY) {
                rejectedRegistrations = 0;
                return Effect.logWarning(
                  "Relay client tunnel was rejected; requesting recovery",
                  attributes,
                ).pipe(
                  Effect.andThen(Queue.offer(recoveryRequests, connector.config)),
                  Effect.asVoid,
                );
              }
            }
            return Effect.logWarning("Relay client reported a transport warning", attributes);
          case "debug":
            return Effect.logDebug("Relay client output", attributes);
        }
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("Relay client output observer failed", {
          cause,
          pid: Number(connector.child.pid),
          tunnelId: connector.config.tunnelId,
          tunnelName: connector.config.tunnelName,
        }),
      ),
    );
  };

  reconcileConfig = Effect.fn("CloudManagedEndpointRuntime.reconcileConfig")(function* (config) {
    if (!config || config.providerKind !== "cloudflare_tunnel") {
      yield* stopActive;
      return config
        ? { status: "unsupported", providerKind: config.providerKind }
        : { status: "disabled" };
    }

    const nextConfigKey = runtimeConfigKey(config);
    const active = yield* Ref.get(activeRef);
    if (active?.configKey === nextConfigKey) {
      const isRunning = yield* active.child.isRunning.pipe(Effect.orElseSucceed(() => false));
      if (isRunning) {
        return {
          status: "running",
          providerKind: "cloudflare_tunnel",
          pid: Number(active.child.pid),
          ...(active.config.tunnelId ? { tunnelId: active.config.tunnelId } : {}),
          ...(active.config.tunnelName ? { tunnelName: active.config.tunnelName } : {}),
        } satisfies CloudManagedEndpointRuntimeStatus;
      }
    }

    yield* stopActive;

    const executable = yield* relayClient.resolve;
    if (needsPinnedRelayClient(executable)) {
      yield* ensurePinnedRelayClient;
      yield* startPinnedRelayClientRetries;
    }
    if (executable.status !== "available") {
      return {
        status: "failed",
        providerKind: "cloudflare_tunnel",
        failure: executable.status === "unsupported" ? "unsupported-platform" : "not-installed",
        reason:
          executable.status === "unsupported"
            ? `Relay client is unsupported on ${executable.platform}-${executable.arch}.`
            : "The relay client is not installed.",
        ...(config.tunnelId ? { tunnelId: config.tunnelId } : {}),
        ...(config.tunnelName ? { tunnelName: config.tunnelName } : {}),
      } satisfies CloudManagedEndpointRuntimeStatus;
    }

    const connectorScope = yield* Scope.make("sequential");
    const child = yield* spawner
      .spawn(
        ChildProcess.make(
          executable.executablePath,
          ["tunnel", "--no-autoupdate", "--loglevel", "info", "--output", "default", "run"],
          {
            detached: false,
            env: {
              ...process.env,
              TUNNEL_TOKEN: config.connectorToken,
            },
            shell: false,
            stderr: "pipe",
            stdout: "pipe",
          },
        ),
      )
      .pipe(
        Effect.provideService(Scope.Scope, connectorScope),
        Effect.tap((child) =>
          Effect.logInfo("Relay client process started; waiting for tunnel connection", {
            pid: Number(child.pid),
            source: executable.source,
            version: executable.version,
            tunnelId: config.tunnelId,
            tunnelName: config.tunnelName,
          }),
        ),
        Effect.catch((cause) =>
          Effect.logWarning("Failed to start relay client", {
            cause,
            tunnelId: config.tunnelId,
            tunnelName: config.tunnelName,
          }).pipe(
            Effect.andThen(Scope.close(connectorScope, Exit.void).pipe(Effect.ignore)),
            Effect.as({
              status: "failed",
              providerKind: "cloudflare_tunnel",
              failure: "spawn-failed",
              reason: String(cause),
              ...(config.tunnelId ? { tunnelId: config.tunnelId } : {}),
              ...(config.tunnelName ? { tunnelName: config.tunnelName } : {}),
            } satisfies CloudManagedEndpointRuntimeStatus),
          ),
        ),
      );

    if ("status" in child && child.status === "failed") {
      return child;
    }

    if (!("status" in child)) {
      const connector = {
        child,
        executable,
        scope: connectorScope,
        configKey: nextConfigKey,
        config,
        startedAtMillis: yield* Clock.currentTimeMillis,
        registered: yield* Deferred.make<void>(),
      } satisfies ActiveConnector;
      yield* Ref.set(activeRef, connector);
      yield* Effect.forkIn(observeConnectorOutput(connector), connectorScope);
      yield* Effect.forkIn(superviseConnector(connector), connectorScope);
      yield* Effect.forkIn(watchConnectorRegistration(connector), connectorScope);
      return {
        status: "running",
        providerKind: "cloudflare_tunnel",
        pid: Number(child.pid),
        ...(config.tunnelId ? { tunnelId: config.tunnelId } : {}),
        ...(config.tunnelName ? { tunnelName: config.tunnelName } : {}),
      } satisfies CloudManagedEndpointRuntimeStatus;
    }

    return {
      status: "failed",
      providerKind: "cloudflare_tunnel",
      failure: "spawn-failed",
      reason: "Relay client did not start.",
      ...(config.tunnelId ? { tunnelId: config.tunnelId } : {}),
      ...(config.tunnelName ? { tunnelName: config.tunnelName } : {}),
    } satisfies CloudManagedEndpointRuntimeStatus;
  });

  const applyConfig = Effect.fn("CloudManagedEndpointRuntime.applyConfig")(
    (config: RelayManagedEndpointRuntimeConfig | null) =>
      reconcileSemaphore.withPermits(1)(
        Effect.gen(function* () {
          // A real config change starts over with a fresh backoff. Recovery
          // that hands back the same tunnel and token must keep the delay, or
          // a crash-looping connector respawns on every recovery round trip.
          const desired = yield* Ref.get(desiredConfigRef);
          const unchanged =
            desired !== null &&
            config !== null &&
            runtimeConfigKey(desired) === runtimeConfigKey(config);
          if (!unchanged) {
            yield* Ref.set(restartDelayRef, 0);
          }
          yield* Ref.set(desiredConfigRef, config);
          return yield* reconcileConfig(config);
        }),
      ),
  );

  const runtime = CloudManagedEndpointRuntime.of({
    applyConfig,
    recoveryRequests: Stream.fromQueue(recoveryRequests),
    requestRecovery: (config) => Queue.offer(recoveryRequests, config).pipe(Effect.asVoid),
    tunnelConnected: Stream.fromQueue(tunnelConnections),
    withLinkStateLock: linkStateSemaphore.withPermits(1),
  });

  yield* Effect.addFinalizer(() => runtime.applyConfig(null));
  return runtime;
});

export const layer = Layer.effect(CloudManagedEndpointRuntime, make);
