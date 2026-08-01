// @ts-nocheck
import type { RelayManagedEndpointRuntimeConfig } from "@t3tools/contracts/relay";
import type { EnvironmentCloudEndpointRuntimeStatus } from "@t3tools/contracts/environmentHttp";
import * as RelayClient from "@t3tools/shared/relayClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

export type CloudManagedEndpointRuntimeStatus = EnvironmentCloudEndpointRuntimeStatus;

const CONNECTOR_FORCE_KILL_AFTER = "1 second";

export class CloudManagedEndpointRuntime extends Context.Service<
  CloudManagedEndpointRuntime,
  {
    readonly applyConfig: (
      config: RelayManagedEndpointRuntimeConfig | null,
    ) => Effect.Effect<CloudManagedEndpointRuntimeStatus>;
    readonly getStatus: Effect.Effect<CloudManagedEndpointRuntimeStatus>;
  }
>()("t3/cloud/ManagedEndpointRuntime/CloudManagedEndpointRuntime") {}

interface ActiveConnector {
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly scope: Scope.Closeable;
  readonly retryStopWithKill: Ref.Ref<boolean>;
  readonly configKey: string;
  readonly config: RelayManagedEndpointRuntimeConfig;
}

const connectorStatus = (
  connector: ActiveConnector,
  status: "starting" | "running",
): CloudManagedEndpointRuntimeStatus => ({
  status,
  providerKind: "cloudflare_tunnel",
  pid: Number(connector.child.pid),
  ...(connector.config.tunnelId ? { tunnelId: connector.config.tunnelId } : {}),
  ...(connector.config.tunnelName ? { tunnelName: connector.config.tunnelName } : {}),
});

export function classifyRelayClientOutput(line: string): "connected" | "warning" | "debug" {
  if (/\bRegistered tunnel connection\b/iu.test(line)) {
    return "connected";
  }
  return /\b(?:ERR|WRN)\b/u.test(line) ? "warning" : "debug";
}

function runtimeConfigKey(config: RelayManagedEndpointRuntimeConfig): string {
  return JSON.stringify({
    providerKind: config.providerKind,
    connectorToken: config.connectorToken,
    tunnelId: config.tunnelId ?? null,
    tunnelName: config.tunnelName ?? null,
  });
}

const stopFailure = (connector: ActiveConnector, cause: unknown) =>
  Effect.logError("Failed to stop relay client", {
    cause,
    pid: Number(connector.child.pid),
    tunnelId: connector.config.tunnelId,
    tunnelName: connector.config.tunnelName,
  }).pipe(
    Effect.as({
      status: "failed",
      providerKind: connector.config.providerKind,
      reason: "The relay client could not be stopped.",
      ...(connector.config.tunnelId ? { tunnelId: connector.config.tunnelId } : {}),
      ...(connector.config.tunnelName ? { tunnelName: connector.config.tunnelName } : {}),
    } satisfies CloudManagedEndpointRuntimeStatus),
  );

const logStoppedConnector = (connector: ActiveConnector) =>
  Effect.logInfo("Relay client stopped", {
    pid: Number(connector.child.pid),
  });

const waitForConnectorExit = (connector: ActiveConnector) =>
  Effect.raceFirst(
    connector.child.exitCode.pipe(
      Effect.as("exited" as const),
      // Node reports a signal exit through the failure channel. That still
      // proves the child process exited; interruption is intentionally not
      // caught so cancelling this wait never masquerades as a process exit.
      Effect.catch(() => Effect.succeed("exited" as const)),
    ),
    Effect.sleep(CONNECTOR_FORCE_KILL_AFTER).pipe(Effect.as("timed-out" as const)),
  );

const signalConnector = (connector: ActiveConnector, killSignal: NodeJS.Signals) =>
  Effect.raceFirst(
    connector.child
      .kill({
        killSignal,
        forceKillAfter: CONNECTOR_FORCE_KILL_AFTER,
      })
      .pipe(
        Effect.as("signaled" as const),
        Effect.catchCause(() => Effect.succeed("failed" as const)),
      ),
    Effect.sleep(CONNECTOR_FORCE_KILL_AFTER).pipe(Effect.as("timed-out" as const)),
  );

