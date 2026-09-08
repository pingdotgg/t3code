import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Stack from "./fixtures/worker-entrypoint-binding/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

// Cold-start retry — fresh `workers.dev` URLs take a few seconds to start
// answering, capped at 3s so the doubling sleeps can't blow the timeout.
const coldStartRetry = Effect.retry({
  schedule: Schedule.min([
    Schedule.exponential("500 millis"),
    Schedule.spaced("3 seconds"),
  ]),
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
  { timeout: 180_000 },
);

test(
  "caller reaches the NAMED entrypoint through the binding",
  Effect.gen(function* () {
    const { callerUrl } = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

    // The default entrypoint has no `greet` — a greeting proves the
    // binding targeted the named `Api` class.
    const res = yield* client
      .get(`${callerUrl}/greet?name=alice`)
      .pipe(coldStartRetry);
    expect(yield* res.text).toBe("hello alice from Api");
  }),
  { timeout: 180_000 },
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
  { timeout: 180_000 },
);
