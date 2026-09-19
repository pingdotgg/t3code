import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { cursorUsageResponseToLimits, readCursorUsageLimits } from "./cursorUsageLimits.ts";

const withNodeServices = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
  effect.pipe(Effect.provide(NodeServices.layer));

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
          label: "Monthly",
          usedPercent: 72.4,
          resetsAt: "2026-09-20T03:53:06.000Z",
        },
        {
          id: "autoPercentUsed",
          kind: "monthly",
          label: "Monthly · Auto",
          usedPercent: 69.5,
          resetsAt: "2026-09-20T03:53:06.000Z",
        },
        {
          id: "apiPercentUsed",
          kind: "monthly",
          label: "Monthly · API",
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
    ).toEqual([{ id: "totalPercentUsed", kind: "monthly", label: "Monthly", usedPercent: 0 }]);
    expect(
      cursorUsageResponseToLimits({ planUsage: { totalPercentUsed: 150 } }, checkedAt).windows,
    ).toEqual([{ id: "totalPercentUsed", kind: "monthly", label: "Monthly", usedPercent: 100 }]);
  });

  it.effect("reads the instance's credentials and endpoint even when usage enabled is false", () =>
    Effect.gen(function* () {
      yield* withNodeServices(
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
              Effect.provideService(HostProcessPlatform, platform),
              Effect.provideService(HttpClient.HttpClient, client),
            );
            expect(limits.windows[0]?.usedPercent).toBe(42);
          }
        }).pipe(Effect.scoped),
      );
    }),
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
              ).pipe(
                Effect.provideService(HostProcessPlatform, platform),
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
});
