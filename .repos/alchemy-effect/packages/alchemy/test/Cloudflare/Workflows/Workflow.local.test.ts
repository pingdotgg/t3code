import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Alchemy from "@/index.ts";
import * as State from "@/State/State";
import * as Test from "@/Test/Alchemy";
import * as workflows from "@distilled.cloud/cloudflare/workflows";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import ExplicitNameWorkflowWorker, {
  EXPLICIT_WORKFLOW_NAME,
} from "./fixtures/explicit-name-worker.ts";
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

class WorkflowLinkNotReady extends Data.TaggedError("WorkflowLinkNotReady")<{
  instanceId: string;
}> {}

interface WorkflowStatus {
  status: string;
  output?: {
    greeting: string;
    retryAttempt: number;
    retryConfig: Cloudflare.Workflows.WorkflowStepConfig;
    timeoutConfig: Cloudflare.Workflows.WorkflowStepConfig;
    defaultsOk: boolean;
    workflowName: string;
    instanceId: string;
  };
  error?: { name?: string; message?: string } | null;
  rollback?: {
    outcome: "complete" | "failed";
    error: { message?: string } | null;
  } | null;
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
const startInstance = (url: string, path = "/workflow/start/world") =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.post(`${url}${path}`).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(new WorkerNotReady({ status: res.status })),
      ),
      Effect.retry({
        while: (e) => e._tag === "WorkerNotReady" && e.status === 404,
        schedule: Schedule.spaced("2 seconds"),
        times: 10,
      }),
    );
    const { instanceId } = (yield* res.json) as { instanceId: string };
    expect(instanceId).toBeTypeOf("string");
    return instanceId;
  });

/** Poll one instance without retrying failed workflow executions. */
const waitForTerminal = (url: string, instanceId: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(`${url}/workflow/status/${instanceId}`).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? res.json.pipe(
              Effect.map((json) => json as unknown as WorkflowStatus),
            )
          : res.text.pipe(
              Effect.flatMap((body) =>
                Effect.fail(
                  new Error(`Workflow status ${res.status}: ${body}`),
                ),
              ),
            ),
      ),
      Effect.repeat({
        schedule: Schedule.spaced("3 seconds"),
        until: isTerminal,
        times: 10,
      }),
    );
  });

const runInstance = (url: string, path: string, live = false) =>
  Effect.gen(function* () {
    const instanceId = yield* startInstance(url, path);
    const status = yield* waitForTerminal(url, instanceId);
    // A newly deployed live workflow can precede its worker/engine link.
    if (
      live &&
      status.status === "errored" &&
      status.error?.message === "Worker not found."
    ) {
      return yield* Effect.fail(new WorkflowLinkNotReady({ instanceId }));
    }
    return { instanceId, status };
  }).pipe(
    Effect.retry({
      while: (error) => error instanceof WorkflowLinkNotReady,
      schedule: Schedule.spaced("3 seconds"),
      times: 2,
    }),
  );

const probeWorkflow = Effect.fn(function* (url: string) {
  const ready = yield* Effect.gen(function* () {
    const id = yield* startInstance(url, "/workflow/probe");
    const status = yield* waitForTerminal(url, id);
    yield* Effect.logInfo(
      `Workflow readiness probe ${id}: ${JSON.stringify(status)}`,
    );
    if (
      status.status === "errored" &&
      (status.error?.message === "Worker not found." ||
        (status.error?.name === "TypeError" &&
          (status.error.message ===
            'The RPC receiver does not implement the method "run".' ||
            status.error.message ===
              "The entrypoint name LocalTestWorkflow was not found in this worker. Ensure the worker exports an entrypoint with that name.")))
    )
      return false;
    expect(status).toMatchObject({
      status: "complete",
      output: { ready: true },
    });
    return true;
  }).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      times: 8,
      until: (ready) => ready,
    }),
    Effect.timeout("45 seconds"),
  );
  expect(ready, "Workflow entrypoint did not propagate").toBe(true);
});

