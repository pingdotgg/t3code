/**
 * Claude Code subscription usage. Both sources produce windows with the same
 * ids so a turn-driven `rate_limit_event` lands on the row the SDK's
 * `get_usage` read established:
 *
 * - `get_usage` (on demand, during the capabilities probe) reports every
 *   window at once as 0–100 percentages with ISO reset times.
 * - `rate_limit_event` (streamed during a turn) names one window at a time
 *   with a 0–1 utilization fraction and an epoch-seconds reset.
 *
 * @module provider/Layers/claudeUsageLimits
 */
import type { SDKControlGetUsageResponse, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import type {
  ProviderUsageLimitsUpdate,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "../providerUsageLimits.ts";

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;

/**
 * The account-wide windows, keyed by the SDK's `rateLimitType`. Model-scoped
 * weeklies are additive on top of these: the CLI reports them under
 * `rate_limits.model_scoped[]` on `get_usage` and streams the overage-included
 * model bucket (Fable today) as `seven_day_overage_included`.
 */
const WINDOWS: Readonly<
  Record<string, Pick<ServerProviderUsageWindow, "kind" | "label" | "windowDurationMins">>
> = {
  five_hour: { kind: "session", label: "Session", windowDurationMins: SESSION_MINS },
  seven_day: { kind: "weekly", label: "Weekly", windowDurationMins: WEEK_MINS },
};

/**
 * The streamed event names the overage-included bucket by type
 * (`seven_day_overage_included`), while `get_usage` names it by the model's
 * `display_name`. Which model that is changes over time, so the probe records
 * the name it saw and the event mapper reuses it; the mid-turn update then
 * lands on the row the probe drew instead of opening a second one.
 */
const OVERAGE_INCLUDED_EVENT_TYPE = "seven_day_overage_included";

export interface ClaudeScopedLimitNames {
  readonly overageIncluded: string | undefined;
}

/** Per-instance memory of the overage-included bucket name the last successful probe saw. */
export const makeClaudeScopedLimitNames = Ref.make<ClaudeScopedLimitNames>({
  overageIncluded: undefined,
});

/** Stable id for a model-scoped weekly row, derived from the model's display name. */
function scopedWindowId(displayName: string): string {
  return `seven_day_${displayName.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

/**
 * The model-scoped weekly window the probe draws and later streamed events
 * must land on, so a mid-turn update does not open a second row.
 */
function scopedWindow(
  displayName: string,
  usedPercent: number,
  resetsAt: string | undefined,
): ServerProviderUsageWindow {
  return {
    id: scopedWindowId(displayName),
    kind: "weekly",
    label: `Weekly · ${displayName}`,
    windowDurationMins: WEEK_MINS,
    usedPercent: clampPercent(usedPercent),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

/**
 * `model_scoped` shipped in the CLI after the SDK typings we pin, so it is
 * read structurally until the `.d.ts` catches up.
 */
interface ModelScopedWindow {
  readonly display_name: string;
  readonly utilization: number | null;
  readonly resets_at: string | null;
}

/** Read `model_scoped` structurally until the pinned SDK typings include it. */
function readModelScoped(rateLimits: object): ReadonlyArray<ModelScopedWindow> {
  const raw = (rateLimits as { readonly model_scoped?: unknown }).model_scoped;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is ModelScopedWindow =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as ModelScopedWindow).display_name === "string",
  );
}

/** ISO timestamp from a streamed event's epoch-second reset. */
function isoFromEpochSeconds(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  const dt = DateTime.make(value * 1000);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

/** ISO timestamp from a `get_usage` reset string. */
function isoFromString(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const dt = DateTime.make(value);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

/** An account-wide session or weekly window from the SDK's `rateLimitType` key. */
function makeWindow(
  id: keyof typeof WINDOWS & string,
  usedPercent: number,
  resetsAt: string | undefined,
): ServerProviderUsageWindow {
  const window = WINDOWS[id]!;
  return {
    id,
    ...window,
    usedPercent: clampPercent(usedPercent),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

/**
 * Utilization is a 0–1 fraction on the streamed event. An overage-included
 * event before any probe has named the bucket is dropped: guessing a name
 * would draw a row the next probe cannot reconcile.
 */
export function claudeRateLimitEventToUpdate(
  info: SDKRateLimitInfo,
  names: ClaudeScopedLimitNames,
): ProviderUsageLimitsUpdate | undefined {
  const type: string | undefined = info.rateLimitType;
  if (!type || typeof info.utilization !== "number") {
    return undefined;
  }
  const usedPercent = info.utilization * 100;
  const resetsAt = isoFromEpochSeconds(info.resetsAt);
  if (type in WINDOWS) {
    return { windows: [makeWindow(type, usedPercent, resetsAt)] };
  }
  if (type === OVERAGE_INCLUDED_EVENT_TYPE && names.overageIncluded) {
    return { windows: [scopedWindow(names.overageIncluded, usedPercent, resetsAt)] };
  }
  return undefined;
}

const NON_SUBSCRIPTION_API_PROVIDERS = new Set(["bedrock", "vertex"]);

/**
 * Claude.ai OAuth token sources, after the same separator-stripping used for
 * API-key names. `claude.ai` keeps its dot because that is the CLI's
 * `authMethod` literally.
 */
const SUBSCRIPTION_TOKEN_SOURCES = new Set(["claude.ai", "claudecodeoauthtoken", "oauth"]);

/**
 * Whether this Claude login can have subscription windows.
 *
 * API-key, Bedrock, and Vertex accounts cannot. A named subscription, or a
 * known OAuth token source, can — a `get_usage` flag that says otherwise is a
 * failed read, not proof the account has no quota. Unknown token sources are
 * treated as non-subscription accounts so they stay `unsupported` instead of
 * showing a failed limits probe.
 */
export function claudeAccountReportsSubscriptionUsage(account: {
  readonly subscriptionType: string | undefined;
  readonly tokenSource: string | undefined;
  readonly apiProvider: string | undefined;
}): boolean {
  const apiProvider = account.apiProvider?.trim().toLowerCase();
  if (apiProvider !== undefined && NON_SUBSCRIPTION_API_PROVIDERS.has(apiProvider)) return false;
  const tokenSource = account.tokenSource?.toLowerCase().replace(/[\s_-]+/g, "");
  if (
    tokenSource === "apikey" ||
    tokenSource === "anthropicapikey" ||
    tokenSource === "anthropicauthtoken"
  ) {
    return false;
  }
  if (account.subscriptionType?.trim()) return true;
  return tokenSource !== undefined && SUBSCRIPTION_TOKEN_SOURCES.has(tokenSource);
}

/**
 * Percentages on the `get_usage` response are already 0–100. Also yields the
 * scoped-bucket names the response carried, for the event mapper to reuse.
 *
 * `rate_limits_available: false` is an account the SDK says cannot report
 * subscription windows. `rate_limits_available: true` with no `rate_limits`
 * is a fetch that failed this time — Claude keeps the flag and nulls the
 * body — so that is `probeFailed`, not a permanent unsupported lock.
 */
export function claudeUsageResponseToLimits(input: {
  readonly response: Pick<SDKControlGetUsageResponse, "rate_limits_available" | "rate_limits">;
  readonly checkedAt: string;
}): { readonly limits: ServerProviderUsageLimits; readonly names: ClaudeScopedLimitNames } {
  const { response, checkedAt } = input;
  if (!response.rate_limits_available) {
    return {
      limits: makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" }),
      names: { overageIncluded: undefined },
    };
  }
  if (!response.rate_limits) {
    return {
      limits: makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed" }),
      names: { overageIncluded: undefined },
    };
  }
  const windows: ServerProviderUsageWindow[] = [];
  for (const id of Object.keys(WINDOWS)) {
    const window = response.rate_limits[id as "five_hour" | "seven_day"];
    if (!window || typeof window.utilization !== "number") continue;
    windows.push(makeWindow(id, window.utilization, isoFromString(window.resets_at)));
  }
  // The CLI filters `model_scoped` to the overage-included allowlist, which
  // today holds one model; the first entry is the one the event refers to.
  let overageIncluded: string | undefined;
  for (const entry of readModelScoped(response.rate_limits)) {
    if (typeof entry.utilization !== "number") continue;
    windows.push(
      scopedWindow(entry.display_name, entry.utilization, isoFromString(entry.resets_at)),
    );
    // Only a bucket that drew a row may receive events; naming one that was
    // skipped would let a mid-turn event open a row the probe never showed.
    overageIncluded ??= entry.display_name;
  }
  return {
    limits: makeUsageLimits({ checkedAt, windows }),
    names: { overageIncluded },
  };
}

/**
 * Limits to publish from one Claude capabilities probe.
 *
 * No usage payload means the request failed. `unsupported` stands only when
 * the account cannot have a subscription. A subscription login that comes
 * back `unsupported`, including a second instance whose `get_usage` omits
 * windows, is `probeFailed` so a later turn can fill the bars in.
 */
export function claudeProbeUsageLimits(input: {
  readonly usage:
    | Pick<SDKControlGetUsageResponse, "rate_limits_available" | "rate_limits">
    | undefined;
  readonly account: {
    readonly subscriptionType: string | undefined;
    readonly tokenSource: string | undefined;
    readonly apiProvider: string | undefined;
  };
  readonly checkedAt: string;
}): { readonly limits: ServerProviderUsageLimits; readonly names: ClaudeScopedLimitNames } {
  if (!input.usage) {
    return {
      limits: makeUnavailableUsageLimits({ checkedAt: input.checkedAt, reason: "probeFailed" }),
      names: { overageIncluded: undefined },
    };
  }
  const mapped = claudeUsageResponseToLimits({
    response: input.usage,
    checkedAt: input.checkedAt,
  });
  if (
    mapped.limits.unavailable?.reason === "unsupported" &&
    claudeAccountReportsSubscriptionUsage(input.account)
  ) {
    return {
      limits: makeUnavailableUsageLimits({ checkedAt: input.checkedAt, reason: "probeFailed" }),
      names: mapped.names,
    };
  }
  return mapped;
}

/**
 * Probe-side helper: map the response and remember the scoped names for events.
 *
 * A `probeFailed` read leaves the names from the last successful body in place.
 * `get_usage` can fail with a present body (`rate_limits_available: false`, or
 * `rate_limits: null`), and clearing the learned overage name would drop later
 * `seven_day_overage_included` events instead of updating that window.
 */
export function recordClaudeUsageResponse(
  namesRef: Ref.Ref<ClaudeScopedLimitNames>,
  input: Parameters<typeof claudeProbeUsageLimits>[0],
): Effect.Effect<ServerProviderUsageLimits> {
  const probed = claudeProbeUsageLimits(input);
  if (probed.limits.unavailable?.reason === "probeFailed") {
    return Effect.succeed(probed.limits);
  }
  return Ref.set(namesRef, probed.names).pipe(Effect.as(probed.limits));
}
