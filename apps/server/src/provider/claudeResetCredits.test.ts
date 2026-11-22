import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
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

const FULL = {
  label: "Full reset",
  description: "Refills your 5-hour and weekly limits.",
} as const;

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
        {
          creditId: "grant_a",
          ...FULL,
          availableCount: 2,
          expiresAt: "2026-10-01T00:00:00.000Z",
        },
      ],
      bankedOptions: [
        {
          creditId: "grant_a",
          ...FULL,
          availableCount: 5,
          expiresAt: "2026-10-01T00:00:00.000Z",
        },
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
            clears: ["seven_day_overage_included"],
            gives_back_weekly: true,
            ends_at: "2027-03-09T07:59:00Z",
          }),
          grant({ id: "fable_b", gives_back_weekly: true, type: "weekly" }),
          grant({ id: "session_a", type: "session" }),
          grant({ id: "spent", clears: ["seven_day"], resets_left: 0 }),
        ],
      },
      NOW,
    );
    const rows = [
      ["session_a", "5-hour reset", 1],
      ["weekly_a", "Weekly reset", 1],
      ["fable_a", "Fable reset", 2],
    ];
    for (const options of [credits?.options, credits?.bankedOptions]) {
      expect(
        options?.map(({ creditId, label, availableCount }) => [creditId, label, availableCount]),
      ).toEqual(rows);
    }
    expect(credits).toMatchObject({ availableCount: 4, nextCreditId: "weekly_a" });
  });

  it.each([
    [{}, {}, "Usable once you reach a limit it refills"],
    [{ use_requires_limit: false }, {}, "Can't be used right now"],
    [{}, { cooldown_until: "2026-09-22T12:01:00Z" }, "Try again in a minute"],
    [{}, { cooldown_until: "2026-09-22T11:59:00Z" }, "Usable once you reach a limit it refills"],
    [{ blocking: ["five_hour"] }, {}, "Can't be used while you're at your 5-hour limit"],
    [
      { blocking: ["seven_day"], gives_back_weekly: true },
      {},
      "No Fable usage this week to give back",
    ],
    [
      { blocking: ["seven_day_cowork"] },
      {},
      "Can't be used while you're at a limit it doesn't refill",
    ],
    [
      { clears: ["five_hour"] },
      { at_limit: true, exhausted: ["seven_day"] },
      "Doesn't refill the limit you've reached",
    ],
    [{ unavailable_reason: "cooldown", blocking: ["five_hour"] }, {}, "Try again in a minute"],
    [
      { unavailable_reason: "blocked_seven_day", gives_back_weekly: true },
      {},
      "No Fable usage this week to give back",
    ],
  ])(
    "lists a banked reset that can't be used yet with why, and leaves it out of the older fields: %j %j",
    (overrides, status, why) => {
      const credits = ClaudeResetCredits.claudeResetCreditsToContract(
        {
          eligible: true,
          next_grant_id: "grant_a",
          grants: [grant({ usable_now: false, ...overrides })],
          ...status,
        },
        NOW,
      );
      expect(credits).toEqual({
        availableCount: 0,
        bankedOptions: [expect.objectContaining({ creditId: "grant_a", unavailableReason: why })],
      });
    },
  );

  it("keeps the older fields empty when Claude's next grant is waiting beside a usable one", () => {
    const credits = ClaudeResetCredits.claudeResetCreditsToContract(
      {
        eligible: true,
        next_grant_id: "full_a",
        grants: [
          grant({ id: "full_a", type: "full", usable_now: false }),
          grant({ id: "fable_wait", gives_back_weekly: true, usable_now: false }),
          grant({ id: "fable_a", gives_back_weekly: true }),
        ],
      },
      NOW,
    );
    expect(credits).toEqual({ availableCount: 0, bankedOptions: expect.any(Array) });
    expect(
      credits?.bankedOptions?.map(({ creditId, availableCount, unavailableReason }) => [
        creditId,
        availableCount,
        unavailableReason,
      ]),
    ).toEqual([
      ["fable_a", 2, undefined],
      ["full_a", 1, "Usable once you reach a limit it refills"],
    ]);
  });

  it("keeps older clients' usable-only options when a waiting kind sits beside the next grant", () => {
    const credits = ClaudeResetCredits.claudeResetCreditsToContract(
      {
        eligible: true,
        next_grant_id: "fable_a",
        grants: [
          grant({ id: "full_a", type: "full", usable_now: false }),
          grant({ id: "fable_a", gives_back_weekly: true }),
        ],
      },
      NOW,
    );
    expect(credits).toMatchObject({ availableCount: 1, nextCreditId: "fable_a" });
    expect(credits?.options?.map((option) => option.creditId)).toEqual(["fable_a"]);
    expect(
      credits?.bankedOptions?.map(({ creditId, unavailableReason }) => [
        creditId,
        unavailableReason,
      ]),
    ).toEqual([
      ["fable_a", undefined],
      ["full_a", "Usable once you reach a limit it refills"],
    ]);
  });

  it("claims an eligible reset by id, even when Claude's next grant is waiting, and never a waiting one", () => {
    const waitingNext = ClaudeResetCredits.claudeResetCreditsToContract(
      {
        eligible: true,
        next_grant_id: "full_a",
        grants: [
          grant({ id: "full_a", type: "full", usable_now: false }),
          grant({ id: "fable_a", gives_back_weekly: true }),
        ],
      },
      NOW,
    );
    expect(
      [undefined, "fable_a", "full_a", "gone"].map((creditId) =>
        ClaudeResetCredits.claudeRedeemTarget(waitingNext, creditId),
      ),
    ).toEqual([
      { outcome: "noCredit" },
      { grantId: "fable_a" },
      { outcome: "nothingToReset" },
      { outcome: "noCredit" },
    ]);
    const usableNext = ClaudeResetCredits.claudeResetCreditsToContract(
      {
        eligible: true,
        next_grant_id: "fable_a",
        grants: [
          grant({ id: "full_a", type: "full", usable_now: false }),
          grant({ id: "fable_a", gives_back_weekly: true }),
        ],
      },
      NOW,
    );
    expect(
      [undefined, "fable_a", "full_a"].map((creditId) =>
        ClaudeResetCredits.claudeRedeemTarget(usableNext, creditId),
      ),
    ).toEqual([{ grantId: "fable_a" }, { grantId: "fable_a" }, { outcome: "nothingToReset" }]);
  });

  it("claims by an older server's options when there is no banked list", () => {
    const olderServer = {
      availableCount: 1,
      nextCreditId: "fable_a",
      options: [{ creditId: "fable_a", ...FULL, availableCount: 1 }],
    };
    expect(ClaudeResetCredits.claudeRedeemTarget(olderServer, "fable_a")).toEqual({
      grantId: "fable_a",
    });
    expect(ClaudeResetCredits.claudeRedeemTarget({ availableCount: 1 }, undefined)).toEqual({
      outcome: "noCredit",
    });
  });

  it("offers nothing to redeem without an eligible account", () => {
    expect(
      ClaudeResetCredits.claudeResetCreditsToContract(
        { eligible: false, grants: [grant({})] },
        NOW,
      ),
    ).toBeUndefined();
    expect(ClaudeResetCredits.claudeResetCreditsToContract(undefined, NOW)).toBeUndefined();
  });
});

effectIt.layer(NodeServices.layer)("readClaudeResetCredits", (it) => {
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
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              cedar_ember: { eligible: true, next_grant_id: "grant_a", grants: [grant({})] },
            }),
          ),
        );
      });
      const credits = yield* ClaudeResetCredits.readClaudeResetCredits(configDir, "2.1.0").pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HttpClient.HttpClient, client),
      );
      expect(credits).toMatchObject({ availableCount: 1, nextCreditId: "grant_a" });
    }),
  );

  it.effect("reads nothing from keychain logins or failed requests", () =>
    Effect.gen(function* () {
      const { configDir } = yield* writeLogin;
      const darwin = yield* ClaudeResetCredits.readClaudeResetCredits(configDir, "2.1.0").pipe(
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(HttpClient.HttpClient, refuseRequests),
      );
      const limited = yield* ClaudeResetCredits.readClaudeResetCredits(configDir, "2.1.0").pipe(
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
