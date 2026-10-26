import type { RelayManagedEndpointRuntimeConfig } from "@t3tools/contracts/relay";
import * as RelayClient from "@t3tools/shared/relayClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
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

/** What the running cloudflared reports about itself. `null` fields are not known yet. */
export interface ConnectorFacts {
  readonly readyConnections: number | null;
  /** The public tunnel hostname from the remote config cloudflared receives once it connects. */
  readonly hostname: string | null;
  readonly protocol: string | null;
}

export class CloudManagedEndpointRuntime extends Context.Service<
  CloudManagedEndpointRuntime,
  {
    readonly applyConfig: (
      config: RelayManagedEndpointRuntimeConfig | null,
    ) => Effect.Effect<CloudManagedEndpointRuntimeStatus>;
    /** `null` when no connector is running. */
    readonly inspectConnector: Effect.Effect<ConnectorFacts | null>;
    /** Emits when a connector registers a connection or its readiness changes. */
    readonly readinessChanged: Stream.Stream<void>;
    readonly recoveryRequests: Stream.Stream<RelayManagedEndpointRuntimeConfig>;
    readonly requestRecovery: (config: RelayManagedEndpointRuntimeConfig) => Effect.Effect<void>;
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
  readonly registered: Deferred.Deferred<void>;
  readonly metricsAddress: Deferred.Deferred<string>;
  readonly protocol: Ref.Ref<string | null>;
}

// An instantly failing relay client otherwise respawns ~100 times/sec and exhausts V8 via tracing.
const RELAY_RESTART_STABLE_UPTIME_MS = 30_000;
const RELAY_RESTART_BACKOFF_BASE_MS = 1_000;
const RELAY_RESTART_BACKOFF_MAX_MS = 60_000;
// Newly created tunnels can fail authorization briefly while Cloudflare propagates their token.
const TUNNEL_AUTHORIZATION_FAILURES_BEFORE_RECOVERY = 4;
// Unknown rejection wording can leave a dead tunnel unconnected; periodically request recovery.
const CONNECTOR_REGISTRATION_TIMEOUT = Duration.minutes(3);
// cloudflared resolves edges only at startup and can keep dialing stale addresses after a network change.
const CONNECTOR_READINESS_INTERVAL = Duration.seconds(30);
const CONNECTOR_READINESS_REQUEST_TIMEOUT = Duration.seconds(5);
const CONNECTOR_NOT_READY_CHECKS_BEFORE_RESTART = 6;
const CONNECTOR_NOT_READY_CHECKS_MAX = 60;
const RELAY_CLIENT_METRICS_LINE = /\bStarting metrics server on (127\.0\.0\.1:\d+)\/metrics\b/u;
const RELAY_CLIENT_PROTOCOL = /\bprotocol=(\w+)/u;
// cloudflared's metrics server: `/ready` answers 200 or 503 with this body, and
// `/config` holds the ingress rules the edge pushed after the first connection.
const ConnectorReadyBody = Schema.Struct({ readyConnections: Schema.Number });
const ConnectorConfigBody = Schema.Struct({
  config: Schema.Struct({
    ingress: Schema.optional(
      Schema.NullOr(Schema.Array(Schema.Struct({ hostname: Schema.optional(Schema.String) }))),
    ),
  }),
});
// Registration resets cloudflared's own fallback, even when QUIC stalls again
// immediately. Keep that evidence across registrations and connector restarts.
const QUIC_STALLS_BEFORE_HTTP2 = 30;
const QUIC_STALL_WINDOW_MS = 5 * 60_000;
// A failed background install of the pinned relay client is retried no sooner
// than this, so a crash-looping connector or an offline host does not redownload
// on every reconcile.
const RELAY_CLIENT_INSTALL_RETRY_INTERVAL_MS = 10 * 60_000;

/** Preserve user-chosen PATH binaries and overrides; CLI downloads require consent. */
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
  // cloudflared uses zerolog FTL/PNC for fatal/panic; classify them above debug too.
  return /\b(?:ERR|WRN|FTL|PNC)\b/u.test(line) ? "warning" : "debug";
}

/** Edge rejection wording varies; any Unauthorized registration error counts. */
export function isRejectedRelayClientTunnelOutput(line: string): boolean {
  return (
    /\bRegister tunnel error from server side\b/iu.test(line) &&
    /error="(?:Unauthorized:[^"]*|Failed to get tunnel|Tunnel not found|Record for tunnel not found|Invalid tunnel secret)"/iu.test(
      line,
    )
  );
}

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

