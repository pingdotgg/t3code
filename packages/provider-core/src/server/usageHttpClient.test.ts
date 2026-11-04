import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { makeUsageHttpClient } from "./usageHttpClient.ts";

const url = "https://api.anthropic.com/api/oauth/usage";
const request = (account: string, suffix = "") =>
  HttpClientRequest.get(url + suffix).pipe(HttpClientRequest.bearerToken(account));

it.effect(
  "deduplicates concurrent surfaces and windows, isolates accounts, and caches failed reads",
  () =>
    Effect.gen(function* () {
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
      yield* TestClock.adjust("4 minutes");
      yield* client.execute(request("a"));
      assert.strictEqual(calls, 2);
      yield* TestClock.adjust("1 minute");
      yield* client.execute(request("a"));
      assert.strictEqual(calls, 3);
    }),
);

it.effect.each(["seconds", "date", "missing"] as const)(
  "enforces %s Retry-After across usage requests and manual refreshes",
  (kind) =>
    Effect.gen(function* () {
      let calls = 0;
      const now = yield* Clock.currentTimeMillis;
      const header =
        kind === "seconds"
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
      yield* TestClock.adjust(kind === "missing" ? "4 minutes" : "9 minutes");
      yield* client.execute(request("a", "?manual=1"));
      assert.strictEqual(calls, 2);
      yield* TestClock.adjust("1 minute");
      yield* client.execute(request("a", "?manual=2"));
      assert.strictEqual(calls, 3);
    }),
);
