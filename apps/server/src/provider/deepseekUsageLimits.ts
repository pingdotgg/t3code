import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest } from "effect/http";

const DEEPSEEK_BALANCE_PATH = "/user/balance";

interface DeepSeekBalanceInfoEntry {
  readonly currency?: unknown;
  readonly total_balance?: unknown;
  readonly granted_balance?: unknown;
  readonly topped_up_balance?: unknown;
}

function resolveDeepSeekBalanceUrl(baseUrl: string | undefined): string | undefined {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return undefined;
  const parsed = URL.parse(trimmed);
  if (!parsed) return undefined;
  const host = parsed.hostname.toLowerCase();
  if (host === "api.deepseek.com" || host === "deepseek.com" || host.endsWith(".deepseek.com")) {
    return `${parsed.origin}${DEEPSEEK_BALANCE_PATH}`;
  }
  return undefined;
}

export function isDeepSeekEndpoint(baseUrl: string | undefined): boolean {
  return resolveDeepSeekBalanceUrl(baseUrl) !== undefined;
}

function formatCurrencySymbol(currency: string): string {
  switch (currency.toUpperCase()) {
    case "CNY":
    case "RMB":
      return "¥";
    case "USD":
      return "$";
    case "EUR":
      return "€";
    default:
      return `${currency.toUpperCase()} `;
  }
}

function normalizeMoney(
  raw: unknown,
): { readonly text: string; readonly value: number } | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return { text: raw.toFixed(2), value: raw };
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return undefined;
    return { text: parsed.toFixed(2), value: parsed };
  }
  return undefined;
}

function deepseekBalanceResponseToLimits(
  payload: unknown,
  checkedAt: string,
): ServerProviderUsageLimits {
  if (!payload || typeof payload !== "object") {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message: "DeepSeek did not return usable balance information.",
    });
  }
  const record = payload as Record<string, unknown>;
  const isAvailable = record.is_available !== false;
  const rawInfos = Array.isArray(record.balance_infos) ? record.balance_infos : [];
  const windows: ServerProviderUsageWindow[] = [];
  const seenIds = new Set<string>();

  for (const item of rawInfos) {
    if (!item || typeof item !== "object") continue;
    const entry = item as DeepSeekBalanceInfoEntry;
    const currency =
      typeof entry.currency === "string" && entry.currency.trim()
        ? entry.currency.trim().toUpperCase()
        : "CNY";
    const total = normalizeMoney(entry.total_balance);
    if (!total) continue;
    const granted = normalizeMoney(entry.granted_balance);
    const toppedUp = normalizeMoney(entry.topped_up_balance);
    const symbol = formatCurrencySymbol(currency);
    const id = `deepseek-balance-${currency.toLowerCase()}`;
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    const parts: string[] = [];
    if (toppedUp && toppedUp.value > 0) {
      parts.push(`topped:${symbol}${toppedUp.text}`);
    }
    if (granted && granted.value > 0) {
      parts.push(`granted:${symbol}${granted.text}`);
    }
    // Structured label parsed by the quota panel's balance card while remaining human-readable as plain text.
    const label =
      parts.length > 0
        ? `${currency}|${symbol}${total.text}|${parts.join(",")}`
        : `${currency}|${symbol}${total.text}`;

    windows.push({
      id,
      label,
      kind: "other",
      usedPercent: isAvailable && total.value > 0 ? 0 : 100,
    });
  }

  if (windows.length === 0) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message: isAvailable
        ? "DeepSeek did not return any balance entries."
        : "DeepSeek account balance is currently unavailable or exhausted.",
    });
  }

  return makeUsageLimits({ checkedAt, windows });
}

export const fetchDeepSeekUsageLimits = Effect.fn("fetchDeepSeekUsageLimits")(function* (input: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly checkedAt: string;
}): Effect.fn.Return<ServerProviderUsageLimits> {
  const url = resolveDeepSeekBalanceUrl(input.baseUrl);
  const apiKey = input.apiKey.trim();
  if (!url || !apiKey) {
    return makeUnavailableUsageLimits({
      checkedAt: input.checkedAt,
      reason: "unsupported",
    });
  }
  const authHeader = apiKey.toLowerCase().startsWith("bearer ") ? apiKey : `Bearer ${apiKey}`;
  const httpClient = yield* Effect.serviceOption(HttpClient.HttpClient);
  if (Option.isNone(httpClient)) {
    return makeUnavailableUsageLimits({
      checkedAt: input.checkedAt,
      reason: "probeFailed",
      message: "DeepSeek balance client is unavailable.",
    });
  }

  return yield* httpClient.value
    .execute(
      HttpClientRequest.get(url).pipe(
        HttpClientRequest.setHeaders({
          Authorization: authHeader,
          Accept: "application/json",
        }),
      ),
    )
    .pipe(
      Effect.flatMap((response) => {
        if (response.status === 401 || response.status === 403) {
          return Effect.succeed(
            makeUnavailableUsageLimits({
              checkedAt: input.checkedAt,
              reason: "probeFailed",
              message: "DeepSeek API key was rejected when checking balance.",
            }),
          );
        }
        return response.json.pipe(
          Effect.orElseSucceed(() => undefined as unknown),
          Effect.map((json) => deepseekBalanceResponseToLimits(json, input.checkedAt)),
        );
      }),
      Effect.timeout("10 seconds"),
      Effect.orElseSucceed(() =>
        makeUnavailableUsageLimits({
          checkedAt: input.checkedAt,
          reason: "probeFailed",
          message: "Could not reach DeepSeek balance endpoint.",
        }),
      ),
    );
});
