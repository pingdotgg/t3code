import type { RelayManagedEndpointRuntimeConfig } from "@t3tools/contracts/relay";
import * as RelayClient from "@t3tools/shared/relayClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CLOUD_ENDPOINT_RUNTIME_CONFIG, decodeRuntimeConfig } from "./config.ts";

const RELAY_CONNECTION_TIMEOUT = "15 seconds";

function bytesToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

const readRuntimeConfig = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const bytes = yield* secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG);
  if (Option.isNone(bytes)) {
    return null;
  }
  return Option.getOrNull(decodeRuntimeConfig(bytesToString(bytes.value)));
});

export type CloudManagedEndpointRuntimeStatus =
  | {
      readonly status: "disabled";
    }
  | {
      readonly status: "failed";
      readonly providerKind: RelayManagedEndpointRuntimeConfig["providerKind"];
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
  }
>()("t3/cloud/ManagedEndpointRuntime/CloudManagedEndpointRuntime") {}

interface ActiveConnector {
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly connected: Deferred.Deferred<void>;
  readonly scope: Scope.Closeable;
  readonly configKey: string;
  readonly config: RelayManagedEndpointRuntimeConfig;
  readonly startedAtMillis: number;
}

// A connector that exits before running this long is treated as part of a
// crash loop; one that stays up at least this long earns an immediate restart
// again. Without the backoff below, a relay client that fails instantly (a
// stale version-manager shim, a bad binary) respawns ~100 times per second
// until the accumulated tracing exhausts the V8 heap.
const RELAY_RESTART_STABLE_UPTIME_MS = 30_000;
const RELAY_RESTART_BACKOFF_BASE_MS = 1_000;
const RELAY_RESTART_BACKOFF_MAX_MS = 60_000;

