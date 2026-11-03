import type {
  ProviderDriverKind,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
  UsageLimitSourceAccount,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { clampPercent, makeUnavailableUsageLimits, makeUsageLimits } from "./usageLimits.ts";

export interface KimiUsageInput {
  readonly driver: ProviderDriverKind;
  readonly credential: { readonly provider: string; readonly key: string };
  readonly checkedAt: string;
}

const KIMI_USAGES_URL = "https://api.kimi.com/coding/v1/usages";
const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usage";
const PROBE_TIMEOUT = "10 seconds";
const PROBE_FAILED_MESSAGE = "Kimi Code usage limits could not be read.";

const FIVE_HOURS_MINUTES = 300;
const SEVEN_DAYS_MINUTES = 7 * 24 * 60;
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * 60;
const SECONDS_PER_MINUTE = 60;
const LIMIT_KEY_PATTERN = /^limit_(\d+)([mhd])$/;

function parseNumeric(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : Number.NaN;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return Number.NaN;
    const numericValue = Number(trimmed);
    return Number.isFinite(numericValue) ? numericValue : Number.NaN;
  }
  return Number.NaN;
}

function parseResetTime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || Number.isNaN(Date.parse(trimmed))) {
    return undefined;
  }
  return trimmed;
}

function parseDurationMinutes(duration: number, timeUnit: string): number | undefined {
  const unit = timeUnit.toUpperCase().replace(/^TIME_UNIT_/, "");
  switch (unit) {
    case "MINUTE":
    case "MINUTES":
      return Math.round(duration);
    case "HOUR":
    case "HOURS":
      return Math.round(duration * MINUTES_PER_HOUR);
    case "DAY":
    case "DAYS":
      return Math.round(duration * MINUTES_PER_DAY);
    case "SECOND":
    case "SECONDS":
      return Math.round(duration / SECONDS_PER_MINUTE);
    default:
      return undefined;
  }
}

function durationMinutesToKind(
  durationMinutes: number | undefined,
): ServerProviderUsageWindow["kind"] {
  if (durationMinutes === undefined) return "other";
  if (durationMinutes <= 12 * MINUTES_PER_HOUR) return "session";
  if (durationMinutes >= 6 * MINUTES_PER_DAY && durationMinutes <= 8 * MINUTES_PER_DAY) {
    return "weekly";
  }
  if (durationMinutes >= 25 * MINUTES_PER_DAY && durationMinutes <= 35 * MINUTES_PER_DAY) {
    return "monthly";
  }
  return "other";
}

function kindToLabel(kind: ServerProviderUsageWindow["kind"], durationMinutes?: number): string {
  if (durationMinutes === FIVE_HOURS_MINUTES) return "Kimi Code 5-hour";
  switch (kind) {
    case "session":
      return "Kimi Code Session";
    case "weekly":
      return "Kimi Code Weekly";
    case "monthly":
      return "Kimi Code Monthly";
    case "other":
      return "Kimi Code Other";
  }
}

function parseLimitKeyDurationMinutes(key: string): number | undefined {
  const match = key.match(LIMIT_KEY_PATTERN);
  if (!match) return undefined;
  const countStr = match[1];
  const unit = match[2];
  if (countStr === undefined || unit === undefined) return undefined;
  const count = parseInt(countStr, 10);
  if (unit === "m") return count;
  if (unit === "h") return count * MINUTES_PER_HOUR;
  return count * MINUTES_PER_DAY;
}

function parseUsagesEntry(key: string, rawEntry: unknown): ServerProviderUsageWindow | undefined {
  if (typeof rawEntry !== "object" || rawEntry === null) return undefined;
  const entry = rawEntry as Record<string, unknown>;
  const ratio = parseNumeric(entry.used_ratio);
  if (Number.isNaN(ratio) || ratio < 0) return undefined;

  const usedPercent = clampPercent(ratio * 100);
  const resetsAt = parseResetTime(entry.reset_time);

  if (key === "limit_5h") {
    return {
      id: "kimi-5h",
      kind: "session",
      label: kindToLabel("session", FIVE_HOURS_MINUTES),
      usedPercent,
      ...(resetsAt ? { resetsAt } : {}),
      windowDurationMins: FIVE_HOURS_MINUTES,
    };
  }
  if (key === "limit_7d") {
    return {
      id: "kimi-7d",
      kind: "weekly",
      label: kindToLabel("weekly", SEVEN_DAYS_MINUTES),
      usedPercent,
      ...(resetsAt ? { resetsAt } : {}),
      windowDurationMins: SEVEN_DAYS_MINUTES,
    };
  }
  if (key.startsWith("limit_")) {
    const durationMinutes = parseLimitKeyDurationMinutes(key);
    return {
      id: `kimi-${key}`,
      kind: "other",
      label: `Kimi Code ${key}`,
      usedPercent,
      ...(resetsAt ? { resetsAt } : {}),
      ...(durationMinutes !== undefined ? { windowDurationMins: durationMinutes } : {}),
    };
  }
  return undefined;
}

function parseUsagesRecord(usages: unknown): ServerProviderUsageWindow[] {
  if (typeof usages !== "object" || usages === null) return [];
  const windows: ServerProviderUsageWindow[] = [];
  for (const [key, rawEntry] of Object.entries(usages as Record<string, unknown>)) {
    const window = parseUsagesEntry(key, rawEntry);
    if (window !== undefined) {
      windows.push(window);
    }
  }
  return windows;
}

