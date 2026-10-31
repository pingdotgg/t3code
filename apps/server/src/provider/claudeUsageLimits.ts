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
import * as Schema from "effect/Schema";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;

const WINDOWS: Readonly<
  Record<string, Pick<ServerProviderUsageWindow, "kind" | "label" | "windowDurationMins">>
> = {
  five_hour: { kind: "session", label: "Session", windowDurationMins: SESSION_MINS },
  seven_day: { kind: "weekly", label: "Weekly", windowDurationMins: WEEK_MINS },
};

/** Reuse probed display names for streamed bucket types so mid-turn updates target the same row. */
const OVERAGE_INCLUDED_EVENT_TYPE = "seven_day_overage_included";

// The SDK does not yet type the spend budget returned by `get_usage`.
const SpendMoney = Schema.Struct({
  amount_minor: Schema.Natural,
  currency: Schema.NonEmptyString,
  exponent: Schema.Natural,
});
const decodeSpendBudget = Schema.decodeUnknownOption(
  Schema.Struct({ enabled: Schema.Boolean, used: SpendMoney, limit: SpendMoney }),
);

export interface ClaudeScopedLimitNames {
  readonly overageIncluded: string | undefined;
  /**
   * Windows the last turn response listed in its rate-limit headers. Claude enforces only those:
   * a verified Ultra account streams `seven_day` alone while `get_usage` keeps reporting an idle
   * `five_hour`. Undefined until a turn has streamed headers.
   */
  readonly enforcedWindows?: ReadonlySet<string>;
}

export const makeClaudeScopedLimitNames = Ref.make<ClaudeScopedLimitNames>({
  overageIncluded: undefined,
});

/**
 * The CLI omits a window whose reset just passed until the next response renews it, while the
 * representative claim still names it, so the claim counts as listed too.
 */
function listedWindows(info: SDKRateLimitInfo): ReadonlySet<string> | undefined {
  const unified = (info as { readonly unifiedWindows?: unknown }).unifiedWindows;
  if (typeof unified !== "object" || unified === null || Array.isArray(unified)) return undefined;
  const listed = new Set<string>();
  for (const id of Object.keys(WINDOWS)) {
    const entry = (unified as Record<string, unknown>)[id];
    if (
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { readonly utilization?: unknown }).utilization === "number"
    ) {
      listed.add(id);
    }
  }
  if (listed.size === 0) return undefined;
  if (info.rateLimitType && info.rateLimitType in WINDOWS) listed.add(info.rateLimitType);
  return listed;
}

/** Response headers list every window Claude enforces; `get_usage` cannot tell a dropped one from an idle one. */
export function rememberClaudeListedWindows(
  names: ClaudeScopedLimitNames,
  info: SDKRateLimitInfo,
): ClaudeScopedLimitNames {
  const listed = listedWindows(info);
  return listed ? { ...names, enforcedWindows: listed } : names;
}

function retiredWindowIds(names: ClaudeScopedLimitNames): ReadonlyArray<string> {
  const enforced = names.enforcedWindows;
  return enforced ? Object.keys(WINDOWS).filter((id) => !enforced.has(id)) : [];
}

