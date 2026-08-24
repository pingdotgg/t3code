import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import LocalRemoteStack from "./fixtures/remote/local-stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// First request has to wait for the local runtime to `docker pull` the image
// and boot the container, so give it plenty of room.
const HOOK_TIMEOUT = 300_000;
const TEST_TIMEOUT = 240_000;

const readinessSchedule = Schedule.min([
  Schedule.exponential("500 millis"),
  Schedule.spaced("3 seconds"),
]);

/**
 * Remote container (`image`) under `alchemy dev`: the local provider must
 * resolve `dev: { imageUri }` so the local runtime can `docker pull` the
 * pre-built image (regression: it previously died with "Container requires a
 * `main` entrypoint" because it only handled the Effect-native variant).
 * The DO proxies a request to the echo server running inside the container.
 */
describe("local remote container (image)", () => {
  const stack = beforeAll(deploy(LocalRemoteStack), { timeout: HOOK_TIMEOUT });
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(LocalRemoteStack), {
    timeout: HOOK_TIMEOUT,
  });

  test(
    "pulls the remote image and serves it over its TCP port",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const client = yield* HttpClient.HttpClient;

      // `new URL` (not `${url}/hello`): the dev url has a trailing slash, and
      // a `//hello` path is protocol-relative — the local dev proxy would
      // resolve it to host "hello" and die with a DNS error.
      const body = yield* client.get(new URL("/hello", url)).pipe(
        Effect.flatMap((r) =>
          r.status !== 200
            ? Effect.fail(new Error(`not ready: ${r.status}`))
            : Effect.flatMap(r.text, (text) =>
                // mendhak/http-https-echo echoes the request (method, path,
                // headers) back as JSON.
                text.includes("method")
                  ? Effect.succeed(text)
                  : Effect.fail(new Error(`not ready: got ${text}`)),
              ),
        ),
        Effect.timeout("30 seconds"),
        Effect.retry({ schedule: readinessSchedule, times: 30 }),
      );
      expect(body).toContain("method");
    }).pipe(logLevel),
    { timeout: TEST_TIMEOUT },
  );
});
