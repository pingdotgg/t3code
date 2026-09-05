import type { RelayManagedEndpointRuntimeConfig } from "@t3tools/contracts/relay";
import * as RelayClient from "@t3tools/shared/relayClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
  const reconcileSemaphore = yield* Semaphore.make(1);
  const restartDelayRef = yield* Ref.make(0);
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
          yield* reconcileConfig(desiredConfig);
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
            return Effect.logInfo("Relay client tunnel connection registered", attributes);
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
      const connector = {
        child,
        scope: connectorScope,
        configKey: nextConfigKey,
        config,
        startedAtMillis: yield* Clock.currentTimeMillis,
      } satisfies ActiveConnector;
      yield* Ref.set(activeRef, connector);
      yield* Effect.forkIn(observeConnectorOutput(connector), connectorScope);
      yield* Effect.forkIn(superviseConnector(connector), connectorScope);
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
      reason: "Relay client did not start.",
      ...(config.tunnelId ? { tunnelId: config.tunnelId } : {}),
      ...(config.tunnelName ? { tunnelName: config.tunnelName } : {}),
    } satisfies CloudManagedEndpointRuntimeStatus;
  });

  const applyConfig = Effect.fn("CloudManagedEndpointRuntime.applyConfig")(
    (config: RelayManagedEndpointRuntimeConfig | null) =>
      reconcileSemaphore.withPermits(1)(
        // An explicit config change starts over with a fresh backoff.
        Ref.set(restartDelayRef, 0).pipe(
          Effect.andThen(Ref.set(desiredConfigRef, config)),
          Effect.andThen(reconcileConfig(config)),
        ),
      ),
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
  yield* runtime.applyConfig(initialConfig);
  yield* Effect.addFinalizer(() => runtime.applyConfig(null));
  return runtime;
});

export const layer = Layer.effect(CloudManagedEndpointRuntime, make);
