import {
  defaultInstanceIdForDriver,
  INFERENCE_DRIVERS,
  isInferenceProviderConfig,
  ProviderDriverKind,
  type InferenceConsumer,
  type InferenceDriver,
  type InferenceProxyStatus,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { connectionRoutes } from "../connection/routes.ts";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import type { Atom } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { requestGuarded } from "../rpc/client.ts";
import { createCommandPermissions } from "./commandPermissions.ts";
import type { EnvironmentServerConfig } from "../connection/presentation.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentGuardedRpcQueryAtomFamily,
  createRuntimeCommand,
  withEnvironmentRpcPermissions,
} from "./runtime.ts";

export interface InferenceFleetEnvironment extends InferenceConsumer {
  readonly connection: { readonly phase: string };
  readonly serverConfig: EnvironmentServerConfig | null;
}

export function planInferenceFallbacks(
  host: InferenceFleetEnvironment,
  status: InferenceProxyStatus,
  consumers: ReadonlyArray<InferenceFleetEnvironment>,
): ReadonlyArray<{
  host: InferenceConsumer;
  consumer: InferenceConsumer;
  driver: InferenceDriver;
  fallback: true;
}> {
  if (!status.enabled || !status.running || host.connection.phase !== "connected") return [];
  return consumers.flatMap((consumer) => {
    const config = consumer.serverConfig;
    if (consumer.connection.phase !== "connected" || !config) return [];
    if (host.environmentId !== consumer.environmentId && !status.sharing) return [];
    return INFERENCE_DRIVERS.flatMap((driver) => {
      if (!status.availableDrivers?.includes(driver)) return [];
      const instance =
        config.settings.providerInstances[
          defaultInstanceIdForDriver(ProviderDriverKind.make(driver))
        ];
      const route = instance?.config;
      return instance?.enabled !== false &&
        isInferenceProviderConfig(route) &&
        route.inferenceEnabled &&
        route.inferenceHostId !== host.environmentId
        ? [
            {
              host: { environmentId: host.environmentId, label: host.label },
              consumer: { environmentId: consumer.environmentId, label: consumer.label },
              driver,
              fallback: true as const,
            },
          ]
        : [];
    });
  });
}

export function inferenceFallbackKey(
  host: InferenceConsumer,
  consumer: InferenceFleetEnvironment,
  driver: InferenceDriver,
  status: InferenceProxyStatus,
): string {
  const instance =
    consumer.serverConfig?.settings.providerInstances[
      defaultInstanceIdForDriver(ProviderDriverKind.make(driver))
    ];
  const route = instance?.config;
  return JSON.stringify([
    host.environmentId,
    consumer.environmentId,
    driver,
    isInferenceProviderConfig(route) ? route.inferenceHostId : null,
    isInferenceProviderConfig(route) ? route.inferenceBaseUrl : null,
    status.enabled,
    status.sharing,
    status.running,
    status.availableDrivers,
    status.accounts.map((account) => [
      account.name,
      account.provider,
      account.status,
      account.availability,
      account.retryAfter,
    ]),
  ]);
}

export function inferenceFallbackRetryDelay(failures: number): number {
  return Math.min(60_000 * 2 ** Math.min(failures - 1, 3), 300_000);
}