const assertRollback = (url: string, live = false) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const { instanceId, status } = yield* runInstance(
      url,
      "/workflow/rollback",
      live,
    );
    expect(status).toMatchObject({ status: "errored" });
    expect(status.error?.message).toContain("rollback requested");
    // Local bindings omit rollback metadata; the persisted records verify execution.
    if (live) {
      expect(status.rollback).toEqual({ outcome: "complete", error: null });
    }

    const response = yield* client.get(
      `${url}/workflow/rollback-result/${instanceId}`,
    );
    expect(response.status).toBe(200);
    expect(yield* response.json).toEqual(
      ["undefined", "both", "timeout-only", "retries-only"].map((step) => ({
        output: { value: "reserved", step },
        error: "rollback requested",
      })),
    );
  });

const assertFailureScenarios = (url: string, live = false) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    for (const scenario of [
      "timeout-zero",
      "rollback-timeout-zero",
      "retry-exhaustion",
      "rollback-retry-exhaustion",
    ]) {
      const { instanceId, status } = yield* runInstance(
        url,
        `/workflow/scenario/${scenario}`,
        live,
      );
      const zeroTimeout = scenario.endsWith("timeout-zero");
      const response = yield* client.get(
        `${url}/workflow/record/${instanceId}/${zeroTimeout ? "protected" : "attempts"}`,
      );
      expect(response.status).toBe(200);
      const record = yield* response.json;
      yield* Effect.log("Workflow failure scenario", {
        scenario,
        status,
        record,
      });
      expect(status).toMatchObject({ status: "errored" });
      if (zeroTimeout) {
        if (live && scenario === "rollback-timeout-zero") {
          // Cloudflare validates rollback config on execution, without exposing its error.
          expect(status.error?.message).toBe("rollback requested");
          expect(status.rollback).toEqual({ outcome: "failed", error: null });
        } else {
          expect(status.error?.message).toContain("invalid format");
        }
        expect(record).toBeNull();
      } else {
        expect(status.error?.message).toContain(
          scenario === "retry-exhaustion"
            ? "retry budget exhausted"
            : "rollback requested",
        );
        expect(record).toEqual({ attempt: 2 });
        if (live && scenario === "rollback-retry-exhaustion") {
          expect(status.rollback?.outcome).toBe("failed");
          expect(status.rollback?.error?.message).toContain(
            "rollback budget exhausted",
          );
        }
      }
    }
  });

/**
 * Read the persisted state row of the nested `Cloudflare.Workflow` resource
 * (the WorkflowResource the `Workflow` effect-class registers under the host
 * worker) from the scratch stack's private state store.
 */
const readWorkflowRow = (stack: Test.ScratchStack) =>
  Effect.gen(function* () {
    const state = yield* yield* State.State;
    const fqns = yield* state.list({ stack: stack.name, stage: stack.stage });
    for (const fqn of fqns) {
      const row = yield* state.get({
        stack: stack.name,
        stage: stack.stage,
        fqn,
      });
      if (
        row &&
        !State.isActionState(row) &&
        row.resourceType === "Cloudflare.Workflow"
      ) {
        return row;
      }
    }
    return undefined;
  }).pipe(Effect.provide(stack.state));

