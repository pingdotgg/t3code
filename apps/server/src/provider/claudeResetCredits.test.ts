import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse, UrlParams } from "effect/http";
import { describe, expect, it } from "vite-plus/test";

import * as ClaudeResetCredits from "./claudeResetCredits.ts";

const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const grant = (overrides: Record<string, unknown>) => ({
  id: "grant_a",
  resets_left: 1,
  usable_now: true,
  ...overrides,
});

const writeLogin = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped();
  yield* fs.writeFileString(
    path.join(directory, ".credentials.json"),
    '{"claudeAiOauth":{"accessToken":"oauth-token"}}',
  );
  const accountConfigPath = path.join(directory, ".claude.json");
  yield* fs.writeFileString(accountConfigPath, '{"oauthAccount":{"organizationUuid":"org-1"}}');
  return { configDir: directory, accountConfigPath };
});

const respond = (status: number, body: unknown) =>
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status }))),
  );
const refuseRequests = HttpClient.make(() => Effect.die("must not send a request"));
const usageBody = {
  cedar_ember: {
    eligible: true,
    next_grant_id: "grant_a",
    grants: [
      grant({}),
      grant({ id: "fable_a", clears: ["seven_day_overage_included"], gives_back_weekly: true }),
      grant({ id: "model_weekly", clears: ["seven_day_overage_included"] }),
    ],
  },
  limits: [
    { kind: "session", percent: 20, scope: null },
    { kind: "weekly_all", percent: 38, scope: null },
    { kind: "weekly_scoped", percent: 16, scope: { model: { id: null, display_name: "Fable" } } },
  ],
  weekly_scoped_shares: [
    { limit_index: 2, used_percent_of_weekly: 8, allowance_percent_of_weekly: 50 },
    { limit_index: 1, used_percent_of_weekly: 38, allowance_percent_of_weekly: 100 },
    { limit_index: 9, used_percent_of_weekly: 1, allowance_percent_of_weekly: 10 },
  ],
};
const fableShare = { ofWindowId: "seven_day", usedPercent: 8, allowancePercent: 50 };

describe("claudeResetCreditsToContract", () => {
  it("counts live grants and pins the next usable one", () => {
    expect(
      ClaudeResetCredits.claudeResetCreditsToContract(
        {
          eligible: true,
          next_grant_id: "grant_a",
          grants: [
            grant({ resets_left: 2, ends_at: "2026-10-01T00:00:00Z" }),
            grant({ id: "paused", paused: true }),
            grant({ id: "expired", ends_at: "2026-09-01T00:00:00Z" }),
            grant({ id: "garbled", ends_at: "not a date" }),
            grant({ id: "date_only", ends_at: "2026-10-01" }),
            grant({ id: "impossible", ends_at: "2027-02-30T00:00:00Z" }),
            grant({ id: "empty", ends_at: "" }),
            grant({ id: "Not Valid" }),
            grant({ id: "grant_b", resets_left: 3, usable_now: false }),
          ],
        },
        NOW,
      ),
    ).toEqual({
      availableCount: 2,
      nextCreditId: "grant_a",
      nextExpiresAt: "2026-10-01T00:00:00.000Z",
      options: [
        expect.objectContaining({
          creditId: "grant_a",
          label: "Full reset",
          availableCount: 2,
          expiresAt: "2026-10-01T00:00:00.000Z",
        }),
      ],
    });
  });

  it("offers each kind of reset by its own grant", () => {
    const credits = ClaudeResetCredits.claudeResetCreditsToContract(
      {
        eligible: true,
        next_grant_id: "weekly_a",
        grants: [
          grant({ id: "weekly_a", clears: ["seven_day"], ends_at: "2026-12-10T22:00:00Z" }),
          grant({
            id: "fable_a",
            clears: ["five_hour", "seven_day_overage_included"],
            gives_back_weekly: true,
            ends_at: "2027-03-09T07:59:00Z",
          }),
          grant({
            id: "fable_b",
            clears: ["seven_day_overage_included"],
            gives_back_weekly: true,
            type: "weekly",
          }),
          grant({ id: "session_a", type: "session" }),
          grant({
            id: "full_a",
            type: "full",
            clears: ["seven_day", "seven_day_overage_included", ""],
          }),
          grant({ id: "spent", clears: ["seven_day"], resets_left: 0 }),
          grant({ id: "weekly_b", clears: ["seven_day"], resets_left: 2 }),
          grant({ id: "model_weekly", clears: ["seven_day_overage_included"] }),
        ],
      },
      NOW,
      "Fable",
    );
    expect(
      credits?.options?.map(({ creditId, label, availableCount, clearsWindowIds, scope }) => [
        creditId,
        label,
        availableCount,
        clearsWindowIds,
        scope,
      ]),
    ).toEqual([
      ["session_a", "5-hour reset", 1, ["five_hour"], undefined],
      ["weekly_a", "Weekly reset", 3, ["seven_day"], undefined],
      ["model_weekly", "Fable weekly reset", 1, ["seven_day_fable"], "Fable"],
      ["fable_a", "Fable reset", 2, ["seven_day_fable"], "Fable"],
      ["full_a", "Full reset", 1, ["seven_day"], undefined],
    ]);
    expect(credits?.options?.find((option) => option.creditId === "model_weekly")).toMatchObject({
      description: "Refills your Fable weekly allowance.",
    });
    expect(credits).toMatchObject({ availableCount: 8, nextCreditId: "weekly_a" });
  });

  it("offers nothing to redeem without a usable next grant or an eligible account", () => {
    expect(
      ClaudeResetCredits.claudeResetCreditsToContract(
        { eligible: true, next_grant_id: "grant_a", grants: [grant({ usable_now: false })] },
        NOW,
      ),
    ).toEqual({ availableCount: 0 });
    expect(
      ClaudeResetCredits.claudeResetCreditsToContract({ eligible: true, grants: [grant({})] }, NOW),
    ).toEqual({
      availableCount: 0,
    });
    expect(
      ClaudeResetCredits.claudeResetCreditsToContract(
        { eligible: false, grants: [grant({})] },
        NOW,
      ),
    ).toBeUndefined();
    expect(ClaudeResetCredits.claudeResetCreditsToContract(undefined, NOW)).toBeUndefined();
  });
});

