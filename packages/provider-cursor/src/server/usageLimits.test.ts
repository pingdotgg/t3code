import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { cursorUsageResponseToLimits, readCursorUsageLimits } from "./usageLimits.ts";

describe("Cursor usage limits", () => {
  const checkedAt = "2026-09-16T00:00:00.000Z";

  it("uses the advertised percentages and billing-cycle reset", () => {
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
  });

  it("does not invent unused allowance for absent buckets", () => {
    expect(cursorUsageResponseToLimits({ planUsage: {} }, checkedAt).unavailable?.reason).toBe(
      "unsupported",
    );
    expect(
      cursorUsageResponseToLimits({ planUsage: { totalPercentUsed: 0 } }, checkedAt).windows,
    ).toEqual([{ id: "totalPercentUsed", kind: "monthly", label: "Overall", usedPercent: 0 }]);
    expect(
      cursorUsageResponseToLimits({ planUsage: { totalPercentUsed: 150 } }, checkedAt).windows,
    ).toEqual([{ id: "totalPercentUsed", kind: "monthly", label: "Overall", usedPercent: 100 }]);
  });

  it.effect("ignores CLI logins and accepts an explicit auth token", () =>
    Effect.gen(function* () {
      for (const platform of ["linux", "darwin"] as const) {
        for (const token of [undefined, "explicit-token"]) {
          const limits = yield* readCursorUsageLimits(
            { apiEndpoint: "" },
            {
              AGENT_CLI_CREDENTIAL_STORE: platform === "linux" ? "memory" : "default",
              ...(token ? { CURSOR_AUTH_TOKEN: token } : {}),
            },
          ).pipe(
            Effect.provideService(HostProcess.Platform, platform),
            Effect.provideService(
              FileSystem.FileSystem,
              FileSystem.makeNoop({
                readFileString: () => Effect.die("must not read an unrelated credential file"),
              }),
            ),
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

  it.effect("reads an API key's own account instead of a stored login", () =>
    Effect.gen(function* () {
      for (const platform of ["linux", "darwin"] as const) {
        const requests: Array<readonly [string, string | undefined]> = [];
        const limits = yield* readCursorUsageLimits(
          { apiEndpoint: "" },
          { CURSOR_API_KEY: "api-key" },
        ).pipe(
          Effect.provideService(HostProcess.Platform, platform),
          Effect.provideService(
            FileSystem.FileSystem,
            FileSystem.makeNoop({
              readFileString: () => Effect.die("must not read a stored login"),
            }),
          ),
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
      }
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
          Effect.provideService(HostProcess.Platform, "darwin"),
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