const asyncWorkflowMain = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.resolve(import.meta.dirname, "fixtures/async-workflow-worker.ts");
});

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

      expect(status).toMatchObject({ status: "complete" });
      expect(status.output?.greeting).toBe("Hello, world!");
      expect(status.output?.instanceId).toBe(instanceId);

      expect(status.error).toBeFalsy();
      expect(status.output?.retryAttempt).toBe(2);
      expect(status.output?.retryConfig.retries).toEqual({
        limit: 2,
        delay: "1 second",
        backoff: "constant",
      });
      expect(status.output?.retryConfig.timeout).toBeDefined();
      expect(status.output?.timeoutConfig.timeout).toBe("30 seconds");
      expect(status.output?.timeoutConfig.retries).toBeDefined();
      expect(status.output?.defaultsOk).toBe(true);
      yield* Effect.log("Workflow resolved configuration", status.output);
      yield* assertRollback(url);
      yield* assertFailureScenarios(url);

      const client = yield* HttpClient.HttpClient;
      const events = yield* client
        .get(`${url}/workflow/events/${instanceId}`)
        .pipe(Effect.flatMap((response) => response.json));
      expect(events).toEqual([
        expect.objectContaining({ type: "workflow_queued" }),
      ]);
      const deleted = yield* client
        .post(`${url}/workflow/delete/${instanceId}`)
        .pipe(Effect.flatMap((response) => response.json));
      expect(deleted).toEqual({
        deleted: [],
        errors: [expect.objectContaining({ id: instanceId })],
      });
      const batchId = yield* startInstance(url);
      const batch = yield* client
        .post(`${url}/workflow/delete-batch/${batchId}`)
        .pipe(Effect.flatMap((response) => response.json));
      expect(batch).toEqual({
        deleted: [{ id: batchId }],
        errors: [expect.objectContaining({ id: "missing-instance" })],
      });

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:r2",
      "provider:cloudflare:worker",
      "provider:cloudflare:workflow",
      "local",
    ],
    timeout: 120_000,
  },
);

// Exercise physical names through real workerd bindings, not just metadata.
test.provider(
  "async Worker binding preserves an explicit physical Workflow name",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const workflowName = "existing-workflow-physical-name";
      const main = yield* asyncWorkflowMain;
      const deployWith = (name?: string) =>
        stack.deploy(
          Cloudflare.Worker("ExplicitWorkflowWorker", {
            main,
            env: {
              WORKFLOW_NAME: name ?? workflowName,
              EXISTING_WORKFLOW: Cloudflare.Workflow("ExistingWorkflow", {
                workflowName: name,
              }),
            },
          }),
        );
      const created = yield* deployWith(workflowName);
      const workflowRow = yield* readWorkflowRow(stack);
      expect(workflowRow?.providerMode).toBe("local");
      expect(workflowRow?.attr?.workflowId).toMatch(/^dev:/);
      expect(workflowRow?.attr?.workflowName).toBe(workflowName);
      const instance = yield* startInstance(created.url!);
      expect(
        (yield* waitForTerminal(created.url!, instance)).output?.workflowName,
      ).toBe(workflowName);

      yield* deployWith();
      const preserved = yield* readWorkflowRow(stack);
      expect(preserved?.attr?.workflowId).toBe(workflowRow?.attr?.workflowId);
      expect(preserved?.attr?.workflowName).toBe(workflowName);

      const renamed = yield* deployWith(`${workflowName}-renamed`);
      const replaced = yield* readWorkflowRow(stack);
      expect(replaced?.attr?.workflowId).not.toBe(
        workflowRow?.attr?.workflowId,
      );
      expect(replaced?.attr?.workflowName).toBe(`${workflowName}-renamed`);
      const client = yield* HttpClient.HttpClient;
      const ready = yield* client.get(`${renamed.url!}/workflow/name`).pipe(
        Effect.flatMap((response) => response.text),
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (name) => name === `${workflowName}-renamed`,
          times: 8,
        }),
      );
      expect(ready).toBe(`${workflowName}-renamed`);
      const renamedInstance = yield* startInstance(renamed.url!);
      expect(
        (yield* waitForTerminal(renamed.url!, renamedInstance)).output
          ?.workflowName,
      ).toBe(`${workflowName}-renamed`);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:worker",
      "provider:cloudflare:workflow",
      "local",
    ],
    timeout: 120_000,
  },
);

test.provider(
  "cross-script binding runs the host's explicit Workflow name",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const workflowName = "existing-cross-script-workflow";
      const main = yield* asyncWorkflowMain;
      const host = Cloudflare.Worker("ExplicitWorkflowHost", {
        main,
        env: {
          EXISTING_WORKFLOW: Cloudflare.Workflow("ExistingWorkflow", {
            workflowName,
          }),
        },
      });
      yield* stack.deploy(host);
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* host;
          return yield* Cloudflare.Worker("ExplicitWorkflowConsumer", {
            main,
            env: {
              EXISTING_WORKFLOW: Cloudflare.Workflow("ExistingWorkflow", {
                scriptName: worker.workerName,
                workflowName,
              }),
            },
          });
        }),
      );
      const instance = yield* startInstance(deployed.url!);
      const status = yield* waitForTerminal(deployed.url!, instance);
      expect(status.status).toBe("complete");
      expect(status.output?.workflowName).toBe(workflowName);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:worker",
      "provider:cloudflare:workflow",
      "local",
    ],
    timeout: 120_000,
  },
);

