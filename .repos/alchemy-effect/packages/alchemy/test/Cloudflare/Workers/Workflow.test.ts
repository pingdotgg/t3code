import * as Cloudflare from "@/Cloudflare";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Stack from "./fixtures/workflow/stack.ts";
import WorkflowTestWorker from "./fixtures/workflow/workflow-worker.ts";

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
  output?: {
    greeting: string;
    envBindingCount: number;
    workflowName: string;
    stepAttempt: number;
    instanceId: string;
  };
  error?: { message?: string } | null;
  rollback?: {
    outcome: "complete" | "failed";
    error: { message?: string } | null;
  } | null;
}

const isTerminal = (status: WorkflowStatus) =>
  status.status === "complete" ||
  status.status === "errored" ||
  status.status === "terminated";

const waitForStatus = (
  client: HttpClient.HttpClient,
  url: string,
  id: string,
  until: (status: WorkflowStatus) => boolean = isTerminal,
  times = 30,
) =>
  client.get(`${url}/workflow/status/${id}`).pipe(
    // The status endpoint transiently returns a 500 (HTML error page, not
    // JSON) while the freshly-deployed worker's Workflow binding is still
    // propagating. Only decode JSON on a 200; treat any other status as a
    // non-terminal "pending" so the poll keeps swinging instead of dying
    // on a JSON decode error.
    Effect.flatMap((res) =>
      res.status === 200
        ? res.json.pipe(Effect.map((json) => json as unknown as WorkflowStatus))
        : Effect.succeed({ status: "pending" } as WorkflowStatus),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until,
      times,
    }),
  );

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
        // Cap the exponential at 3s — uncapped, 15 retries grow past 30s of
        // sleep after only six attempts and blow the test timeout.
        schedule: Schedule.min([
          Schedule.exponential("500 millis"),
          Schedule.spaced("3 seconds"),
        ]),
        times: 15,
      }),
    );
    const { instanceId } = (yield* startRes.json) as { instanceId: string };
    expect(instanceId).toBeTypeOf("string");

    const lastStatus = yield* waitForStatus(client, url, instanceId);

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
    // `event.workflowName` carries the account-global *physical* name, which
    // is derived from the host Worker's unique name (stack-id-stage prefix).
    expect(lastStatus.output?.workflowName).toMatch(/^workflowbindingstack-/);
    expect(lastStatus.output?.stepAttempt).toBe(1);
    expect(lastStatus.rollback).toBeNull();
    // The body yields `WorkerEnvironment` — if the regression from PR #71 ever
    // returns, the body dies on the first yield and `output` is undefined.
    expect(lastStatus.output?.envBindingCount).toBeGreaterThan(0);
  }).pipe(logLevel),
  { timeout: 180_000 },
);

test(
  "workflow can wait for and receive external events",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;

    const { instanceId, lastStatus } = yield* Effect.gen(function* () {
      const { instanceId } = yield* client
        .post(`${url}/workflow/wait/world`)
        .pipe(
          Effect.flatMap((res) =>
            res.status === 200
              ? res.json.pipe(
                  Effect.flatMap((body) => {
                    const instanceId = (body as { instanceId?: unknown })
                      .instanceId;
                    return typeof instanceId === "string"
                      ? Effect.succeed({ instanceId })
                      : Effect.fail(
                          new Error("Worker returned no workflow id"),
                        );
                  }),
                )
              : Effect.fail(new Error(`Worker not ready: ${res.status}`)),
          ),
          Effect.retry({
            schedule: Schedule.exponential("500 millis"),
            times: 15,
          }),
        );

      // Cloudflare reports an instance parked in `waitForEvent` as `running`
      // (`waiting` is reserved for sleeps), so the wait step itself is not
      // observable through the coarse instance status. Wait for the instance
      // to start, then deliver the event.
      const runningStatus = yield* waitForStatus(
        client,
        url,
        instanceId,
        (status) => status.status === "running" || isTerminal(status),
      );
      if (runningStatus.status !== "running") {
        return yield* Effect.fail(
          new Error(
            `workflow ${runningStatus.status}: ${JSON.stringify(runningStatus.error)}`,
          ),
        );
      }

      // An event sent in the gap before the `waitForEvent` step registers can
      // be missed, so re-send until the workflow acknowledges it by reaching a
      // terminal status.
      const lastStatus = yield* Effect.gen(function* () {
        const sendRes = yield* client.post(
          `${url}/workflow/send/${instanceId}/external-ok`,
        );
        if (sendRes.status !== 200) {
          return yield* Effect.fail(
            new Error(`sendEvent failed: ${sendRes.status}`),
          );
        }
        const status = yield* waitForStatus(
          client,
          url,
          instanceId,
          isTerminal,
          5,
        );
        return isTerminal(status)
          ? status
          : yield* Effect.fail(new Error(`workflow still ${status.status}`));
      }).pipe(Effect.retry({ times: 3 }));
      return { instanceId, lastStatus };
    }).pipe(
      // A just-deployed workflow can error its first instance while the
      // binding propagates. Retry the scenario with a fresh instance.
      Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 2 }),
    );
    expect(lastStatus.status).toBe("complete");
    expect(lastStatus.error).toBeFalsy();
    expect(lastStatus.output?.greeting).toBe("external-ok");
    expect(lastStatus.output?.instanceId).toBe(instanceId);
  }).pipe(logLevel),
  { timeout: 180_000 },
);

// Canonical `list()` test (account collection): deploy the worker+workflow
// fixture (which creates a `WorkflowResource` named "TestWorkflow"), then
// enumerate every workflow in the account via the typed provider and assert the
// deployed one is present. Bracket with destroy so the test is isolated.
//
// SKIP-GATED on a distilled response-schema mismatch.
// `list()` itself works — the account-scoped `listWorkflows` API returns 200 —
// but decoding fails because pre-existing foreign workflows in the test account
// report `class_name: null`, while distilled's `ListWorkflowsResponse` declares
// `result[].className: Schema.String` (non-nullable). This surfaces as:
//   CloudflareHttpError: {"success":true,...,"result":[{...,"class_name":null,...}]}
// thrown during response decode in distilled client.ts.
//
// NEEDED DISTILLED PATCH (workflows service): make
// `ListWorkflowsResponse.result[].className` nullable
// (`Schema.Union([Schema.String, Schema.Null])`, surfaced as `string | null`).
// This is a response-schema fix (not an error-tag patch), so it must be made
// in the workflows generator/spec by the service owner, then regenerated. Once
// applied, drop the skipIf gate (`CLOUDFLARE_TEST_WORKFLOW_LIST`) and this test
// passes unchanged.
test.provider.skipIf(!process.env.CLOUDFLARE_TEST_WORKFLOW_LIST)(
  "list enumerates the deployed workflow",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* WorkflowTestWorker;
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.Workflows.WorkflowResource,
      );
      const all = yield* provider.list();

      // Physical names are derived from the host Worker name (which carries
      // the stack-id-stage prefix), not the exported class name.
      expect(
        all.some((w) => w.workflowName.startsWith("workflowbindingstack-")),
      ).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
