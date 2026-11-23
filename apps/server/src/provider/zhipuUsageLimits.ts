import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as Effect from "effect/Effect";

const ZHIPU_QUOTA_PATH = "/api/monitor/usage/quota/limit";
const ZHIPU_QUOTA_TIMEOUT_MS = 10_000;

interface ZhipuQuotaLimitEntry {
  readonly type?: unknown;
  readonly unit?: unknown;
  readonly number?: unknown;
  readonly percentage?: unknown;
  readonly usage?: unknown;
  readonly currentValue?: unknown;
  readonly maxValue?: unknown;
  readonly remaining?: unknown;
  readonly nextResetTime?: unknown;
}

function resolveZhipuQuotaUrl(baseUrl: string | undefined): string | undefined {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return undefined;
  const parsed = URL.parse(trimmed);
  if (!parsed) return undefined;
  const host = parsed.hostname.toLowerCase();
  if (
    host === "open.bigmodel.cn" ||
    host.endsWith(".bigmodel.cn") ||
    host === "api.z.ai" ||
    host === "z.ai" ||
    host.endsWith(".z.ai")
  ) {
    return `${parsed.origin}${ZHIPU_QUOTA_PATH}`;
  }
  return undefined;
}

export function isZhipuEndpoint(baseUrl: string | undefined): boolean {
  return resolveZhipuQuotaUrl(baseUrl) !== undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseResetTimeIso(value: unknown): string | undefined {
  const numeric = asFiniteNumber(value);
  if (numeric !== undefined && numeric > 0) {
    const ms = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
  }
  return undefined;
}

function computeUsedPercent(entry: ZhipuQuotaLimitEntry): number | undefined {
  const percentage = asFiniteNumber(entry.percentage);
  if (percentage !== undefined) {
    return Math.max(0, Math.min(100, percentage));
  }
  const current = asFiniteNumber(entry.currentValue);
  const total = asFiniteNumber(entry.maxValue) ?? asFiniteNumber(entry.usage);
  if (current !== undefined && total !== undefined && total > 0) {
    return Math.max(0, Math.min(100, (current / total) * 100));
  }
  const remaining = asFiniteNumber(entry.remaining);
  if (remaining !== undefined && total !== undefined && total > 0) {
    return Math.max(0, Math.min(100, ((total - remaining) / total) * 100));
  }
  return undefined;
}

function mapZhipuLimitEntry(
  entry: ZhipuQuotaLimitEntry,
  index: number,
): ServerProviderUsageWindow | undefined {
  const usedPercent = computeUsedPercent(entry);
  if (usedPercent === undefined) return undefined;

  const type = typeof entry.type === "string" ? entry.type.toUpperCase() : "";
  const unit = asFiniteNumber(entry.unit);
  const count = asFiniteNumber(entry.number);
  const resetsAt = parseResetTimeIso(entry.nextResetTime);

  let id: string;
  let label: string;
  let kind: ServerProviderUsageWindow["kind"];
  let windowDurationMins: number | undefined;

  if (type === "TIME_LIMIT") {
    if (unit === 5) {
      id = "zhipu-mcp-monthly";
      label = "MCP / Tools · Monthly";
      kind = "other";
      windowDurationMins = 30 * 24 * 60;
    } else if (unit === 3) {
      const hours = count && count > 0 ? count : 5;
      id = `zhipu-time-${hours}h`;
      label = hours === 5 ? "5-hour" : `${hours}-hour`;
      kind = "session";
      windowDurationMins = hours * 60;
    } else if (unit === 6) {
      id = "zhipu-time-weekly";
      label = "Weekly";
      kind = "weekly";
      windowDurationMins = 7 * 24 * 60;
    } else {
      id = `zhipu-time-${index}`;
      label = "Tool Quota";
      kind = "other";
    }
  } else {
    if (unit === 3) {
      const hours = count && count > 0 ? count : 5;
      id = `zhipu-tokens-${hours}h`;
      label = hours === 5 ? "5-hour" : `${hours}-hour`;
      kind = "session";
      windowDurationMins = hours * 60;
    } else if (unit === 6) {
      id = "zhipu-tokens-weekly";
      label = "Weekly";
      kind = "weekly";
      windowDurationMins = 7 * 24 * 60;
    } else if (unit === 5) {
      id = "zhipu-tokens-monthly";
      label = "Monthly";
      kind = "other";
      windowDurationMins = 30 * 24 * 60;
    } else {
      id = `zhipu-quota-${index}`;
      label = "Token Quota";
      kind = "other";
    }
  }

  return {
    id,
    label,
    kind,
    usedPercent,
    ...(resetsAt ? { resetsAt } : {}),
    ...(windowDurationMins !== undefined ? { windowDurationMins } : {}),
  };
}

function zhipuQuotaResponseToLimits(
  payload: unknown,
  checkedAt: string,
): ServerProviderUsageLimits {
  if (!payload || typeof payload !== "object") {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message: "Zhipu did not return usable quota information.",
    });
  }
  const record = payload as Record<string, unknown>;
  const code = asFiniteNumber(record.code);
  if (code !== undefined && code !== 200) {
    const msg = typeof record.msg === "string" && record.msg.trim() ? record.msg.trim() : undefined;
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      ...(msg ? { message: `Zhipu quota error (${code}): ${msg}` } : {}),
    });
  }
  const data =
    record.data && typeof record.data === "object"
      ? (record.data as Record<string, unknown>)
      : record;
  const rawLimits = Array.isArray(data.limits) ? data.limits : [];
  const windows: ServerProviderUsageWindow[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < rawLimits.length; i++) {
    const item = rawLimits[i];
    if (!item || typeof item !== "object") continue;
    const mapped = mapZhipuLimitEntry(item as ZhipuQuotaLimitEntry, i);
    if (!mapped || seenIds.has(mapped.id)) continue;
    seenIds.add(mapped.id);
    windows.push(mapped);
  }
  if (windows.length === 0) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message: "Zhipu did not return any active quota windows.",
    });
  }
  return makeUsageLimits({ checkedAt, windows });
}

