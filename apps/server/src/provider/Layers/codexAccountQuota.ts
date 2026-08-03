/**
 * Pure mapping from the `codex app-server` account responses to the fork's
 * provider-neutral quota contract (fork: f1 increment 2).
 *
 * Lives outside `CodexProvider.ts` on purpose: the probe file is upstream and
 * hot, so it keeps one import plus one spread while every decision — unit
 * normalisation, clamping, "is there anything worth showing" — is testable
 * here without a subprocess.
 *
 * Two rules shape everything below:
 *
 *   - **Never invent a value.** Codex marks nearly every quota field
 *     `optionalKey | null`; an absent field stays absent rather than becoming
 *     `0`, because `0%` used and "unknown" look identical in a meter and only
 *     one of them is true.
 *   - **Never fail.** A quota read is decoration on a status probe. Anything
 *     unparseable collapses to `undefined` and the card simply shows less.
 *
 * @module codexAccountQuota
 */
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import type {
  ProviderAccountRateLimits,
  ProviderAccountRateLimitWindow,
  ProviderAccountUsage,
  ServerProviderAuth,
} from "@t3tools/contracts";
import type * as CodexSchema from "effect-codex-app-server/schema";

/**
 * Codex stamps `resetsAt` as int64 unix **seconds**, but the field is only
 * documented as an integer. Anything past this cut-off is already implausible
 * as a seconds-since-epoch value (year 5138) and is treated as milliseconds,
 * so a producer that switches units cannot silently render "resets in 1970".
 */
const EPOCH_SECONDS_CEILING = 1e11;

export function normalizeEpochToIso(value: number | null | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  const millis = value < EPOCH_SECONDS_CEILING ? value * 1000 : value;
  return DateTime.make(millis).pipe(
    Option.match({
      onNone: () => undefined,
      onSome: DateTime.formatIso,
    }),
  );
}

function mapWindow(
  window: CodexSchema.V2GetAccountRateLimitsResponse__RateLimitWindow | null | undefined,
): ProviderAccountRateLimitWindow | undefined {
  if (!window || typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) {
    return undefined;
  }
  const resetsAt = normalizeEpochToIso(window.resetsAt);
  const windowMinutes =
    typeof window.windowDurationMins === "number" &&
    Number.isFinite(window.windowDurationMins) &&
    window.windowDurationMins > 0
      ? window.windowDurationMins
      : undefined;
  return {
    usedPercent: Math.min(100, Math.max(0, window.usedPercent)),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(windowMinutes !== undefined ? { windowMinutes } : {}),
  };
}

function trimmed(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.trim();
  return text.length > 0 ? text : undefined;
}

/**
 * `undefined` when the response carried nothing a user could act on — an
 * all-empty `rateLimits` struct must not produce an empty quota row.
 */
export function mapCodexRateLimits(
  response: CodexSchema.V2GetAccountRateLimitsResponse | undefined,
  options: { readonly checkedAt: string },
): ProviderAccountRateLimits | undefined {
  const limits = response?.rateLimits;
  if (!limits) {
    return undefined;
  }
  const primary = mapWindow(limits.primary);
  const secondary = mapWindow(limits.secondary);
  const limitReason = trimmed(limits.rateLimitReachedType);
  const limitReached = limits.rateLimitReachedType != null || limits.spendControlReached === true;
  const creditBalance =
    limits.credits?.unlimited === true ? undefined : trimmed(limits.credits?.balance);

  if (
    primary === undefined &&
    secondary === undefined &&
    !limitReached &&
    creditBalance === undefined
  ) {
    return undefined;
  }

  return {
    checkedAt: options.checkedAt,
    ...(primary !== undefined ? { primary } : {}),
    ...(secondary !== undefined ? { secondary } : {}),
    ...(limitReached ? { limitReached: true } : {}),
    ...(limitReason !== undefined ? { limitReason } : {}),
    ...(creditBalance !== undefined ? { creditBalance } : {}),
  };
}

function positiveNumber(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Collapses the daily buckets into one "recent" total. The bucket list is
 * whatever window the provider chose to return, so `recentDays` travels with
 * the number and the UI never has to guess whether it means 7 or 30.
 */
export function mapCodexAccountUsage(
  response: CodexSchema.V2GetAccountTokenUsageResponse | undefined,
): ProviderAccountUsage | undefined {
  if (!response) {
    return undefined;
  }
  const lifetimeTokens = positiveNumber(response.summary?.lifetimeTokens);
  const buckets = (response.dailyUsageBuckets ?? []).filter(
    (bucket) => typeof bucket.tokens === "number" && Number.isFinite(bucket.tokens),
  );
  const recentTokens = buckets.reduce((total, bucket) => total + Math.max(0, bucket.tokens), 0);
  const hasRecent = buckets.length > 0 && recentTokens > 0;

  if (lifetimeTokens === undefined && !hasRecent) {
    return undefined;
  }
  return {
    ...(lifetimeTokens !== undefined ? { lifetimeTokens } : {}),
    ...(hasRecent ? { recentTokens, recentDays: buckets.length } : {}),
  };
}

/**
 * The account's plan tier as an open slug (`"pro"`, `"team"`, …). Only the
 * ChatGPT account variant has one; API-key and Bedrock accounts have no plan.
 */
export function codexAccountPlanType(
  account: CodexSchema.V2GetAccountResponse["account"],
): string | undefined {
  if (!account || account.type !== "chatgpt") {
    return undefined;
  }
  return trimmed(account.planType);
}

/**
 * The extra `ServerProviderAuth` fields a Codex probe can fill in. Returns an
 * empty object rather than `undefined` so the call site stays a single spread.
 */
export function codexAuthQuotaFields(input: {
  readonly account: CodexSchema.V2GetAccountResponse;
  readonly rateLimits: CodexSchema.V2GetAccountRateLimitsResponse | undefined;
  readonly usage: CodexSchema.V2GetAccountTokenUsageResponse | undefined;
  readonly checkedAt: string;
}): Partial<Pick<ServerProviderAuth, "planType" | "requiresReauth" | "rateLimits" | "usage">> {
  const planType = codexAccountPlanType(input.account.account);
  const rateLimits = mapCodexRateLimits(input.rateLimits, { checkedAt: input.checkedAt });
  const usage = mapCodexAccountUsage(input.usage);
  // `requiresOpenaiAuth` alongside a live account means the session works but
  // the stored credential is on its way out — worth surfacing, never worth
  // pretending the account is signed out.
  const requiresReauth = input.account.account != null && input.account.requiresOpenaiAuth;
  return {
    ...(planType !== undefined ? { planType } : {}),
    ...(requiresReauth ? { requiresReauth: true } : {}),
    ...(rateLimits !== undefined ? { rateLimits } : {}),
    ...(usage !== undefined ? { usage } : {}),
  };
}
