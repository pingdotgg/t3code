import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import { isHttpClientError } from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import Stack from "./fixtures/do-abort/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

let bust = 0;
const getJson = <T>(
  client: HttpClient.HttpClient,
  url: string,
  phase: "readiness" | "before abort" | "after abort",
): Effect.Effect<T, unknown> =>
  Effect.sync(() => `${url}?cb=${Date.now()}-${bust++}`).pipe(
    Effect.flatMap((url) =>
      client.get(url, { headers: { "cache-control": "no-cache" } }),
    ),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.tapError((error) =>
      Effect.gen(function* () {
        if (error.reason._tag === "StatusCodeError") {
          const response = error.reason.response;
          const body = yield* response.text.pipe(
            Effect.catch(() => Effect.succeed("<unreadable response body>")),
          );
          yield* (response.status === 404 ? Effect.logDebug : Effect.logError)(
            `${phase}: GET ${response.request.url} returned ${response.status}`,
            body,
          );
        } else {
          yield* Effect.logError(`${phase}: GET ${url} failed`, error);
        }
      }),
    ),
    Effect.retry({
      while: (error) =>
        Effect.gen(function* () {
          if (phase !== "readiness" || new URL(url).pathname !== "/ping")
            return false;
          if (error.reason._tag !== "StatusCodeError") return false;
          const response = error.reason.response;
          const html = (response.headers["content-type"] ?? "").includes(
            "text/html",
          );
          if (response.status === 404 && html) return true;
          if (response.status !== 500) return false;
          if (html) {
            const body = yield* response.text.pipe(
              Effect.orElseSucceed(() => ""),
            );
            return (
              body.includes('<span class="cf-error-code">1104</span>') &&
              body.includes("Script not found")
            );
          }
          // The opaque startup error is unexplained; only read-only readiness tolerates it.
          return response.headers["x-do-readiness-retry"] === "true";
        }),
      schedule: Schedule.spaced("3 seconds"),
      times: 8,
    }),
    Effect.flatMap((res) => res.json as Effect.Effect<T>),
  );

describe.skipIf(!!process.env.FAST)(
  "DurableObjectState.abort resets the isolate",
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"] },
  () => {
    test(
      "abort resets the Durable Object so the constructor re-runs",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const client = yield* HttpClient.HttpClient;

        yield* getJson(client, `${url}/ping`, "readiness").pipe(
          Effect.timeout("30 seconds"),
        );
        const before = yield* getJson<{ boots: number; ok: true }>(
          client,
          `${url}/ping`,
          "before abort",
        );
        yield* Effect.logInfo("before abort", before);
        expect(before.ok).toBe(true);
        expect(before.boots).toBeGreaterThanOrEqual(1);

        const failure = yield* getJson(
          client,
          `${url}/fail-ping`,
          "before abort",
        ).pipe(Effect.flip);
        if (
          !isHttpClientError(failure) ||
          failure.reason._tag !== "StatusCodeError"
        ) {
          return yield* Effect.die(failure);
        }
        expect(failure.reason.response.status).toBe(500);
        expect(failure.reason.response.headers["x-do-readiness-retry"]).toBe(
          "false",
        );
        expect(yield* failure.reason.response.text).toContain(
          "application-ping-failure",
        );
        const unchanged = yield* getJson<{
          boots: number;
          failedPings: number;
        }>(client, `${url}/ping`, "before abort");
        expect(unchanged.boots).toBe(before.boots);
        expect(unchanged.failedPings).toBe(1);

        const aborted = yield* Effect.sync(
          () => `${url}/abort?cb=${Date.now()}-${bust++}`,
        ).pipe(
          Effect.flatMap((url) =>
            client.get(url, { headers: { "cache-control": "no-cache" } }),
          ),
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((response) => response.text),
        );
        yield* Effect.logInfo("abort RPC", aborted);
        expect(aborted).toContain("test abort");

        const after = yield* getJson<{ boots: number; ok: true }>(
          client,
          `${url}/ping`,
          "after abort",
        );
        yield* Effect.logInfo("after abort", after);
        expect(after.ok).toBe(true);
        expect(after.boots).toBe(before.boots + 1);
      }).pipe(logLevel),
      { timeout: 120_000 },
    );
  },
);
