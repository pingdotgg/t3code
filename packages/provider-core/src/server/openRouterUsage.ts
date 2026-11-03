import type {
  ProviderDriverKind,
  ServerProviderUsageWindow,
  UsageLimitSourceAccount,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import { clampPercent, makeUnavailableUsageLimits, makeUsageLimits } from "./usageLimits.ts";

export interface OpenRouterUsageInput {
  readonly driver: ProviderDriverKind;
  readonly credential: {
    readonly provider: string;
    readonly key: string;
  };
  readonly checkedAt: string;
}

const KEY_URL = "https://openrouter.ai/api/v1/key";
const ACTIVITY_URL = "https://openrouter.ai/activity";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** OpenRouter reports these as numbers or null. */
function usd(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * The key only ever leaves this function as the bearer token; transport errors can
 * quote the request, so failures fold into a probeFailed account, never callers or logs.
 */
export const readOpenRouterUsageAccount = Effect.fn("readOpenRouterUsageAccount")(function* (
  input: OpenRouterUsageInput,
) {
  const httpClient = yield* HttpClient.HttpClient;
  const failed: UsageLimitSourceAccount = {
    id: input.credential.provider,
    driver: input.driver,
    usageLimits: makeUnavailableUsageLimits({
      checkedAt: input.checkedAt,
      reason: "probeFailed",
      message: "OpenRouter could not read this account's usage.",
    }),
  };
  const response = yield* httpClient
    .execute(
      HttpClientRequest.get(KEY_URL).pipe(HttpClientRequest.bearerToken(input.credential.key)),
    )
    .pipe(Effect.orElseSucceed(() => null));
  if (response === null || response.status < 200 || response.status >= 300) return failed;
  const body = yield* response.json.pipe(Effect.orElseSucceed(() => null));
  if (!isRecord(body) || !isRecord(body.data)) return failed;
  const data = body.data;
  const usage = usd(data.usage);
  const limit = usd(data.limit);
  const remaining = usd(data.limit_remaining);
  const windows: ReadonlyArray<ServerProviderUsageWindow> =
    limit !== undefined && limit > 0
      ? [
          {
            id: "credit_limit",
            kind: "other",
            label: "OpenRouter credit limit",
            usedPercent: clampPercent(((usage ?? 0) / limit) * 100),
          },
        ]
      : [];
  const account: UsageLimitSourceAccount = {
    id: input.credential.provider,
    driver: input.driver,
    plan:
      data.is_free_tier === true
        ? "OpenRouter Free Tier"
        : data.is_free_tier === false
          ? "OpenRouter Pay as you go"
          : "OpenRouter",
    usageLimits: {
      ...makeUsageLimits({ checkedAt: input.checkedAt, windows }),
      monetaryUsage: {
        ...(usage !== undefined ? { usedUsd: usage } : {}),
        ...(remaining !== undefined ? { remainingUsd: remaining } : {}),
        ...(limit !== undefined ? { limitUsd: limit } : {}),
      },
      externalUsage: { label: "OpenRouter activity", url: ACTIVITY_URL },
    },
  };
  return account;
});
