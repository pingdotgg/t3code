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
  type LimitPool,
  type LimitPresentations,
  projectRunOut,
  providersWithLimits,
  type ResetCreditChoice,
  resetCountdown,
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

/** `runs out in about 40m`, or null when the window resets before it runs dry. */
export function formatRunsOutIn(
  window: ServerProviderUsageWindow,
  now: number,
  resolve: MFunctionType = mFallback,
): string | null {
  const runOut = projectRunOut(window, now);
  if (runOut === null) return null;
  if (runOut < MINUTE) return resolve(msg("runs out now"));
  return resolve(msg("runs out in about {duration}", { duration: formatDuration(runOut, resolve) }));
}
