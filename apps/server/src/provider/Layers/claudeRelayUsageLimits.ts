/**
 * Subscription usage for Claude instances pointed at an Anthropic-compatible
 * relay through `ANTHROPIC_BASE_URL`. The Claude CLI's `get_usage` only knows
 * Anthropic accounts, so a relay instance would otherwise show no limits even
 * when the relay's own plan meters it. Each supported relay publishes its
 * quota on a separate endpoint authorised by the same token the CLI sends.
 *
 * @module provider/Layers/claudeRelayUsageLimits
 */
import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "../providerUsageLimits.ts";

const ZAI_HOSTS = new Set(["api.z.ai", "open.bigmodel.cn", "dev.bigmodel.cn"]);

const ZaiQuotaLimit = Schema.Struct({
  type: Schema.String,
  unit: Schema.optional(Schema.NullOr(Schema.Finite)),
  number: Schema.optional(Schema.NullOr(Schema.Finite)),
  percentage: Schema.optional(Schema.NullOr(Schema.Finite)),
  nextResetTime: Schema.optional(Schema.NullOr(Schema.Finite)),
});
const decodeZaiQuotaLimit = Schema.decodeUnknownOption(ZaiQuotaLimit);
const ZaiQuotaResponse = Schema.Struct({
  success: Schema.optional(Schema.Boolean),
  code: Schema.optional(Schema.Finite),
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({ limits: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))) }),
    ),
  ),
});

/** Z.ai's `unit` codes for the windows it is known to report. */
const ZAI_UNITS: Readonly<
  Record<
    number,
    (count: number) => Pick<ServerProviderUsageWindow, "kind" | "label" | "windowDurationMins">
  >
> = {
  3: (hours) => ({
    kind: hours <= 24 ? "session" : "other",
    label: hours === 5 ? "Session" : `${hours}-hour`,
    windowDurationMins: hours * 60,
  }),
  6: (weeks) => ({
    kind: "weekly",
    label: weeks === 1 ? "Weekly" : `${weeks}-week`,
    windowDurationMins: weeks * 7 * 24 * 60,
  }),
};

