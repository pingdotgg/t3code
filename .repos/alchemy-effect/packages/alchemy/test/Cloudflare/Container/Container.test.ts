import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import EffectfulStack from "./fixtures/effectful/stack.ts";
import ExternalStack from "./fixtures/external/stack.ts";
import RemoteStack from "./fixtures/remote/stack.ts";

describe.concurrent.each([
  {
    dev: true,
    stage: "test-local",
    // Must cover the full readiness budget (readinessRetries × 3s ≈ 3 min)
    // when a saturated machine keeps the local container answering 500s.
    timeout: 300_000,
  },
  {
    dev: false,
    stage: "test-live",
    timeout: 300_000,
  },
])("Container (dev: $dev)", ({ dev, stage, timeout }) => {
  // We need to create a new test context for each test case because the
  // local runner stops running after the root scope is closed, which happens
  // in an afterAll hook registered by `Test.make`.
  const make = () =>
    Test.make({
      providers: Cloudflare.providers(),
      state: Cloudflare.state(),
      stage,
      dev,
    });

  const logLevel = Effect.provideService(
    MinimumLogLevel,
    process.env.DEBUG ? "Debug" : "Info",
  );

  // Container image build + push + worker/DO deploy comfortably exceeds the
  // default 120s hook budget, so give every deploy/destroy plenty of room.
  const HOOK_TIMEOUT = 600_000;

  /**
   * Effect-native container (`main`): the entrypoint Effect is bundled into a
   * generated image. The Durable Object proxies into the container two ways —
   * RPC (`container.ping()` / `container.readObject()`) and HTTP over its
   * port-3000 server (`getTcpPort(3000).fetch`). The bucket tests prove the
   * full end-to-end R2 path: a value written through the DO's NATIVE binding is
   * read back from inside the container over its scoped HTTP token, surfaced
   * both via RPC and via fetch.
   */
  describe("effectful container (main)", () => {
    const { test, beforeAll, afterAll, deploy, destroy } = make();
    const stack = beforeAll(deploy(EffectfulStack), {
      timeout: HOOK_TIMEOUT,
    });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(EffectfulStack), {
      timeout: HOOK_TIMEOUT,
    });

    test(
      "RPC: ping round-trips into the container",
      Effect.gen(function* () {
        const { url } = yield* stack;

        const pong = yield* fetchReady(new URL("/ping", url), "pong");
        expect(pong).toContain("pong");
      }).pipe(logLevel),
      { timeout },
    );

    test(
      "fetch: serves over its TCP port",
      Effect.gen(function* () {
        const { url } = yield* stack;

        const hello = yield* fetchReady(
          new URL("/hello", url),
          "effectful container",
        );
        expect(hello).toContain("effectful container");
      }).pipe(logLevel),
      { timeout },
    );

    test(
      "RPC: reads an R2 object from inside the container",
      Effect.gen(function* () {
        const { url } = yield* stack;

        yield* seed(url, "rpc.txt", "hello-rpc");
        const body = yield* fetchReady(
          new URL("/rpc?key=rpc.txt", url),
          "hello-rpc",
        );
        expect(body).toContain("hello-rpc");
      }).pipe(logLevel),
      { timeout },
    );

    test(
      "fetch: reads an R2 object from inside the container",
      Effect.gen(function* () {
        const { url } = yield* stack;

        yield* seed(url, "fetch.txt", "hello-fetch");
        const body = yield* fetchReady(
          new URL("/fetch?key=fetch.txt", url),
          "hello-fetch",
        );
        expect(body).toContain("hello-fetch");
      }).pipe(logLevel),
      { timeout },
    );
  });

  /**
   * External container (`context` / `dockerfile`): Alchemy builds the user's
   * Dockerfile against the context directory (nginx serving a static page on
   * port 8080) and the DO proxies a request to it.
   */
  describe("external container (context/dockerfile)", () => {
    const { test, beforeAll, afterAll, deploy, destroy } = make();
    const stack = beforeAll(deploy(ExternalStack), { timeout: HOOK_TIMEOUT });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(ExternalStack), {
      timeout: HOOK_TIMEOUT,
    });

    test(
      "builds the user Dockerfile and serves it over its TCP port",
      Effect.gen(function* () {
        const { url } = yield* stack;

        const hello = yield* fetchReady(
          new URL("/hello", url),
          "external container",
        );
        expect(hello).toContain("external container");
      }).pipe(logLevel),
      { timeout },
    );
  });

  /**
   * Remote container (`image`): Alchemy pulls a pre-built public image and
   * re-pushes it to Cloudflare's registry without building anything; the DO
   * proxies a request to it.
   */
  describe("remote container (image)", () => {
    const { test, beforeAll, afterAll, deploy, destroy } = make();
    const stack = beforeAll(deploy(RemoteStack), { timeout: HOOK_TIMEOUT });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(RemoteStack), {
      timeout: HOOK_TIMEOUT,
    });

    test(
      "pulls and re-pushes the remote image and serves it over its TCP port",
      Effect.gen(function* () {
        const { url } = yield* stack;

        const hello = yield* fetchReady(new URL("/hello", url), "method");
        expect(hello).toContain("method");
      }).pipe(logLevel),
      { timeout },
    );
  });
});

