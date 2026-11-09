import { isAppActive, subscribeAppState } from "../../lib/appState";
import {
  EnvironmentId,
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  refreshUsageLimits,
  usageLimitsRefreshDelay,
  usageRefreshDeadline,
  usageRefreshAccountKey,
} from "@t3tools/client-runtime/state/usage";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";

/**
 * Whether the last finished limits refresh for an environment failed. Not kept
 * alive: the limits view mounts it, and leaving the view forgets old failures.
 */
const limitsRefreshFailedAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(false).pipe(Atom.withLabel(`mobile:limits-refresh-failed:${environmentId}`)),
);

export function instanceLimitsRefreshSelection(
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
  driver?: ProviderDriverKind,
  providers: readonly Pick<ServerProvider, "instanceId" | "driver" | "auth">[] = [],
  generation = 0,
) {
  return {
    key: JSON.stringify([
      instanceId,
      driver,
      usageRefreshAccountKey(environmentId, providers, driver, null, generation),
    ]),
    resources: [
      ...(driver
        ? [
            JSON.stringify([
              "provider",
              driver,
              usageRefreshAccountKey(environmentId, providers, driver, null, generation),
            ]),
          ]
        : []),
      JSON.stringify([
        "instance",
        instanceId,
        driver,
        usageRefreshAccountKey(environmentId, providers, driver, instanceId, generation),
      ]),
    ],
  };
}

function environmentLimitsRefreshKeys(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
) {
  const config = registry.get(serverEnvironment.configValueAtom(environmentId));
  const generation =
    registry.get(environmentPresentations.presentationAtom(environmentId))?.connection.generation ??
    0;
  const keys = (config?.providers ?? []).flatMap(
    (provider) =>
      instanceLimitsRefreshSelection(
        environmentId,
        provider.instanceId,
        provider.driver,
        config?.providers ?? [],
        generation,
      ).resources,
  );
  for (const source of config?.usageLimitSources ?? []) {
    keys.push(
      JSON.stringify(["source", source.id, generation]),
      ...source.accounts.map((account) =>
        JSON.stringify([
          "provider",
          account.driver,
          usageRefreshAccountKey(
            environmentId,
            config?.providers ?? [],
            account.driver,
            null,
            generation,
          ),
        ]),
      ),
    );
  }
  return keys.length ? [...new Set(keys)] : [""];
}

export async function refreshEnvironmentLimits(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  options: {
    readonly automatic?: boolean;
    readonly instanceId?: ProviderInstanceId;
    readonly driver?: ProviderDriverKind;
  } = {},
): Promise<void> {
  if (!isAppActive()) return;
  const providers = registry.get(serverEnvironment.configValueAtom(environmentId))?.providers ?? [];
  const generation =
    registry.get(environmentPresentations.presentationAtom(environmentId))?.connection.generation ??
    0;
  const result = await refreshUsageLimits(
    environmentId,
    () =>
      runAtomCommand(
        registry,
        serverEnvironment.refreshProviders,
        {
          environmentId,
          input: options.driver
            ? { usage: true, usageProviders: [options.driver] }
            : { usage: true, ...(options.instanceId ? { instanceId: options.instanceId } : {}) },
        },
        { reportFailure: false },
      ),
    options.automatic,
    {
      ...(options.instanceId
        ? instanceLimitsRefreshSelection(
            environmentId,
            options.instanceId,
            options.driver,
            providers,
            generation,
          )
        : {
            key: usageRefreshAccountKey(environmentId, providers, null, null, generation),
            resources: environmentLimitsRefreshKeys(registry, environmentId),
          }),
      refreshDeadline: (result) =>
        AsyncResult.isSuccess(result)
          ? usageRefreshDeadline(
              [
                ...result.value.providers
                  .filter((provider) =>
                    options.driver
                      ? provider.driver === options.driver
                      : options.instanceId === undefined ||
                        provider.instanceId === options.instanceId,
                  )
                  .map((provider) => provider.usageLimits),
                ...(
                  registry.get(serverEnvironment.configValueAtom(environmentId))
                    ?.usageLimitSources ?? []
                ).flatMap((source) =>
                  source.accounts
                    .filter((account) =>
                      options.driver
                        ? account.driver === options.driver
                        : options.instanceId === undefined,
                    )
                    .map((account) => account.usageLimits),
                ),
              ],
              result.value.serverTime,
            )
          : undefined,
    },
  );
  if (result === undefined) return;
  registry.set(limitsRefreshFailedAtom(environmentId), result._tag === "Failure");
}

const limitsAccountKeyAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) =>
    usageRefreshAccountKey(
      environmentId,
      get(serverEnvironment.configValueAtom(environmentId))?.providers ?? [],
      null,
      null,
      get(environmentPresentations.presentationAtom(environmentId))?.connection.generation,
    ),
  ),
);

// Mounting starts an automatic refresh, which refreshUsageLimits throttles to
// one every few minutes per environment.
const limitsAutoRefreshAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    get(limitsAccountKeyAtom(environmentId));
    let disposed = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (!isAppActive() || pending || disposed) return;
      pending = true;
      clearTimeout(timer);
      try {
        await refreshEnvironmentLimits(get.registry, environmentId, { automatic: true });
      } finally {
        pending = false;
        if (!disposed)
          timer = setTimeout(
            () => {
              void refresh();
            },
            Math.max(
              30_000,
              usageLimitsRefreshDelay(
                environmentId,
                environmentLimitsRefreshKeys(get.registry, environmentId),
              ),
            ),
          );
      }
    };
    void refresh();
    const unsubscribe = subscribeAppState(() => {
      void refresh();
    });
    get.addFinalizer(() => {
      disposed = true;
      unsubscribe();
      clearTimeout(timer);
    });
  }).pipe(Atom.withLabel(`mobile:limits-auto-refresh:${environmentId}`)),
);

export function environmentIdsKey(environmentIds: Iterable<EnvironmentId>): string {
  return [...environmentIds].sort().join(",");
}

function splitEnvironmentIds(key: string): EnvironmentId[] {
  return key === "" ? [] : key.split(",").map((id) => EnvironmentId.make(id));
}

/** Keyed by a sorted, comma-joined id list so equal selections share one atom. */
export const limitsAutoRefreshSetAtom = Atom.family((environmentIds: string) =>
  Atom.make((get) => {
    for (const environmentId of splitEnvironmentIds(environmentIds)) {
      get(limitsAutoRefreshAtom(environmentId));
    }
  }),
);

export const limitsRefreshFailuresAtom = Atom.family((environmentIds: string) =>
  Atom.make((get) =>
    splitEnvironmentIds(environmentIds).filter((environmentId) =>
      get(limitsRefreshFailedAtom(environmentId)),
    ),
  ),
);
