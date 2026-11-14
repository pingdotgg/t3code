import * as Cloudflare from "@alchemy.run/cloudflare";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { isHttpClientError } from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { waitUntilStable } from "../Utils/WorkerRequest.ts";
import Stack from "./fixtures/do-abort/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

let bust = 0;
/**
 * `url` plus the per-attempt object `name` and a cache buster. Every attempt
 * addresses a fresh Durable Object, so a retried attempt never inherits the
 * `boots`/`failedPings` counters a failed attempt left behind.
 */
const withQuery = (url: string, name: string) =>
  Effect.sync(() => `${url}?name=${name}&cb=${Date.now()}-${bust++}`);

const getJson = <T>(
  client: HttpClient.HttpClient,
  url: string,
  name: string,
  phase: "readiness" | "before abort" | "after abort",
): Effect.Effect<T, unknown> =>
  withQuery(url, name).pipe(
    Effect.flatMap((url) => client.get(url, { headers: { "cache-control": "no-cache" } })),
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
          // Only the read-only `/ping` is retried — never `/fail-ping` (it
          // bumps `failedPings`) and never `/abort`. Every phase retries: under
          // load a ping between the steps below can hit the same transient
          // platform errors as readiness, and the exact `boots`/`failedPings`
          // assertions still catch any real reset.
          if (new URL(url).pathname !== "/ping") return false;
          if (error.reason._tag === "TransportError") return true;
          if (error.reason._tag !== "StatusCodeError") return false;
          const response = error.reason.response;
          const html = (response.headers["content-type"] ?? "").includes("text/html");
          if (response.status === 404 && html) return true;
          if (response.status !== 500) return false;
          if (html) {
            const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
            return (
              body.includes('<span class="cf-error-code">1104</span>') &&
              body.includes("Script not found")
            );
          }
          // The fixture flags an opaque `internal error; reference = …` RPC
          // failure on `/ping` as retryable; only the read-only ping tolerates it.
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
        const name = yield* Effect.sync(() => `abort-${crypto.randomUUID()}`);
        yield* Effect.logInfo("Durable Object name", name);

        // Ready means three pings in a row reach the same Durable Object
        // incarnation: a host still rolling out the new version answers 404,
        // and a version swap restarts the object (boots changes), which would
        // break the before/after-abort comparison below.
        let lastBoots: number | undefined;
        yield* waitUntilStable(
          `Durable Object at ${url}`,
          getJson<{ boots: number }>(client, `${url}/ping`, name, "readiness").pipe(
            Effect.map(({ boots }) => {
              const same = boots === lastBoots;
              lastBoots = boots;
              return same;
            }),
          ),
          { consecutive: 2, timeout: "60 seconds" },
        );
        const before = yield* getJson<{ boots: number; ok: true }>(
          client,
          `${url}/ping`,
          name,
          "before abort",
        );
        yield* Effect.logInfo("before abort", before);
        expect(before.ok).toBe(true);
        expect(before.boots).toBeGreaterThanOrEqual(1);

        const failure = yield* getJson(client, `${url}/fail-ping`, name, "before abort").pipe(
          Effect.flip,
        );
        if (!isHttpClientError(failure) || failure.reason._tag !== "StatusCodeError") {
          return yield* Effect.die(failure);
        }
        expect(failure.reason.response.status).toBe(500);
        expect(failure.reason.response.headers["x-do-readiness-retry"]).toBe("false");
        expect(yield* failure.reason.response.text).toContain("application-ping-failure");
        const unchanged = yield* getJson<{ boots: number; failedPings: number }>(
          client,
          `${url}/ping`,
          name,
          "before abort",
        );
        yield* Effect.logInfo("after failed ping", unchanged);
        expect(unchanged.boots).toBe(before.boots);
        expect(unchanged.failedPings).toBe(1);

        const aborted = yield* withQuery(`${url}/abort`, name).pipe(
          Effect.flatMap((url) => client.get(url, { headers: { "cache-control": "no-cache" } })),
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((response) => response.text),
        );
        yield* Effect.logInfo("abort RPC", aborted);
        expect(aborted).toContain("test abort");

        const after = yield* getJson<{ boots: number; ok: true }>(
          client,
          `${url}/ping`,
          name,
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