// Note on image choice for the non-Effect (`image`/`dockerfile`) variants:
// stock nginx images crash-loop inside Cloudflare's container sandbox because
// they symlink /var/log/nginx/{access,error}.log to /dev/stdout and
// /dev/stderr, and opening those device paths fails with ENXIO (errno 6) — the
// nginx master aborts with `[emerg] could not open error log file` before it
// ever binds the port, so getTcpPort() can never connect. The fixtures work
// around this two ways: the `external` Dockerfile (which we own) replaces the
// log symlinks with real files, and the `remote` variant uses a server image
// (`mendhak/http-https-echo`) that writes to its inherited stdout fd directly
// instead of opening the /dev/std* paths as files.

// Cap exponential backoff at 3s — keeps the fast path snappy but stops the
// geometric blow-up from dominating wall time when CF edge is slow.
const readinessSchedule = Schedule.min([
  Schedule.exponential("500 millis"),
  Schedule.spaced("3 seconds"),
]);
// ~3 min of 3s-spaced polls: a saturated full-suite run (many concurrent
// docker builds/pushes on this machine) can keep a dev container answering
// 500 well past the ~90s that 30 retries buys. Failing attempts return
// fast, so the extra budget only matters on the slow path.
const readinessRetries = 60;

// While a freshly pre-created worker propagates, Cloudflare's edge serves
// Alchemy's pre-create stub (200 with this body); any poll that sees it retries.
const DEPLOY_PLACEHOLDER = "Alchemy worker is being deployed...";

// Force `Connection: close` so each readiness attempt opens a fresh connection
// and can land on an edge that already has the new deploy (a pooled keep-alive
// socket stays pinned to one edge metal and can keep reading the stale body).
const freshConn = HttpClient.HttpClient.pipe(
  Effect.map(
    HttpClient.mapRequest(HttpClientRequest.setHeader("connection", "close")),
  ),
);

// Retry a freshly-deployed worker route until it answers 200 with a body that
// contains `expected` — rejecting both transient non-200s and the deploy stub.
// Each attempt is bounded so a worker that is hung waiting on its container
// surfaces as a retryable failure rather than blocking the whole test budget.
const fetchReady = (url: URL, expected: string) =>
  Effect.gen(function* () {
    const client = yield* freshConn;
    return yield* client.get(url).pipe(
      Effect.flatMap((r) =>
        r.text.pipe(
          Effect.flatMap((body) =>
            r.status !== 200
              ? Effect.fail(new Error(`Worker not ready: ${r.status} ${body}`))
              : body.includes(DEPLOY_PLACEHOLDER) || !body.includes(expected)
                ? Effect.fail(new Error(`not ready: got ${body}`))
                : Effect.succeed(body),
          ),
        ),
      ),
      Effect.timeout("10 seconds"),
      Effect.retry({ schedule: readinessSchedule, times: readinessRetries }),
    );
  });

// Seed a value into R2 via the worker's `/seed` route (DO native binding),
// retrying through cold-start until the producer accepts it (200).
const seed = (url: string, key: string, value: string) =>
  Effect.gen(function* () {
    const client = yield* freshConn;
    return yield* client
      .execute(
        HttpClientRequest.put(
          new URL(`/seed?key=${encodeURIComponent(key)}`, url),
        ).pipe(HttpClientRequest.bodyText(value)),
      )
      .pipe(
        Effect.flatMap((r) =>
          r.status === 200
            ? Effect.succeed(r)
            : Effect.fail(new Error(`seed not ready: ${r.status}`)),
        ),
        Effect.timeout("10 seconds"),
        Effect.retry({
          schedule: readinessSchedule,
          times: readinessRetries,
        }),
      );
  });