export function createInferenceProxyAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const inferenceStatus = createEnvironmentGuardedRpcQueryAtomFamily(runtime, {
    label: "inference:status",
    tag: WS_METHODS.inferenceStatus,
    execute: (input) => requestGuarded(WS_METHODS.inferenceStatus, input),
  });
  const updates = createEnvironmentGuardedRpcQueryAtomFamily(runtime, {
    label: "inference:updates",
    tag: WS_METHODS.inferenceManage,
    execute: () => requestGuarded(WS_METHODS.inferenceManage, { operation: "checkUpdate" }),
  });
  const manageInference = createEnvironmentRpcCommand(runtime, {
    label: "inference:manage",
    tag: WS_METHODS.inferenceManage,
    onSuccess: ({ environmentId, input }, registry) =>
      Effect.sync(() => {
        registry.refresh(inferenceStatus({ environmentId, input: {} }));
        if (input.operation === "configure" || input.operation === "update")
          registry.refresh(updates({ environmentId, input: { operation: "checkUpdate" } }));
      }),
  });
  const hostPermission = createCommandPermissions(runtime, WS_METHODS.inferenceGrant);
  const consumerPermission = createCommandPermissions(runtime, WS_METHODS.inferenceConnect);
  const fallbackPermission = createCommandPermissions(
    runtime,
    WS_METHODS.inferenceRegisterFallback,
  );
  const routeInference = createRuntimeCommand(runtime, {
    label: "inference:route",
    execute: Effect.fn("InferenceProxy.route")(
      function* (
        input: {
          host: InferenceConsumer;
          consumer: InferenceConsumer;
          driver: InferenceDriver;
          fallback?: boolean;
        },
        registry: AtomRegistry.AtomRegistry,
      ) {
        yield* (input.fallback ? fallbackPermission : consumerPermission).authorize(
          registry,
          input.consumer.environmentId,
        );
        const connections = yield* EnvironmentRegistry;
        const { grant, prepared } = yield* connections.run(
          input.host.environmentId,
          Effect.gen(function* () {
            const grant = yield* requestGuarded(WS_METHODS.inferenceGrant, {
              environmentId: input.consumer.environmentId,
              label: input.consumer.label,
              ...(input.fallback ? { automatic: true } : {}),
            });
            const supervisor = yield* EnvironmentSupervisor;
            return { grant, prepared: yield* SubscriptionRef.get(supervisor.prepared) };
          }),
        );
        const entries = yield* SubscriptionRef.get(connections.entries);
        const entry = entries.get(input.host.environmentId);
        const active = Option.getOrUndefined(prepared);
        const target = active?.target;
        const profile =
          entry && target?._tag === "SshConnectionTarget"
            ? connectionRoutes(entry).find(
                (route) =>
                  route.target._tag === "SshConnectionTarget" &&
                  route.target.connectionId === target.connectionId,
              )?.profile
            : undefined;
        const ssh =
          profile && Option.isSome(profile) && profile.value._tag === "SshConnectionProfile"
            ? profile.value.target
            : undefined;
        // Without SSH, the consumer cannot reach this client's loopback address for the host.
        const reachable =
          ssh !== undefined ||
          !["127.0.0.1", "localhost", "[::1]"].includes(
            URL.parse(active?.httpBaseUrl ?? "")?.hostname ?? "",
          );
        const connection =
          active && reachable ? { url: active.httpBaseUrl, ...(ssh ? { ssh } : {}) } : undefined;
        if (!input.fallback)
          registry.refresh(inferenceStatus({ environmentId: input.host.environmentId, input: {} }));
        yield* connections.run(
          input.consumer.environmentId,
          requestGuarded(
            input.fallback ? WS_METHODS.inferenceRegisterFallback : WS_METHODS.inferenceConnect,
            {
              grant,
              driver: input.driver,
              hostLabel: input.host.label,
              ...(connection ? { connection } : {}),
            },
          ),
        );
        if (!input.fallback)
          registry.refresh(
            inferenceStatus({ environmentId: input.consumer.environmentId, input: {} }),
          );
      },
      (effect, _input, registry) =>
        effect.pipe(
          withEnvironmentRpcPermissions(runtime, registry),
          Effect.withTracerEnabled(false),
        ),
    ),
  });
  return {
    inferenceStatus,
    updates,
    manageInference,
    routeInference,
    canGrant: hostPermission.permissionAtom,
    canConnect: consumerPermission.permissionAtom,
    canRegisterFallback: fallbackPermission.permissionAtom,
  };
}
