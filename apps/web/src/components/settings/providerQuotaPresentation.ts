/**
 * Pure presentation for the provider account plan/quota row (fork f1,
 * increment 2).
 *
 * Everything here reads `ServerProviderAuth` and nothing else: the quota is
 * already on the provider snapshot that streams to every client, so no surface
 * needs to fetch anything, and there is no per-render read to debounce.
 *
 * The whole module is `now`-parameterised so countdowns are testable without
 * timers.
 *
 * @module providerQuotaPresentation
 */
import type { ProviderAccountRateLimitWindow, ServerProviderAuth } from "@t3tools/contracts";

/** Above this the meter is a warning; at 100 it is a hard stop. */
const QUOTA_WARNING_PERCENT = 80;

export type ProviderQuotaTone = "normal" | "warning" | "destructive";

export interface ProviderQuotaMeter {
  readonly id: string;
  readonly label: string;
  readonly usedPercent: number;
  readonly tone: ProviderQuotaTone;
  /** Reset countdown, when the provider supplied one. */
  readonly detail?: string;
}

export function providerQuotaTone(usedPercent: number, severity?: string): ProviderQuotaTone {
  if (usedPercent >= 100) {
    return "destructive";
  }
  const normalizedSeverity = severity?.trim().toLowerCase();
  return usedPercent >= QUOTA_WARNING_PERCENT ||
    (normalizedSeverity !== undefined && normalizedSeverity !== "normal")
    ? "warning"
    : "normal";
}

/**
 * `5h limit` when the provider named the window, otherwise a neutral label —
 * never an invented duration.
 */
export function providerQuotaWindowLabel(
  id: "primary" | "secondary",
  window: ProviderAccountRateLimitWindow,
): string {
  const minutes = window.windowMinutes;
  if (minutes !== undefined && Number.isFinite(minutes) && minutes > 0) {
    if (minutes < 60) {
      return `${Math.round(minutes)}m limit`;
    }
    if (minutes < 60 * 24) {
      return `${Math.round(minutes / 60)}h limit`;
    }
    return `${Math.round(minutes / (60 * 24))}d limit`;
  }
  return id === "primary" ? "Current usage" : "Longer window";
}

export function formatQuotaReset(resetsAt: string | undefined, now: number): string | undefined {
  if (resetsAt === undefined) {
    return undefined;
  }
  const target = Date.parse(resetsAt);
  if (Number.isNaN(target)) {
    return undefined;
  }
  const remainingMinutes = Math.round((target - now) / 60_000);
  if (remainingMinutes <= 0) {
    return "resets now";
  }
  if (remainingMinutes < 60) {
    return `resets in ${remainingMinutes}m`;
  }
  const hours = Math.floor(remainingMinutes / 60);
  if (hours < 24) {
    const minutes = remainingMinutes % 60;
    return minutes === 0 ? `resets in ${hours}h` : `resets in ${hours}h ${minutes}m`;
  }
  return `resets in ${Math.round(hours / 24)}d`;
}

export function providerQuotaMeters(
  auth: ServerProviderAuth | undefined,
  now: number,
): ReadonlyArray<ProviderQuotaMeter> {
  const rateLimits = auth?.rateLimits;
  if (!rateLimits) {
    return [];
  }
  const meters: Array<ProviderQuotaMeter> = [];
  if (rateLimits.windows && rateLimits.windows.length > 0) {
    for (const window of rateLimits.windows) {
      const detail = formatQuotaReset(window.resetsAt, now);
      meters.push({
        id: window.id,
        label: window.label,
        usedPercent: window.usedPercent,
        tone: providerQuotaTone(window.usedPercent, window.severity),
        ...(detail !== undefined ? { detail } : {}),
      });
    }
    const extra = rateLimits.extraUsage;
    if (extra?.isEnabled && extra.usedPercent !== undefined) {
      meters.push({
        id: "extra-usage",
        label: "Extra usage",
        usedPercent: extra.usedPercent,
        tone: providerQuotaTone(extra.usedPercent),
      });
    }
    return meters;
  }
  for (const id of ["primary", "secondary"] as const) {
    const window = rateLimits[id];
    if (window === undefined) {
      continue;
    }
    const detail = formatQuotaReset(window.resetsAt, now);
    meters.push({
      id,
      label: providerQuotaWindowLabel(id, window),
      usedPercent: window.usedPercent,
      tone: providerQuotaTone(window.usedPercent),
      ...(detail !== undefined ? { detail } : {}),
    });
  }
  return meters;
}

const PLAN_LABELS: Readonly<Record<string, string>> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  max: "Max",
  prolite: "Pro 5x",
  team: "Team",
  business: "Business",
  self_serve_business_usage_based: "Business",
  enterprise: "Enterprise",
  enterprise_cbp_usage_based: "Enterprise",
  edu: "Edu",
};

/**
 * `planType` is an **open** slug on the wire, so an unknown value renders as
 * itself rather than disappearing — a plan tier this build has not heard of is
 * still worth showing.
 */
export function providerPlanLabel(auth: ServerProviderAuth | undefined): string | undefined {
  const planType = auth?.planType?.trim();
  if (!planType || planType === "unknown") {
    return undefined;
  }
  return PLAN_LABELS[planType] ?? planType;
}

export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return "0";
  }
  if (tokens >= 1_000_000_000) {
    return `${(tokens / 1_000_000_000).toFixed(1)}B`;
  }
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}K`;
  }
  return `${Math.round(tokens)}`;
}

export function providerUsageSummary(auth: ServerProviderAuth | undefined): string | undefined {
  const usage = auth?.usage;
  if (!usage) {
    return undefined;
  }
  const parts: Array<string> = [];
  if (usage.recentTokens !== undefined && usage.recentDays !== undefined) {
    const days = usage.recentDays === 1 ? "day" : `${usage.recentDays} days`;
    parts.push(`${formatTokenCount(usage.recentTokens)} tokens in the last ${days}`);
  }
  if (usage.lifetimeTokens !== undefined) {
    parts.push(`${formatTokenCount(usage.lifetimeTokens)} lifetime`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * The one line worth interrupting for: the account is out of quota, or its
 * credential is about to stop working.
 */
export function providerQuotaNotice(
  auth: ServerProviderAuth | undefined,
  now: number,
): string | undefined {
  if (auth?.requiresReauth === true) {
    return "This account needs to sign in again soon.";
  }
  if (auth?.rateLimits?.limitReached !== true) {
    return undefined;
  }
  const reset =
    formatQuotaReset(auth.rateLimits.primary?.resetsAt, now) ??
    formatQuotaReset(auth.rateLimits.secondary?.resetsAt, now) ??
    auth.rateLimits.windows
      ?.map((window) => formatQuotaReset(window.resetsAt, now))
      .find((value) => value !== undefined);
  return reset === undefined ? "Usage limit reached." : `Usage limit reached — ${reset}.`;
}

/** True when there is anything at all to render, so a card can skip the block. */
export function hasProviderQuota(auth: ServerProviderAuth | undefined, now: number): boolean {
  return (
    providerQuotaMeters(auth, now).length > 0 ||
    providerUsageSummary(auth) !== undefined ||
    providerQuotaNotice(auth, now) !== undefined ||
    auth?.rateLimits?.creditBalance !== undefined ||
    auth?.rateLimits?.extraUsage?.isEnabled === true
  );
}