effectIt.layer(NodeServices.layer)("readClaudeAccountUsage", (it) => {
  it.effect("reads the grants with the CLI's request", () =>
    Effect.gen(function* () {
      const { configDir } = yield* writeLogin;
      const client = HttpClient.make((request) => {
        expect(request.method).toBe("GET");
        expect(request.url).toBe("https://api.anthropic.com/api/oauth/usage");
        expect(UrlParams.toString(request.urlParams)).toBe("cedar_ember=1&skip_spend=1");
        expect(request.headers.authorization).toBe("Bearer oauth-token");
        expect(request.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
        expect(request.headers["user-agent"]).toBe("claude-cli/2.1.0 (external, cli)");
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(usageBody)));
      });
      const usage = yield* ClaudeResetCredits.readClaudeAccountUsage(
        configDir,
        "2.1.0",
        "Fable",
      ).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HttpClient.HttpClient, client),
      );
      expect(usage?.resetCredits).toMatchObject({ nextCreditId: "grant_a" });
      expect([...(usage?.sharesByWindowId ?? [])]).toEqual([["seven_day_fable", fableShare]]);
      expect(usage?.resetCredits?.options?.map((option) => option.description)).toEqual([
        "Refills your Fable weekly allowance.",
        "Refills your Fable allowance and gives back the 8% of your weekly limit Fable used. It doesn't reset the rest of your weekly limit.",
        "Refills your 5-hour and weekly limits.",
      ]);
    }),
  );

  it.effect("serves a recent read from disk until it is forgotten or expires", () =>
    Effect.gen(function* () {
      const { configDir } = yield* writeLogin;
      const cacheFile = ClaudeResetCredits.claudeResetCreditsCacheFile(
        yield* Path.Path,
        configDir,
        configDir,
      );
      let requests = 0;
      let body: unknown = usageBody;
      const client = HttpClient.make((request) => {
        requests += 1;
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body)));
      });
      const read = (version = "2.1.0") =>
        ClaudeResetCredits.readClaudeAccountUsage(configDir, version, undefined, cacheFile).pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HttpClient.HttpClient, client),
        );
      yield* read();
      const cached = yield* read();
      expect(cached?.resetCredits).toMatchObject({ nextCreditId: "grant_a" });
      expect(cached?.sharesByWindowId.get("seven_day_fable")).toEqual(fableShare);
      expect(requests).toBe(1);
      yield* read("2.2.0");
      yield* read("2.2.0");
      expect(requests).toBe(2);
      yield* ClaudeResetCredits.forgetClaudeResetCredits(cacheFile);
      yield* read("2.2.0");
      expect(requests).toBe(3);
      yield* TestClock.adjust("2 minutes");
      yield* read("2.2.0");
      expect(requests).toBe(4);
      body = {};
      yield* TestClock.adjust("2 minutes");
      yield* read("2.2.0");
      yield* read("2.2.0");
      expect(requests).toBe(5);
    }),
  );

  it.effect("reads nothing from keychain logins or failed requests", () =>
    Effect.gen(function* () {
      const { configDir } = yield* writeLogin;
      const darwin = yield* ClaudeResetCredits.readClaudeAccountUsage(configDir, "2.1.0").pipe(
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(HttpClient.HttpClient, refuseRequests),
      );
      const limited = yield* ClaudeResetCredits.readClaudeAccountUsage(configDir, "2.1.0").pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HttpClient.HttpClient, respond(429, {})),
      );
      expect([darwin, limited]).toEqual([undefined, undefined]);
    }),
  );
});

