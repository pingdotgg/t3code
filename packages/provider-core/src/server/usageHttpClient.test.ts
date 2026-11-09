import { assert, it, vi } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import {
  makeUsageHttpClient,
  usageResponseCheckedAt,
  usageReadRefreshAfter,
  UsageAccountIdentity,
} from "./usageHttpClient.ts";

const url = "https://api.anthropic.com/api/oauth/usage";
const request = (account: string, suffix = "") =>
  HttpClientRequest.get(url + suffix).pipe(HttpClientRequest.bearerToken(account));

it.effect(
  "deduplicates concurrent surfaces and windows, isolates accounts, and caches failed reads",
  () =>
    Effect.gen(function* () {
      using expiredReads = vi.spyOn(Map.prototype, "delete");
      let calls = 0;
      const client = yield* makeUsageHttpClient(
        HttpClient.make((input) =>
          Effect.sync(() => {
            calls++;
            return HttpClientResponse.fromWeb(input, Response.json({ calls }, { status: 503 }));
          }),
        ),
      );
      const responses = yield* Effect.all(
        [client.execute(request("a")), client.execute(request("a"))],
        { concurrency: "unbounded" },
      );
      assert.strictEqual(calls, 1);
      assert.deepStrictEqual(yield* responses[0]!.json, yield* responses[1]!.json);
      yield* client.execute(request("b"));
      assert.strictEqual(calls, 2);
      const sampleAt = DateTime.formatIso(yield* DateTime.now);
      yield* TestClock.adjust("4 minutes");
      const cached = yield* client.execute(request("a"));
      assert.strictEqual(usageResponseCheckedAt(cached, "missing"), sampleAt);
      assert.strictEqual(calls, 2);
      yield* TestClock.adjust("1 minute");
      yield* client.execute(request("renewed-token"));
      assert.strictEqual(calls, 3);
      assert.isTrue(
        expiredReads.mock.calls.some(
          ([key]) =>
            typeof key === "string" && key.includes("Bearer a") && key.includes("/api/oauth/usage"),
        ),
      );
    }),
);

it.effect.each(["seconds", "date", "missing", "short"] as const)(
  "enforces %s Retry-After across usage requests and manual refreshes",
  (kind) =>
    Effect.gen(function* () {
      let calls = 0;
      const now = yield* Clock.currentTimeMillis;
      const header =
        kind === "short"
          ? "1"
          : kind === "seconds"
            ? "600"
            : kind === "date"
              ? DateTime.toDateUtc(DateTime.makeUnsafe(now + 600_000)).toUTCString()
              : undefined;
      const client = yield* makeUsageHttpClient(
        HttpClient.make((input) =>
          Effect.sync(() => {
            calls++;
            return HttpClientResponse.fromWeb(
              input,
              Response.json({}, { status: 429, headers: header ? { "retry-after": header } : {} }),
            );
          }),
        ),
      );
      yield* client.execute(request("a"));
      assert.strictEqual(
        yield* client.isCoolingDown("https://api.anthropic.com", "Bearer a"),
        true,
      );
      yield* client.invalidateSuccessfulReads("https://api.anthropic.com", "Bearer a");
      yield* client.execute(request("a", "?cedar_ember=1"));
      assert.strictEqual(calls, 1);
      yield* client.execute(request("b"));
      assert.strictEqual(calls, 2);
      const wait = kind === "short" ? 2_000 : kind === "missing" ? 240_000 : 540_000;
      const deadline = kind === "short" || kind === "missing" ? 300_000 : 600_000;
      yield* TestClock.adjust(wait);
      const synthesized = yield* client.execute(request("a", "?manual=1"));
      assert.strictEqual(usageReadRefreshAfter(synthesized), now + deadline);
      assert.strictEqual(calls, 2);
      yield* TestClock.adjust(deadline - wait);
      yield* client.execute(request("a", "?manual=2"));
      assert.strictEqual(calls, 3);
    }),
);

it.effect.each([200, 503, 429, "interrupted"] as const)(
  "does not reuse invalidated or interrupted reads while preserving failure backoff (%s)",
  (status) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      let calls = 0;
      const client = yield* makeUsageHttpClient(
        HttpClient.make((input) =>
          Effect.gen(function* () {
            calls++;
            const reading = calls;
            if (reading === 1) {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(finish);
            }
            return HttpClientResponse.fromWeb(
              input,
              Response.json({ reading }, { status: typeof status === "number" ? status : 200 }),
            );
          }).pipe(Effect.interruptible),
        ),
      );
      const pending = yield* client
        .execute(request("a"))
        .pipe(Effect.uninterruptible, Effect.forkChild);
      yield* Deferred.await(started);
      yield* client.invalidateSuccessfulReads("https://api.anthropic.com", "Bearer a");
      if (status === "interrupted") yield* Fiber.interrupt(pending);
      else {
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(pending);
      }
      const refreshed = yield* client.execute(request("a")).pipe(Effect.exit);
      assert.strictEqual(refreshed._tag, "Success");
      if (Exit.isFailure(refreshed)) return;
      const expected = status === "interrupted" || status < 400 ? 2 : 1;
      assert.deepStrictEqual(yield* refreshed.value.json, { reading: expected });
      assert.strictEqual(calls, expected);
    }),
);

it.effect.each([401, 403])(
  "does not share token authentication failures across a stable account (%s)",
  (status) =>
    Effect.gen(function* () {
      let calls = 0;
      const client = yield* makeUsageHttpClient(
        HttpClient.make((input) =>
          Effect.sync(() => {
            calls++;
            return HttpClientResponse.fromWeb(input, Response.json({}, { status }));
          }),
        ),
      );
      yield* client
        .execute(request("old-token"))
        .pipe(Effect.provideService(UsageAccountIdentity, "account-a"));
      yield* client
        .execute(request("new-token"))
        .pipe(Effect.provideService(UsageAccountIdentity, "account-a"));
      yield* client
        .execute(request("new-token"))
        .pipe(Effect.provideService(UsageAccountIdentity, "account-a"));
      assert.strictEqual(calls, 2);
    }),
);
