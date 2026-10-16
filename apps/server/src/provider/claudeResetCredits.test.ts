import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
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
      expect(credits).toEqual({ availableCount: 1, nextCreditId: "grant_a" });
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
        // Claude answered, so a retry must be a new claim.
        if (result._tag === "Failure") {
          expect(ClaudeResetCredits.isSettledClaudeResetCreditFailure(result.failure)).toBe(true);
        }
      }
      // No answer, or Claude could not confirm the claim: a retry is the same claim.
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

  it.effect("times out a stalled claim body", () =>
    Effect.gen(function* () {
      const login = yield* writeLogin;
      const readingBody = yield* Deferred.make<void>();
      const client = HttpClient.make((request) => {
        const response = HttpClientResponse.fromWeb(request, Response.json({ result: "reset" }));
        Object.defineProperty(response, "json", {
          value: Deferred.succeed(readingBody, undefined).pipe(Effect.andThen(Effect.never)),
        });
        return Effect.succeed(response);
      });
      const claim = yield* ClaudeResetCredits.consumeClaudeResetCredit({
        ...login,
        version: "2.1.0",
        grantId: "grant_a",
        requestId: "r-1",
      }).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.result,
        Effect.forkChild,
      );
      yield* Deferred.await(readingBody);
      yield* TestClock.adjust("26 seconds");
      expect(yield* Fiber.join(claim)).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "ClaudeResetCreditError",
          reason: "requestFailed",
          cause: { _tag: "TimeoutError" },
        },
      });
    }).pipe(Effect.provide(TestClock.layer())),
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

describe("reading the banked resets at most once per interval", () => {
  it("is due when never asked or when the last request is old enough", () => {
    expect(ClaudeResetCredits.resetCreditsReadDue(null, 1_000)).toBe(true);
    expect(
      ClaudeResetCredits.resetCreditsReadDue(
        1_000,
        1_000 + ClaudeResetCredits.RESET_CREDITS_READ_INTERVAL_MS - 1,
      ),
    ).toBe(false);
    expect(
      ClaudeResetCredits.resetCreditsReadDue(
        1_000,
        1_000 + ClaudeResetCredits.RESET_CREDITS_READ_INTERVAL_MS,
      ),
    ).toBe(true);
  });

  it("waits twice as long after each refused request, at most an hour", () => {
    const interval = ClaudeResetCredits.RESET_CREDITS_READ_INTERVAL_MS;
    expect(ClaudeResetCredits.resetCreditsReadDue(0, interval, 1)).toBe(false);
    expect(ClaudeResetCredits.resetCreditsReadDue(0, 2 * interval, 1)).toBe(true);
    expect(ClaudeResetCredits.resetCreditsReadDue(0, 4 * interval - 1, 2)).toBe(false);
    expect(
      ClaudeResetCredits.resetCreditsReadDue(
        0,
        ClaudeResetCredits.RESET_CREDITS_READ_MAX_INTERVAL_MS,
        9,
      ),
    ).toBe(true);
  });

  // `refused` stands for a failed request; any other entry is an answer.
  const answering = (answers: ReadonlyArray<number | undefined | "refused">) => {
    let calls = 0;
    const read = () =>
      Effect.suspend(() => {
        const answer = answers[calls++];
        return answer === "refused" ? Effect.fail("refused" as const) : Effect.succeed(answer);
      });
    return { read, calls: () => calls };
  };

  effectIt.effect("a successful answer without resets replaces the count and the wait", () =>
    Effect.gen(function* () {
      const source = answering([3, "refused", undefined, 4]);
      const reader = yield* ClaudeResetCredits.makeThrottledResetCreditsReader(source.read);
      expect(yield* reader.read("1.0.0")).toBe(3);
      yield* TestClock.adjust(ClaudeResetCredits.RESET_CREDITS_READ_INTERVAL_MS);
      expect(yield* reader.read("1.0.0")).toBe(3);
      yield* TestClock.adjust(2 * ClaudeResetCredits.RESET_CREDITS_READ_INTERVAL_MS);
      // The account answered that it has no resets: the old count goes.
      expect(yield* reader.read("1.0.0")).toBeUndefined();
      yield* TestClock.adjust(ClaudeResetCredits.RESET_CREDITS_READ_INTERVAL_MS);
      expect(yield* reader.read("1.0.0")).toBe(4);
      expect(source.calls()).toBe(4);
    }),
  );

  effectIt.effect(
    "a read still running when the count is forgotten does not store its answer",
    () =>
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>();
        const started = yield* Deferred.make<void>();
        let calls = 0;
        const reader = yield* ClaudeResetCredits.makeThrottledResetCreditsReader(() =>
          Effect.gen(function* () {
            calls += 1;
            if (calls === 1) {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return 3;
            }
            return 1;
          }),
        );
        const inFlight = yield* Effect.forkChild(reader.read("1.0.0"));
        yield* Deferred.await(started);
        yield* reader.forget;
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(inFlight)).toBeUndefined();
        // Nothing was stored, so the next read asks at once.
        expect(yield* reader.read("1.0.0")).toBe(1);
        expect(calls).toBe(2);
      }),
  );

  effectIt.effect("two reads at once send one request", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      let calls = 0;
      const reader = yield* ClaudeResetCredits.makeThrottledResetCreditsReader(() =>
        Effect.gen(function* () {
          calls += 1;
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          return 2;
        }),
      );
      const first = yield* Effect.forkChild(reader.read("1.0.0"));
      yield* Deferred.await(started);
      const second = yield* Effect.forkChild(reader.read("1.0.0"));
      // Let the second read get as far as it can before the first one answers.
      for (let i = 0; i < 5; i += 1) yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(first)).toBe(2);
      expect(yield* Fiber.join(second)).toBe(2);
      expect(calls).toBe(1);
    }),
  );

  effectIt.effect("asks once, keeps the answer, and keeps it through a refused request", () =>
    Effect.gen(function* () {
      const source = answering([3, "refused", 5, 6]);
      const reader = yield* ClaudeResetCredits.makeThrottledResetCreditsReader(source.read);
      expect(yield* reader.read("1.0.0")).toBe(3);
      expect(yield* reader.read("1.0.0")).toBe(3);
      expect(source.calls()).toBe(1);
      yield* TestClock.adjust(ClaudeResetCredits.RESET_CREDITS_READ_INTERVAL_MS);
      // Refused this time: the last known count stays, and the next request waits twice as long.
      expect(yield* reader.read("1.0.0")).toBe(3);
      expect(source.calls()).toBe(2);
      yield* TestClock.adjust(ClaudeResetCredits.RESET_CREDITS_READ_INTERVAL_MS);
      expect(yield* reader.read("1.0.0")).toBe(3);
      expect(source.calls()).toBe(2);
      yield* TestClock.adjust(ClaudeResetCredits.RESET_CREDITS_READ_INTERVAL_MS);
      expect(yield* reader.read("1.0.0")).toBe(5);
      // A redeem forgets the count, so the next read asks at once.
      yield* reader.forget;
      yield* reader.read("1.0.0");
      expect(source.calls()).toBe(4);
    }),
  );
});
