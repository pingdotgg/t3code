import { useMemo } from "react";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  resolveProviderInstanceAccentColor,
  resolveProviderInstanceDisplayName,
  shouldShowInstanceBadge,
} from "@t3tools/client-runtime/state/provider-instance-display";
import type { EnvironmentId, ProviderDriverKind } from "@t3tools/contracts";

import type {
  ThreadListProjectOverrides,
  ThreadListProvider,
} from "../../state/thread-list-environments";
export interface ThreadRowProviderInstance {
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string;
  readonly accentColor?: string | undefined;
  readonly showBadge: boolean;
}

/** Scope by environment; default instance ids name different accounts on different servers. */
export function resolveThreadProviderInstance(
  environmentProviders: ReadonlyArray<ThreadListProvider> | undefined,
  thread: EnvironmentThreadShell,
  projectOverrides?: ThreadListProjectOverrides,
): ThreadRowProviderInstance | null {
  if (environmentProviders === undefined) return null;
  // Matches web: a project override decides which siblings make this instance ambiguous.
  const overrides = projectOverrides?.[thread.projectId]?.providerInstances;
  const providers = overrides
    ? environmentProviders.map((provider) => {
        const enabled = overrides[provider.instanceId]?.enabled ?? provider.enabled;
        return enabled === provider.enabled ? provider : { ...provider, enabled };
      })
    : environmentProviders;
  const instanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
  const snapshot = providers.find((provider) => provider.instanceId === instanceId);
  if (!snapshot) return null;
  const entry = {
    driverKind: snapshot.driver,
    displayName: resolveProviderInstanceDisplayName(snapshot),
    accentColor: resolveProviderInstanceAccentColor(snapshot, providers),
  };
  return {
    ...entry,
    showBadge: shouldShowInstanceBadge(
      { ...entry, enabled: snapshot.enabled },
      providers.map((provider) => ({ driverKind: provider.driver, enabled: provider.enabled })),
    ),
  };
}

/** Cache per provider-list generation so fresh resolver objects cannot invalidate every memoized row. */
export function createThreadRowProviderInstanceResolver(
  providersByEnvironmentId: ReadonlyMap<EnvironmentId, ReadonlyArray<ThreadListProvider>>,
  projectOverridesByEnvironmentId?: ReadonlyMap<EnvironmentId, ThreadListProjectOverrides>,
): (thread: EnvironmentThreadShell) => ThreadRowProviderInstance | null {
  const cache = new Map<string, ThreadRowProviderInstance | null>();
  return (thread) => {
    const instanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
    const cacheKey = `${thread.environmentId}|${thread.projectId}|${instanceId ?? ""}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;
    const resolved = resolveThreadProviderInstance(
      providersByEnvironmentId.get(thread.environmentId),
      thread,
      projectOverridesByEnvironmentId?.get(thread.environmentId),
    );
    cache.set(cacheKey, resolved);
    return resolved;
  };
}

export function useThreadRowProviderInstanceResolver(
  providersByEnvironmentId: ReadonlyMap<EnvironmentId, ReadonlyArray<ThreadListProvider>>,
  projectOverridesByEnvironmentId: ReadonlyMap<EnvironmentId, ThreadListProjectOverrides>,
): (thread: EnvironmentThreadShell) => ThreadRowProviderInstance | null {
  return useMemo(
    () =>
      createThreadRowProviderInstanceResolver(
        providersByEnvironmentId,
        projectOverridesByEnvironmentId,
      ),
    [providersByEnvironmentId, projectOverridesByEnvironmentId],
  );
}
