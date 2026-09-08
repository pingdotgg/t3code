import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Alchemy";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as workflows from "@distilled.cloud/cloudflare/workflows";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Stack from "./fixtures/workflow-async/stack.ts";

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
  output?: { greeting: string };
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
    const { instanceId } = yield* client
      .post(`${url}/workflow/start/world`)
      .pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? res.json.pipe(
                Effect.flatMap((body) => {
                  const instanceId = (body as { instanceId?: unknown })
                    .instanceId;
                  return typeof instanceId === "string"
                    ? Effect.succeed({ instanceId })
                    : Effect.fail(new Error("Worker returned no workflow id"));
                }),
              )
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
    expect(instanceId).toBeTypeOf("string");

    const lastStatus = yield* client
      .get(`${url}/workflow/status/${instanceId}`)
      .pipe(
        // The status endpoint transiently returns a 500 (HTML error page, not
        // JSON) while the freshly-deployed worker's Workflow binding is still
        // propagating. Only decode JSON on a 200; treat any other status as a
        // non-terminal "pending" so the poll keeps swinging instead of dying
        // on a JSON decode error.
        Effect.flatMap((res) =>
          res.status === 200
            ? res.json.pipe(
                Effect.map((json) => json as unknown as WorkflowStatus),
              )
            : Effect.succeed({ status: "pending" } as WorkflowStatus),
        ),
        Effect.repeat({
          // Under full-suite load a fresh workflow instance can sit in
          // `pending`/`queued` well past 24s before its first step runs;
          // give each attempt ~60s before handing back to the outer retry.
          schedule: Schedule.spaced("2 seconds"),
          until: (s) => s.status === "complete" || s.status === "errored",
          times: 30,
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
  "async worker can run a class-based workflow bound via env",
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
  }).pipe(logLevel),
  // Budget covers the full retry envelope: up to 3 attempts, each with a
  // capped start-retry (~30s worst case) + status polling (30 × 2s).
  { timeout: 300_000 },
);

// ---------------------------------------------------------------------------
// Cross-script binding: a consumer Worker binds a Workflow hosted by another
// Worker script via `scriptName`. The host owns the workflow (props-only form
// with no `scriptName` → drives `putWorkflow`); the consumer's binding is a
// reference only. Inline `script` keeps both workers in this one file.
// ---------------------------------------------------------------------------

// Host hosts the WorkflowEntrypoint class AND drives a workflow instance.
const hostWorkflowScript = `import { WorkflowEntrypoint } from "cloudflare:workers";
export class MyWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const greeting = await step.do("greet", async () => \`Hello, \${event.payload.value}!\`);
    return await step.do("finalize", async () => ({ greeting }));
  }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/workflow/start/")) {
      const value = url.pathname.split("/workflow/start/")[1] ?? "world";
      const instance = await env.MY_WORKFLOW.create({ params: { value } });
      return Response.json({ instanceId: instance.id });
    }
    if (url.pathname.startsWith("/workflow/status/")) {
      const id = url.pathname.split("/workflow/status/")[1] ?? "";
      const instance = await env.MY_WORKFLOW.get(id);
      return Response.json(await instance.status());
    }
    return new Response("ok");
  },
};
`;

// Consumer has no class — it only references the host's workflow.
const consumerWorkflowScript = `export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/workflow/start/")) {
      const value = url.pathname.split("/workflow/start/")[1] ?? "world";
      const instance = await env.MY_WORKFLOW.create({ params: { value } });
      return Response.json({ instanceId: instance.id });
    }
    if (url.pathname.startsWith("/workflow/status/")) {
      const id = url.pathname.split("/workflow/status/")[1] ?? "";
      const instance = await env.MY_WORKFLOW.get(id);
      return Response.json(await instance.status());
    }
    return new Response("ok");
  },
};
`;