const ClaimBody = Schema.fromJsonString(
  Schema.Struct({ program: Schema.String, grant_id: Schema.String, request_id: Schema.String }),
);
const decodeClaimBody = Schema.decodeEffect(ClaimBody);

const consume = (client: HttpClient.HttpClient, ids = { grantId: "grant_a", requestId: "r-1" }) =>
  Effect.gen(function* () {
    const login = yield* writeLogin;
    return yield* ClaudeResetCredits.consumeClaudeResetCredit({
      ...login,
      version: "2.1.0",
      ...ids,
    }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.result,
    );
  });

effectIt.layer(NodeServices.layer)("consumeClaudeResetCredit", (it) => {
  it.effect("claims the grant for the organization", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          expect(request.method).toBe("POST");
          expect(request.url).toBe(
            "https://api.anthropic.com/api/organizations/org-1/reset_rate_limits",
          );
          expect(request.headers.authorization).toBe("Bearer oauth-token");
          const body =
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
          expect(yield* decodeClaimBody(body)).toEqual({
            program: "cedar_ember",
            grant_id: "grant_a",
            request_id: "r-1",
          });
          return HttpClientResponse.fromWeb(request, Response.json({ result: "reset" }));
        }).pipe(Effect.orDie),
      );
      expect(yield* consume(client)).toMatchObject({ _tag: "Success", success: "reset" });
    }),
  );

  it.effect("maps each answer to an outcome or a failure", () =>
    Effect.gen(function* () {
      for (const [result, outcome] of [
        ["not_limited", "nothingToReset"],
        ["already_used", "alreadyRedeemed"],
        ["ineligible", "noCredit"],
      ] as const) {
        expect(yield* consume(respond(200, { result }))).toMatchObject({ success: outcome });
      }
      for (const client of [
        respond(200, { result: "cooldown" }),
        respond(429, {}),
        respond(401, {}),
      ]) {
        const result = yield* consume(client);
        expect(result).toMatchObject({ _tag: "Failure" });
        if (result._tag === "Failure") {
          expect(ClaudeResetCredits.isSettledClaudeResetCreditFailure(result.failure)).toBe(true);
        }
      }
      for (const client of [respond(500, {}), respond(200, { result: "unavailable" })]) {
        const unanswered = yield* consume(client);
        expect(unanswered).toMatchObject({ _tag: "Failure" });
        if (unanswered._tag === "Failure") {
          expect(ClaudeResetCredits.isSettledClaudeResetCreditFailure(unanswered.failure)).toBe(
            false,
          );
        }
      }
    }),
  );

  it.effect("refuses malformed ids without sending anything", () =>
    Effect.gen(function* () {
      for (const ids of [
        { grantId: "Bad Grant", requestId: "r-1" },
        { grantId: "grant_a", requestId: "has space" },
      ]) {
        expect(yield* consume(refuseRequests, ids)).toMatchObject({ _tag: "Failure" });
      }
    }),
  );
});
