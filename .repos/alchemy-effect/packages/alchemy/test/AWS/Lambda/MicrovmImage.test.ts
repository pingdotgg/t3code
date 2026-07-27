import * as AWS from "@/AWS";
import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import EffectfulStack from "./fixtures/microvm/stack.ts";
import ExternalStack from "./fixtures/microvm/external/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  // The effectful stack deploys an AWS Lambda AND a Cloudflare Worker driving
  // the same MicroVM image, so the harness needs both provider sets.
  providers: Layer.mergeAll(AWS.providers(), Cloudflare.providers()),
  state: Alchemy.localState(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// MicroVM image builds run server-side (Firecracker snapshot) and can take
// several minutes, so give deploy/destroy plenty of room.
const HOOK_TIMEOUT = 1_500_000;
const TEST_TIMEOUT = 300_000;

// Lambda MicroVM is a preview feature: builds are asynchronous (minutes) and the
// account must be onboarded to the preview, with a bootstrapped Assets bucket.
const skip = !process.env.LAMBDA_TEST_MICROVM;

const readinessSchedule = Schedule.min([
  Schedule.exponential("500 millis"),
  Schedule.spaced("3 seconds"),
]);
const readinessRetries = 30;

// Retry a freshly-deployed Lambda URL until it answers 200 (cold-start, IAM
// propagation).
const send = (req: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.execute(req).pipe(
      Effect.flatMap((r) =>
        r.status === 200
          ? Effect.succeed(r)
          : Effect.fail(new Error(`not ready: ${r.status}`)),
      ),
      Effect.timeout("30 seconds"),
      Effect.retry({ schedule: readinessSchedule, times: readinessRetries }),
    );
  });

/**
 * Effectful MicroVM (`main`): the in-VM HTTP server is written in TypeScript and
 * bundled into a generated image. A Lambda orchestrator binds the instance
 * operations and drives the full lifecycle (run -> auth-token -> list ->
 * terminate) over its function URL.
 */
describe.skipIf(skip)("effectful microvm (main)", () => {
  const stack = beforeAll(deploy(EffectfulStack), { timeout: HOOK_TIMEOUT });
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(EffectfulStack), {
    timeout: HOOK_TIMEOUT,
  });

  test(
    "runs a MicroVM, mints a token, and terminates it",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const baseUrl = url.replace(/\/+$/, "");

      const runRes = yield* send(HttpClientRequest.post(`${baseUrl}/run`));
      const vm = (yield* runRes.json) as {
        microvmId: string;
        endpoint: string;
        state: string;
      };
      expect(vm.microvmId).toBeTruthy();
      // RunMicrovm returns the MicroVM's endpoint as a bare hostname
      // (`<id>.lambda-microvm.<region>.on.aws`), not a full URL.
      expect(vm.endpoint).toContain("lambda-microvm");

      yield* send(HttpClientRequest.get(`${baseUrl}/get?id=${vm.microvmId}`));

      const tokenRes = yield* send(
        HttpClientRequest.post(`${baseUrl}/auth-token?id=${vm.microvmId}`),
      );
      const token = (yield* tokenRes.json) as { hasToken: boolean };
      expect(token.hasToken).toBe(true);

      const listRes = yield* send(HttpClientRequest.get(`${baseUrl}/list`));
      const list = (yield* listRes.json) as { count: number };
      expect(list.count).toBeGreaterThanOrEqual(1);

      const termRes = yield* send(
        HttpClientRequest.post(`${baseUrl}/terminate?id=${vm.microvmId}`),
      );
      expect(termRes.status).toBe(200);
    }).pipe(logLevel),
    { timeout: TEST_TIMEOUT },
  );

  test(
    "drives the in-VM tagged RPC method and the fetch route",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const baseUrl = url.replace(/\/+$/, "");
      const client = yield* HttpClient.HttpClient;

      // The orchestrator runs ONE MicroVM, calls `hello` over RPC, and GETs the
      // `/echo` fetch route — both against the in-VM server's endpoint — then
      // terminates it. We issue a single request (the handler waits for RUNNING
      // internally) and retry only transport errors, NOT 500s: a 500 is a real
      // failure to surface, and retrying it would spawn more MicroVMs.
      const res = yield* client.post(`${baseUrl}/rpc?message=world`).pipe(
        Effect.timeout("150 seconds"),
        Effect.retry({
          schedule: Schedule.exponential("1 second"),
          times: 3,
        }),
        Effect.orDie,
      );
      if (res.status !== 200) {
        const text = yield* res.text.pipe(Effect.orDie);
        return yield* Effect.die(new Error(`/rpc ${res.status}: ${text}`));
      }
      const body = (yield* res.json.pipe(Effect.orDie)) as {
        reply: string;
        echo: string;
      };
      expect(body.reply).toBe("hello, world!");
      expect(body.echo).toBe("world");
    }).pipe(logLevel),
    { timeout: TEST_TIMEOUT },
  );

  test(
    "drives the MicroVM from a Cloudflare Worker (cross-cloud assume-role)",
    Effect.gen(function* () {
      const { workerUrl } = yield* stack;
      const baseUrl = workerUrl.replace(/\/+$/, "");
      const client = yield* HttpClient.HttpClient;

      // Same `/rpc` flow as the Lambda host, but the orchestrator is a
      // Cloudflare Worker reaching AWS via the IAM User → assume-role
      // credentials minted by the binding. A single request (waits for RUNNING
      // internally); retry only transport errors, not 500s.
      const res = yield* client.post(`${baseUrl}/rpc?message=cloudflare`).pipe(
        Effect.timeout("150 seconds"),
        Effect.retry({
          schedule: Schedule.exponential("1 second"),
          times: 3,
        }),
        Effect.orDie,
      );
      if (res.status !== 200) {
        const text = yield* res.text.pipe(Effect.orDie);
        return yield* Effect.die(new Error(`/rpc ${res.status}: ${text}`));
      }
      const body = (yield* res.json.pipe(Effect.orDie)) as {
        reply: string;
        echo: string;
      };
      expect(body.reply).toBe("hello, cloudflare!");
      expect(body.echo).toBe("cloudflare");
    }).pipe(logLevel),
    { timeout: TEST_TIMEOUT },
  );
});

/**
 * External MicroVM (`context`/`dockerfile`): Alchemy zips the build context and
 * AWS runs the user's Dockerfile server-side.
 */
describe.skipIf(skip)("external microvm (context/dockerfile)", () => {
  const stack = beforeAll(deploy(ExternalStack), { timeout: HOOK_TIMEOUT });
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(ExternalStack), {
    timeout: HOOK_TIMEOUT,
  });

  test(
    "builds the image from a Dockerfile + context",
    Effect.gen(function* () {
      // The stack outputs reflect the resolved image — a `CREATED` state proves
      // the server-side build of the user Dockerfile succeeded.
      const { imageArn, state } = yield* stack;
      expect(state).toBe("CREATED");
      expect(imageArn).toContain("microvm-image");
    }).pipe(logLevel),
    { timeout: TEST_TIMEOUT },
  );
});