test.provider(
  "Effect-native Worker binding preserves an explicit physical Workflow name",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deployed = yield* stack.deploy(ExplicitNameWorkflowWorker);

      const workflowRow = yield* readWorkflowRow(stack);
      expect(workflowRow?.providerMode).toBe("local");
      expect(workflowRow?.attr?.workflowName).toBe(EXPLICIT_WORKFLOW_NAME);
      const instance = yield* startInstance(deployed.url!);
      const status = yield* waitForTerminal(deployed.url!, instance);
      expect(status.status).toBe("complete");
      expect(status.output?.workflowName).toBe(EXPLICIT_WORKFLOW_NAME);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:worker",
      "provider:cloudflare:workflow",
      "local",
    ],
    timeout: 120_000,
  },
);

test.provider(
  "Alchemy.remote() preserves an explicit Workflow name and schedules",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deployed = yield* stack.deploy(
        ExplicitNameWorkflowWorker.pipe(Alchemy.remote()),
      );
      expect(deployed.url).not.toMatch(/^http:\/\/localhost/);

      const row = yield* readWorkflowRow(stack);
      expect(row?.providerMode).toBe("live");
      expect(row?.attr?.workflowId).not.toMatch(/^dev:/);
      const workflowName = row!.attr!.workflowName;
      const accountId = row!.attr!.accountId;
      const observed = yield* workflows.getWorkflow({
        accountId,
        workflowName,
      });
      expect(observed.id).toBe(row!.attr!.workflowId);
      expect(observed.name).toBe(EXPLICIT_WORKFLOW_NAME);
      expect(observed.schedules?.map((schedule) => schedule.cron)).toEqual([
        "0 0 1 1 *",
      ]);

      const { status } = yield* runInstance(
        deployed.url!,
        "/workflow/start/world",
        true,
      );
      expect(status).toMatchObject({ status: "complete" });
      expect(status.error).toBeFalsy();
      expect(status.output?.greeting).toBe("Hello, world!");
      expect(status.output?.workflowName).toBe(EXPLICIT_WORKFLOW_NAME);

      yield* stack.destroy();
      const gone = yield* workflows
        .getWorkflow({ accountId, workflowName })
        .pipe(
          Effect.as(false),
          Effect.catchTag("WorkflowNotFound", () => Effect.succeed(true)),
        );
      expect(gone).toBe(true);
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:worker",
      "provider:cloudflare:workflow",
      "live",
    ],
    timeout: 120_000,
  },
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

      const url = deployed.worker.url!;
      yield* probeWorkflow(url);
      const { status } = yield* runInstance(url, "/workflow/start/world", true);
      expect(status).toMatchObject({ status: "complete" });
      expect(status.error).toBeFalsy();
      expect(status.output?.greeting).toBe("Hello, world!");
      expect(status.output?.retryAttempt).toBe(2);
      expect(status.output?.retryConfig.retries).toEqual({
        limit: 2,
        delay: "1 second",
        backoff: "constant",
      });
      expect(status.output?.retryConfig.timeout).toBeDefined();
      expect(status.output?.timeoutConfig.timeout).toBe("30 seconds");
      expect(status.output?.timeoutConfig.retries).toBeDefined();
      expect(status.output?.defaultsOk).toBe(true);
      yield* Effect.log("Workflow resolved configuration", status.output);
      yield* assertRollback(url, true);
      yield* assertFailureScenarios(url, true);

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
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:r2",
      "provider:cloudflare:worker",
      "provider:cloudflare:workflow",
      "live",
    ],
    timeout: 120_000,
  },
);
