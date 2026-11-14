import type {
  ProviderConsumeResetCreditInput,
  ServerProviderResetCredits,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import {
  collectExternalUsageLinks as collectExternalUsageLinksWith,
  cursorUsageWindowDetails as cursorUsageWindowDetailsBase,
  type LimitAccount,
  type LimitPool,
  type LimitPresentations,
  providersWithLimits,
  remainingPercent,
  type ResetCreditChoice,
  resetCountdown,
  resetMillis,
} from "./usageLimits.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const CURSOR_USAGE_WINDOW_COPY: Readonly<
  Record<string, { readonly label: string; readonly description: string }>
> = {
  totalPercentUsed: {
    label: msg("Overall", { $context: "usage limit covering the whole plan" }),
    description: msg("All usage on your plan this billing cycle."),
  },
  autoPercentUsed: {
    label: msg("Cursor Models"),
    description: msg("Grok, Composer, and Auto use this allowance."),
  },
  apiPercentUsed: {
    label: msg("Other Models"),
    description: msg("Usage allowance for third-party models such as Claude, GPT, and Gemini."),
  },
};

/** @public */
export function cursorUsageWindowDetails(
  id: string,
  pool: LimitPool,
  resolve: MFunctionType = mFallback,
) {
  const details = cursorUsageWindowDetailsBase(id, pool);
  const copy = CURSOR_USAGE_WINDOW_COPY[id];
  if (!details || !copy) return details;
  return {
    ...details,
    label: details.label === null ? null : resolve(copy.label),
    description: details.description === undefined ? undefined : resolve(copy.description),
  };
}

/** @public */
export function collectExternalUsageLinks(
  presentations: LimitPresentations,
  resolve: MFunctionType = mFallback,
) {
  return collectExternalUsageLinksWith(presentations, (provider, environment) =>
    resolve(msg("{provider} on {environment}", { provider, environment })),
  );
}

/** @public */
export function limitsNotice(
  limits: ServerProviderUsageLimits,
  resolve: MFunctionType = mFallback,
): string | null {
  if (limits.unavailable?.reason === "unsupported") {
    return limits.unavailable.message ?? resolve(msg("This account has no subscription limits."));
  }
  if (limits.unavailable?.reason === "probeFailed") {
    return limits.unavailable.message ?? resolve(msg("Could not read limits."));
  }
  return limits.windows.length === 0 ? resolve(msg("No limits reported.")) : null;
}

/** @public */
export function collectLimitNotices(
  presentations: LimitPresentations,
  resolve: MFunctionType = mFallback,
): readonly string[] {
  const label = (environmentLabel: string, subject: string) =>
    presentations.size > 1 ? `${environmentLabel} · ${subject}` : subject;
  const notices = new Set<string>();
  for (const presentation of presentations.values()) {
    const environmentLabel = presentation.entry.target.label;
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      if (provider.usageLimits?.unavailable?.reason === "unsupported") continue;
      const notice = provider.usageLimits ? limitsNotice(provider.usageLimits, resolve) : null;
      const name = provider.displayName?.trim() || String(provider.driver);
      if (notice) notices.add(`${label(environmentLabel, name)}: ${notice}`);
    }
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      if (source.error) {
        notices.add(`${label(environmentLabel, source.label)}: ${source.error}`);
      } else if (source.accounts.length === 0) {
        notices.add(
          resolve(
            msg("{source}: No accounts reported.", {
              source: label(environmentLabel, source.label),
            }),
          ),
        );
      }
    }
  }
  return [...notices];
}

/** @public */
export function formatDuration(ms: number, resolve: MFunctionType = mFallback): string {
  const remaining = Math.max(0, ms);
  const days = Math.floor(remaining / DAY);
  const hours = Math.floor((remaining % DAY) / HOUR);
  const minutes = Math.floor((remaining % HOUR) / MINUTE);
  if (days > 0) return resolve(msg("{days}d {hours}h", { days, hours }));
  if (hours > 0) return resolve(msg("{hours}h {minutes}m", { hours, minutes }));
  return resolve(msg("{minutes}m", { minutes }));
}

/** @public */
export function resetCreditChoices(
  credits: ServerProviderResetCredits,
  input: ProviderConsumeResetCreditInput,
  now: number,
  compact = false,
  resolve: MFunctionType = mFallback,
): ReadonlyArray<ResetCreditChoice> {
  const expiresIn = (at: string | undefined) =>
    at ? formatDuration(Date.parse(at) - now, resolve) : null;
  if (credits.options && "instanceId" in input) {
    return credits.options.map((option) => {
      const expires = expiresIn(option.expiresAt);
      const values = { label: option.label, count: option.availableCount };
      return {
        key: option.creditId,
        summary: expires
          ? resolve(msg("{label} · {count} left · expires in {expires}", { ...values, expires }))
          : resolve(msg("{label} · {count} left", values)),
        actionLabel: resolve(msg("Use", { $context: "button that redeems a reset credit" })),
        confirmDescription: resolve(
          msg("{label}: {description} This cannot be undone.", {
            label: option.label,
            description: option.description,
          }),
        ),
        availableCount: option.availableCount,
        input: { ...input, creditId: option.creditId },
      };
    });
  }
  const count = credits.availableCount;
  const expires = expiresIn(credits.nextExpiresAt);
  return [
    {
      key: "next",
      summary:
        count === 0
          ? resolve(msg("No reset credits banked"))
          : compact
            ? expires
              ? resolve(msg("{count} banked · expires in {expires}", { count, expires }))
              : resolve(msg("{count} banked", { count }))
            : expires
              ? resolve(
                  msg(
                    "{count, plural, one {{count} reset credit banked · next expires in {expires}} other {{count} reset credits banked · next expires in {expires}}}",
                    { count, expires },
                  ),
                )
              : resolve(
                  msg(
                    "{count, plural, one {{count} reset credit banked} other {{count} reset credits banked}}",
                    { count },
                  ),
                ),
      actionLabel: resolve(msg("Use reset")),
      confirmDescription: resolve(
        msg(
          "This redeems one credit on your account and clears the current rate-limit windows. It cannot be undone.",
        ),
      ),
      availableCount: count,
      input,
    },
  ];
}

