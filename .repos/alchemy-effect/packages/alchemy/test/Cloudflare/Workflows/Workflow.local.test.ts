import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment.ts";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Alchemy from "@/index.ts";
import * as State from "@/State/State";
import * as Test from "@/Test/Alchemy";
import * as workflows from "@distilled.cloud/cloudflare/workflows";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import WorkflowLocalWorker from "./fixtures/workflow-worker.ts";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command (see
// MakeOptions.sidecar in Test/Core.ts).
const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
}> {}

interface WorkflowStatus {
  status: string;
  output?: {
    greeting: string;
    workflowName: string;
    instanceId: string;
  };
  error?: { message?: string } | null;
}

const isTerminal = (status: WorkflowStatus): boolean =>
  status.status === "complete" ||
  status.status === "errored" ||
  status.status === "terminated";

/**
 * Start a workflow instance over HTTP, retrying while the freshly-served
 * worker is still coming up (local workerd boots fast; a fresh workers.dev
 * URL takes a few seconds to start serving 200s).
 */
const startInstance = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.post(`${url}/workflow/start/world`).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(new WorkerNotReady({ status: res.status })),
      ),
      Effect.retry({
        while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
        // Cap the exponential so a persistent non-200 fails fast instead of
        // looking like a hang.
        schedule: Schedule.max([
          Schedule.min([
            Schedule.exponential("500 millis"),
            Schedule.spaced("3 seconds"),
          ]),
          Schedule.recurs(15),
        ]),
      }),
    );
    const { instanceId } = (yield* res.json) as { instanceId: string };
    expect(instanceId).toBeTypeOf("string");
    return instanceId;
  });

/**
 * Poll the status route until the instance reaches a terminal state. The
 * status endpoint can transiently 500 while a fresh worker's Workflow
 * binding is still propagating — treat any non-200 as "pending".
 */
const waitForTerminal = (url: string, instanceId: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(`${url}/workflow/status/${instanceId}`).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? res.json.pipe(
              Effect.map((json) => json as unknown as WorkflowStatus),
            )
          : Effect.succeed({ status: "pending" } as WorkflowStatus),
      ),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: isTerminal,
        times: 30,
      }),
    );
  });

/**
 * Read the persisted state row of the nested `Cloudflare.Workflow` resource
 * (the WorkflowResource the `Workflow` effect-class registers under the host
 * worker) from the scratch stack's private state store.
 */
const readWorkflowRow = (stack: Test.ScratchStack) =>
  Effect.gen(function* () {
    const state = yield* yield* State.State;
    const fqns = yield* state.list({ stack: stack.name, stage: "test" });
    for (const fqn of fqns) {
      const row = yield* state.get({ stack: stack.name, stage: "test", fqn });
      if (
        row &&
        (row as { resourceType?: string }).resourceType ===
          "Cloudflare.Workflow"
      ) {
        return row as {
          resourceType: string;
          providerMode?: "live" | "local";
          attr?: {
            workflowId: string;
            workflowName: string;
            accountId: string;
          };
        };
      }
    }
    return undefined;
  }).pipe(Effect.provide(stack.state));

/**
 * Under `alchemy dev` the Workflow resource is emulated by the local provider
 * (a `dev:` id, no cloud API calls) and the host worker's `workflow` binding
 * is lowered onto the local workerd workflow engine. This exercises the full
 * local roundtrip: create an instance through the binding and poll it to
 * completion against the local simulator.
 */
test.provider(
  "workflow runs to completion against the local simulator",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* WorkflowLocalWorker;
          return { worker };
        }),
      );

      // The worker serves from the local dev proxy — proof the stack ran in
      // local mode.
      expect(deployed.worker.url).toMatch(/^http:\/\/localhost:\d+$/);

      // The local provider fabricated a `dev:` workflow id (proof no cloud
      // call ran) and the row is stamped with the local provider mode.
      const row = yield* readWorkflowRow(stack);
      expect(row).toBeDefined();
      expect(row!.attr?.workflowId).toMatch(/^dev:/);
      expect(row!.providerMode).toBe("local");

      // Drive the workflow through the binding against local workerd.
      const url = deployed.worker.url!;
      const instanceId = yield* startInstance(url);
      const status = yield* waitForTerminal(url, instanceId);

      expect(status.status).toBe("complete");
      expect(status.output?.greeting).toBe("Hello, world!");
      expect(status.output?.instanceId).toBe(instanceId);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

/**
 * `Alchemy.remote()` opts the whole worker + hosted workflow OUT of local
 * emulation: even under `alchemy dev` the worker deploys to real Cloudflare
 * and `putWorkflow` registers a real account-level Workflow. The workflow
 * class is hosted BY the worker script, so both must run live together —
 * a live workflow cannot reference a script that only exists in local
 * workerd. After destroy, an out-of-band `getWorkflow` proves the cloud
 * workflow is gone (pins the stamped-mode delete path).
 */
test.provider(
  "Alchemy.remote() worker + workflow run live in dev and delete on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* WorkflowLocalWorker;
          return { worker };
        }).pipe(Alchemy.remote()),
      );

      // Live deploy: a real workers.dev URL, not the local dev proxy.
      expect(deployed.worker.url).not.toMatch(/^http:\/\/localhost/);

      // The workflow has a real Cloudflare id and a `live` mode stamp.
      const row = yield* readWorkflowRow(stack);
      expect(row).toBeDefined();
      expect(row!.attr?.workflowId).not.toMatch(/^dev:/);
      expect(row!.providerMode).toBe("live");
      const workflowName = row!.attr!.workflowName;
      const workflowAccountId = row!.attr!.accountId;

      // Out-of-band: the workflow exists on real Cloudflare.
      const live = yield* workflows.getWorkflow({
        accountId: workflowAccountId,
        workflowName,
      });
      expect(live.id).toBe(row!.attr!.workflowId);

      // Round-trip an instance through the real edge. A freshly-deployed
      // worker's engine link can still be propagating, in which case the
      // instance terminates `errored` ("Worker not found.") — the same
      // transient the live suite rides out (see Workers/Workflow.test.ts
      // `runWorkflowToCompletion`): fail the attempt and retry with a
      // brand-new instance.
      const url = deployed.worker.url!;
      const status = yield* Effect.gen(function* () {
        const instanceId = yield* startInstance(url);
        const terminal = yield* waitForTerminal(url, instanceId);
        if (terminal.status !== "complete") {
          return yield* Effect.fail(
            new Error(
              `workflow expected complete, got ${terminal.status}: ${JSON.stringify(terminal)}`,
            ),
          );
        }
        return terminal;
      }).pipe(
        Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 2 }),
      );
      expect(status.output?.greeting).toBe("Hello, world!");

      yield* stack.destroy();

      // The live-stamped row was deleted through the live provider even in a
      // dev run — the cloud workflow is gone.
      const gone = yield* workflows
        .getWorkflow({ accountId: workflowAccountId, workflowName })
        .pipe(
          Effect.as(false),
          Effect.catchTag("WorkflowNotFound", () => Effect.succeed(true)),
        );
      expect(gone).toBe(true);
    }).pipe(logLevel),
  { timeout: 180_000 },
);