/** @public */
export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const relayClient = yield* RelayClient.RelayClient;
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const activeRef = yield* Ref.make<ActiveConnector | null>(null);
  const desiredConfigRef = yield* Ref.make<RelayManagedEndpointRuntimeConfig | null>(null);
  const recoveryRequests = yield* Queue.sliding<RelayManagedEndpointRuntimeConfig>(1);
  const tunnelConnections = yield* Queue.sliding<void>(1);
  const readinessChanges = yield* Queue.sliding<void>(1);
  const reconcileSemaphore = yield* Semaphore.make(1);
  const restartDelayRef = yield* Ref.make(0);
  const linkStateSemaphore = yield* Semaphore.make(1);
  const runtimeScope = yield* Effect.scope;
  const installInFlightRef = yield* Ref.make(false);
  const lastInstallFailureAtRef = yield* Ref.make<number | null>(null);
  const prunedRef = yield* Ref.make(false);
  const retryLoopRunningRef = yield* Ref.make(false);
  const notReadyChecksBeforeRestartRef = yield* Ref.make(CONNECTOR_NOT_READY_CHECKS_BEFORE_RESTART);
  // An explicit cloudflared transport in the environment is the user's choice.
  const transportChosenByUser = process.env.TUNNEL_TRANSPORT_PROTOCOL !== undefined;
  const http2Ref = yield* Ref.make(false);
  const quicStallsRef = yield* Ref.make<ReadonlyArray<number>>([]);
  let reconcileConfig: CloudManagedEndpointRuntime["Service"]["applyConfig"];

  const stopActive = Effect.gen(function* () {
    const active = yield* Ref.getAndSet(activeRef, null);
    yield* stopConnector(active);
  });

  // Lives until connector exit and starts replacements; avoid nested lifetime spans.
  const superviseConnector = Effect.fnUntraced(
    function* (connector: ActiveConnector) {
      const result = yield* Effect.result(connector.child.exitCode);
      const activeAtExit = yield* Ref.get(activeRef);
      if (
        activeAtExit?.child.pid !== connector.child.pid ||
        activeAtExit.configKey !== connector.configKey
      ) {
        return;
      }
      const uptimeMillis = (yield* Clock.currentTimeMillis) - connector.startedAtMillis;
      // Back off outside the semaphore so config changes remain responsive; recheck config afterwards.
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
    },
    Effect.catchCause((cause) => Effect.logWarning("Relay client supervisor failed", { cause })),
  );

  // Keep the old connector until its replacement registers, preserving the relay connection.
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
            // Self-updated binaries share the pinned path; compare versions to detect replacements.
            if (
              active?.executable.executablePath === installed.executablePath &&
              active.executable.version === installed.version
            ) {
              return;
            }
            // A scanner can block a fresh binary's probe; retry instead of restarting onto the older binary.
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
            const previous = yield* Ref.getAndSet(activeRef, null);
            const status = yield* reconcileConfig(desiredConfig);
            const next = yield* Ref.get(activeRef);
            if (!next) {
              yield* Effect.logWarning("Relay client did not start after the update", status);
              // The supervisor skips exits while detached; request recovery explicitly.
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

  const ensurePinnedRelayClient = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const lastFailureAt = yield* Ref.get(lastInstallFailureAtRef);
    if (lastFailureAt !== null && now - lastFailureAt < RELAY_CLIENT_INSTALL_RETRY_INTERVAL_MS) {
      return;
    }
    yield* installPinnedRelayClient;
  }).pipe(Effect.forkIn(runtimeScope), Effect.asVoid);

  // Retry installs skipped by applyConfig without the failure gate.
  const retryPinnedRelayClientInstall = Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(Duration.millis(RELAY_CLIENT_INSTALL_RETRY_INTERVAL_MS));
      const desiredConfig = yield* Ref.get(desiredConfigRef);
      if (!desiredConfig || desiredConfig.providerKind !== "cloudflare_tunnel") return;
      // An installed pin still needs activation after a failed probe or while an older connector runs.
      const active = yield* Ref.get(activeRef);
      if (active && !needsPinnedRelayClient(active.executable)) return;
      yield* installPinnedRelayClient;
    }
  }).pipe(Effect.ensuring(Ref.set(retryLoopRunningRef, false)));

  const startPinnedRelayClientRetries = Effect.gen(function* () {
    if (yield* Ref.getAndSet(retryLoopRunningRef, true)) return;
    yield* Effect.forkIn(retryPinnedRelayClientInstall, runtimeScope);
  });

  // Registration retries can last for the connector lifetime; keep this loop untraced.
  const watchConnectorRegistration = Effect.fnUntraced(
    function* (connector: ActiveConnector) {
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
    },
    Effect.repeat({ until: (connected) => connected }),
  );

  // Only an explicit 503 counts: a failed request says nothing about the
  // Readiness polling runs for the connector lifetime; keep this loop untraced.
  const watchConnectorReadiness = Effect.fnUntraced(function* (connector: ActiveConnector) {
    const readyUrl = `http://${yield* Deferred.await(connector.metricsAddress)}/ready`;
    let notReadyChecks = 0;
    let lastReady: boolean | null = null;
    while (true) {
      yield* Effect.sleep(CONNECTOR_READINESS_INTERVAL);
      const status = yield* httpClient.get(readyUrl).pipe(
        Effect.map((response) => response.status),
        Effect.scoped,
        Effect.withTracerEnabled(false),
        Effect.timeoutOption(CONNECTOR_READINESS_REQUEST_TIMEOUT),
        Effect.orElseSucceed(() => Option.none<number>()),
      );
      if (Option.isNone(status)) continue;
      if (status.value === 200 || status.value === 503) {
        const ready = status.value === 200;
        if (ready !== lastReady) yield* Queue.offer(readinessChanges, undefined);
        lastReady = ready;
      }
      if (status.value === 200) {
        notReadyChecks = 0;
        yield* Ref.set(notReadyChecksBeforeRestartRef, CONNECTOR_NOT_READY_CHECKS_BEFORE_RESTART);
        continue;
      }
      if (status.value !== 503) continue;
      notReadyChecks += 1;
      const threshold = yield* Ref.get(notReadyChecksBeforeRestartRef);
      if (notReadyChecks < threshold) continue;
      notReadyChecks = 0;
      yield* Ref.set(
        notReadyChecksBeforeRestartRef,
        Math.min(threshold * 2, CONNECTOR_NOT_READY_CHECKS_MAX),
      );
      yield* Effect.logWarning("Relay client has no tunnel connection; restarting it", {
        pid: Number(connector.child.pid),
        notReadyChecks: threshold,
        tunnelId: connector.config.tunnelId,
        tunnelName: connector.config.tunnelName,
      });
      yield* connector.child.kill().pipe(Effect.ignore);
    }
  });

  const switchToHttp2 = Effect.fnUntraced(function* (connector: ActiveConnector) {
    const active = yield* Ref.get(activeRef);
    const desiredConfig = yield* Ref.get(desiredConfigRef);
    if ((yield* Ref.get(http2Ref)) || active !== connector || !desiredConfig) return;
    yield* Ref.set(http2Ref, true);
    yield* Effect.logWarning("Relay client keeps losing QUIC connections; switching to HTTP/2", {
      pid: Number(connector.child.pid),
      tunnelId: connector.config.tunnelId,
      tunnelName: connector.config.tunnelName,
    });
    // Shutdown must not interrupt cleanup after active ownership is cleared.
    yield* Effect.uninterruptible(stopActive);
    const status = yield* reconcileConfig(desiredConfig);
    // A failed spawn has no supervisor to request recovery.
    if (status.status !== "running") {
      yield* Queue.offer(recoveryRequests, desiredConfig);
    }
  }, reconcileSemaphore.withPermits(1));

  const noteQuicStall = Effect.fnUntraced(function* (connector: ActiveConnector) {
    if (transportChosenByUser || (yield* Ref.get(http2Ref))) return;
    const now = yield* Clock.currentTimeMillis;
    if ((yield* Ref.get(activeRef)) !== connector) return;
    const stalls = yield* Ref.updateAndGet(quicStallsRef, (previous) => [
      ...previous.filter((at) => now - at < QUIC_STALL_WINDOW_MS),
      now,
    ]);
    if (stalls.length < QUIC_STALLS_BEFORE_HTTP2) return;
    // Stopping the connector interrupts the output observer that called this.
    yield* Effect.forkIn(switchToHttp2(connector), runtimeScope);
  });

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
                Ref.set(connector.protocol, RELAY_CLIENT_PROTOCOL.exec(line)?.[1] ?? null),
              ),
              Effect.andThen(
                Effect.logInfo("Relay client tunnel connection registered", attributes),
              ),
              Effect.andThen(Queue.offer(tunnelConnections, undefined)),
              Effect.andThen(Queue.offer(readinessChanges, undefined)),
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
            if (/\btimeout: no recent network activity\b/u.test(line)) {
              return noteQuicStall(connector).pipe(
                Effect.andThen(
                  Effect.logWarning("Relay client reported a transport warning", attributes),
                ),
              );
            }
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
          case "debug": {
            const metricsAddress = RELAY_CLIENT_METRICS_LINE.exec(line)?.[1];
            return metricsAddress
              ? Deferred.succeed(connector.metricsAddress, metricsAddress).pipe(
                  Effect.andThen(Effect.logDebug("Relay client output", attributes)),
                )
              : Effect.logDebug("Relay client output", attributes);
          }
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

    const http2 = yield* Ref.get(http2Ref);
    const connectorScope = yield* Scope.make("sequential");
    const child = yield* spawner
      .spawn(
        ChildProcess.make(
          executable.executablePath,
          [
            "tunnel",
            "--no-autoupdate",
            "--loglevel",
            "info",
            "--output",
            "default",
            "--metrics",
            "127.0.0.1:0",
            ...(http2 ? ["--protocol", "http2"] : []),
            "run",
          ],
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
            protocol: http2 ? "http2" : "auto",
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
        metricsAddress: yield* Deferred.make<string>(),
        protocol: yield* Ref.make<string | null>(null),
      } satisfies ActiveConnector;
      yield* Ref.set(activeRef, connector);
      yield* Effect.forkIn(observeConnectorOutput(connector), connectorScope);
      yield* Effect.forkIn(superviseConnector(connector), connectorScope);
      yield* Effect.forkIn(watchConnectorRegistration(connector), connectorScope);
      yield* Effect.forkIn(watchConnectorReadiness(connector), connectorScope);
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
          // Keep backoff when recovery returns the same tunnel/token, or every recovery respawns a crash loop.
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

  const readMetrics = <S extends Schema.Decoder<unknown>>(url: string, schema: S) =>
    httpClient.get(url).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
      Effect.scoped,
      Effect.withTracerEnabled(false),
      Effect.timeoutOption(CONNECTOR_READINESS_REQUEST_TIMEOUT),
      Effect.map(Option.getOrNull),
      Effect.orElseSucceed(() => null),
    );

  const inspectConnector = Effect.gen(function* () {
    const active = yield* Ref.get(activeRef);
    if (!active || !(yield* active.child.isRunning.pipe(Effect.orElseSucceed(() => false)))) {
      return null;
    }
    const protocol = yield* Ref.get(active.protocol);
    if (!(yield* Deferred.isDone(active.metricsAddress))) {
      return { readyConnections: null, hostname: null, protocol } satisfies ConnectorFacts;
    }
    const metricsUrl = `http://${yield* Deferred.await(active.metricsAddress)}`;
    const [ready, config] = yield* Effect.all(
      [
        readMetrics(`${metricsUrl}/ready`, ConnectorReadyBody),
        readMetrics(`${metricsUrl}/config`, ConnectorConfigBody),
      ],
      { concurrency: 2 },
    );
    return {
      readyConnections: ready?.readyConnections ?? null,
      hostname: config?.config.ingress?.find((rule) => rule.hostname)?.hostname ?? null,
      protocol,
    } satisfies ConnectorFacts;
  });

  const runtime = CloudManagedEndpointRuntime.of({
    applyConfig,
    inspectConnector,
    readinessChanged: Stream.fromQueue(readinessChanges),
    recoveryRequests: Stream.fromQueue(recoveryRequests),
    requestRecovery: Effect.fn("CloudManagedEndpointRuntime.requestRecovery")(function (config) {
      return Queue.offer(recoveryRequests, config).pipe(Effect.asVoid);
    }),
    tunnelConnected: Stream.fromQueue(tunnelConnections),
    withLinkStateLock: linkStateSemaphore.withPermits(1),
  });

  yield* Effect.addFinalizer(() => runtime.applyConfig(null));
  return runtime;
});

export const layer = Layer.effect(CloudManagedEndpointRuntime, make);