async function fetchZhipuQuotaJson(url: string, authHeader: string): Promise<unknown> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(ZHIPU_QUOTA_TIMEOUT_MS),
  });
  const json: unknown = await response.json().catch(() => undefined);
  return { status: response.status, json };
}

export const fetchZhipuUsageLimits = Effect.fn("fetchZhipuUsageLimits")(function* (input: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly checkedAt: string;
}): Effect.fn.Return<ServerProviderUsageLimits> {
  const url = resolveZhipuQuotaUrl(input.baseUrl);
  const apiKey = input.apiKey.trim();
  if (!url || !apiKey) {
    return makeUnavailableUsageLimits({
      checkedAt: input.checkedAt,
      reason: "unsupported",
    });
  }

  return yield* Effect.tryPromise({
    try: async () => {
      const first = (await fetchZhipuQuotaJson(url, apiKey)) as {
        status: number;
        json: unknown;
      };
      const firstCode =
        first.json && typeof first.json === "object"
          ? asFiniteNumber((first.json as Record<string, unknown>).code)
          : undefined;
      if (first.status === 401 || firstCode === 401 || firstCode === 1000) {
        const bearerHeader = apiKey.toLowerCase().startsWith("bearer ")
          ? apiKey
          : `Bearer ${apiKey}`;
        const retry = (await fetchZhipuQuotaJson(url, bearerHeader)) as {
          status: number;
          json: unknown;
        };
        return zhipuQuotaResponseToLimits(retry.json, input.checkedAt);
      }
      return zhipuQuotaResponseToLimits(first.json, input.checkedAt);
    },
    catch: () =>
      makeUnavailableUsageLimits({
        checkedAt: input.checkedAt,
        reason: "probeFailed",
        message: "Could not reach Zhipu quota endpoint.",
      }),
  }).pipe(Effect.catch((fallback) => Effect.succeed(fallback)));
});
