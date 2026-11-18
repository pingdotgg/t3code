import {
  defaultInstanceIdForDriver,
  INFERENCE_DRIVERS,
  INFERENCE_HARNESSES,
  InferenceProxyError,
  inferenceRouteIssue,
  isInferenceProviderConfig,
  ProviderDriverKind,
  type EnvironmentId,
  type InferenceConsumer,
  type InferenceDriver,
  type InferenceProxyStatus,
  WS_METHODS,
} from "@t3tools/contracts";
import { isProviderInstanceEnabledInAnyScope } from "@t3tools/shared/serverSettings";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
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

interface EnableInferenceRoutingInput {
  readonly consumer: InferenceConsumer;
  readonly driver: InferenceDriver;
  readonly environments: ReadonlyArray<InferenceFleetEnvironment>;
  readonly preferredHostId?: EnvironmentId;
}

export function inferenceHostRoutingIssue(
  status: InferenceProxyStatus | null,
  input: {
    readonly host: InferenceConsumer;
    readonly consumer: InferenceConsumer;
    readonly driver: InferenceDriver;
  },
): string | null {
  const issue = inferenceRouteIssue(
    status,
    input.host.environmentId === input.consumer.environmentId,
  );
  if (issue !== null) return issue;
  return status?.availableDrivers.includes(input.driver)
    ? null
    : `This host has no available ${INFERENCE_HARNESSES[input.driver].label} accounts.`;
}

export function inferenceHostCandidates<Environment extends InferenceFleetEnvironment>(
  environments: ReadonlyArray<Environment>,
  consumerId: EnvironmentId,
  preferredHostId?: EnvironmentId,
): ReadonlyArray<Environment> {
  const priority = (id: EnvironmentId) => (id === preferredHostId ? 0 : id === consumerId ? 1 : 2);
  return environments
    .filter(
      (environment) =>
        environment.connection.phase === "connected" &&
        environment.serverConfig?.environment.capabilities.inferenceProxy === true,
    )
    .sort(
      (left, right) =>
        priority(left.environmentId) - priority(right.environmentId) ||
        left.label.localeCompare(right.label) ||
        left.environmentId.localeCompare(right.environmentId),
    );
}

type InferenceAccount = InferenceProxyStatus["accounts"][number];

const accountAvailabilityLabels = {
  available: "Active",
  authenticationError: "Authentication or access rejected",
  rateLimited: "Rate limited",
  unavailable: "Unavailable",
  disabled: "Disabled",
} as const;

export function inferenceAccountStatus(account: InferenceAccount): string {
  return accountAvailabilityLabels[account.availability];
}

export function inferenceAccountRetryAfter(account: InferenceAccount): string | null {
  return account.availability === "rateLimited" ? (account.retryAfter ?? null) : null;
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
      if (!status.availableDrivers.includes(driver)) return [];
      const instanceId = defaultInstanceIdForDriver(ProviderDriverKind.make(driver));
      const instance = config.settings.providerInstances[instanceId];
      const route = instance?.config;
      return isProviderInstanceEnabledInAnyScope(config.settings, instanceId) &&
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
  const routeThroughHost = Effect.fn("InferenceProxy.route")(
    function* (
      input: {
        host: InferenceConsumer;
        consumer: InferenceConsumer;
        driver: InferenceDriver;
        fallback?: boolean;
        automatic?: boolean;
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
            ...(input.fallback || input.automatic ? { automatic: true } : {}),
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
  );
  const routeInference = createRuntimeCommand(runtime, {
    label: "inference:route",
    execute: (
      input: {
        readonly host: InferenceConsumer;
        readonly consumer: InferenceConsumer;
        readonly driver: InferenceDriver;
        readonly fallback?: boolean;
      },
      registry,
    ) => routeThroughHost(input, registry),
  });
  const enableInferenceRouting = createRuntimeCommand(runtime, {
    label: "inference:enable-routing",
    concurrency: {
      mode: "singleFlight",
      key: (input: EnableInferenceRoutingInput) =>
        JSON.stringify([input.consumer.environmentId, input.driver]),
    },
    execute: Effect.fn("InferenceProxy.enableRouting")(
      function* (input: EnableInferenceRoutingInput, registry: AtomRegistry.AtomRegistry) {
        yield* consumerPermission.authorize(registry, input.consumer.environmentId);
        const connections = yield* EnvironmentRegistry;
        const candidates = inferenceHostCandidates(
          input.environments,
          input.consumer.environmentId,
          input.preferredHostId,
        );
        const problems: string[] = [];
        for (const candidate of candidates) {
          const { environmentId, label } = candidate;
          const host = { environmentId, label };
          const result = yield* Effect.result(
            Effect.gen(function* () {
              yield* hostPermission.authorize(registry, environmentId);
              const status = yield* connections.run(
                environmentId,
                requestGuarded(WS_METHODS.inferenceStatus, {}),
              );
              const issue = inferenceHostRoutingIssue(status, { host, ...input });
              if (issue) return yield* new InferenceProxyError({ message: issue });
              yield* routeThroughHost({ ...input, host, automatic: true }, registry);
              return host;
            }),
          );
          if (Result.isSuccess(result)) return result.success;
          problems.push(`${label}: ${result.failure.message}`);
        }
        return yield* new InferenceProxyError({
          message: problems.join(" ") || "Connect to an environment that hosts inference accounts.",
        });
      },
      (effect, _input, registry) => withEnvironmentRpcPermissions(runtime, registry)(effect),
    ),
  });
  return {
    inferenceStatus,
    updates,
    manageInference,
    routeInference,
    enableInferenceRouting,
    canGrant: hostPermission.permissionAtom,
    canConnect: consumerPermission.permissionAtom,
    canRegisterFallback: fallbackPermission.permissionAtom,
  };
}