/**
 * `full` reads "resets in 2h 5m", `in` reads "in 2h 5m", `refill` reads "↻ 2h 5m".
 * @public
 */
export function formatResetsIn(
  window: ServerProviderUsageWindow,
  now: number,
  resolve: MFunctionType = mFallback,
  style: "full" | "in" | "refill" = "full",
): string | null {
  const countdown = resetCountdown(window, now);
  if (countdown === null) return null;
  if (countdown.kind === "now") return resolve(msg("resets now"));
  if (countdown.kind === "momentarily") return resolve(msg("Resets momentarily"));
  const duration = formatDuration(countdown.ms, resolve);
  if (style === "in") {
    return resolve(
      msg("in {duration}", { duration, $context: "time until a usage window resets" }),
    );
  }
  if (style === "refill") return resolve(msg("↻ {duration}", { duration }));
  return resolve(msg("resets in {duration}", { duration }));
}

export interface ResetCreditSuggestion {
  readonly recommendation: "recommended" | "wait" | "save" | "hold" | "expiring_soon";
  readonly actionLabel: string;
  readonly reason: string;
}

export function suggestResetCredit(
  account: LimitAccount,
  window: ServerProviderUsageWindow,
  poolMembers: ReadonlyArray<{
    readonly account: LimitAccount;
    readonly window?: ServerProviderUsageWindow | null;
  }>,
  now: number,
): ResetCreditSuggestion | null {
  const credits = account.limits.resetCredits;
  if (!credits || credits.availableCount <= 0) return null;

  const remaining = remainingPercent(window);
  const resetsAt = resetMillis(window);
  const resetsInMs = resetsAt !== null ? resetsAt - now : null;

  // 1. Expiring soon: credit expires within 24 hours
  const optionExpiries = (credits.options ?? [])
    .filter((opt) => opt.availableCount > 0 && opt.expiresAt)
    .map((opt) => Date.parse(opt.expiresAt!))
    .filter(Number.isFinite);
  const nextExpires = credits.nextExpiresAt ? Date.parse(credits.nextExpiresAt) : null;
  if (nextExpires && Number.isFinite(nextExpires)) {
    optionExpiries.push(nextExpires);
  }
  const soonestExpiry = optionExpiries.length > 0 ? Math.min(...optionExpiries) : null;
  if (soonestExpiry !== null) {
    const timeUntilExpiry = soonestExpiry - now;
    if (timeUntilExpiry > 0 && timeUntilExpiry <= 24 * 3600 * 1000) {
      return {
        recommendation: "expiring_soon",
        actionLabel: "Use before expiry",
        reason: `Banked reset credit expires in ${formatDuration(timeUntilExpiry)}. Use it before it expires.`,
      };
    }
  }

  // 2. Natural reset is imminent (within 45 minutes)
  if (resetsInMs !== null && resetsInMs > 0 && resetsInMs <= 45 * 60 * 1000) {
    return {
      recommendation: "wait",
      actionLabel: "Wait for natural reset",
      reason: `Window resets naturally in ${formatDuration(resetsInMs)}. Save your banked credit.`,
    };
  }

  // 3. This account still has plenty of quota (> 20% remaining)
  if (remaining > 20) {
    return {
      recommendation: "save",
      actionLabel: "Save for later",
      reason: `${remaining}% quota remaining. Reset only when depleted.`,
    };
  }

  // 4. Other account in the same pool has plenty of quota (> 25% remaining)
  const otherMembers = poolMembers.filter((m) => m.account.key !== account.key && m.window);
  const otherMaxRemaining =
    otherMembers.length > 0 ? Math.max(...otherMembers.map((m) => remainingPercent(m.window!))) : 0;
  if (otherMaxRemaining > 25) {
    return {
      recommendation: "hold",
      actionLabel: "Hold off (other account active)",
      reason: `Auto mode has another account with ${otherMaxRemaining}% quota left. Save credit until both are depleted.`,
    };
  }

  // 5. Recommended: Account is depleted and next reset is far away (or not soon)
  return {
    recommendation: "recommended",
    actionLabel: "Recommended to use now",
    reason: `Quota depleted and next natural reset is ${resetsInMs !== null && resetsInMs > 0 ? `in ${formatDuration(resetsInMs)}` : "hours away"}. Good time to reset.`,
  };
}
