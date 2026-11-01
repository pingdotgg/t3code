import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import type { CursorSettings } from "../settings.ts";
import { CURSOR_USAGE_WINDOWS } from "@t3tools/shared/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import { DEFAULT_CURSOR_API_ENDPOINT, exchangeCursorApiKey } from "./apiKey.ts";

const NO_LIMITS_MESSAGE =
  "Cursor doesn't report a personal spend limit for this account. Open Cursor's dashboard with the same account to see its usage.";
const CursorInt64 = Schema.Union([Schema.String, Schema.Number]);
const CursorUsageResponse = Schema.Struct({
  billingCycleStart: Schema.optional(CursorInt64),
  billingCycleEnd: Schema.optional(CursorInt64),
  planUsage: Schema.optional(
    Schema.Struct({
      limit: Schema.optional(CursorInt64),
      totalPercentUsed: Schema.optional(Schema.Number),
      autoPercentUsed: Schema.optional(Schema.Number),
      apiPercentUsed: Schema.optional(Schema.Number),
    }),
  ),
  spendLimitUsage: Schema.optional(
    Schema.Struct({
      overallLimit: Schema.optional(CursorInt64),
      overallUsed: Schema.optional(CursorInt64),
      individualLimit: Schema.optional(CursorInt64),
      individualUsed: Schema.optional(CursorInt64),
    }),
  ),
});

/** Cursor's dashboard percentages include bonus usage; spend / limit does not. */
export function cursorUsageResponseToLimits(
  response: typeof CursorUsageResponse.Type,
  checkedAt: string,
) {
  const end = Number(response.billingCycleEnd);
  const cycleStart = Number(response.billingCycleStart);
  const reset = DateTime.make(end);
  // Without includePooledUsage, Cursor reports start = end = now instead of the cycle.
  const resetsAt =
    end > 0 && !(cycleStart >= end) && Option.isSome(reset)
      ? DateTime.formatIso(reset.value)
      : undefined;
  const { planUsage, spendLimitUsage: spend } = response;
  // Usage-based plans such as Enterprise send zeroed percentages without an allowance.
  const usageBased =
    spend !== undefined &&
    planUsage?.limit === undefined &&
    !planUsage?.totalPercentUsed &&
    !planUsage?.autoPercentUsed &&
    !planUsage?.apiPercentUsed;
  const windowDurationMins =
    resetsAt && cycleStart > 0 ? Math.round((end - cycleStart) / 60_000) : 0;
  const windows: ServerProviderUsageWindow[] = [];
  if (planUsage && !usageBased) {
    for (const { id, label } of CURSOR_USAGE_WINDOWS) {
      if (id === "spendLimit") continue;
      const usedPercent = planUsage[id];
      if (usedPercent === undefined || !Number.isFinite(usedPercent)) continue;
      windows.push({
        id,
        kind: "monthly",
        label,
        usedPercent: clampPercent(usedPercent),
        ...(resetsAt ? { resetsAt } : {}),
        ...(windowDurationMins > 0 ? { windowDurationMins } : {}),
      });
    }
  }
  const spendLimit = Number(spend?.overallLimit ?? spend?.individualLimit);
  const spent = Number(spend?.overallUsed ?? spend?.individualUsed ?? 0);
  if (windows.length === 0 && spendLimit > 0 && Number.isFinite(spent)) {
    windows.push({
      id: "spendLimit",
      kind: "monthly",
      label: "Spend",
      usedPercent: clampPercent((spent / spendLimit) * 100),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  if (windows.length > 0) return makeUsageLimits({ checkedAt, windows });
  return {
    ...makeUnavailableUsageLimits({ checkedAt, reason: "unsupported", message: NO_LIMITS_MESSAGE }),
    externalUsage: { label: "Cursor usage", url: "https://cursor.com/dashboard?tab=usage" },
  };
}

export const readCursorUsageLimits = Effect.fn("readCursorUsageLimits")(function* (
  settings: Pick<CursorSettings, "apiEndpoint">,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  return yield* Effect.gen(function* () {
    const endpoint = (
      settings.apiEndpoint?.trim() ||
      environment.CURSOR_API_ENDPOINT?.trim() ||
      DEFAULT_CURSOR_API_ENDPOINT
    ).replace(/\/$/, "");
    let token = environment.CURSOR_AUTH_TOKEN?.trim();
    const apiKey = environment.CURSOR_API_KEY?.trim();
    if (!token && apiKey) {
      if (endpoint !== DEFAULT_CURSOR_API_ENDPOINT) {
        return makeUnavailableUsageLimits({
          checkedAt,
          reason: "unsupported",
          message: "Cursor usage for an API key requires the default Cursor endpoint.",
        });
      }
      token = yield* exchangeCursorApiKey(apiKey);
    }
    if (!token) return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.post(`${endpoint}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.setHeaders({
          "connect-protocol-version": "1",
          "x-cursor-client-type": "cli",
        }),
        HttpClientRequest.bodyJsonUnsafe({ includePooledUsage: true }),
      ),
    );
    const body = yield* HttpClientResponse.schemaBodyJson(CursorUsageResponse)(
      yield* HttpClientResponse.filterStatusOk(response),
    );
    return cursorUsageResponseToLimits(body, checkedAt);
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed(() =>
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Cursor could not read usage limits.",
      }),
    ),
  );
});
