import type { ProviderListResponse } from "@opencode-ai/sdk/v2";
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

const PROVIDER_ID = "zai-coding-plan";
const CODING_URL = "https://api.z.ai/api/coding/paas/v4";
const QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const Limit = Schema.Struct({
  type: Schema.String,
  unit: Schema.Int,
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  percentage: Schema.Number.check(Schema.isFinite()),
  nextResetTime: Schema.optional(Schema.NullOr(Schema.Number.check(Schema.isFinite()))),
});
const QuotaResponse = Schema.Struct({
  code: Schema.Literal(200),
  success: Schema.Literal(true),
  data: Schema.Struct({ limits: Schema.Array(Limit) }),
});

function quotaWindow(limit: typeof Limit.Type): ServerProviderUsageWindow | undefined {
  if (limit.type !== "TOKENS_LIMIT" && limit.type !== "TIME_LIMIT") return undefined;
  // Z.ai uses 3 = hours, 4 = days, 5 = calendar months, 6 = weeks.
  // Calendar months have no fixed duration; retain their reset timestamp instead.
  const minutesPerUnit =
    limit.unit === 3 ? 60 : limit.unit === 4 ? 1440 : limit.unit === 6 ? 10080 : undefined;
  if (minutesPerUnit === undefined && limit.unit !== 5) return undefined;
  const duration = minutesPerUnit === undefined ? undefined : minutesPerUnit * limit.number;
  const isToolLimit = limit.type === "TIME_LIMIT";
  const kind = isToolLimit
    ? "other"
    : limit.unit === 5
      ? "monthly"
      : duration === 10080
        ? "weekly"
        : "session";
  const period = `${limit.number}${limit.unit === 3 ? "h" : limit.unit === 4 ? "d" : limit.unit === 6 ? "w" : "mo"}`;
  const reset =
    limit.nextResetTime && limit.nextResetTime > 0
      ? DateTime.make(limit.nextResetTime)
      : Option.none();
  return {
    id: `zai_${limit.type.toLowerCase()}_${limit.unit}_${limit.number}`,
    kind,
    label: `Z.ai ${isToolLimit ? "MCP" : "Coding"} · ${period}`,
    usedPercent: clampPercent(limit.percentage),
    ...(duration !== undefined ? { windowDurationMins: duration } : {}),
    ...(Option.isSome(reset) ? { resetsAt: DateTime.formatIso(reset.value) } : {}),
  };
}

/** Uses the credentials OpenCode resolved for this server, including remote instances.
 * Never falls back to the T3 host's auth file, which may belong to another account.
 */
export const readOpenCodeZaiUsageLimits = Effect.fn("readOpenCodeZaiUsageLimits")(function* (
  providers: ProviderListResponse,
  checkedAt: string,
): Effect.fn.Return<ServerProviderUsageLimits | undefined, never, HttpClient.HttpClient> {
  if (!providers.connected.includes(PROVIDER_ID)) return undefined;
  const provider = providers.all.find((entry) => entry.id === PROVIDER_ID);
  const unavailable = (reason: "unsupported" | "probeFailed", message: string) =>
    makeUnavailableUsageLimits({ checkedAt, reason, message });
  if (!provider || provider.source === "custom") {
    return unavailable(
      "unsupported",
      "Z.ai quota is unavailable for this OpenCode authentication method.",
    );
  }
  const baseURL = provider.options.baseURL;
  if (
    baseURL !== undefined &&
    (typeof baseURL !== "string" || baseURL.replace(/\/+$/, "") !== CODING_URL)
  ) {
    return unavailable("unsupported", "Z.ai quota is unavailable for a custom API endpoint.");
  }
  const key = provider.options.apiKey ?? provider.key;
  if (typeof key !== "string" || key.trim().length === 0) {
    return unavailable(
      "unsupported",
      "OpenCode did not expose a Z.ai API credential for quota reporting.",
    );
  }
  const client = yield* HttpClient.HttpClient;
  // Same read-only endpoint used by zai-org/zai-coding-plugins. Errors deliberately
  // exclude response bodies and request details, which can contain credentials.
  return yield* client
    .execute(
      HttpClientRequest.get(QUOTA_URL).pipe(
        HttpClientRequest.setHeader("Authorization", `Bearer ${key}`),
      ),
    )
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.flatMap(Schema.decodeUnknownEffect(QuotaResponse)),
      Effect.map((response) => {
        const windows = response.data.limits.flatMap((limit) => {
          const window = quotaWindow(limit);
          return window ? [window] : [];
        });
        return windows.length > 0
          ? makeUsageLimits({ checkedAt, windows })
          : unavailable("unsupported", "Z.ai did not report any supported quota windows.");
      }),
      Effect.timeout("5 seconds"),
      Effect.orElseSucceed(() =>
        unavailable("probeFailed", "Could not refresh Z.ai quota. Try refreshing the provider."),
      ),
    );
});
