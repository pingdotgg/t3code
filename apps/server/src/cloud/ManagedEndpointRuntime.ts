import type { RelayManagedEndpointRuntimeConfig } from "@t3tools/contracts/relay";
import * as RelayClient from "@t3tools/shared/relayClient";
import * as Context from "effect/Context";
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
    return Option.none<RelayManagedEndpointRuntimeConfig>();
  }
  return decodeRuntimeConfig(bytesToString(bytes.value));
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
      config: Option.Option<RelayManagedEndpointRuntimeConfig>,
    ) => Effect.Effect<CloudManagedEndpointRuntimeStatus>;
  }
>()("t3/cloud/ManagedEndpointRuntime/CloudManagedEndpointRuntime") {}

interface ActiveConnector {
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly scope: Scope.Closeable;
  readonly configKey: string;
  readonly config: RelayManagedEndpointRuntimeConfig;
}

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

const stopConnector = (connector: Option.Option<ActiveConnector>) =>
  Option.match(connector, {
    onNone: () => Effect.void,
    onSome: (active) =>
      Scope.close(active.scope, Exit.void).pipe(
        Effect.tap(() =>
          Effect.logInfo("Relay client stopped", {
            pid: Number(active.child.pid),
          }),
        ),
        Effect.ignore,
      ),
  });

export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const relayClient = yield* RelayClient.RelayClient;
  const activeRef = yield* Ref.make<Option.Option<ActiveConnector>>(Option.none());
  const desiredConfigRef = yield* Ref.make<Option.Option<RelayManagedEndpointRuntimeConfig>>(
    Option.none(),
  );
  const reconcileSemaphore = yield* Semaphore.make(1);
  let reconcileConfig: CloudManagedEndpointRuntime["Service"]["applyConfig"];

  const stopActive = Effect.gen(function* () {
    const active = yield* Ref.getAndSet(activeRef, Option.none());
    yield* stopConnector(active);
  });

  const superviseConnector = (connector: ActiveConnector) =>
    Effect.gen(function* () {
      const result = yield* Effect.result(connector.child.exitCode);
      yield* reconcileSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const active = yield* Ref.get(activeRef);
          if (
            Option.isNone(active) ||
            active.value.child.pid !== connector.child.pid ||
            active.value.configKey !== connector.configKey
          ) {
            return;
          }
          yield* Ref.set(activeRef, Option.none());
          yield* stopConnector(Option.some(connector));

          const desiredConfig = yield* Ref.get(desiredConfigRef);
          if (
            Option.isNone(desiredConfig) ||
            desiredConfig.value.providerKind !== "cloudflare_tunnel" ||
            runtimeConfigKey(desiredConfig.value) !== connector.configKey
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

  reconcileConfig = Effect.fn("CloudManagedEndpointRuntime.reconcileConfig")(
    function* (configOption) {
      if (Option.isNone(configOption)) {
        yield* stopActive;
        return { status: "disabled" };
      }

      const config = configOption.value;
      if (config.providerKind !== "cloudflare_tunnel") {
        yield* stopActive;
        return { status: "unsupported", providerKind: config.providerKind };
      }

      const nextConfigKey = runtimeConfigKey(config);
      const active = yield* Ref.get(activeRef);
      if (Option.isSome(active) && active.value.configKey === nextConfigKey) {
        const isRunning = yield* active.value.child.isRunning.pipe(
          Effect.orElseSucceed(() => false),
        );
        if (isRunning) {
          return {
            status: "running",
            providerKind: "cloudflare_tunnel",
            pid: Number(active.value.child.pid),
            ...(active.value.config.tunnelId ? { tunnelId: active.value.config.tunnelId } : {}),
            ...(active.value.config.tunnelName
              ? { tunnelName: active.value.config.tunnelName }
              : {}),
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
        } satisfies ActiveConnector;
        yield* Ref.set(activeRef, Option.some(connector));
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
    },
  );

  const applyConfig = Effect.fn("CloudManagedEndpointRuntime.applyConfig")(
    (config: Option.Option<RelayManagedEndpointRuntimeConfig>) =>
      reconcileSemaphore.withPermits(1)(
        Ref.set(desiredConfigRef, config).pipe(Effect.andThen(reconcileConfig(config))),
      ),
  );

  const runtime = CloudManagedEndpointRuntime.of({
    applyConfig,
  });

  const initialConfig = yield* readRuntimeConfig.pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Failed to read managed endpoint runtime config", { cause }).pipe(
        Effect.as(Option.none<RelayManagedEndpointRuntimeConfig>()),
      ),
    ),
  );
  yield* runtime.applyConfig(initialConfig);
  yield* Effect.addFinalizer(() => runtime.applyConfig(Option.none()));
  return runtime;
});

export const layer = Layer.effect(CloudManagedEndpointRuntime, make);
