import {
  ProviderSetupError,
  type WsServerRefreshProvidersRpc,
  type ServerProvider,
} from "@t3tools/contracts";
import { UsagePolling, UsageProviderFilter } from "@t3tools/provider-core/server/usageLimits";
import { withUsageLimitsCommands } from "@t3tools/shared/usageLimits";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as ServerSettings from "../serverSettings.ts";
import { invalidateSettingsSecrets } from "../sourceControl/sourceControlHostSecrets.ts";

type RefreshInput = typeof WsServerRefreshProvidersRpc.payloadSchema.Type;

export class ProviderRefresh extends Context.Service<
  ProviderRefresh,
  {
    readonly refresh: (
      input: RefreshInput,
    ) => Effect.Effect<{ readonly providers: ReadonlyArray<ServerProvider> }, ProviderSetupError>;
  }
>()("t3/provider/ProviderRefresh") {}

export function withoutWorkspaceSnapshots(
  providers: ReadonlyArray<ServerProvider>,
): ServerProvider[] {
  return providers.map(({ workspaceSnapshots: _workspaceSnapshots, ...provider }) => provider);
}

const make = Effect.gen(function* () {
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const usageLimitSources = yield* UsageLimitSources.UsageLimitSources;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const secretResolver = yield* SecretResolver.SecretResolver;
  const refresh = Effect.fn("ProviderRefresh.refresh")(function* (input: RefreshInput) {
    // Older clients omit usage and expect a quota refresh; current clients opt out for health.
    const usage = input.usage !== false;
    const sourcesOnly = input.usageSources === true;
    if (input.refreshModels) {
      yield* providerRegistry.invalidateModelCaches({
        instanceId: input.instanceId,
        cwd: input.cwd,
        fresh: input.fresh,
      });
    }
    if (input.reloadSecrets === true && input.instanceId === undefined) {
      yield* invalidateSettingsSecrets(secretResolver, serverSettings.getSettings);
    }
    if (input.usage === undefined && !sourcesOnly) {
      yield* (
        input.instanceId !== undefined
          ? providerRegistry.refreshInstance(input.instanceId)
          : providerRegistry.refresh()
      ).pipe(Effect.provideService(UsagePolling, false));
    }
    if (sourcesOnly) {
      yield* usageLimitSources.refresh.pipe(
        Effect.provideService(UsageProviderFilter, input.usageProviders),
      );
    }
    // Await refresh; RPC scope closure would interrupt a fork before the hub answered.
    if (!sourcesOnly && usage && input.instanceId === undefined) {
      yield* usageLimitSources.refresh.pipe(
        Effect.provideService(UsageProviderFilter, input.usageProviders),
      );
    }
    let providers = yield* (
      sourcesOnly
        ? providerRegistry.getProviders
        : input.cwd !== undefined && input.instanceId !== undefined
          ? providerRegistry.refreshWorkspaceSnapshot({
              instanceId: input.instanceId,
              cwd: input.cwd,
              fresh: input.fresh === true,
            })
          : input.reloadSecrets === true
            ? providerRegistry.reloadSecretsAndRefresh(input.instanceId)
            : usage
              ? providerRegistry.refreshUsage(input.instanceId, input.usageProviders)
              : input.instanceId !== undefined
                ? providerRegistry.refreshInstance(input.instanceId)
                : providerRegistry.refresh()
    ).pipe(Effect.provideService(UsagePolling, usage));
    if (input.refreshModels && !sourcesOnly) {
      const instances = yield* providerInstances.listInstances;
      for (const instance of instances) {
        if (
          !instance.refreshModels ||
          (input.instanceId !== undefined && input.instanceId !== instance.instanceId) ||
          !providers.some(
            (provider) =>
              provider.instanceId === instance.instanceId && provider.enabled && provider.installed,
          )
        )
          continue;
        yield* instance.refreshModels().pipe(
          Effect.mapError(
            (error) =>
              new ProviderSetupError({
                instanceId: instance.instanceId,
                operation: "refresh-models",
                detail: error.detail,
              }),
          ),
        );
        providers = yield* providerRegistry.refreshInstance(instance.instanceId);
      }
    }
    if (input.workspaceSnapshotsOnDemand !== true) return { providers };
    const commandProviders =
      input.usageLimitsCommand === true
        ? withUsageLimitsCommands(providers, yield* usageLimitSources.current)
        : providers;
    const { instanceId, cwd } = input;
    if (instanceId === undefined || cwd === undefined) {
      return { providers: withoutWorkspaceSnapshots(commandProviders) };
    }
    return {
      providers: commandProviders
        .filter((provider) => provider.instanceId === instanceId)
        .map((provider) => ({
          ...provider,
          // Callers read only the cwd snapshot; the config stream carries the rest.
          models: [],
          slashCommands: [],
          skills: [],
          workspaceSnapshots: (provider.workspaceSnapshots ?? []).filter(
            (snapshot) => snapshot.cwd === cwd,
          ),
        })),
    };
  });
  return ProviderRefresh.of({ refresh });
});

export const layer = Layer.effect(ProviderRefresh, make);
