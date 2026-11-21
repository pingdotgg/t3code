import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { cursorUsageResponseToLimits, readCursorUsageLimits } from "./usageLimits.ts";

describe("Cursor usage limits", () => {
  const checkedAt = "2026-09-16T00:00:00.000Z";

  it("uses the advertised percentages and reset, or Spend when no allowance is included", () => {
    const limits = cursorUsageResponseToLimits(
      {
        billingCycleEnd: "1789876386000",
        planUsage: { totalPercentUsed: 72.4, autoPercentUsed: 69.5, apiPercentUsed: 100 },
      },
      checkedAt,
    );
    expect(limits.windows).toEqual(
      expect.arrayContaining([
        {
          id: "totalPercentUsed",
          kind: "monthly",
          label: "Overall",
          usedPercent: 72.4,
          resetsAt: "2026-09-20T03:53:06.000Z",
        },
        {
          id: "autoPercentUsed",
          kind: "monthly",
          label: "Cursor Models",
          usedPercent: 69.5,
          resetsAt: "2026-09-20T03:53:06.000Z",
        },
        {
          id: "apiPercentUsed",
          kind: "monthly",
          label: "Other Models",
          usedPercent: 100,
          resetsAt: "2026-09-20T03:53:06.000Z",
        },
      ]),
    );
    const withSpendLimit = cursorUsageResponseToLimits(
      {
        billingCycleEnd: "1789876386000",
        planUsage: { totalPercentUsed: 72.4, autoPercentUsed: 69.5, apiPercentUsed: 100 },
        spendLimitUsage: { individualLimit: 5000, individualUsed: 100 },
      },
      checkedAt,
    );
    expect(withSpendLimit.windows).toEqual(limits.windows);
    const zeroPercents = { totalPercentUsed: 0, autoPercentUsed: 0, apiPercentUsed: 0 };
    const zeroPlanWindows = [
      { id: "apiPercentUsed", kind: "monthly", label: "Other Models", usedPercent: 0 },
      { id: "autoPercentUsed", kind: "monthly", label: "Cursor Models", usedPercent: 0 },
      { id: "totalPercentUsed", kind: "monthly", label: "Overall", usedPercent: 0 },
    ];
    const windowIds = (response: Parameters<typeof cursorUsageResponseToLimits>[0]) =>
      cursorUsageResponseToLimits(response, checkedAt).windows.map((window) => window.id);
    // Usage already counted against a pooled plan keeps the plan bars.
    expect(
      windowIds({
        planUsage: { totalPercentUsed: 6, autoPercentUsed: 6, apiPercentUsed: 0 },
        spendLimitUsage: { pooledLimit: "3000000", overallLimit: 50000, overallUsed: 3211 },
      }),
    ).toEqual(["apiPercentUsed", "autoPercentUsed", "totalPercentUsed"]);
    // Fresh-cycle Pro: an included allowance, or no pool marker, keeps the plan bars.
    for (const response of [
      {
        planUsage: { ...zeroPercents, limit: "2000" },
        spendLimitUsage: { individualLimit: 5000, individualUsed: 0, pooledLimit: "3000000" },
      },
      { planUsage: zeroPercents, spendLimitUsage: { individualLimit: 5000 } },
    ]) {
      expect(cursorUsageResponseToLimits(response, checkedAt).windows).toEqual(zeroPlanWindows);
    }
    expect(
      windowIds({
        planUsage: { ...zeroPercents, limit: "0" },
        spendLimitUsage: { pooledLimit: "3000000", overallLimit: 50000, overallUsed: 3211 },
      }),
    ).toEqual(["spendLimit"]);
    // Without includePooledUsage, Cursor reports start = end = now instead of the cycle.
    expect(
      cursorUsageResponseToLimits(
        {
          billingCycleStart: "1793491200000",
          billingCycleEnd: "1793491200000",
          spendLimitUsage: { individualLimit: "2000", individualUsed: "500" },
        },
        checkedAt,
      ).windows,
    ).toEqual([{ id: "spendLimit", kind: "monthly", label: "Spend", usedPercent: 25 }]);
    // Limit and used come from the same pair; protobuf JSON omits a zero used.
    for (const [spendLimitUsage, usedPercent] of [
      [{ overallLimit: 50000, individualUsed: 3211 }, 0],
      [{ overallLimit: 0, individualLimit: "2000", individualUsed: "500" }, 25],
    ] as const) {
      expect(
        cursorUsageResponseToLimits({ spendLimitUsage }, checkedAt).windows.map(
          (window) => window.usedPercent,
        ),
      ).toEqual([usedPercent]);
    }
  });

  it("reports the billing-cycle length so pace can be computed", () => {
    const planUsage = { totalPercentUsed: 40, autoPercentUsed: 30, apiPercentUsed: 20 };
    const durations = (billingCycleStart: string | number | undefined, billingCycleEnd: string) =>
      cursorUsageResponseToLimits(
        { billingCycleStart, billingCycleEnd, planUsage },
        checkedAt,
      ).windows.map((window) => window.windowDurationMins);
    expect(durations("1794045847072", "1796637847072")).toEqual([43_200, 43_200, 43_200]);
    expect(durations(1_796_637_847_072, "1799316247072")).toEqual([44_640, 44_640, 44_640]);
  });

  it("omits the cycle length when the start is missing or invalid", () => {
    for (const billingCycleStart of [undefined, "", "0", "not-a-number"]) {
      expect(
        cursorUsageResponseToLimits(
          {
            billingCycleStart,
            billingCycleEnd: "1796637847072",
            planUsage: { totalPercentUsed: 40 },
          },
          checkedAt,
        ).windows,
      ).toEqual([
        {
          id: "totalPercentUsed",
          kind: "monthly",
          label: "Overall",
          usedPercent: 40,
          resetsAt: "2026-12-07T10:04:07.072Z",
        },
      ]);
    }
  });

  it("retains unified totals for account aggregation", () => {
    const windows = cursorUsageResponseToLimits(
      { planUsage: { totalPercentUsed: 1.77, autoPercentUsed: 1.77 } },
      checkedAt,
    ).windows;
    expect(windows.map((window) => window.id)).toEqual(["autoPercentUsed", "totalPercentUsed"]);
    expect(
      cursorUsageResponseToLimits(
        { planUsage: { totalPercentUsed: 100, apiPercentUsed: 100 } },
        checkedAt,
      ).windows.map((window) => window.id),
    ).toEqual(["apiPercentUsed", "totalPercentUsed"]);
  });

  it("does not invent unused allowance for absent buckets", () => {
    const linkOnly = {
      checkedAt,
      windows: [],
      unavailable: {
        reason: "unsupported",
        message:
          "Cursor doesn't report a personal spend limit for this account. Open Cursor's dashboard with the same account to see its usage.",
      },
      externalUsage: { label: "Cursor usage", url: "https://cursor.com/dashboard?tab=usage" },
    };
    expect(cursorUsageResponseToLimits({ planUsage: {} }, checkedAt)).toEqual(linkOnly);
    // Real Enterprise (token-based contract) response: no planUsage at all.
    expect(cursorUsageResponseToLimits({ billingCycleEnd: "1793495876373" }, checkedAt)).toEqual(
      linkOnly,
    );
    // Enterprise seat with only the team pool: zeroed percentages and no personal limit.
    expect(
      cursorUsageResponseToLimits(
        {
          billingCycleStart: "1793491200000",
          billingCycleEnd: "1796083200000",
          planUsage: { totalPercentUsed: 0, autoPercentUsed: 0, apiPercentUsed: 0 },
          spendLimitUsage: { pooledLimit: "3000000" },
        },
        checkedAt,
      ),
    ).toEqual(linkOnly);
    expect(
      cursorUsageResponseToLimits({ planUsage: { totalPercentUsed: 0 } }, checkedAt).windows,
    ).toEqual([{ id: "totalPercentUsed", kind: "monthly", label: "Overall", usedPercent: 0 }]);
    expect(
      cursorUsageResponseToLimits({ planUsage: { totalPercentUsed: 150 } }, checkedAt).windows,
    ).toEqual([{ id: "totalPercentUsed", kind: "monthly", label: "Overall", usedPercent: 100 }]);
  });

  it.effect(
    "requests pooled usage and shows Enterprise spend against the personal spend limit",
    () =>
      Effect.gen(function* () {
        const limits = yield* readCursorUsageLimits(
          { apiEndpoint: "" },
          { CURSOR_AUTH_TOKEN: "token" },
        ).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              expect(
                request.body._tag === "Uint8Array" && new TextDecoder().decode(request.body.body),
              ).toBe('{"includePooledUsage":true}');
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json({
                    billingCycleStart: "1793491200000",
                    billingCycleEnd: "1796083200000",
                    displayThreshold: 50,
                    planUsage: { totalPercentUsed: 0, autoPercentUsed: 0, apiPercentUsed: 0 },
                    spendLimitUsage: {
                      limitType: "team",
                      overallLimit: 50000,
                      overallUsed: 3211,
                      overallRemaining: 46789,
                      pooledLimit: "3000000",
                      pooledUsed: 0,
                      pooledRemaining: "3000000",
                    },
                    displayMessage: "You've used 6% of your included usage",
                  }),
                ),
              );
            }),
          ),
        );
        expect(limits).toEqual({
          checkedAt: expect.any(String),
          windows: [
            {
              id: "spendLimit",
              kind: "monthly",
              label: "Spend",
              usedPercent: 6.422,
              resetsAt: "2026-12-01T00:00:00.000Z",
            },
          ],
        });
      }),
  );

  it.effect("requires explicit credentials and accepts an auth token", () =>
    Effect.gen(function* () {
      for (const token of [undefined, "explicit-token"]) {
        const limits = yield* readCursorUsageLimits(
          { apiEndpoint: "" },
          token ? { CURSOR_AUTH_TOKEN: token } : {},
        ).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              expect(token).toBe("explicit-token");
              expect(request.headers.authorization).toBe("Bearer explicit-token");
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json({ planUsage: { totalPercentUsed: 10 } }),
                ),
              );
            }),
          ),
        );
        if (token) expect(limits.windows[0]?.usedPercent).toBe(10);
        else expect(limits.unavailable?.reason).toBe("unsupported");
      }
    }),
  );

  it.effect("reports failed requests without exposing credentials or response bodies", () =>
    Effect.gen(function* () {
      const limits = yield* readCursorUsageLimits(
        { apiEndpoint: "" },
        { CURSOR_AUTH_TOKEN: "private-token" },
      ).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response("private response", { status: 401 }),
              ),
            ),
          ),
        ),
      );
      expect(limits.unavailable).toEqual({
        reason: "probeFailed",
        message: "Cursor could not read usage limits.",
      });
    }),
  );

  it.effect("exchanges an API key to read its account limits", () =>
    Effect.gen(function* () {
      const requests: Array<readonly [string, string | undefined]> = [];
      const limits = yield* readCursorUsageLimits(
        { apiEndpoint: "" },
        { CURSOR_API_KEY: "api-key" },
      ).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            requests.push([request.url, request.headers.authorization]);
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json(
                  request.url.endsWith("/auth/exchange_user_api_key")
                    ? { accessToken: "api-key-access-token" }
                    : { planUsage: { totalPercentUsed: 37 } },
                ),
              ),
            );
          }),
        ),
      );
      expect(requests).toEqual([
        ["https://api2.cursor.sh/auth/exchange_user_api_key", "Bearer api-key"],
        [
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
          "Bearer api-key-access-token",
        ],
      ]);
      expect(limits.windows[0]?.usedPercent).toBe(37);
    }),
  );

  it.effect("does not send an API key to a custom endpoint", () =>
    Effect.gen(function* () {
      for (const [apiEndpoint, environment] of [
        ["http://localhost:3000", { CURSOR_API_KEY: "api-key" }],
        ["", { CURSOR_API_ENDPOINT: "http://localhost:3000", CURSOR_API_KEY: "api-key" }],
        ["", { CURSOR_API_ENDPOINT: "https://cursor-proxy.example", CURSOR_API_KEY: "api-key" }],
        ["https://cursor-proxy.example", { CURSOR_API_KEY: "api-key" }],
      ] as const) {
        const limits = yield* readCursorUsageLimits({ apiEndpoint }, environment).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("must not send an API key to a proxy")),
          ),
        );
        expect(limits.unavailable?.reason).toBe("unsupported");
        expect(limits.unavailable?.message).toContain("default Cursor endpoint");
      }
    }),
  );
});