const forceStopConnector = (connector: ActiveConnector) =>
  signalConnector(connector, "SIGKILL").pipe(
    Effect.flatMap((signal) =>
      signal === "signaled"
        ? waitForConnectorExit(connector)
        : Effect.fail(new Error("Relay client SIGKILL did not complete.")),
    ),
    Effect.flatMap((exit) =>
      exit === "exited"
        ? Effect.void
        : Effect.fail(new Error("Relay client did not exit after SIGKILL.")),
    ),
  );

const stopRetainedConnector = (connector: ActiveConnector) =>
  signalConnector(connector, "SIGTERM").pipe(
    Effect.flatMap((signal) =>
      signal === "signaled"
        ? waitForConnectorExit(connector)
        : Effect.succeed("timed-out" as const),
    ),
    Effect.flatMap((exit) => (exit === "exited" ? Effect.void : forceStopConnector(connector))),
  );

const closeConnectorScope = (connector: ActiveConnector) =>
  Effect.raceFirst(
    Scope.close(connector.scope, Exit.void).pipe(Effect.as("closed" as const)),
    Effect.sleep(CONNECTOR_FORCE_KILL_AFTER).pipe(Effect.as("timed-out" as const)),
  ).pipe(
    Effect.flatMap((closed) =>
      closed === "closed" ? Effect.void : stopRetainedConnector(connector),
    ),
  );

const stopConnector = (connector: ActiveConnector | null) =>
  connector
    ? Ref.get(connector.retryStopWithKill).pipe(
        Effect.flatMap((retryWithKill) =>
          (retryWithKill ? stopRetainedConnector(connector) : closeConnectorScope(connector)).pipe(
            Effect.tap(() => logStoppedConnector(connector)),
            Effect.as(null),
            Effect.catchCause((cause) =>
              retryWithKill
                ? stopFailure(connector, cause)
                : Ref.set(connector.retryStopWithKill, true).pipe(
                    Effect.andThen(stopFailure(connector, cause)),
                  ),
            ),
          ),
        ),
      )
    : Effect.succeed(null);

