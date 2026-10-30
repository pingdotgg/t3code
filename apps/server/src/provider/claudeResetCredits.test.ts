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
import * as ResetCreditCoordinator from "./resetCreditCoordinator.ts";

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
    });
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

effectIt.layer(NodeServices.layer)("fetchClaudeResetCredits", (it) => {
  it.effect("reads the grants with the CLI's request", () =>
    Effect.gen(function* () {
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
      const block = yield* ClaudeResetCredits.fetchClaudeResetCredits("oauth-token", "2.1.0").pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      expect(ClaudeResetCredits.claudeResetCreditsToContract(block, NOW)).toEqual({
        availableCount: 1,
        nextCreditId: "grant_a",
      });
    }),
  );

  it.effect("skips keychain logins and reports failed requests", () =>
    Effect.gen(function* () {
      const login = yield* writeLogin;
      const darwin = yield* ClaudeResetCredits.readClaudeResetCreditAccount(
        login.configDir,
        login.accountConfigPath,
      ).pipe(
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(HttpClient.HttpClient, refuseRequests),
      );
      const limited = yield* ClaudeResetCredits.fetchClaudeResetCredits(
        "oauth-token",
        "2.1.0",
      ).pipe(Effect.provideService(HttpClient.HttpClient, respond(429, {})), Effect.result);
      expect(darwin).toBeUndefined();
      expect(limited).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ClaudeResetCreditReadError" },
      });
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
      for (const client of [respond(200, { result: "cooldown" }), respond(429, {})]) {
        const result = yield* consume(client);
        expect(result).toMatchObject({ _tag: "Failure" });
        if (result._tag === "Failure") {
          expect(ClaudeResetCredits.isSettledClaudeResetCreditFailure(result.failure)).toBe(true);
        }
      }
      for (const client of [
        respond(401, {}),
        respond(500, {}),
        respond(200, { result: "unavailable" }),
      ]) {
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

  it.effect("keeps an unconfirmed claim when account validation prevents a retry", () =>
    Effect.gen(function* () {
      const coordinator = yield* ResetCreditCoordinator.ResetCreditCoordinator;
      const login = yield* writeLogin;
      const requests: Array<string> = [];
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
          );
          return HttpClientResponse.fromWeb(request, Response.json({ result: "unavailable" }));
        }),
      );
      yield* coordinator.readClaudeCredits(
        "account-a",
        Effect.succeedSome({
          eligible: true,
          next_grant_id: "grant_a",
          grants: [grant({})],
        }),
      );
      const claim = (expectedAccountKey?: string) =>
        coordinator
          .redeemClaudeCredit(
            "account-a",
            (grantId, requestId) =>
              ClaudeResetCredits.consumeClaudeResetCredit({
                ...login,
                version: "2.1.0",
                grantId,
                requestId,
                ...(expectedAccountKey === undefined ? {} : { expectedAccountKey }),
              }),
            ClaudeResetCredits.isSettledClaudeResetCreditFailure,
          )
          .pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.result);
      expect((yield* claim())._tag).toBe("Failure");
      expect((yield* claim("different-account"))._tag).toBe("Failure");
      expect(requests).toHaveLength(1);
      expect((yield* claim())._tag).toBe("Failure");
      expect(requests).toHaveLength(2);
      expect(requests[1]).toBe(requests[0]);
    }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provide(ResetCreditCoordinator.layerTest),
    ),
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
