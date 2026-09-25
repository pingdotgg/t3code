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
  if (!origin || !ZAI_HOSTS.has(origin.hostname)) return undefined;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  // Z.ai accepts either variable as the CLI's credential.
  const token = environment.ANTHROPIC_AUTH_TOKEN?.trim() || environment.ANTHROPIC_API_KEY?.trim();
  if (!token) {
    return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  }
  return yield* Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
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
        message: "Z.ai could not read usage limits.",
      }),
    ),
  );
});
