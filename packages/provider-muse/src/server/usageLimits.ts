/**
 * Muse Code's subscription usage limits. Meta reports the account's windows
 * with every model response; the last report is re-derived against the clock.
 */
import type {
  ServerProviderAuth,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
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

const WEEK_MINS = 7 * 24 * 60;

type MuseUsageObservation = Pick<MuseSubscriptionUsage, "observedAtMs" | "window" | "weekly">;

const isoFromMillis = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

function makeWindow(
  id: "window" | "weekly",
  windowDurationMins: number,
  usedPercent: number,
  resetsAtMs: number,
  nowMs: number,
): ServerProviderUsageWindow {
  const kind = windowDurationMins >= WEEK_MINS ? "weekly" : "session";
  // Meta opens the next window with the account's next request, so a window
  // that has reset since the report is empty and its new reset is unknown.
  const current = resetsAtMs > nowMs;
  return {
    id,
    kind,
    label: kind === "weekly" ? "Weekly" : "Session",
    windowDurationMins: Math.round(windowDurationMins),
    usedPercent: current ? clampPercent(usedPercent) : 0,
    ...(current ? { resetsAt: isoFromMillis(resetsAtMs) } : {}),
  };
}

export function museUsageWindows(
  observation: MuseUsageObservation,
  nowMs: number,
): ReadonlyArray<ServerProviderUsageWindow> {
  const { window, weekly } = observation;
  return [
    makeWindow("window", window.windowDurationMins, window.usedPercent, window.resetsAtMs, nowMs),
    makeWindow("weekly", WEEK_MINS, weekly.usedPercent, weekly.resetsAtMs, nowMs),
  ];
}

/** Limits as of `nowMs`, dated when Meta reported them so the freshest report wins across environments. */
export function museUsageLimits(
  observation: MuseUsageObservation,
  nowMs: number,
): ServerProviderUsageLimits {
  return makeUsageLimits({
    checkedAt: isoFromMillis(observation.observedAtMs),
    windows: museUsageWindows(observation, nowMs),
  });
}

/** The login a status check names: its address or label. */
export function museUsageAccount(auth: ServerProviderAuth): string | undefined {
  return auth.type === "accountLogin" ? (auth.email ?? auth.label) : undefined;
}

/**
 * Which login an instance's usage reports belong to. Reports name no account,
 * so each one counts for the generation its host started under, and a logout
 * or another login starts a new generation: a report from an older host is
 * never shown under the account that replaced it.
 */
export interface MuseUsageAccount {
  readonly generation: number;
  /** The login last named, `null` once signed out, `undefined` before any status check names one. */
  readonly identity: string | null | undefined;
}

export function nextMuseUsageAccount(
  account: MuseUsageAccount,
  auth: ServerProviderAuth,
): MuseUsageAccount {
  const identity =
    auth.status === "unauthenticated" || auth.type === "apiKey" ? null : museUsageAccount(auth);
  if (identity === undefined || identity === account.identity) return account;
  // The first login a check names is the one the hosts so far started under.
  if (account.identity === undefined) return { ...account, identity };
  return { generation: account.generation + 1, identity };
}

/**
 * What a status check publishes for an instance. An API key names no Meta
 * account, so its reports cannot be told apart across environments and none
 * are shown. Otherwise the newest report stands, or a login says when to
 * expect one.
 */
export function museStatusUsageLimits(input: {
  readonly auth: ServerProviderAuth;
  readonly enabled: boolean;
  readonly observation: MuseUsageObservation | undefined;
  /** This check dropped the kept report: a logout or another login started a new generation. */
  readonly dropped?: boolean;
  readonly nowMs: number;
}): ServerProviderUsageLimits | undefined {
  const checkedAt = isoFromMillis(input.nowMs);
  if (input.auth.type === "apiKey") {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "unsupported",
      message: "Muse uses an API key here, which names no Meta account to report limits for.",
    });
  }
  // Signed out, there is no account to report on.
  if (input.auth.status === "unauthenticated") return undefined;
  if (input.observation) return museUsageLimits(input.observation, input.nowMs);
  // The dropped report's windows are still published. "Waiting for a report" would
  // keep them, as a failed probe keeps the last good bars, so publish none to clear them.
  if (input.dropped) return undefined;
  if (!input.enabled || input.auth.type !== "accountLogin") return undefined;
  return makeUnavailableUsageLimits({
    checkedAt,
    reason: "probeFailed",
    message: "Muse reports usage limits with its next reply.",
  });
}