export function classifyRelayClientOutput(line: string): "connected" | "warning" | "debug" {
  if (/\bRegistered tunnel connection\b/iu.test(line)) {
    return "connected";
  }
  // cloudflared uses zerolog level tokens. FTL (fatal) and PNC (panic) are more
  // severe than ERR, so they must surface at least as loudly — without them a
  // fatal connector failure would be logged at debug and hidden.
  return /\b(?:ERR|WRN|FTL|PNC)\b/u.test(line) ? "warning" : "debug";
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

export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const relayClient = yield* RelayClient.RelayClient;
  const activeRef = yield* Ref.make<ActiveConnector | null>(null);
  const desiredConfigRef = yield* Ref.make<RelayManagedEndpointRuntimeConfig | null>(null);
  const configApplied = yield* Ref.make(false);
  const reconcileSemaphore = yield* Semaphore.make(1);
  const restartDelayRef = yield* Ref.make(0);
  let startConnector: (
    config: RelayManagedEndpointRuntimeConfig,
    configKey: string,
  ) => Effect.Effect<ActiveConnector | CloudManagedEndpointRuntimeStatus>;

  const stopActive = Effect.gen(function* () {
    const active = yield* Ref.getAndSet(activeRef, null);
    yield* stopConnector(active);
  });

  const awaitConnectorConnection = Effect.fn(
    "CloudManagedEndpointRuntime.awaitConnectorConnection",
  )(function* (connector: ActiveConnector) {
    const failed = (reason: string) =>
      ({
        status: "failed",
        providerKind: "cloudflare_tunnel",
        reason,
        ...(connector.config.tunnelId ? { tunnelId: connector.config.tunnelId } : {}),
        ...(connector.config.tunnelName ? { tunnelName: connector.config.tunnelName } : {}),
      }) satisfies CloudManagedEndpointRuntimeStatus;
    const outcome = yield* Deferred.await(connector.connected).pipe(
      Effect.as("connected" as const),
      Effect.race(Effect.result(connector.child.exitCode).pipe(Effect.as("exited" as const))),
      Effect.timeoutOption(RELAY_CONNECTION_TIMEOUT),
    );
    if (Option.isSome(outcome) && outcome.value === "connected") {
      return yield* reconcileSemaphore.withPermits(1)(
        Effect.gen(function* () {
          if ((yield* Ref.get(activeRef)) !== connector) {
            return failed(
              "Relay client configuration changed before its connection could be confirmed.",
            );
          }
          const isRunning = yield* connector.child.isRunning.pipe(
            Effect.orElseSucceed(() => false),
          );
          if (!isRunning) {
            return failed(
              "Relay client is no longer running or its status could not be confirmed.",
            );
          }
          return {
            status: "running",
            providerKind: "cloudflare_tunnel",
            pid: Number(connector.child.pid),
            ...(connector.config.tunnelId ? { tunnelId: connector.config.tunnelId } : {}),
            ...(connector.config.tunnelName ? { tunnelName: connector.config.tunnelName } : {}),
          } satisfies CloudManagedEndpointRuntimeStatus;
        }),
      );
    }

    const reason = Option.isSome(outcome)
      ? "Relay client exited before it registered a tunnel connection."
      : `Relay client did not register a tunnel connection within ${RELAY_CONNECTION_TIMEOUT}. Check whether the network allows outbound TCP and UDP traffic on port 7844.`;
    return failed(reason);
  });

  const superviseConnector = (connector: ActiveConnector) =>
    Effect.gen(function* () {
      const result = yield* Effect.result(connector.child.exitCode);
      const activeAtExit = yield* Ref.get(activeRef);
      if (activeAtExit !== connector) {
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
          if (active !== connector) {
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
          yield* startConnector(desiredConfig, connector.configKey);
        }),
      );
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Relay client supervisor failed", { cause })),
    );

  const observeConnectorOutput = (connector: ActiveConnector) =>
    connector.child.all.pipe(
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
            return Deferred.succeed(connector.connected, undefined).pipe(
              Effect.andThen(
                Effect.logInfo("Relay client tunnel connection registered", attributes),
              ),
            );
          case "warning":
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

  startConnector = Effect.fn("CloudManagedEndpointRuntime.startConnector")(
    function* (config, nextConfigKey) {
      const executable = yield* relayClient.resolve;
      if (executable.status !== "available") {
        return {
          status: "failed",
          providerKind: "cloudflare_tunnel",
          reason:
            executable.status === "unsupported"
              ? `Relay client is unsupported on ${executable.platform}-${executable.arch}.`
              : "The relay client is not installed.",
          ...(config.tunnelId ? { tunnelId: config.tunnelId } : {}),
          ...(config.tunnelName ? { tunnelName: config.tunnelName } : {}),
        } satisfies CloudManagedEndpointRuntimeStatus;
      }

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const connectorScope = yield* Scope.make("sequential");
          const child = yield* restore(
            spawner
              .spawn(
                ChildProcess.make(executable.executablePath, ["tunnel", "run"], {
                  detached: false,
                  env: {
                    ...process.env,
                    TUNNEL_TOKEN: config.connectorToken,
                  },
                  shell: false,
                  stderr: "pipe",
                  stdout: "pipe",
                }),
              )
              .pipe(
                Effect.provideService(Scope.Scope, connectorScope),
                Effect.tap((child) =>
                  Effect.logInfo("Relay client process started; waiting for tunnel connection", {
                    pid: Number(child.pid),
                    tunnelId: config.tunnelId,
                    tunnelName: config.tunnelName,
                  }),
                ),
                Effect.onInterrupt(() =>
                  Scope.close(connectorScope, Exit.void).pipe(Effect.ignore),
                ),
              ),
          ).pipe(
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
            const connected = yield* Deferred.make<void>();
            const connector = {
              child,
              connected,
              scope: connectorScope,
              configKey: nextConfigKey,
              config,
              startedAtMillis: yield* Clock.currentTimeMillis,
            } satisfies ActiveConnector;
            yield* Ref.set(activeRef, connector);
            yield* Effect.forkIn(observeConnectorOutput(connector), connectorScope);
            yield* Effect.forkIn(superviseConnector(connector), connectorScope);
            return connector;
          }

          return {
            status: "failed",
            providerKind: "cloudflare_tunnel",
            reason: "Relay client did not start.",
            ...(config.tunnelId ? { tunnelId: config.tunnelId } : {}),
            ...(config.tunnelName ? { tunnelName: config.tunnelName } : {}),
          } satisfies CloudManagedEndpointRuntimeStatus;
        }),
      );
    },
  );

  const reconcileConfig = Effect.fn("CloudManagedEndpointRuntime.reconcileConfig")(function* (
    config: RelayManagedEndpointRuntimeConfig | null,
  ): Effect.fn.Return<ActiveConnector | CloudManagedEndpointRuntimeStatus> {
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
        return active;
      }
    }

    yield* stopActive;
    return yield* startConnector(config, nextConfigKey);
  });

  const applyConfig = Effect.fn("CloudManagedEndpointRuntime.applyConfig")(function* (
    config: RelayManagedEndpointRuntimeConfig | null,
  ) {
    let started: ActiveConnector | null = null;
    return yield* reconcileSemaphore
      .withPermits(1)(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            // An explicit config change starts over with a fresh backoff.
            yield* Ref.set(restartDelayRef, 0);
            yield* Ref.set(configApplied, true);
            yield* Ref.set(desiredConfigRef, config);
            const previous = yield* Ref.get(activeRef);
            const result = yield* restore(reconcileConfig(config)).pipe(
              Effect.onInterrupt(() =>
                Effect.gen(function* () {
                  if ((yield* Ref.get(activeRef)) !== previous) yield* stopActive;
                }),
              ),
            );
            if ("child" in result && result !== previous) started = result;
            return result;
          }),
        ),
      )
      .pipe(
        // Only process ownership is serialized. Registration must not delay
        // another config or the shorter shutdown tunnel-release deadline.
        Effect.flatMap((result) =>
          "child" in result ? awaitConnectorConnection(result) : Effect.succeed(result),
        ),
        Effect.onInterrupt(() => {
          const owned = started;
          if (owned === null) return Effect.void;
          return reconcileSemaphore.withPermits(1)(
            Effect.gen(function* () {
              // A reused child belongs to the earlier apply. A replacement may
              // already belong to a later one; neither is ours to cancel.
              if ((yield* Ref.get(activeRef)) === owned) yield* stopActive;
            }),
          );
        }),
      );
  });

  // The boot apply discards its status, so it must not hold the reconcile
  // permit through the registration wait. The shutdown tunnel release calls
  // applyConfig(null) under a shorter timeout and would expire behind it.
  const applyInitialConfig = (config: RelayManagedEndpointRuntimeConfig | null) =>
    reconcileSemaphore.withPermits(1)(
      Effect.gen(function* () {
        // A caller can apply a config while the boot apply still waits for the
        // permit. That newer config wins. The boot config must not replace it.
        if (yield* Ref.get(configApplied)) {
          return;
        }
        yield* Ref.set(desiredConfigRef, config);
        if (!config || config.providerKind !== "cloudflare_tunnel") {
          yield* stopActive;
          return;
        }
        yield* startConnector(config, runtimeConfigKey(config));
      }),
    );

  const runtime = CloudManagedEndpointRuntime.of({
    applyConfig,
  });

  const initialConfig = yield* readRuntimeConfig.pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Failed to read managed endpoint runtime config", { cause }).pipe(
        Effect.as(null),
      ),
    ),
  );
  // Interrupt a boot apply that still starts the connector, so the final
  // reconcile does not wait for a spawn it will stop right after.
  const startup = yield* applyInitialConfig(initialConfig).pipe(Effect.forkScoped);
  yield* Effect.addFinalizer(() =>
    Fiber.interrupt(startup).pipe(Effect.andThen(runtime.applyConfig(null))),
  );
  return runtime;
});

export const layer = Layer.effect(CloudManagedEndpointRuntime, make);
