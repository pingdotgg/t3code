// @effect-diagnostics-next-line nodeBuiltinImport:off -- A synchronous digest inside the pure provider mapping.
import * as NodeCrypto from "node:crypto";
import {
  ProviderSetupError,
  type WsServerRefreshProvidersRpc,
  type ServerProvider,
} from "@t3tools/contracts";
import { UsagePolling, UsageProviderFilter } from "@t3tools/provider-core/server/usageLimits";
import { withUsageLimitsCommands } from "@t3tools/shared/usageLimits";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { invalidateSettingsSecrets } from "../sourceControl/sourceControlHostSecrets.ts";

type RefreshInput = typeof WsServerRefreshProvidersRpc.payloadSchema.Type;

export class ProviderRefresh extends Context.Service<
  ProviderRefresh,
  {
    readonly refresh: (
      input: RefreshInput,
    ) => Effect.Effect<
      { readonly providers: ReadonlyArray<ServerProvider>; readonly serverTime?: number },
      ProviderSetupError
    >;
  }
>()("t3/provider/ProviderRefresh") {}

// A failed scan leaves no cwd snapshot, so a client without the machine catalog gets it
// as a pending snapshot, which it shows while it retries the scan.
function workspaceSnapshotOrCatalog(
  provider: ServerProvider,
  cwd: string,
  catalogOnDemand: boolean,
) {
  const snapshots = (provider.workspaceSnapshots ?? []).filter((snapshot) => snapshot.cwd === cwd);
  if (snapshots.length > 0 || !catalogOnDemand) return snapshots;
  return [
    {
      cwd,
      checkedAt: provider.checkedAt,
      slashCommands: provider.slashCommands,
      slashCommandsPending: true,
      skills: provider.skills,
    },
  ];
}

// What an on-demand catalog client keeps of the machine catalog: full entries come from the
// cwd snapshot it fetches, and skill names and labels keep skill links working without one.
function machineCatalogNames(provider: Pick<ServerProvider, "slashCommands" | "skills">) {
  return {
    slashCommands: provider.slashCommands.map(({ name }) => ({ name })),
    skills: provider.skills.map(({ description: _d, shortDescription: _s, ...skill }) => skill),
  };
}

// Stable across restarts, so a client's cached lists stay current until the catalog changes.
// It covers the full entries: a changed description or input hint must reach the client too.
const machineCatalogDigest = (provider: Pick<ServerProvider, "slashCommands" | "skills">) =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify([provider.slashCommands, provider.skills]))
    .digest("hex")
    .slice(0, 16);

// Names, or the digest that stands for them, still change the config when the machine catalog
// does, so the client refetches its cwd snapshot.
export function withoutWorkspaceSnapshots(
  providers: ReadonlyArray<ServerProvider>,
  catalogsPerCwd: ReadonlySet<string> = new Set(),
  catalogDigests = false,
): ServerProvider[] {
  return providers.map(({ workspaceSnapshots: _workspaceSnapshots, ...provider }) => {
    if (!catalogsPerCwd.has(provider.instanceId)) return provider;
    return catalogDigests
      ? {
          ...provider,
          slashCommands: [],
          skills: [],
          catalogDigest: machineCatalogDigest(provider),
        }
      : { ...provider, ...machineCatalogNames(provider) };
  });
}

const make = Effect.gen(function* () {
  const projectService = yield* ProjectService.ProjectService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const usageLimitSources = yield* UsageLimitSources.UsageLimitSources;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const secretResolver = yield* SecretResolver.SecretResolver;
  // Request instrumentation already owns the span; keep this helper in that context.
  const refresh = Effect.fnUntraced(function* (input: RefreshInput) {
    if (input.modelCatalogOnly === true) {
      yield* providerRegistry.refreshModelCatalog;
      return { providers: [] };
    }
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
    const reloadsSecretsBeforeRefresh =
      input.reloadSecrets === true && !(input.cwd !== undefined && input.instanceId !== undefined);
    if (input.usage === undefined && !sourcesOnly && !reloadsSecretsBeforeRefresh) {
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
              scanCwd: yield* projectService.workspaceScanDirectory(input.cwd),
              fresh: input.fresh === true,
            })
          : input.reloadSecrets === true
            ? providerRegistry.reloadSecretsAndRefresh(input.instanceId).pipe(
                Effect.provideService(UsagePolling, false),
                Effect.filterOrElse(
                  () => !usage,
                  () => providerRegistry.refreshUsage(input.instanceId, input.usageProviders),
                ),
              )
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
    const serverTime = yield* Clock.currentTimeMillis;
    if (
      input.omitProviders === true &&
      (input.instanceId === undefined || input.cwd === undefined)
    ) {
      return { providers: [], serverTime };
    }
    if (input.workspaceSnapshotsOnDemand !== true) return { providers, serverTime };
    const commandProviders =
      input.usageLimitsCommand === true
        ? withUsageLimitsCommands(providers, yield* usageLimitSources.current)
        : providers;
    const { instanceId, cwd } = input;
    if (instanceId === undefined || cwd === undefined) {
      return { providers: withoutWorkspaceSnapshots(commandProviders), serverTime };
    }
    const catalogOnDemand =
      input.providerCatalogsOnDemand === true &&
      (yield* providerInstances.getInstance(instanceId))?.snapshotForCwd !== undefined;
    return {
      serverTime,
      providers: commandProviders
        .filter((provider) => provider.instanceId === instanceId)
        .map((provider) => {
          const catalog =
            catalogOnDemand && input.machineCatalog === true
              ? machineCatalogNames(provider)
              : undefined;
          return {
            ...provider,
            // Callers read only the cwd snapshot; the config stream carries the rest.
            models: [],
            slashCommands: catalog?.slashCommands ?? [],
            skills: catalog?.skills ?? [],
            ...(catalog === undefined ? {} : { catalogDigest: machineCatalogDigest(provider) }),
            workspaceSnapshots: workspaceSnapshotOrCatalog(provider, cwd, catalogOnDemand),
          };
        }),
    };
  });
  return ProviderRefresh.of({ refresh });
});

export const layer = Layer.effect(ProviderRefresh, make);
