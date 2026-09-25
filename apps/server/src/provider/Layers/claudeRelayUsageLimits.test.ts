import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { readClaudeRelayUsageLimits, zaiQuotaResponseToLimits } from "./claudeRelayUsageLimits.ts";

const checkedAt = "2026-09-25T00:00:00.000Z";

const refuseRequests = HttpClient.make(() => Effect.die("must not call a relay usage endpoint"));

describe("Z.ai usage limits", () => {
  it("maps the five-hour and weekly credit windows with their resets", () => {
    const limits = zaiQuotaResponseToLimits(
      {
        data: {
          limits: [
            {
              type: "CREDIT_LIMIT",
              unit: 3,
              number: 5,
              percentage: 20,
              nextResetTime: 1788351145586,
            },
            {
              type: "CREDIT_LIMIT",
              unit: 6,
              number: 1,
              percentage: 52,
              nextResetTime: 1788784466996,
            },
          ],
        },
      },
      checkedAt,
    );
    expect(limits.windows).toEqual([
      {
        id: "credit_limit_3_5",
        kind: "session",
        label: "Session",
        usedPercent: 20,
        windowDurationMins: 300,
        resetsAt: "2026-09-02T12:12:25.586Z",
      },
      {
        id: "credit_limit_6_1",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 52,
        windowDurationMins: 10080,
        resetsAt: "2026-09-07T12:34:26.996Z",
      },
    ]);
  });

  it("labels the tool-call allowance and keeps unknown units without a duration", () => {
    const limits = zaiQuotaResponseToLimits(
      {
        data: {
          limits: [
            { type: "TOKENS_LIMIT", unit: 9, number: 1, percentage: 150 },
            { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 4 },
          ],
        },
      },
      checkedAt,
    );
    expect(limits.windows).toEqual([
      { id: "time_limit_5_1", kind: "other", label: "Tool calls", usedPercent: 4 },
      { id: "tokens_limit_9_1", kind: "other", label: "Quota", usedPercent: 100 },
    ]);
  });

  it("keeps two same-sized windows apart", () => {
    const limits = zaiQuotaResponseToLimits(
      {
        data: {
          limits: [
            { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 10 },
            { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 30 },
          ],
        },
      },
      checkedAt,
    );
    expect(limits.windows.map((window) => [window.id, window.usedPercent])).toEqual([
      ["credit_limit_3_5", 10],
      ["credit_limit_3_5_1", 30],
    ]);
  });

  it("reports no windows as unsupported rather than an empty bar", () => {
    expect(zaiQuotaResponseToLimits({ data: { limits: [] } }, checkedAt).unavailable?.reason).toBe(
      "unsupported",
    );
  });

  it.effect("leaves instances that do not point at a known relay alone", () =>
    Effect.gen(function* () {
      for (const environment of [
        {},
        { ANTHROPIC_BASE_URL: "https://api.anthropic.com", ANTHROPIC_AUTH_TOKEN: "token" },
        { ANTHROPIC_BASE_URL: "not a url", ANTHROPIC_AUTH_TOKEN: "token" },
        // The token never goes out in cleartext or to a port the relay does not serve.
        { ANTHROPIC_BASE_URL: "http://api.z.ai/api/anthropic", ANTHROPIC_AUTH_TOKEN: "token" },
        {
          ANTHROPIC_BASE_URL: "https://api.z.ai:8443/api/anthropic",
          ANTHROPIC_AUTH_TOKEN: "token",
        },
      ]) {
        const limits = yield* readClaudeRelayUsageLimits(environment).pipe(
          Effect.provideService(HttpClient.HttpClient, refuseRequests),
        );
        expect(limits).toBeUndefined();
      }
    }),
  );

  it.effect("reads the quota endpoint on the relay's own host with the CLI's token", () =>
    Effect.gen(function* () {
      for (const [baseUrl, variable] of [
        ["https://api.z.ai/api/anthropic", "ANTHROPIC_AUTH_TOKEN"],
        ["https://open.bigmodel.cn/api/anthropic", "ANTHROPIC_API_KEY"],
      ] as const) {
        const client = HttpClient.make((request) => {
          expect(request.url).toBe(`${new URL(baseUrl).origin}/api/monitor/usage/quota/limit`);
          expect(request.headers.authorization).toBe("relay-token");
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                code: 200,
                success: true,
                data: {
                  level: "pro",
                  limits: [{ type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 3 }],
                },
              }),
            ),
          );
        });
        const limits = yield* readClaudeRelayUsageLimits({
          ANTHROPIC_BASE_URL: baseUrl,
          [variable]: "relay-token",
        }).pipe(Effect.provideService(HttpClient.HttpClient, client));
        expect(limits?.windows[0]?.usedPercent).toBe(3);
      }
    }),
  );

  it.effect("marks a relay without a token unsupported and a failed read probeFailed", () =>
    Effect.gen(function* () {
      const missing = yield* readClaudeRelayUsageLimits({
        ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
      }).pipe(Effect.provideService(HttpClient.HttpClient, refuseRequests));
      expect(missing?.unavailable?.reason).toBe("unsupported");

      const failed = yield* readClaudeRelayUsageLimits({
        ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
        ANTHROPIC_AUTH_TOKEN: "expired",
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response("unauthorized", { status: 401 })),
            ),
          ),
        ),
      );
      expect(failed?.unavailable?.reason).toBe("probeFailed");
    }),
  );
});
