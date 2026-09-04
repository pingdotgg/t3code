import {
  isProviderAvailable,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";

export type ProviderWithReportedUsage = ServerProvider & {
  readonly usageLimits: ServerProviderUsageLimits;
};

/**
 * Only surface providers that are usable and currently report at least one
 * quota window. An unsupported or failed probe stays out of the title bar.
 */
export function providersWithReportedUsage(
  providers: readonly ServerProvider[],
): readonly ProviderWithReportedUsage[] {
  return providers.filter(
    (provider): provider is ProviderWithReportedUsage =>
      provider.enabled &&
      provider.installed &&
      isProviderAvailable(provider) &&
      provider.usageLimits !== undefined &&
      provider.usageLimits.unavailable === undefined &&
      provider.usageLimits.windows.length > 0,
  );
}

export function highestUsageWindow(provider: ProviderWithReportedUsage): ServerProviderUsageWindow {
  return provider.usageLimits.windows.reduce((highest, window) =>
    window.usedPercent > highest.usedPercent ? window : highest,
  );
}

/**
 * Prefer the provider bound to the current session. When it cannot report
 * usage, show the provider whose most constrained window is currently fullest.
 */
export function selectCollapsedUsageProvider(
  providers: readonly ProviderWithReportedUsage[],
  activeProviderInstanceId: ProviderInstanceId | null,
): ProviderWithReportedUsage | null {
  const activeProvider = providers.find(
    (provider) => provider.instanceId === activeProviderInstanceId,
  );
  if (activeProvider) return activeProvider;

  return (
    providers.reduce<ProviderWithReportedUsage | null>((highest, provider) => {
      if (highest === null) return provider;
      return highestUsageWindow(provider).usedPercent > highestUsageWindow(highest).usedPercent
        ? provider
        : highest;
    }, null) ?? null
  );
}
