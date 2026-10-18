/**
 * Muse Code's subscription usage limits. Meta reports the account's windows
 * with every model response, and Muse forwards them as `usage/changed`. When a
 * window runs out, Meta refuses the next request and Muse fails the turn.
 */
import * as DateTime from "effect/DateTime";

import { LATEST_DATE_MS, type MuseSubscriptionUsage } from "./protocol.ts";

/**
 * Muse surfaces Meta's quota refusal as `API error 429: Subscription quota
 * exhausted. Your usage window resets at 2026-10-13T10:45:52Z.`, at times
 * wrapped by a credential proxy. Muse can also type the stop as `error.quota`,
 * but a relayed refusal arrives untyped, so the text still counts.
 */
export function isMuseUsageLimitFailure(message: string | undefined): boolean {
  return message !== undefined && /\b429\b/.test(message) && /quota|usage limit/i.test(message);
}

const NAMED_RESET =
  /\bresets at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/i;

/**
 * When a stopped turn can run again: every exhausted window must reset first.
 * The resets come from the typed quota, the time the refusal names, and the
 * used-up windows of the last report before it; the latest one still ahead wins.
 */
export function museUsageLimitResetAt(
  usage: MuseSubscriptionUsage | undefined,
  nowMs: number,
  refusal?: {
    readonly quota?: { readonly resetsAtMs: number } | undefined;
    readonly message?: string | undefined;
  },
): string | null {
  const named = refusal?.message?.match(NAMED_RESET)?.[1];
  const resets = [
    ...[usage?.window, usage?.weekly].map((window) =>
      window && window.usedPercent >= 100 ? window.resetsAtMs : undefined,
    ),
    refusal?.quota?.resetsAtMs,
    named === undefined ? undefined : Date.parse(named),
  ].filter(
    (ms): ms is number =>
      ms !== undefined && Number.isFinite(ms) && ms > nowMs && ms <= LATEST_DATE_MS,
  );
  return resets.length > 0 ? DateTime.formatIso(DateTime.makeUnsafe(Math.max(...resets))) : null;
}
