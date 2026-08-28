/**
 * Pure parsing for Grok subscription limits.
 *
 * The Grok CLI stores its OIDC sign-in in `auth.json` under the Grok home
 * (a map keyed by `<issuer>::<client_id>`), and the figures come from the
 * CLI's own backend: `/v1/billing?format=credits` reports the weekly credit
 * window (with per-product splits) and `/v1/user?include=subscription`
 * reports the plan tier and email. Neither shape is a published contract, so
 * every parser here is defensive: unrecognised documents yield `null`/empty
 * rather than an error.
 *
 * @module usageLimitsGrok
 */
import type { UsageLimitWindow } from "@t3tools/contracts";

export interface GrokAuthCredentials {
  /** Bearer token for the CLI backend. Short-lived; the CLI refreshes it. */
  readonly key: string;
  /** `oidc` for a grok.com sign-in; anything else is not a subscription. */
  readonly authMode: string | null;
  readonly email: string | null;
}

function readAuthEntry(value: unknown): GrokAuthCredentials | null {
  if (typeof value !== "object" || value === null) return null;
  const { key, auth_mode, email } = value as Record<string, unknown>;
  if (typeof key !== "string" || key.trim().length === 0) return null;
  return {
    key: key.trim(),
    authMode:
      typeof auth_mode === "string" && auth_mode.trim().length > 0 ? auth_mode.trim() : null,
    email: typeof email === "string" && email.trim().length > 0 ? email.trim() : null,
  };
}

/**
 * Picks the credential entry to use from the CLI's `auth.json` map. OIDC
 * entries win: only a grok.com sign-in has subscription limits to report.
 */
export function parseGrokAuthCredentials(raw: string): GrokAuthCredentials | null {
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof document !== "object" || document === null) return null;

  let fallback: GrokAuthCredentials | null = null;
  for (const value of Object.values(document)) {
    const entry = readAuthEntry(value);
    if (entry === null) continue;
    if (entry.authMode === "oidc") return entry;
    fallback ??= entry;
  }
  return fallback;
}

export const GROK_DEFAULT_PROXY_BASE_URL = "https://cli-chat-proxy.grok.com/v1";

/** A valid absolute http(s) URL without its trailing slashes, else null. */
function normalizeBaseUrl(value: string | undefined | null): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return url.toString().replace(/\/+$/, "");
}

/**
 * Resolves the CLI chat proxy base the stored bearer is scoped to.
 *
 * The CLI honors `GROK_CLI_CHAT_PROXY_BASE_URL` and `[endpoints]
 * cli_chat_proxy_base_url` in its config; the resolved origin it actually
 * used last shows up in `models_cache.json`'s `origin`. A bearer meant for a
 * team proxy must never travel to the public default, so an override that
 * cannot be parsed fails closed (null) instead of falling back.
 */
export function resolveGrokProxyBaseUrl(input: {
  readonly envBaseUrl: string | undefined;
  readonly modelsCacheRaw: string | null;
}): string | null {
  if (input.envBaseUrl !== undefined && input.envBaseUrl.trim().length > 0) {
    return normalizeBaseUrl(input.envBaseUrl);
  }

  if (input.modelsCacheRaw !== null) {
    let document: unknown;
    try {
      document = JSON.parse(input.modelsCacheRaw);
    } catch {
      document = null;
    }
    if (typeof document === "object" && document !== null) {
      const { origin } = document as Record<string, unknown>;
      if (typeof origin === "string" && origin.trim().endsWith("/models")) {
        const base = normalizeBaseUrl(origin.trim().slice(0, -"/models".length));
        if (base !== null) return base;
      }
    }
  }

  return GROK_DEFAULT_PROXY_BASE_URL;
}

const PLAN_LABELS: Record<string, string> = {
  free: "Grok Free",
  xpremium: "X Premium",
  xpremiumplus: "X Premium+",
  supergrok: "SuperGrok",
  supergrokpro: "SuperGrok Pro",
  supergrokheavy: "SuperGrok Heavy",
};

/** `XPremium` → "X Premium"; unknown tiers get camel-case spacing. */
export function grokPlanLabel(subscriptionTier: string | null): string | null {
  if (subscriptionTier === null) return null;
  const trimmed = subscriptionTier.trim();
  if (trimmed.length === 0) return null;
  return PLAN_LABELS[trimmed.toLowerCase()] ?? trimmed.replaceAll(/(?<=[a-z])(?=[A-Z])/g, " ");
}

