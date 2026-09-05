import type { ServerProvider, ServerProviderUsageLimits } from "@t3tools/contracts";

import { getDriverOption } from "../settings/providerDriverMeta";

export type ComposerUsageMeterModel = {
  readonly providerLabel: string;
  readonly usageLimits: ServerProviderUsageLimits;
  readonly usedPercent: number;
};

export function headlineUsageUsedPercent(windows: ServerProviderUsageLimits["windows"]): number {
  if (windows.length === 0) return 0;
  return Math.max(...windows.map((window) => window.usedPercent));
}

export function composerUsageProviderLabel(provider: ServerProvider): string {
  return (
    provider.displayName?.trim() ||
    getDriverOption(provider.driver)?.label ||
    String(provider.driver)
  );
}

function isGrokFreeTier(provider: Pick<ServerProvider, "driver" | "auth">): boolean {
  if (provider.driver !== "grok") return false;
  const tier = (provider.auth.label ?? provider.auth.type ?? "").trim().toLowerCase();
  return tier === "free";
}

/**
 * Chat-box usage is opt-in, scoped to the thread's current provider, and
 * hidden until the thread has started a turn. Missing, failed, or empty
 * snapshots stay hidden so the chat box never renders an error state next
 * to send. Any provider with usable windows shows.
 */
export function resolveComposerUsageMeter(input: {
  readonly enabled: boolean;
  readonly hasStartedTurn: boolean;
  readonly provider: ServerProvider | null | undefined;
}): ComposerUsageMeterModel | null {
  if (!input.enabled || !input.hasStartedTurn) return null;
  const provider = input.provider;
  if (!provider) return null;
  if (!provider.enabled || !provider.installed || provider.availability === "unavailable") {
    return null;
  }
  if (isGrokFreeTier(provider)) return null;

  const usageLimits = provider.usageLimits;
  if (!usageLimits || usageLimits.unavailable || usageLimits.windows.length === 0) return null;

  return {
    providerLabel: composerUsageProviderLabel(provider),
    usageLimits,
    usedPercent: headlineUsageUsedPercent(usageLimits.windows),
  };
}
