import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import {
  materializeIsolatedProject,
  removeIsolatedProject,
} from "../../IsolatedProject.ts";
import { project } from "./fixtures/isolated/container.ts";
import IsolatedStack from "./fixtures/isolated/stack.ts";

// Live proof that the Cloudflare Container bootstrap boots when the
// container's `main` lives in an isolated project (see
// test/IsolatedProject.ts) — the bundle `cwd` resolves none of alchemy's
// dependencies, so the bootstrap's `@effect/platform-bun` / `alchemy/*`
// imports must be bundled by the virtual-entry plugin rather than found from
// the project root. With them left external bun dies at module load and the
// Durable Object's RPC / TCP requests never get a reply.
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Container image build + push + worker/DO deploy comfortably exceeds the
// default 120s hook budget.
const HOOK_TIMEOUT = 600_000;

// The project must exist before the deploy bundles it; written in its own
// hook so a failed deploy still runs the cleanup.
beforeAll(materializeIsolatedProject(project));
const stack = beforeAll(deploy(IsolatedStack), { timeout: HOOK_TIMEOUT });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(IsolatedStack), {
  timeout: HOOK_TIMEOUT,
});
afterAll(removeIsolatedProject(project));

// Force `Connection: close` so each readiness attempt opens a fresh
// connection and can land on an edge that already has the new deploy.
const freshConn = HttpClient.HttpClient.pipe(
  Effect.map(
    HttpClient.mapRequest(HttpClientRequest.setHeader("connection", "close")),
  ),
);

// While a freshly pre-created worker propagates, the edge serves Alchemy's
// pre-create stub; any poll that sees it retries.
const DEPLOY_PLACEHOLDER = "Alchemy worker is being deployed...";

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
      Effect.retry({
        schedule: Schedule.min([
          Schedule.exponential("500 millis"),
          Schedule.spaced("3 seconds"),
        ]),
        times: 60,
      }),
    );
  });

test(
  "RPC: ping round-trips into the container",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const pong = yield* fetchReady(new URL("/ping", url), "pong");
    expect(pong).toContain("pong");
  }).pipe(logLevel),
  { timeout: 300_000 },
);

test(
  "fetch: the container's HTTP server answers over its TCP port",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const hello = yield* fetchReady(
      new URL("/hello", url),
      "hello from isolated project",
    );
    expect(hello).toContain("hello from isolated project");
  }).pipe(logLevel),
  { timeout: 300_000 },
);