export interface GrokUserProfile {
  readonly email: string | null;
  readonly subscriptionTier: string | null;
}

/** Best-effort account identity from `/v1/user?include=subscription`. */
export function parseGrokUserProfile(document: unknown): GrokUserProfile {
  if (typeof document !== "object" || document === null) {
    return { email: null, subscriptionTier: null };
  }
  const { email, subscriptionTier } = document as Record<string, unknown>;
  return {
    email: typeof email === "string" && email.trim().length > 0 ? email.trim() : null,
    subscriptionTier:
      typeof subscriptionTier === "string" && subscriptionTier.trim().length > 0
        ? subscriptionTier.trim()
        : null,
  };
}

/** See {@link usageLimitsClaude}: clamped, not rounded. */
function clampUtilization(value: number): number {
  return Math.min(Math.max(value, 0), 999);
}

function periodTitle(periodType: string | null): { label: string; detail: string } {
  if (periodType !== null && periodType.includes("WEEKLY")) {
    return { label: "Weekly limit", detail: "weekly credit window" };
  }
  if (periodType !== null && periodType.includes("MONTHLY")) {
    return { label: "Monthly limit", detail: "monthly credit window" };
  }
  return { label: "Usage limit", detail: "credit window" };
}

/** `GrokBuild` → "Grok Build". */
function productLabel(product: string): string {
  return product.replaceAll(/(?<=[a-z])(?=[A-Z])/g, " ");
}

/**
 * Extracts credit windows from `/v1/billing?format=credits`.
 *
 * Grok has a single billing-cycle credit budget rather than rolling rate
 * windows: `creditUsagePercent` is the account-wide figure, and
 * `productUsage` splits it per product (Build, Chat, ...). All windows share
 * the current period's end as their reset instant.
 */
export function parseGrokBillingWindows(document: unknown): UsageLimitWindow[] {
  if (typeof document !== "object" || document === null) return [];
  const root = (document as Record<string, unknown>).config ?? document;
  if (typeof root !== "object" || root === null) return [];
  const { creditUsagePercent, currentPeriod, billingPeriodEnd, productUsage } = root as Record<
    string,
    unknown
  >;
  // The backend serializes proto3 JSON, which drops zero-valued scalars: at
  // 0% usage `creditUsagePercent` is absent entirely. Treat absence as zero
  // when the period fields confirm this is really the credits document.
  const isCreditsDocument =
    (typeof currentPeriod === "object" && currentPeriod !== null) ||
    typeof billingPeriodEnd === "string";
  const usagePercentValue =
    creditUsagePercent === undefined && isCreditsDocument ? 0 : creditUsagePercent;
  if (typeof usagePercentValue !== "number" || !Number.isFinite(usagePercentValue)) return [];

  let periodType: string | null = null;
  let periodEnd: string | null = null;
  if (typeof currentPeriod === "object" && currentPeriod !== null) {
    const { type, end } = currentPeriod as Record<string, unknown>;
    periodType = typeof type === "string" ? type : null;
    periodEnd = typeof end === "string" && end.trim().length > 0 ? end.trim() : null;
  }
  periodEnd ??=
    typeof billingPeriodEnd === "string" && billingPeriodEnd.trim().length > 0
      ? billingPeriodEnd.trim()
      : null;

  const title = periodTitle(periodType);
  const windows: UsageLimitWindow[] = [
    {
      id: "credits",
      label: title.label,
      detail: `All products · ${title.detail}`,
      utilization: clampUtilization(usagePercentValue),
      resetsAt: periodEnd,
    },
  ];

  if (Array.isArray(productUsage)) {
    for (const entry of productUsage) {
      if (typeof entry !== "object" || entry === null) continue;
      const { product, usagePercent } = entry as Record<string, unknown>;
      if (typeof product !== "string" || product.trim().length === 0) continue;
      if (typeof usagePercent !== "number" || !Number.isFinite(usagePercent)) continue;
      windows.push({
        id: `credits:${product.trim()}`,
        label: `${title.label} (${productLabel(product.trim())})`,
        detail: `${title.detail.charAt(0).toUpperCase()}${title.detail.slice(1)}`,
        utilization: clampUtilization(usagePercent),
        resetsAt: periodEnd,
      });
    }
  }

  return windows;
}