test.provider(
  "async worker workflow binding accepts scriptName (cross-script)",
  (scratch) =>
    Effect.gen(function* () {
      // Deploy the host first so its workflow exists (putWorkflow) before the
      // consumer references it by scriptName.
      yield* scratch.deploy(
        Effect.gen(function* () {
          return {
            host: yield* Cloudflare.Worker("host-workflow-worker", {
              script: hostWorkflowScript,
              env: {
                MY_WORKFLOW: Cloudflare.Workflow("MyWorkflow"),
              },
            }),
          };
        }),
      );

      const deployed = yield* scratch.deploy(
        Effect.gen(function* () {
          const host = yield* Cloudflare.Worker("host-workflow-worker", {
            script: hostWorkflowScript,
            env: {
              MY_WORKFLOW: Cloudflare.Workflow("MyWorkflow"),
            },
          });
          const consumer = yield* Cloudflare.Worker(
            "consumer-workflow-worker",
            {
              script: consumerWorkflowScript,
              env: {
                MY_WORKFLOW: Cloudflare.Workflow("MyWorkflow", {
                  scriptName: host.workerName,
                }),
              },
            },
          );
          return { consumer, host };
        }),
      );

      // Start + complete a workflow instance through the CONSUMER's binding,
      // exercising both `create` and `get` across the cross-script reference.
      const lastStatus = yield* runWorkflowToCompletion(
        deployed.consumer.url!,
      ).pipe(
        Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 2 }),
      );

      expect(lastStatus.status).toBe("complete");
      expect(lastStatus.error).toBeFalsy();
      expect(lastStatus.output?.greeting).toBe("Hello, world!");

      yield* scratch.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// ---------------------------------------------------------------------------
// Per-workflow limits: deploy a locally-hosted workflow declared with a step
// limit, then read it back out-of-band from the versions API (the only read
// that surfaces `limits`) to confirm it was applied.
// ---------------------------------------------------------------------------

const limitsWorkflowScript = `import { WorkflowEntrypoint } from "cloudflare:workers";
export class LimitsWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    return await step.do("noop", async () => "ok");
  }
}
export default {
  async fetch() {
    return new Response("ok");
  },
};
`;

// Physical workflow names are derived from the host Worker name and class, so
// read the name off the deployed binding rather than assuming the class name.
const readWorkflowName = (scriptName: string) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const settings = yield* workers.getScriptScriptAndVersionSetting({
      accountId,
      scriptName,
    });
    const binding = (settings.bindings ?? []).find(
      (b): b is Extract<typeof b, { type: "workflow" }> =>
        b.type === "workflow",
    );
    return binding === undefined
      ? yield* Effect.fail(new Error(`no workflow binding on '${scriptName}'`))
      : binding.workflowName;
  });

// Read the applied step limit out-of-band via the versions API, retrying until
// it propagates (bounded, so a missing limit fails fast).
const waitForAppliedStepLimit = (workflowName: string, expected: number) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const versions = yield* workflows.listVersions
      .items({ accountId, workflowName })
      .pipe(Stream.runCollect);
    return Array.from(versions)
      .map((v) => v.limits?.steps ?? undefined)
      .find((steps) => steps !== undefined);
  }).pipe(
    Effect.flatMap((steps) =>
      steps === expected
        ? Effect.succeed(steps)
        : Effect.fail(new Error(`steps limit not applied yet: ${steps}`)),
    ),
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 15 }),
  );

test.provider(
  "async worker workflow binding applies a per-workflow step limit",
  (scratch) =>
    Effect.gen(function* () {
      const steps = 100;

      const deployed = yield* scratch.deploy(
        Effect.gen(function* () {
          return {
            worker: yield* Cloudflare.Worker("limits-workflow-worker", {
              script: limitsWorkflowScript,
              env: {
                LIMITS_WORKFLOW: Cloudflare.Workflow("LimitsWorkflow", {
                  limits: { steps },
                }),
              },
            }),
          };
        }),
      );

      const workflowName = yield* readWorkflowName(deployed.worker.workerName);
      const applied = yield* waitForAppliedStepLimit(workflowName, steps);
      expect(applied).toBe(steps);

      yield* scratch.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