function isoFromEpochMillis(value: number | null | undefined): string | undefined {
  if (value == null || value <= 0) return undefined;
  const dt = DateTime.make(value);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

/**
 * Window ids key merges and pooling, so two rows of the same size must not
 * share one; the later row takes its position as a suffix.
 */
function uniqueWindowId(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  id: string,
  index: number,
): string {
  return windows.some((window) => window.id === id) ? `${id}_${index}` : id;
}

/**
 * Plans report token or credit windows (`TOKENS_LIMIT`, or `CREDIT_LIMIT` on
 * newer plans) and a monthly tool-call allowance (`TIME_LIMIT`). The window
 * size is `number` of `unit`; an unrecognised unit still draws a bar, just
 * without a duration to pace against.
 */
export function zaiQuotaResponseToLimits(
  response: typeof ZaiQuotaResponse.Type,
  checkedAt: string,
): ServerProviderUsageLimits {
  const failed = () =>
    makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message: "Z.ai could not read usage limits.",
    });
  if (response.success === false || (response.code !== undefined && response.code !== 200)) {
    return failed();
  }
  const windows: ServerProviderUsageWindow[] = [];
  for (const [index, rawLimit] of (response.data?.limits ?? []).entries()) {
    const decoded = decodeZaiQuotaLimit(rawLimit);
    if (Option.isNone(decoded)) continue;
    const limit = decoded.value;
    const type = limit.type.trim();
    if (!type || limit.percentage == null) continue;
    const count = limit.number ?? 1;
    const shape =
      limit.unit == null || limit.number == null || count <= 0
        ? undefined
        : ZAI_UNITS[limit.unit]?.(count);
    const duration = shape?.windowDurationMins;
    const tools = type === "TIME_LIMIT";
    const resetsAt = isoFromEpochMillis(limit.nextResetTime);
    windows.push({
      id: uniqueWindowId(windows, `${type.toLowerCase()}_${limit.unit ?? "x"}_${count}`, index),
      kind: tools ? "other" : (shape?.kind ?? "other"),
      label: tools ? "Tool calls" : (shape?.label ?? "Quota"),
      usedPercent: clampPercent(limit.percentage),
      ...(duration !== undefined && Number.isSafeInteger(duration) && duration > 0 && !tools
        ? { windowDurationMins: duration }
        : {}),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return windows.length === 0 ? failed() : makeUsageLimits({ checkedAt, windows });
}

const KIMI_HOST = "api.kimi.com";
const WEEK_MINS = 7 * 24 * 60;

/** Kimi sends counts as numbers or numeric strings. */
const KimiNumber = Schema.Union([Schema.Finite, Schema.String]);
const kimiQuotaFields = {
  name: Schema.optional(Schema.NullOr(Schema.String)),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  limit: Schema.optional(Schema.NullOr(KimiNumber)),
  used: Schema.optional(Schema.NullOr(KimiNumber)),
  remaining: Schema.optional(Schema.NullOr(KimiNumber)),
  reset_at: Schema.optional(Schema.NullOr(Schema.String)),
  resetAt: Schema.optional(Schema.NullOr(Schema.String)),
  reset_time: Schema.optional(Schema.NullOr(Schema.String)),
  resetTime: Schema.optional(Schema.NullOr(Schema.String)),
  reset_in: Schema.optional(Schema.NullOr(KimiNumber)),
  resetIn: Schema.optional(Schema.NullOr(KimiNumber)),
};
const KimiQuota = Schema.Struct(kimiQuotaFields);
const decodeKimiQuota = Schema.decodeUnknownOption(KimiQuota);
const KimiWindow = Schema.Struct({
  duration: Schema.optional(Schema.NullOr(KimiNumber)),
  timeUnit: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeKimiLimit = Schema.decodeUnknownOption(
  Schema.Struct({
    ...kimiQuotaFields,
    scope: Schema.optional(Schema.NullOr(Schema.String)),
    detail: Schema.optional(Schema.NullOr(KimiQuota)),
    window: Schema.optional(Schema.NullOr(KimiWindow)),
  }),
);
// Decode rows independently so one unavailable quota does not hide the others.
const KimiUsageResponse = Schema.Struct({
  usage: Schema.optional(Schema.Unknown),
  limits: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
});

function kimiNumber(value: typeof KimiNumber.Type | null | undefined): number | undefined {
  if (typeof value === "number") return value;
  const number = value?.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}

function kimiUsedPercent(quota: typeof KimiQuota.Type): number | undefined {
  const limit = kimiNumber(quota.limit);
  if (limit === undefined || limit <= 0) return undefined;
  const remaining = kimiNumber(quota.remaining);
  const used = kimiNumber(quota.used) ?? (remaining === undefined ? undefined : limit - remaining);
  return used === undefined ? undefined : clampPercent((used / limit) * 100);
}

/** Reset as an ISO time (Kimi sends nanosecond fractions) or as seconds from now. */
function kimiResetsAt(quota: typeof KimiQuota.Type, now: number): string | undefined {
  const at = quota.reset_at ?? quota.resetAt ?? quota.reset_time ?? quota.resetTime;
  if (at) {
    const dt = DateTime.make(at.replace(/(\.\d{3})\d+/, "$1"));
    if (Option.isSome(dt)) return DateTime.formatIso(dt.value);
  }
  const seconds = kimiNumber(quota.reset_in ?? quota.resetIn);
  if (seconds === undefined || seconds <= 0) return undefined;
  const dt = DateTime.make(now + seconds * 1000);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

const KIMI_UNIT_MINS: Readonly<Record<string, number>> = {
  SECOND: 1 / 60,
  MINUTE: 1,
  HOUR: 60,
  DAY: 24 * 60,
  WEEK: 7 * 24 * 60,
};

/** Months vary in length, so a monthly window keeps its count but no fixed duration. */
function kimiWindowMonths(window: typeof KimiWindow.Type | null | undefined): number | undefined {
  if (window?.timeUnit?.toUpperCase().replace(/^TIME_UNIT_/, "") !== "MONTH") return undefined;
  const months = kimiNumber(window.duration);
  return months !== undefined && months > 0 ? months : undefined;
}

function kimiWindowMins(window: typeof KimiWindow.Type | null | undefined) {
  const duration = kimiNumber(window?.duration);
  const unit = window?.timeUnit?.toUpperCase().replace(/^TIME_UNIT_/, "");
  const multiplier = unit ? KIMI_UNIT_MINS[unit] : undefined;
  const mins = duration !== undefined && multiplier !== undefined ? duration * multiplier : 0;
  // The shared wire contract only accepts whole minutes. Keep other quotas
  // visible without publishing a duration that clients would reject.
  return Number.isSafeInteger(mins) && mins > 0 ? mins : undefined;
}

function kimiWindowShape(mins: number): Pick<ServerProviderUsageWindow, "kind" | "label"> {
  if (mins === 5 * 60) return { kind: "session", label: "Session" };
  if (mins % WEEK_MINS === 0) {
    const weeks = mins / WEEK_MINS;
    return { kind: "weekly", label: weeks === 1 ? "Weekly" : `${weeks}-week` };
  }
  if (mins % (24 * 60) === 0) {
    return { kind: mins >= 28 * 24 * 60 ? "monthly" : "other", label: `${mins / (24 * 60)}-day` };
  }
  return {
    kind: mins <= 24 * 60 ? "session" : "other",
    label: mins % 60 === 0 ? `${mins / 60}-hour` : `${mins}-minute`,
  };
}

/**
 * Mirrors Kimi Code CLI's `/usage`: a plan-wide `usage` summary (weekly on
 * the plans that have one) plus rolling `limits`, each sized by its window.
 */
export function kimiUsageResponseToLimits(
  response: typeof KimiUsageResponse.Type,
  checkedAt: string,
): ServerProviderUsageLimits {
  const now = Date.parse(checkedAt);
  const windows: ServerProviderUsageWindow[] = [];
  const summary = Option.getOrUndefined(decodeKimiQuota(response.usage));
  const summaryPercent = summary ? kimiUsedPercent(summary) : undefined;
  if (summary && summaryPercent !== undefined) {
    const resetsAt = kimiResetsAt(summary, now);
    windows.push({
      id: "weekly",
      kind: "weekly",
      label: summary.name?.trim() || summary.title?.trim() || "Weekly",
      usedPercent: summaryPercent,
      windowDurationMins: WEEK_MINS,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  (response.limits ?? []).forEach((rawLimit, index) => {
    const limit = Option.getOrUndefined(decodeKimiLimit(rawLimit));
    if (!limit) return;
    const quota = limit.detail ?? limit;
    const usedPercent = kimiUsedPercent(quota);
    if (usedPercent === undefined) return;
    const months = kimiWindowMonths(limit.window);
    const mins = months === undefined ? kimiWindowMins(limit.window) : undefined;
    const shape: Pick<ServerProviderUsageWindow, "kind" | "label"> | undefined =
      months !== undefined
        ? { kind: "monthly", label: months === 1 ? "Monthly" : `${months}-month` }
        : mins === undefined
          ? undefined
          : kimiWindowShape(mins);
    const resetsAt = kimiResetsAt(quota, now);
    const baseId =
      months !== undefined
        ? `limit_${months}mo`
        : mins === undefined
          ? `limit_${index}`
          : `limit_${mins}m`;
    windows.push({
      id: uniqueWindowId(windows, baseId, index),
      kind: shape?.kind ?? "other",
      label:
        quota.name?.trim() ||
        quota.title?.trim() ||
        limit.name?.trim() ||
        limit.title?.trim() ||
        limit.scope?.trim() ||
        shape?.label ||
        "Limit",
      usedPercent,
      ...(mins === undefined ? {} : { windowDurationMins: mins }),
      ...(resetsAt ? { resetsAt } : {}),
    });
  });
  return windows.length === 0
    ? makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Kimi returned no usable usage limits.",
      })
    : makeUsageLimits({ checkedAt, windows });
}

/** Every supported relay is a public HTTPS service; anything else never receives the token. */
function relayOrigin(environment: NodeJS.ProcessEnv): URL | undefined {
  const baseUrl = environment.ANTHROPIC_BASE_URL?.trim();
  if (!baseUrl) return undefined;
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" && url.port === "" ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The relay's limits, or `undefined` when the instance does not point at a
 * relay this module knows, so the caller keeps whatever the CLI reported.
 */
export const readClaudeRelayUsageLimits = Effect.fn("readClaudeRelayUsageLimits")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const origin = relayOrigin(environment);
  const relay = !origin
    ? undefined
    : ZAI_HOSTS.has(origin.hostname)
      ? ("Z.ai" as const)
      : origin.hostname === KIMI_HOST
        ? ("Kimi" as const)
        : undefined;
  if (!origin || !relay) return undefined;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  // Both relays accept either variable as the CLI's credential.
  const token = environment.ANTHROPIC_AUTH_TOKEN?.trim() || environment.ANTHROPIC_API_KEY?.trim();
  if (!token) {
    return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  }
  return yield* Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    if (relay === "Kimi") {
      const response = yield* client.execute(
        HttpClientRequest.get(`${origin.origin}/coding/v1/usages`).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.acceptJson,
        ),
      );
      const body = yield* HttpClientResponse.schemaBodyJson(KimiUsageResponse)(
        yield* HttpClientResponse.filterStatusOk(response),
      );
      return kimiUsageResponseToLimits(body, checkedAt);
    }
    const response = yield* client.execute(
      HttpClientRequest.get(`${origin.origin}/api/monitor/usage/quota/limit`).pipe(
        // Z.ai's own usage tooling sends the bare key, not a Bearer token.
        HttpClientRequest.setHeader("authorization", token),
        HttpClientRequest.acceptJson,
      ),
    );
    const body = yield* HttpClientResponse.schemaBodyJson(ZaiQuotaResponse)(
      yield* HttpClientResponse.filterStatusOk(response),
    );
    return zaiQuotaResponseToLimits(body, checkedAt);
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed(() =>
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: `${relay} could not read usage limits.`,
      }),
    ),
  );
});
