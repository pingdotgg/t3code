import type {
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import {
  formatResetsIn,
  limitsNotice,
  providersWithLimits,
  remainingPercent,
} from "@t3tools/shared/usageLimits";

/** Quota left at or below this reads as the error colour, matching the context meter's last stretch. */
export const USAGE_LIMIT_METER_WARNING_PERCENT = 10;

export interface UsageLimitMeterModel {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ServerProvider["driver"];
  /** The instance's configured name; null when it goes by its driver. */
  readonly displayName: string | null;
  /** Plan as the provider labels it (`Claude Max`, `ChatGPT Plus`). */
  readonly plan: string | null;
  readonly limits: ServerProviderUsageLimits;
}

/**
 * The composer meter follows the selected provider instance and reads the
 * same `usageLimits` snapshot Usage → Limits and `/usage-limits` draw from,
 * so it needs no request of its own and stays live as turn-driven updates
 * merge into the config stream. Null when the instance reports nothing the
 * glyph can draw: an API-key account, a failed probe, or no windows yet.
 */
export function resolveUsageLimitMeter(
  providers: readonly ServerProvider[],
  instanceId: ProviderInstanceId | null | undefined,
): UsageLimitMeterModel | null {
  if (!instanceId) return null;
  const provider = providersWithLimits(providers).find(
    (candidate) => candidate.instanceId === instanceId,
  );
  if (!provider?.usageLimits || limitsNotice(provider.usageLimits) !== null) return null;
  return {
    instanceId: provider.instanceId,
    driver: provider.driver,
    displayName: provider.displayName?.trim() || null,
    plan: provider.auth.label?.trim() || null,
    limits: provider.usageLimits,
  };
}

/** True once the provider's reset instant has passed; the reported figure is then stale. */
export function isUsageWindowReset(window: ServerProviderUsageWindow, now: number): boolean {
  if (window.resetsAt === undefined) return false;
  const at = Date.parse(window.resetsAt);
  return Number.isFinite(at) && at <= now;
}

/**
 * The window the glyph summarises: the least quota left among windows whose
 * reset has not passed. A window past its reset is full again as far as the
 * provider is concerned, so it never drives the warning colour.
 */
export function selectHeadlineUsageWindow(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  now: number,
): ServerProviderUsageWindow | null {
  let headline: ServerProviderUsageWindow | null = null;
  for (const window of windows) {
    if (isUsageWindowReset(window, now)) continue;
    if (!headline || remainingPercent(window) < remainingPercent(headline)) {
      headline = window;
    }
  }
  return headline;
}

/** `Session: 58% left, resets in 2h 10m`, for the trigger's accessible name. */
export function formatUsageLimitMeterLabel(model: UsageLimitMeterModel, now: number): string {
  const headline = selectHeadlineUsageWindow(model.limits.windows, now);
  if (!headline) return "Usage limits";
  const resetsIn = formatResetsIn(headline, now);
  return `${headline.label}: ${remainingPercent(headline)}% left${resetsIn ? `, ${resetsIn}` : ""}`;
}
