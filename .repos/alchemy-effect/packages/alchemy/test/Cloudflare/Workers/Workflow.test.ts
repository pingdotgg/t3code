import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Stack from "./fixtures/workflow/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const stack = beforeAll(
  deploy(Stack).pipe(
    // Let the freshly-deployed worker (and its Workflow binding) settle before
    // the first run so a step doesn't error mid-propagation.
    Effect.tap(Effect.sleep("5 seconds")),
  ),
);
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

interface WorkflowStatus {
  status: string;
  output?: { greeting: string; envBindingCount: number };
  error?: { message?: string } | null;
}

// Start a fresh workflow instance and poll until it reaches a terminal state.
// A transient `errored` during edge/binding propagation fails this effect so
// the caller can retry with a brand-new instance.
const runWorkflowToCompletion = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;

    // Cloudflare's edge takes a few seconds to start serving a fresh
    // workers.dev URL, so retry until it returns 200 (a fresh URL also
    // returns 404 transiently, which is not an HTTP error so Effect.retry
    // does not catch it unless we explicitly fail on non-200).
    const startRes = yield* client.post(`${url}/workflow/start/world`).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(new Error(`Worker not ready: ${res.status}`)),
      ),
      Effect.retry({
        schedule: Schedule.exponential("500 millis"),
        times: 15,
      }),
    );
    const { instanceId } = (yield* startRes.json) as { instanceId: string };
    expect(instanceId).toBeTypeOf("string");

    const lastStatus = yield* client
      .get(`${url}/workflow/status/${instanceId}`)
      .pipe(
        Effect.flatMap((res) => res.json),
        Effect.map((json) => json as unknown as WorkflowStatus),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (s) => s.status === "complete" || s.status === "errored",
          times: 12,
        }),
      );

    // Surface a non-complete terminal state as a failure so the outer retry
    // can take another swing (a fresh worker occasionally errors a step while
    // its bindings are still propagating).
    if (lastStatus.status !== "complete") {
      return yield* Effect.fail(
        new Error(
          `workflow ${lastStatus.status}: ${JSON.stringify(lastStatus.error)}`,
        ),
      );
    }
    return lastStatus;
  });

test(
  "deployed worker can run a workflow to completion",
  Effect.gen(function* () {
    const out = yield* stack;
    const url = out.url;
    expect(url).toBeTypeOf("string");

    const lastStatus = yield* runWorkflowToCompletion(url).pipe(
      Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 2 }),
    );

    expect(lastStatus.status).toBe("complete");
    expect(lastStatus.error).toBeFalsy();
    expect(lastStatus.output?.greeting).toBe("Hello, world!");
    // The body yields `WorkerEnvironment` — if the regression from PR #71 ever
    // returns, the body dies on the first yield and `output` is undefined.
    expect(lastStatus.output?.envBindingCount).toBeGreaterThan(0);
  }).pipe(logLevel),
  { timeout: 30_000 },
);