function scopedWindowId(displayName: string): string {
  return `seven_day_${displayName.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

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

function percentFromAmounts(used: number | null | undefined, limit: number | null | undefined) {
  if (
    typeof used !== "number" ||
    typeof limit !== "number" ||
    !Number.isFinite(used) ||
    !Number.isFinite(limit) ||
    used < 0 ||
    limit <= 0
  ) {
    return undefined;
  }
  const percent = (used / limit) * 100;
  return Number.isFinite(percent) ? clampPercent(percent) : undefined;
}

function readSpendPercent(rateLimits: NonNullable<SDKControlGetUsageResponse["rate_limits"]>) {
  const spend = Option.getOrUndefined(
    decodeSpendBudget((rateLimits as { readonly spend?: unknown }).spend),
  );
  // Minor-unit ratios require matching currency and scale; spend.percent is rounded.
  if (
    spend?.enabled &&
    spend.used.currency.trim().length > 0 &&
    spend.used.currency.trim() === spend.limit.currency.trim() &&
    spend.used.exponent === spend.limit.exponent
  ) {
    const percent = percentFromAmounts(spend.used.amount_minor, spend.limit.amount_minor);
    if (percent !== undefined) return percent;
  }

  const extra = rateLimits.extra_usage;
  if (extra?.is_enabled !== true) return undefined;
  const percent = percentFromAmounts(extra.used_credits, extra.monthly_limit) ?? extra.utilization;
  return typeof percent === "number" && Number.isFinite(percent) && percent >= 0
    ? clampPercent(percent)
    : undefined;
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

function isoFromEpochSeconds(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  const dt = DateTime.make(value * 1000);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function isoFromString(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const dt = DateTime.make(value);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

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

/** Stream utilization is 0-1. Drop unnamed overage buckets until probed to avoid unreconcilable rows. */
export function claudeRateLimitEventToUpdate(
  info: SDKRateLimitInfo,
  names: ClaudeScopedLimitNames,
): ProviderUsageLimitsUpdate | undefined {
  const removeWindowIds = retiredWindowIds(names);
  const windows: ServerProviderUsageWindow[] = [];
  const type: string | undefined = info.rateLimitType;
  if (type && typeof info.utilization === "number") {
    const usedPercent = info.utilization * 100;
    const resetsAt = isoFromEpochSeconds(info.resetsAt);
    if (type in WINDOWS && !removeWindowIds.includes(type)) {
      windows.push(makeWindow(type, usedPercent, resetsAt));
    } else if (type === OVERAGE_INCLUDED_EVENT_TYPE && names.overageIncluded) {
      windows.push(scopedWindow(names.overageIncluded, usedPercent, resetsAt));
    }
  }
  if (windows.length === 0 && removeWindowIds.length === 0) return undefined;
  return { windows, ...(removeWindowIds.length > 0 ? { removeWindowIds } : {}) };
}

/** Learn the enforced windows from this event, then map it against them. */
export const recordClaudeRateLimitEvent = (
  namesRef: Ref.Ref<ClaudeScopedLimitNames>,
  info: SDKRateLimitInfo,
): Effect.Effect<ProviderUsageLimitsUpdate | undefined> =>
  Ref.modify(namesRef, (names) => {
    const next = rememberClaudeListedWindows(names, info);
    return [claudeRateLimitEventToUpdate(info, next), next] as const;
  });

/** get_usage percentages are already 0-100. `enforcedWindows` drops windows streamed headers retired. */
export function claudeUsageResponseToLimits(input: {
  readonly response: Pick<SDKControlGetUsageResponse, "rate_limits_available" | "rate_limits">;
  readonly checkedAt: string;
  readonly enforcedWindows?: ReadonlySet<string> | undefined;
}): { readonly limits: ServerProviderUsageLimits; readonly names: ClaudeScopedLimitNames } {
  const { response, checkedAt, enforcedWindows } = input;
  if (!response.rate_limits_available || !response.rate_limits) {
    return {
      limits: makeUnavailableUsageLimits({
        checkedAt,
        reason: response.rate_limits_available ? "probeFailed" : "unsupported",
      }),
      names: { overageIncluded: undefined },
    };
  }
  const windows: ServerProviderUsageWindow[] = [];
  for (const id of Object.keys(WINDOWS)) {
    const window = response.rate_limits[id as "five_hour" | "seven_day"];
    if (!window || typeof window.utilization !== "number") continue;
    if (enforcedWindows && !enforcedWindows.has(id)) continue;
    windows.push(makeWindow(id, window.utilization, isoFromString(window.resets_at)));
  }
  // The CLI's overage allowlist currently has one model; events refer to its first entry.
  let overageIncluded: string | undefined;
  for (const entry of readModelScoped(response.rate_limits)) {
    if (typeof entry.utilization !== "number") continue;
    windows.push(
      scopedWindow(entry.display_name, entry.utilization, isoFromString(entry.resets_at)),
    );
    overageIncluded ??= entry.display_name;
  }
  const spendPercent = readSpendPercent(response.rate_limits);
  if (spendPercent !== undefined) {
    windows.push({
      id: "monthly_spend",
      kind: "monthly",
      label: "Monthly spend",
      usedPercent: spendPercent,
    });
  }
  return {
    limits: makeUsageLimits({ checkedAt, windows }),
    names: { overageIncluded },
  };
}

export const recordClaudeUsageResponse = (
  namesRef: Ref.Ref<ClaudeScopedLimitNames>,
  input: Omit<Parameters<typeof claudeUsageResponseToLimits>[0], "enforcedWindows">,
): Effect.Effect<ServerProviderUsageLimits> =>
  Ref.modify(namesRef, (names) => {
    const { limits, names: probed } = claudeUsageResponseToLimits({
      ...input,
      enforcedWindows: names.enforcedWindows,
    });
    return [limits, { ...names, overageIncluded: probed.overageIncluded }] as const;
  });