export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const relayClient = yield* RelayClient.RelayClient;
  const activeRef = yield* Ref.make<ActiveConnector | null>(null);
  const desiredConfigRef = yield* Ref.make<RelayManagedEndpointRuntimeConfig | null>(null);
  const statusRef = yield* Ref.make<CloudManagedEndpointRuntimeStatus>({ status: "disabled" });
  const reconcileSemaphore = yield* Semaphore.make(1);
  let reconcileConfig: CloudManagedEndpointRuntime["Service"]["applyConfig"];

  const stopActive = Effect.gen(function* () {
    const active = yield* Ref.get(activeRef);
    const stopped = yield* stopConnector(active);
    if (stopped) return stopped;
    yield* Ref.set(activeRef, null);
    return null;
  });

  const superviseConnector = (connector: ActiveConnector) =>
    Effect.gen(function* () {
      const result = yield* Effect.result(connector.child.exitCode);
      const active = yield* Ref.get(activeRef);
      if (active?.child.pid !== connector.child.pid || active.configKey !== connector.configKey) {
        return;
      }
      // Publish the lost connection before waiting behind an in-flight
      // reconciliation or beginning replacement work.
      yield* Ref.set(statusRef, connectorStatus(connector, "starting"));
      yield* reconcileSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const active = yield* Ref.get(activeRef);
          if (
            active?.child.pid !== connector.child.pid ||
            active.configKey !== connector.configKey
          ) {
            return;
          }
          // The process has exited, so its last registered connection is no
          // longer a usable endpoint while restart work is in progress.
          yield* Ref.set(statusRef, connectorStatus(connector, "starting"));
          yield* Ref.set(activeRef, null);

          const desiredConfig = yield* Ref.get(desiredConfigRef);
          if (desiredConfig?.providerKind === "cloudflare_tunnel") {
            yield* Effect.logWarning("Relay client exited; restarting", {
              pid: Number(connector.child.pid),
              ...(Result.isSuccess(result)
                ? { exitCode: Number(result.success) }
                : { cause: result.failure }),
              tunnelId: connector.config.tunnelId,
              tunnelName: connector.config.tunnelName,
            });
          }
          const restarted = yield* reconcileConfig(desiredConfig);
          yield* Ref.set(statusRef, restarted);
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
            return Effect.logInfo("Relay client tunnel connection registered", attributes).pipe(
              Effect.andThen(
                Ref.get(activeRef).pipe(
                  Effect.flatMap((active) =>
                    active?.child.pid === connector.child.pid &&
                    active.configKey === connector.configKey
                      ? Ref.set(statusRef, connectorStatus(connector, "running"))
                      : Effect.void,
                  ),
                ),
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

  reconcileConfig = Effect.fn("CloudManagedEndpointRuntime.reconcileConfig")(function* (config) {
    if (!config || config.providerKind !== "cloudflare_tunnel") {
      const stopped = yield* stopActive;
      if (stopped) return stopped;
      return config
        ? { status: "unsupported", providerKind: config.providerKind }
        : { status: "disabled" };
    }

    const nextConfigKey = runtimeConfigKey(config);
    const active = yield* Ref.get(activeRef);
    if (active?.configKey === nextConfigKey) {
      const isRunning = yield* active.child.isRunning.pipe(Effect.orElseSucceed(() => false));
      if (isRunning) {
        const status = yield* Ref.get(statusRef);
        return connectorStatus(active, status.status === "running" ? "running" : "starting");
      }
    }

    if (active) {
      // The old connector is no longer a usable endpoint while its scope is
      // closing and relay resolution or installation may still be pending.
      yield* Ref.set(statusRef, connectorStatus(active, "starting"));
    }
    const stopped = yield* stopActive;
    if (stopped) return stopped;

    const resolvedExecutable = yield* relayClient.resolve;
    const executable =
      resolvedExecutable.status === "missing"
        ? yield* relayClient.install.pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Failed to install relay client", { cause }).pipe(
                Effect.as(resolvedExecutable),
              ),
            ),
          )
        : resolvedExecutable;
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

    const connectorScope = yield* Scope.make("sequential");
    const child = yield* spawner
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
          forceKillAfter: CONNECTOR_FORCE_KILL_AFTER,
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
      const retryStopWithKill = yield* Ref.make(false);
      const connector = {
        child,
        scope: connectorScope,
        retryStopWithKill,
        configKey: nextConfigKey,
        config,
      } satisfies ActiveConnector;
      yield* Ref.set(activeRef, connector);
      yield* Effect.forkIn(observeConnectorOutput(connector), connectorScope);
      // A failed scope close leaves this connector retained for a later stop
      // retry. Keep its exit supervisor alive on the runtime scope so an
      // eventual process exit can still reconcile the desired replacement.
      yield* Effect.forkScoped(superviseConnector(connector));
      return connectorStatus(connector, "starting");
    }

    return {
      status: "failed",
      providerKind: "cloudflare_tunnel",
      reason: "Relay client did not start.",
      ...(config.tunnelId ? { tunnelId: config.tunnelId } : {}),
      ...(config.tunnelName ? { tunnelName: config.tunnelName } : {}),
    } satisfies CloudManagedEndpointRuntimeStatus;
  });

  const applyConfig = Effect.fn("CloudManagedEndpointRuntime.applyConfig")(
    (config: RelayManagedEndpointRuntimeConfig | null) =>
      reconcileSemaphore.withPermits(1)(
        Ref.set(desiredConfigRef, config).pipe(
          Effect.andThen(reconcileConfig(config)),
          Effect.tap((status) => Ref.set(statusRef, status)),
        ),
      ),
  );

  const runtime = CloudManagedEndpointRuntime.of({
    applyConfig,
    getStatus: Ref.get(statusRef),
  });

  // Startup reconciliation validates the desired link and uses the listener's
  // actual port before applying a tunnel config. Do not revive stale config here.
  yield* Effect.addFinalizer(() =>
    runtime
      .applyConfig(null)
      .pipe(
        Effect.flatMap((stopped) =>
          stopped.status === "failed"
            ? runtime
                .applyConfig(null)
                .pipe(
                  Effect.flatMap((retried) =>
                    retried.status === "failed"
                      ? Effect.logError("Failed to stop relay client during runtime shutdown").pipe(
                          Effect.andThen(
                            Effect.fail(new Error("Managed relay connector could not be stopped.")),
                          ),
                        )
                      : Effect.void,
                  ),
                )
            : Effect.void,
        ),
      ),
  );
  return runtime;
});

export const layer = Layer.effect(CloudManagedEndpointRuntime, make);
