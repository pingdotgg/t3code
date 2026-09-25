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
  unit: Schema.optional(Schema.Finite),
  number: Schema.optional(Schema.Finite),
  percentage: Schema.optional(Schema.Finite),
  nextResetTime: Schema.optional(Schema.Finite),
});
const ZaiQuotaResponse = Schema.Struct({
  data: Schema.optional(Schema.Struct({ limits: Schema.optional(Schema.Array(ZaiQuotaLimit)) })),
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

function isoFromEpochMillis(value: number | undefined): string | undefined {
  if (value === undefined || value <= 0) return undefined;
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
  const windows: ServerProviderUsageWindow[] = [];
  for (const [index, limit] of (response.data?.limits ?? []).entries()) {
    if (limit.percentage === undefined) continue;
    const count = limit.number ?? 1;
    const shape = limit.unit === undefined ? undefined : ZAI_UNITS[limit.unit]?.(count);
    const tools = limit.type === "TIME_LIMIT";
    const resetsAt = isoFromEpochMillis(limit.nextResetTime);
    windows.push({
      id: uniqueWindowId(
        windows,
        `${limit.type.toLowerCase()}_${limit.unit ?? "x"}_${count}`,
        index,
      ),
      kind: tools ? "other" : (shape?.kind ?? "other"),
      label: tools ? "Tool calls" : (shape?.label ?? "Quota"),
      usedPercent: clampPercent(limit.percentage),
      ...(shape && !tools ? { windowDurationMins: shape.windowDurationMins } : {}),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return windows.length === 0
    ? makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" })
    : makeUsageLimits({ checkedAt, windows });
}

const KIMI_HOST = "api.kimi.com";
const WEEK_MINS = 7 * 24 * 60;

/** Kimi sends counts as numbers or numeric strings. */
const KimiNumber = Schema.Union([Schema.Finite, Schema.String]);
const kimiQuotaFields = {
  name: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  limit: Schema.optional(KimiNumber),
  used: Schema.optional(KimiNumber),
  remaining: Schema.optional(KimiNumber),
  reset_at: Schema.optional(Schema.String),
  resetAt: Schema.optional(Schema.String),
  reset_time: Schema.optional(Schema.String),
  resetTime: Schema.optional(Schema.String),
  reset_in: Schema.optional(KimiNumber),
  resetIn: Schema.optional(KimiNumber),
};
const KimiQuota = Schema.Struct(kimiQuotaFields);
const KimiWindow = Schema.Struct({
  duration: Schema.optional(KimiNumber),
  timeUnit: Schema.optional(Schema.String),
});
const KimiUsageResponse = Schema.Struct({
  usage: Schema.optional(KimiQuota),
  limits: Schema.optional(
    Schema.Array(
      Schema.Struct({
        ...kimiQuotaFields,
        scope: Schema.optional(Schema.String),
        detail: Schema.optional(KimiQuota),
        window: Schema.optional(KimiWindow),
      }),
    ),
  ),
});

function kimiNumber(value: typeof KimiNumber.Type | undefined): number | undefined {
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
  MINUTE: 1,
  HOUR: 60,
  DAY: 24 * 60,
  WEEK: 7 * 24 * 60,
};

/** Months vary in length, so a monthly window keeps its count but no fixed duration. */
function kimiWindowMonths(window: typeof KimiWindow.Type | undefined): number | undefined {
  if (!window?.timeUnit?.toUpperCase().includes("MONTH")) return undefined;
  const months = kimiNumber(window.duration);
  return months !== undefined && months > 0 ? months : undefined;
}

function kimiWindowMins(window: typeof KimiWindow.Type | undefined) {
  const duration = kimiNumber(window?.duration);
  const unit = Object.keys(KIMI_UNIT_MINS).find((name) =>
    window?.timeUnit?.toUpperCase().includes(name),
  );
  return duration !== undefined && duration > 0 && unit
    ? duration * KIMI_UNIT_MINS[unit]!
    : undefined;
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
  const summaryPercent = response.usage ? kimiUsedPercent(response.usage) : undefined;
  if (response.usage && summaryPercent !== undefined) {
    const resetsAt = kimiResetsAt(response.usage, now);
    windows.push({
      id: "weekly",
      kind: "weekly",
      label: response.usage.name ?? response.usage.title ?? "Weekly",
      usedPercent: summaryPercent,
      windowDurationMins: WEEK_MINS,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  (response.limits ?? []).forEach((limit, index) => {
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
      label: limit.name ?? limit.title ?? limit.scope ?? shape?.label ?? "Limit",
      usedPercent,
      ...(mins === undefined ? {} : { windowDurationMins: mins }),
      ...(resetsAt ? { resetsAt } : {}),
    });
  });
  return windows.length === 0
    ? makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" })
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
