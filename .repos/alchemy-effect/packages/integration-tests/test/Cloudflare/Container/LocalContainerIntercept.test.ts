import * as Cloudflare from "@alchemy.run/cloudflare";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { INTERCEPT_HOST } from "./fixtures/intercept/object.ts";
import InterceptStack, { state } from "./fixtures/intercept/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state,
  dev: true,
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// First request has to wait for the local runtime to `docker build` the image
// and boot the container, so give it plenty of room.
const HOOK_TIMEOUT = 300_000;
const TEST_TIMEOUT = 240_000;

const readinessSchedule = Schedule.min([
  Schedule.exponential("500 millis"),
  Schedule.spaced("3 seconds"),
]);

/**
 * `interceptOutboundHttp` / `interceptAllOutboundHttp` on a container
 * handle must register the caller's Fetcher with workerd, so the container's
 * outbound HTTP reaches the Durable Object that owns it.
 */
describe(
  "local container outbound interception",
  { tags: ["provider:cloudflare", "provider:cloudflare:container", "provider:cloudflare:worker"] },
  () => {
    const stack = beforeAll(deploy(InterceptStack), { timeout: HOOK_TIMEOUT });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(InterceptStack), { timeout: HOOK_TIMEOUT });

    const probe = (path: string) =>
      Effect.gen(function* () {
        const { url } = yield* stack;
        const client = yield* HttpClient.HttpClient;
        const text = yield* client.get(new URL(path, url)).pipe(
          Effect.flatMap((r) =>
            r.status !== 200 ? Effect.fail(new Error(`not ready: ${r.status}`)) : r.text,
          ),
          Effect.timeout("30 seconds"),
          Effect.retry({ schedule: readinessSchedule, times: 30 }),
        );
        return JSON.parse(text) as { status?: number; body?: string; error?: string };
      });

    test(
      "interceptOutboundHttp routes the container's requests for a host to the object",
      Effect.gen(function* () {
        const result = yield* probe("/probe/host");
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(200);
        expect(result.body).toBe(`intercepted ${INTERCEPT_HOST}/hello`);
      }).pipe(logLevel),
      { tags: ["local"], timeout: TEST_TIMEOUT },
    );

    test(
      "interceptAllOutboundHttp routes all of the container's requests to the object",
      Effect.gen(function* () {
        const result = yield* probe("/probe/all");
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(200);
        expect(result.body).toBe("intercepted any.example/hello");
      }).pipe(logLevel),
      { tags: ["local"], timeout: TEST_TIMEOUT },
    );
  },
);
