import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  kimiUsageResponseToLimits,
  readClaudeRelayUsageLimits,
  zaiQuotaResponseToLimits,
} from "./claudeRelayUsageLimits.ts";

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

describe("Kimi Code usage limits", () => {
  it("maps the weekly summary and the rolling five-hour limit like Kimi's own /usage", () => {
    const limits = kimiUsageResponseToLimits(
      {
        usage: { limit: "100", remaining: "74", resetTime: "2026-09-28T05:24:18.443553353Z" },
        limits: [
          {
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: { limit: 100, used: 40, reset_in: 3600 },
          },
        ],
      },
      checkedAt,
    );
    expect(limits.windows).toEqual([
      {
        id: "limit_300m",
        kind: "session",
        label: "Session",
        usedPercent: 40,
        windowDurationMins: 300,
        resetsAt: "2026-09-25T01:00:00.000Z",
      },
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 26,
        windowDurationMins: 10080,
        resetsAt: "2026-09-28T05:24:18.443Z",
      },
    ]);
  });

  it("skips rows without a usable limit and keeps unsized windows without a duration", () => {
    const limits = kimiUsageResponseToLimits(
      {
        limits: [
          { name: "Monthly credits", limit: 50, used: "75" },
          { detail: { limit: 0, used: 1 } },
          { detail: { used: 3 } },
        ],
      },
      checkedAt,
    );
    expect(limits.windows).toEqual([
      { id: "limit_0", kind: "other", label: "Monthly credits", usedPercent: 100 },
    ]);
    expect(kimiUsageResponseToLimits({}, checkedAt).unavailable?.reason).toBe("unsupported");
  });

  it("sizes week and month windows and keeps same-sized rows apart", () => {
    const limits = kimiUsageResponseToLimits(
      {
        limits: [
          { window: { duration: 1, timeUnit: "TIME_UNIT_WEEK" }, detail: { limit: 10, used: 1 } },
          { window: { duration: 2, timeUnit: "TIME_UNIT_WEEK" }, detail: { limit: 10, used: 5 } },
          { window: { duration: 1, timeUnit: "TIME_UNIT_MONTH" }, detail: { limit: 10, used: 2 } },
          { window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" }, detail: { limit: 10, used: 3 } },
          {
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: { limit: 10, used: 4 },
          },
        ],
      },
      checkedAt,
    );
    expect(
      limits.windows.map(({ id, kind, label, windowDurationMins }) => ({
        id,
        kind,
        label,
        windowDurationMins,
      })),
    ).toEqual([
      { id: "limit_300m", kind: "session", label: "Session", windowDurationMins: 300 },
      { id: "limit_300m_4", kind: "session", label: "Session", windowDurationMins: 300 },
      { id: "limit_10080m", kind: "weekly", label: "Weekly", windowDurationMins: 10080 },
      { id: "limit_20160m", kind: "weekly", label: "2-week", windowDurationMins: 20160 },
      { id: "limit_1mo", kind: "monthly", label: "Monthly", windowDurationMins: undefined },
    ]);
  });

  it.effect("reads Kimi Code's usages endpoint with the CLI's key as a bearer token", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) => {
        expect(request.url).toBe("https://api.kimi.com/coding/v1/usages");
        expect(request.headers.authorization).toBe("Bearer sk-kimi-token");
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, Response.json({ usage: { limit: 10, used: 5 } })),
        );
      });
      const limits = yield* readClaudeRelayUsageLimits({
        ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/",
        ANTHROPIC_API_KEY: "sk-kimi-token",
      }).pipe(Effect.provideService(HttpClient.HttpClient, client));
      expect(limits?.windows[0]?.usedPercent).toBe(50);
    }),
  );

  it.effect("leaves Moonshot's open platform alone: it has no coding plan to meter", () =>
    Effect.gen(function* () {
      const limits = yield* readClaudeRelayUsageLimits({
        ANTHROPIC_BASE_URL: "https://api.moonshot.ai/anthropic",
        ANTHROPIC_API_KEY: "sk-token",
      }).pipe(Effect.provideService(HttpClient.HttpClient, refuseRequests));
      expect(limits).toBeUndefined();
    }),
  );
});