function parseLegacySummaryWindow(usage: unknown): ServerProviderUsageWindow | undefined {
  if (typeof usage !== "object" || usage === null) return undefined;
  const record = usage as Record<string, unknown>;
  const used = parseNumeric(record.used);
  const limit = parseNumeric(record.limit);
  if (Number.isNaN(used) || Number.isNaN(limit) || limit <= 0) return undefined;

  const resetsAt = parseResetTime(record.resetTime);
  return {
    id: "kimi-7d",
    kind: "weekly",
    label: kindToLabel("weekly", SEVEN_DAYS_MINUTES),
    usedPercent: clampPercent((used / limit) * 100),
    ...(resetsAt ? { resetsAt } : {}),
    windowDurationMins: SEVEN_DAYS_MINUTES,
  };
}

function parseLegacyLimitItem(item: unknown, index: number): ServerProviderUsageWindow | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const entry = item as Record<string, unknown>;
  if (typeof entry.detail !== "object" || entry.detail === null) return undefined;
  const detail = entry.detail as Record<string, unknown>;
  const used = parseNumeric(detail.used);
  const limit = parseNumeric(detail.limit);
  if (Number.isNaN(used) || Number.isNaN(limit) || limit <= 0) return undefined;

  const window =
    typeof entry.window === "object" && entry.window !== null
      ? (entry.window as Record<string, unknown>)
      : undefined;
  const duration = parseNumeric(window?.duration);
  const timeUnit = typeof window?.timeUnit === "string" ? window.timeUnit : undefined;
  const windowDurationMins =
    duration > 0 && timeUnit ? parseDurationMinutes(duration, timeUnit) : undefined;
  const kind = durationMinutesToKind(windowDurationMins);
  const label = kindToLabel(kind, windowDurationMins);
  const resetsAt = parseResetTime(detail.resetTime);

  return {
    id: `kimi-limit-${index}`,
    kind,
    label,
    usedPercent: clampPercent((used / limit) * 100),
    ...(resetsAt ? { resetsAt } : {}),
    ...(windowDurationMins !== undefined ? { windowDurationMins } : {}),
  };
}

function parseLegacyUsageRecord(payload: Record<string, unknown>): ServerProviderUsageWindow[] {
  const windows: ServerProviderUsageWindow[] = [];
  const summaryWindow = parseLegacySummaryWindow(payload.usage);
  if (summaryWindow !== undefined) {
    windows.push(summaryWindow);
  }
  if (Array.isArray(payload.limits)) {
    for (let index = 0; index < payload.limits.length; index++) {
      const window = parseLegacyLimitItem(payload.limits[index], index);
      if (window !== undefined) {
        windows.push(window);
      }
    }
  }
  return windows;
}

function probeFailedLimits(checkedAt: string): ServerProviderUsageLimits {
  return makeUnavailableUsageLimits({
    checkedAt,
    reason: "probeFailed",
    message: PROBE_FAILED_MESSAGE,
  });
}

function kimiUsageResponseToLimits(
  response: unknown,
  checkedAt: string,
): ServerProviderUsageLimits {
  if (typeof response !== "object" || response === null) {
    return probeFailedLimits(checkedAt);
  }

  const payload = response as Record<string, unknown>;
  // Kimi groups quota ratios under usages; alternative endpoints report top-level usage and limits.
  const windows =
    payload.usages !== undefined
      ? parseUsagesRecord(payload.usages)
      : parseLegacyUsageRecord(payload);

  if (windows.length === 0) {
    return probeFailedLimits(checkedAt);
  }

  return makeUsageLimits({ checkedAt, windows });
}

function kimiUsageAccount(
  input: KimiUsageInput,
  usageLimits: ServerProviderUsageLimits,
): UsageLimitSourceAccount {
  return {
    id: input.credential.provider,
    driver: input.driver,
    plan: "Kimi Code",
    usageLimits,
  };
}

export const readKimiCodeUsageAccount = Effect.fn("readKimiCodeUsageAccount")(function* (
  input: KimiUsageInput,
) {
  const token = input.credential.key.trim();
  if (token.length === 0) {
    return kimiUsageAccount(
      input,
      makeUnavailableUsageLimits({ checkedAt: input.checkedAt, reason: "unsupported" }),
    );
  }
  const usageLimits = yield* Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const usagesResponse = yield* client.execute(
      HttpClientRequest.get(KIMI_USAGES_URL).pipe(HttpClientRequest.bearerToken(token)),
    );
    // Older deployments only expose the singular endpoint; no other status retries.
    const response =
      usagesResponse.status === 404
        ? yield* client.execute(
            HttpClientRequest.get(KIMI_USAGE_URL).pipe(HttpClientRequest.bearerToken(token)),
          )
        : usagesResponse;
    const body = yield* HttpClientResponse.schemaBodyJson(Schema.Unknown)(
      yield* HttpClientResponse.filterStatusOk(response),
    );
    return kimiUsageResponseToLimits(body, input.checkedAt);
  }).pipe(
    Effect.timeout(PROBE_TIMEOUT),
    // Failed requests carry the credential; the fallback message is the only one surfaced.
    Effect.orElseSucceed(() => probeFailedLimits(input.checkedAt)),
  );
  return kimiUsageAccount(input, usageLimits);
});
