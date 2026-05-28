import type { RelayManagedEndpointRuntimeConfig } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { makeServerSecretStore } from "../auth/Layers/ServerSecretStore.ts";
import { CLOUD_ENDPOINT_RUNTIME_CONFIG, decodeRuntimeConfig } from "./config.ts";

function bytesToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

const readRuntimeConfig = Effect.gen(function* () {
  const secrets = yield* makeServerSecretStore;
  const bytes = yield* secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG);
  if (!bytes) {
    return null;
  }
  return Option.getOrNull(decodeRuntimeConfig(bytesToString(bytes)));
});

export interface CloudManagedEndpointRuntimeShape {
  readonly applyConfig: (
    config: RelayManagedEndpointRuntimeConfig | null,
  ) => Effect.Effect<CloudManagedEndpointRuntimeStatus>;
}

export class CloudManagedEndpointRuntime extends Context.Service<
  CloudManagedEndpointRuntime,
  CloudManagedEndpointRuntimeShape
>()("t3/cloud/ManagedEndpointRuntime") {}

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

interface ActiveConnector {
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly scope: Scope.Closeable;
  readonly configKey: string;
  readonly config: RelayManagedEndpointRuntimeConfig;
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
          Effect.logInfo("Cloudflare managed endpoint connector stopped", {
            pid: Number(connector.child.pid),
          }),
        ),
        Effect.ignore,
      )
    : Effect.void;

export const makeCloudManagedEndpointRuntime = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const activeRef = yield* Ref.make<ActiveConnector | null>(null);
  let applyConfig: CloudManagedEndpointRuntimeShape["applyConfig"];

  const stopActive = Effect.gen(function* () {
    const active = yield* Ref.getAndSet(activeRef, null);
    yield* stopConnector(active);
  });

  const superviseConnector = (connector: ActiveConnector) =>
    Effect.gen(function* () {
      const exitCode = yield* connector.child.exitCode;
      const active = yield* Ref.get(activeRef);
      if (active?.child.pid !== connector.child.pid || active.configKey !== connector.configKey) {
        return;
      }
      yield* Ref.set(activeRef, null);
      yield* Effect.logWarning("Cloudflare managed endpoint connector exited; restarting", {
        pid: Number(connector.child.pid),
        exitCode: Number(exitCode),
        tunnelId: connector.config.tunnelId,
        tunnelName: connector.config.tunnelName,
      });
      yield* applyConfig(connector.config);
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Cloudflare managed endpoint connector supervisor failed", { cause }),
      ),
    );

  applyConfig = (config) =>
    Effect.gen(function* () {
      if (!config || config.providerKind !== "cloudflare_tunnel") {
        yield* stopActive;
        return config
          ? { status: "unsupported", providerKind: config.providerKind }
          : { status: "disabled" };
      }

      const nextConfigKey = runtimeConfigKey(config);
      const active = yield* Ref.get(activeRef);
      if (active?.configKey === nextConfigKey) {
        const isRunning = yield* active.child.isRunning.pipe(
          Effect.catch(() => Effect.succeed(false)),
        );
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

      const connectorScope = yield* Scope.make("sequential");
      const child = yield* spawner
        .spawn(
          ChildProcess.make("cloudflared", ["tunnel", "run", "--token", config.connectorToken], {
            shell: process.platform === "win32",
            stderr: "ignore",
            stdout: "ignore",
          }),
        )
        .pipe(
          Effect.provideService(Scope.Scope, connectorScope),
          Effect.tap(() =>
            Effect.logInfo("Cloudflare managed endpoint connector started", {
              tunnelId: config.tunnelId,
              tunnelName: config.tunnelName,
            }),
          ),
          Effect.catch((cause) =>
            Effect.logWarning("Failed to start Cloudflare managed endpoint connector", {
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
        yield* Ref.set(activeRef, connector);
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
        reason: "Cloudflare connector did not start.",
        ...(config.tunnelId ? { tunnelId: config.tunnelId } : {}),
        ...(config.tunnelName ? { tunnelName: config.tunnelName } : {}),
      } satisfies CloudManagedEndpointRuntimeStatus;
    });

  return CloudManagedEndpointRuntime.of({
    applyConfig,
  });
});

export const CloudManagedEndpointRuntimeLive = Layer.effect(
  CloudManagedEndpointRuntime,
  Effect.gen(function* () {
    const runtime = yield* makeCloudManagedEndpointRuntime;
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
  }),
);
