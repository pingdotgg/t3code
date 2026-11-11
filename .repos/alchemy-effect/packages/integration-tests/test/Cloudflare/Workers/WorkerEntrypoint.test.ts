import * as Cloudflare from "@alchemy.run/cloudflare";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { expectUrlContains } from "../Utils/Http.ts";
import PropsStack from "./fixtures/entrypoint-props/stack.ts";
import Stack from "./fixtures/worker-entrypoint-binding/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

// ctx.props / ctx.exports: an Effect Worker and an async Worker, each with a Durable Object.
const propsStack = beforeAll(deploy(PropsStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(PropsStack));

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// Cold-start retry — fresh `workers.dev` URLs take a few seconds to start
// answering, capped at 3s so the doubling sleeps can't blow the timeout.
const coldStartRetry = Effect.retry({
  schedule: Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced("3 seconds")]),
  times: 30,
});

test(
  "target worker's default entrypoint responds",
  Effect.gen(function* () {
    const { targetUrl } = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

    const res = yield* client.get(targetUrl).pipe(coldStartRetry);
    expect(yield* res.text).toBe("hello from EntrypointTargetWorker");
  }),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"],
    timeout: 180_000,
  },
);

test(
  "caller reaches the NAMED entrypoint through the binding",
  Effect.gen(function* () {
    const { callerUrl } = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

    // The default entrypoint has no `greet` — a greeting proves the
    // binding targeted the named `Api` class.
    const res = yield* client.get(`${callerUrl}/greet?name=alice`).pipe(coldStartRetry);
    expect(yield* res.text).toBe("hello alice from Api");
  }),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"],
    timeout: 180_000,
  },
);

test(
  "a worker reaches its own NAMED entrypoint through WorkerEntrypoint(name)",
  Effect.gen(function* () {
    const { targetUrl } = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

    // A bare `Self` binding would hit the default export, which has no
    // `greet`: the greeting proves the self binding carried `entrypoint`.
    const res = yield* client.get(`${targetUrl}/self-greet?name=bob`).pipe(coldStartRetry);
    expect(yield* res.text).toBe("hello bob from Api");
  }),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"],
    timeout: 180_000,
  },
);

test(
  "a worker reaches its own default export through WorkerEntrypoint()",
  Effect.gen(function* () {
    const { targetUrl } = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

    const res = yield* client.get(`${targetUrl}/self-default`).pipe(coldStartRetry);
    expect(yield* res.text).toBe("via self default: hello from EntrypointTargetWorker");
  }),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"],
    timeout: 180_000,
  },
);

// The Cloudflare API's service-binding schema does not carry `props` yet:
// the distilled `workers` service drops the field at encode, so deployed
// bindings deliver no ctx.props. Local dev already delivers them (see
// WorkerEntrypoint.local.test.ts). Flip this on when the distilled patch
// lands.
test.skip(
  "props reach the named entrypoint's ctx.props",
  Effect.gen(function* () {
    const { callerUrl } = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

    const res = yield* client.get(`${callerUrl}/props`).pipe(coldStartRetry);
    expect((yield* res.json) as Record<string, unknown>).toEqual({
      tenant: "acme",
    });
  }),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"],
    timeout: 180_000,
  },
);

const TENANT = `props=${JSON.stringify({ tenant: "acme" })}`;

const routes = (variant: "effect" | "async") => [
  { name: "an external request has empty props", path: "/props", expected: "props={}" },
  {
    name: "a Worker handler mints a default entrypoint stub with props",
    path: "/mint",
    expected: `via-worker:${TENANT}`,
  },
  {
    name: "a Durable Object mints a host entrypoint stub with props",
    path: "/mint-do",
    expected: `via-do:${TENANT}`,
  },
  // Effect Workers export only `default`; a named entrypoint is a native class.
  ...(variant === "async"
    ? [
        {
          name: "a Worker handler mints a named entrypoint stub with props",
          path: "/mint-named",
          expected: `via-named:${TENANT}`,
        },
      ]
    : []),
  {
    name: "an entrypoint the Worker does not export is unavailable",
    path: "/missing",
    expected: variant === "effect" ? "EntrypointUnavailableError:Missing" : "undefined:Missing",
  },
];

for (const variant of ["effect", "async"] as const) {
  describe(
    `ctx.props and self entrypoint stubs (${variant})`,
    { tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"] },
    () => {
      for (const route of routes(variant)) {
        test(
          route.name,
          Effect.gen(function* () {
            const urls = yield* propsStack;
            const url = variant === "effect" ? urls.effectUrl : urls.asyncUrl;
            yield* expectUrlContains(`${url}${route.path}`, route.expected, {
              label: `${variant} ${route.path}`,
            });
          }).pipe(logLevel),
          { timeout: 180_000 },
        );
      }
    },
  );
}
