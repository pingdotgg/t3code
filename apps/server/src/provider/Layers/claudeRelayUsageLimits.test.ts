import { describe, expect, it } from "@effect/vitest";
import { ServerProviderUsageWindow } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { resolveUsageLimitsAfterProbe } from "../providerUsageLimits.ts";
import { readClaudeRelayUsageLimits, zaiQuotaResponseToLimits } from "./claudeRelayUsageLimits.ts";

const checkedAt = "2026-09-25T00:00:00.000Z";
const isUsageWindow = Schema.is(ServerProviderUsageWindow);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

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

  it("treats an empty quota response as a failed probe", () => {
    expect(zaiQuotaResponseToLimits({ data: { limits: [] } }, checkedAt).unavailable?.reason).toBe(
      "probeFailed",
    );
  });

  it.effect("leaves instances that do not point at a known relay alone", () =>
    Effect.gen(function* () {
      for (const environment of [
        {},
        { ANTHROPIC_BASE_URL: "https://api.anthropic.com", ANTHROPIC_AUTH_TOKEN: "token" },
        { ANTHROPIC_BASE_URL: "not a url", ANTHROPIC_AUTH_TOKEN: "token" },
        { ANTHROPIC_BASE_URL: "https://api.z.ai.example.com", ANTHROPIC_AUTH_TOKEN: "token" },
        { ANTHROPIC_BASE_URL: "https://api.z.ai@proxy.example.com", ANTHROPIC_AUTH_TOKEN: "token" },
        { ANTHROPIC_BASE_URL: "https://proxy.example.com/api.z.ai", ANTHROPIC_AUTH_TOKEN: "token" },
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
        ["https://dev.bigmodel.cn:443/api/anthropic?key=discarded", "ANTHROPIC_AUTH_TOKEN"],
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

  it.effect("retains last good bars after empty, rejected, or malformed responses", () =>
    Effect.gen(function* () {
      const row = { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 25 };
      const published = zaiQuotaResponseToLimits({ data: { limits: [row] } }, checkedAt);
      for (const response of [
        Response.json({}),
        Response.json({ error: "fixture-secret" }),
        Response.json({ data: null }),
        Response.json({ data: { limits: [] } }),
        Response.json({ data: { limits: [null, { type: "CREDIT_LIMIT" }] } }),
        Response.json({ success: false, code: 200, data: { limits: [row] } }),
        Response.json({ code: 401, data: { limits: [row] } }),
        ...[401, 429, 500].map((status) => new Response("fixture-secret", { status })),
        new Response("invalid json fixture-secret"),
      ]) {
        const probed = yield* readClaudeRelayUsageLimits({
          ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
          ANTHROPIC_AUTH_TOKEN: "fixture-secret",
        }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(HttpClientResponse.fromWeb(request, response)),
            ),
          ),
        );
        expect(probed?.unavailable?.reason).toBe("probeFailed");
        expect(resolveUsageLimitsAfterProbe({ published, probed })).toBe(published);
        expect(yield* encodeJson(probed)).not.toContain("fixture-secret");
      }
    }),
  );

  it.effect("keeps usable quotas when sibling rows are malformed or unavailable", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              success: true,
              code: 200,
              data: {
                limits: [
                  null,
                  { type: "CREDIT_LIMIT", percentage: "unavailable" },
                  { type: "CREDIT_LIMIT", percentage: null },
                  { type: "   ", percentage: 30 },
                  {
                    type: " CREDIT_LIMIT ",
                    unit: 3,
                    number: 5,
                    percentage: 25,
                    nextResetTime: null,
                  },
                ],
              },
            }),
          ),
        ),
      );
      const limits = yield* readClaudeRelayUsageLimits({
        ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
        ANTHROPIC_API_KEY: "fixture-key",
      }).pipe(Effect.provideService(HttpClient.HttpClient, client));
      expect(limits?.windows).toEqual([
        {
          id: "credit_limit_3_5",
          kind: "session",
          label: "Session",
          usedPercent: 25,
          windowDurationMins: 300,
        },
      ]);
      expect(limits?.unavailable).toBeUndefined();
    }),
  );

  it("preserves bars without emitting invalid or invented window durations", () => {
    for (const number of [undefined, null, -1, 0, 0.001, Number.MAX_VALUE]) {
      const limits = zaiQuotaResponseToLimits(
        {
          data: {
            limits: [{ type: "CREDIT_LIMIT", unit: 3, number, percentage: 25 }],
          },
        },
        checkedAt,
      );
      expect(limits.windows).toHaveLength(1);
      expect(limits.windows[0]?.windowDurationMins).toBeUndefined();
      expect(isUsageWindow(limits.windows[0])).toBe(true);
    }
    const limits = zaiQuotaResponseToLimits(
      { data: { limits: [{ type: "CREDIT_LIMIT", unit: 3, number: 0.5, percentage: -1 }] } },
      checkedAt,
    );
    expect(limits.windows[0]).toMatchObject({ windowDurationMins: 30, usedPercent: 0 });
  });

  it("omits invalid reset timestamps without losing the quota", () => {
    for (const nextResetTime of [undefined, null, -1, 0, Number.MAX_VALUE]) {
      const limits = zaiQuotaResponseToLimits(
        { data: { limits: [{ type: "TOKENS_LIMIT", percentage: 12, nextResetTime }] } },
        checkedAt,
      );
      expect(limits.windows).toHaveLength(1);
      expect(limits.windows[0]?.resetsAt).toBeUndefined();
      expect(isUsageWindow(limits.windows[0])).toBe(true);
    }
  });

  it.effect("prefers the auth token and falls back to the API key when it is blank", () =>
    Effect.gen(function* () {
      for (const authToken of [" auth-token ", "   "]) {
        const client = HttpClient.make((request) => {
          expect(request.headers.authorization).toBe(authToken.trim() || "api-key");
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ data: { limits: [{ type: "TOKENS_LIMIT", percentage: 0 }] } }),
            ),
          );
        });
        const limits = yield* readClaudeRelayUsageLimits({
          ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
          ANTHROPIC_AUTH_TOKEN: authToken,
          ANTHROPIC_API_KEY: " api-key ",
        }).pipe(Effect.provideService(HttpClient.HttpClient, client));
        expect(limits?.windows[0]?.usedPercent).toBe(0);
        expect(yield* encodeJson(limits)).not.toMatch(/auth-token|api-key/);
      }
    }),
  );

  it.effect("aborts a stalled response body at the ten-second timeout", () =>
    Effect.gen(function* () {
      const readingBody = yield* Deferred.make<void>();
      let requestSignal: AbortSignal | undefined;
      const client = HttpClient.make((request, _url, signal) => {
        requestSignal = signal;
        const response = HttpClientResponse.fromWeb(request, Response.json({}));
        Object.defineProperty(response, "json", {
          value: Deferred.succeed(readingBody, undefined).pipe(Effect.andThen(Effect.never)),
        });
        return Effect.succeed(response);
      });
      const probe = yield* readClaudeRelayUsageLimits({
        ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
        ANTHROPIC_AUTH_TOKEN: "fixture-key",
      }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.forkChild);
      yield* Deferred.await(readingBody);
      yield* TestClock.adjust("10 seconds");
      expect((yield* Fiber.join(probe))?.unavailable?.reason).toBe("probeFailed");
      expect(requestSignal?.aborted).toBe(true);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("aborts an in-flight request when its caller is interrupted", () =>
    Effect.gen(function* () {
      const requested = yield* Deferred.make<void>();
      let requestSignal: AbortSignal | undefined;
      const client = HttpClient.make((_request, _url, signal) => {
        requestSignal = signal;
        return Deferred.succeed(requested, undefined).pipe(Effect.andThen(Effect.never));
      });
      const probe = yield* readClaudeRelayUsageLimits({
        ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
        ANTHROPIC_AUTH_TOKEN: "fixture-key",
      }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.forkChild);
      yield* Deferred.await(requested);
      yield* Fiber.interrupt(probe);
      expect(requestSignal?.aborted).toBe(true);
    }),
  );
});
