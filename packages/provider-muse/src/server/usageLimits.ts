/**
 * Muse Code subscription usage. Meta reports the account's windows with every
 * model response, and Muse forwards them as `usage/changed`.
 *
 * Meta has no usage endpoint, so the last report is all there is between
 * responses. Windows are re-derived from it against the clock: a window whose
 * reset has passed starts over empty.
 */
import type {
  ServerProviderAuth,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";

const WEEK_MINS = 7 * 24 * 60;

/** One report of the account's windows, as Muse forwards it. */
export interface MuseUsageObservation {
  readonly observedAtMs: number;
  /** Meta's five-hour-class block. */
  readonly window?: {
    readonly usedPercent: number;
    readonly windowDurationMins: number;
    readonly resetsAtMs: number;
  };
  readonly weekly?: { readonly usedPercent: number; readonly resetsAtMs: number };
}

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
    ...(window
      ? [
          makeWindow(
            "window",
            window.windowDurationMins,
            window.usedPercent,
            window.resetsAtMs,
            nowMs,
          ),
        ]
      : []),
    ...(weekly
      ? [makeWindow("weekly", WEEK_MINS, weekly.usedPercent, weekly.resetsAtMs, nowMs)]
      : []),
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
  const identity = auth.status === "unauthenticated" ? null : museUsageAccount(auth);
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
