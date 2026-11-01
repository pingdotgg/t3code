import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as CursorKeychain from "./CursorKeychain.ts";
import { cursorUsageResponseToLimits, readCursorUsageLimits } from "./usageLimits.ts";

const withNodeServices = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | CursorKeychain.CursorKeychain>,
  accessToken: CursorKeychain.CursorKeychain["Service"]["accessToken"] = Effect.die(
    "must not read Keychain",
  ),
) =>
  effect.pipe(
    Effect.provideService(CursorKeychain.CursorKeychain, { accessToken }),
    Effect.provide(NodeServices.layer),
  );

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
        const limits = yield* withNodeServices(
          readCursorUsageLimits({ apiEndpoint: "" }, { CURSOR_AUTH_TOKEN: "token" }).pipe(
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

  it.effect("reads the instance's credentials and endpoint even when usage enabled is false", () =>
    withNodeServices(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        yield* fs.makeDirectory(path.join(directory, "cursor"));
        yield* fs.writeFileString(
          path.join(directory, "cursor", "auth.json"),
          '{"accessToken":"instance-token"}',
        );
        const client = HttpClient.make((request) => {
          expect(request.url).toBe(
            "https://cursor.example/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
          );
          expect(request.method).toBe("POST");
          expect(request.headers.authorization).toBe("Bearer instance-token");
          expect(request.headers["connect-protocol-version"]).toBe("1");
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ enabled: false, planUsage: { totalPercentUsed: 42 } }),
            ),
          );
        });
        yield* fs.makeDirectory(path.join(directory, ".cursor"));
        yield* fs.writeFileString(
          path.join(directory, ".cursor", "auth.json"),
          '{"accessToken":"instance-token"}',
        );
        for (const platform of ["linux", "darwin"] as const) {
          const limits = yield* readCursorUsageLimits(
            { apiEndpoint: "https://cursor.example/" },
            { XDG_CONFIG_HOME: directory, HOME: directory, AGENT_CLI_CREDENTIAL_STORE: "file" },
          ).pipe(
            Effect.provideService(HostProcess.Platform, platform),
            Effect.provideService(HttpClient.HttpClient, client),
          );
          expect(limits.windows[0]?.usedPercent).toBe(42);
        }
      }).pipe(Effect.scoped),
    ),
  );

  it.effect(
    "never reads stale files for keychain or memory logins, but accepts an explicit auth token",
    () =>
      Effect.gen(function* () {
        for (const platform of ["linux", "darwin"] as const) {
          for (const token of [undefined, "explicit-token"]) {
            const limits = yield* withNodeServices(
              readCursorUsageLimits(
                { apiEndpoint: "" },
                {
                  AGENT_CLI_CREDENTIAL_STORE: platform === "linux" ? "memory" : "default",
                  ...(token ? { CURSOR_AUTH_TOKEN: token } : {}),
                },
                false,
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
      const limits = yield* withNodeServices(
        readCursorUsageLimits({ apiEndpoint: "" }, { CURSOR_AUTH_TOKEN: "private-token" }).pipe(
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
        ),
      );
      expect(limits.unavailable).toEqual({
        reason: "probeFailed",
        message: "Cursor could not read usage limits.",
      });
    }),
  );

  it.effect("does not use a stored login for an explicit API key", () =>
    Effect.gen(function* () {
      const limits = yield* withNodeServices(
        readCursorUsageLimits({ apiEndpoint: "" }, { CURSOR_API_KEY: "different-account" }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("must not request usage")),
          ),
        ),
      );
      expect(limits.unavailable?.reason).toBe("unsupported");
    }),
  );

  it.effect("reads the default macOS Cursor login from Keychain for limits", () =>
    Effect.gen(function* () {
      const limits = yield* withNodeServices(
        readCursorUsageLimits({ apiEndpoint: "" }, {}, true).pipe(
          Effect.provideService(HostProcess.Platform, "darwin"),
          Effect.provideService(
            FileSystem.FileSystem,
            FileSystem.makeNoop({
              readFileString: () => Effect.die("must not read a stale credential file"),
            }),
          ),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              expect(request.headers.authorization).toBe("Bearer keychain-token");
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json({ planUsage: { totalPercentUsed: 42 } }),
                ),
              );
            }),
          ),
        ),
        Effect.succeed("keychain-token"),
      );
      expect(limits.windows[0]?.usedPercent).toBe(42);
    }),
  );

  it.effect("reports a Keychain initialization failure without failing the provider refresh", () =>
    Effect.gen(function* () {
      const limits = yield* withNodeServices(
        readCursorUsageLimits({ apiEndpoint: "" }, {}, true).pipe(
          Effect.provideService(HostProcess.Platform, "darwin"),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("must not request limits without a login")),
          ),
        ),
        Effect.fail(
          new CursorKeychain.CursorKeychainReadError({
            cause: new Error("Keychain initialization failed"),
          }),
        ),
      );
      expect(limits.unavailable?.reason).toBe("probeFailed");
    }),
  );

  it.effect("does not read Keychain or send its token to a custom endpoint", () =>
    Effect.gen(function* () {
      for (const [apiEndpoint, environment] of [
        ["http://localhost:3000", {}],
        ["", { CURSOR_API_ENDPOINT: "http://localhost:3000" }],
        ["https://cursor-proxy.example", {}],
        ["", { CURSOR_API_ENDPOINT: "https://cursor-proxy.example" }],
      ] as const) {
        const limits = yield* withNodeServices(
          readCursorUsageLimits({ apiEndpoint }, environment, true).pipe(
            Effect.provideService(HostProcess.Platform, "darwin"),
            Effect.provideService(
              HttpClient.HttpClient,
              HttpClient.make(() => Effect.die("must not send a Keychain credential to a proxy")),
            ),
          ),
        );
        expect(limits.unavailable?.reason).toBe("unsupported");
        expect(limits.unavailable?.message).toContain("default Cursor endpoint");
      }
    }),
  );
});
