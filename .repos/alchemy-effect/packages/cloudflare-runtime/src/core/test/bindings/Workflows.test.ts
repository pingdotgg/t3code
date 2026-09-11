import type { InstanceStatus } from "@cloudflare/workers-types/experimental";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Workflows from "../../bindings/workflows/Workflows.ts";
import * as Docker from "../../Docker.ts";
import * as Globals from "../../globals/Globals.ts";
import * as Internet from "../../globals/Internet.ts";
import * as Storage from "../../globals/Storage.ts";
import * as Paths from "../../internal/Paths.ts";
import * as Runtime from "../../Runtime.ts";
import * as RuntimeServices from "../../RuntimeServices.ts";
import * as Workerd from "../../workerd/Workerd.ts";
import type { TestWorker } from "../helpers/runtime.ts";
import {
  localRuntimeLayer,
  PredicateFailed,
  poll,
  startTestWorker,
  waitForRegistryEntry,
  makeTempDirectory,
} from "../helpers/runtime.ts";

const WORKFLOW_SCRIPT = `
import { WorkflowEntrypoint } from "cloudflare:workers";
export class MyWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    await step.do("i'm a step?", async () => "yes you are");
    return "I'm a output string";
  }
}
export default {
  async fetch(request, env) {
    const workflow = await env.MY_WORKFLOW.create({ id: "an-id" });
    return new Response(JSON.stringify(await workflow.status()));
  },
};
`;

const COMPLETE_STATUS =
  '{"status":"complete","__LOCAL_DEV_STEP_OUTPUTS":["yes you are"],"output":"I\'m a output string"}';

describe("Workflows binding", () => {
  // NOTE: this test uses `describe`/`it.effect` (not `layer(...)`), so it picks
  // up the @effect/vitest default `TestEnv` (TestClock + TestConsole). That
  // happens to work here because `runOnceAgainstStorage` provides its own
  // `Runtime.RuntimeLive` layer with a real Clock via `NodeServices.layer`.
  it.effect(
    "persists Workflow data on file-system between runs",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const tmp = yield* makeTempDirectory("workflows-persist-");

        const rumtimeLayerTempDir = Runtime.RuntimeLive.pipe(
          Layer.provideMerge(RuntimeServices.layerLocalBindings()),
          Layer.provide(Globals.GlobalsLive),
          Layer.provideMerge(RuntimeServices.layerLoopback()),
          Layer.provide(Storage.layerDisk(tmp)),
          Layer.provide(Internet.InternetLive),
          Layer.provideMerge(RuntimeServices.layerRegistry()),
          Layer.provide(Paths.PathsLive),
          Layer.provide(Docker.DockerLive),
          Layer.provide(Workerd.WorkerdLive),
          Layer.provideMerge(
            Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer),
          ),
        );

        const runStorageExit = Effect.fn(
          function* () {
            const worker = yield* startTestWorker({
              name: "workflows-persist-test",
              compatibilityDate: "2024-11-20",
              compatibilityFlags: [],
              modules: [
                { name: "main.js", type: "ESModule", content: WORKFLOW_SCRIPT },
              ],
              workflows: [
                { workflowName: "MY_WORKFLOW", className: "MyWorkflow" },
              ],
              bindings: [
                Workflows.local({
                  binding: "MY_WORKFLOW",
                  workflowName: "MY_WORKFLOW",
                  className: "MyWorkflow",
                }),
              ],
            });

            const res = yield* worker.fetch("/");
            expect(res.status).toBe(200);

            return yield* worker.fetchText("/").pipe(
              Effect.flatMap((text) =>
                text === COMPLETE_STATUS
                  ? Effect.succeed(text)
                  : Effect.fail(new PredicateFailed({ value: text })),
              ),
              Effect.retry({
                while: (error) => error._tag === "PredicateFailed",
                schedule: Schedule.spaced("50 millis"),
                times: 5000 / 50,
              }),
            );
          },
          (self) =>
            self.pipe(Effect.provide(rumtimeLayerTempDir), Effect.scoped),
        );

        const first = yield* runStorageExit();
        expect(first).toBe(COMPLETE_STATUS);

        const persistDir = path.join(tmp, "workflows");
        const names = yield* fs.readDirectory(persistDir);
        expect(names).toContain(encodeURIComponent("MY_WORKFLOW"));

        const second = yield* runStorageExit();
        expect(second).toBe(COMPLETE_STATUS);
      }).pipe(Effect.provide(NodeServices.layer)),
    { timeout: 30_000 },
  );
});

const LIFECYCLE_SCRIPT = `
import { WorkflowEntrypoint } from "cloudflare:workers";
export class LifecycleWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    await step.do("first step", async () => "step-1-done");
    await step.do("long step", async () => {
      await scheduler.wait(500);
      return "long-step-done";
    });
    await step.do("third step", async () => "step-3-done");
    return "workflow-complete";
  }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const id = url.searchParams.get("id") || "lifecycle-test";

    if (url.pathname === "/create") {
      const instance = await env.LIFECYCLE_WORKFLOW.create({ id });
      const status = await instance.status();
      return Response.json({ id: instance.id, status });
    }
    if (url.pathname === "/status") {
      const instance = await env.LIFECYCLE_WORKFLOW.get(id);
      return Response.json(await instance.status());
    }
    if (url.pathname === "/pause") {
      const instance = await env.LIFECYCLE_WORKFLOW.get(id);
      await instance.pause();
      return Response.json(await instance.status());
    }
    if (url.pathname === "/resume") {
      const instance = await env.LIFECYCLE_WORKFLOW.get(id);
      await instance.resume();
      return Response.json(await instance.status());
    }
    if (url.pathname === "/restart") {
      const instance = await env.LIFECYCLE_WORKFLOW.get(id);
      await instance.restart();
      return Response.json(await instance.status());
    }
    if (url.pathname === "/terminate") {
      const instance = await env.LIFECYCLE_WORKFLOW.get(id);
      await instance.terminate();
      return Response.json(await instance.status());
    }
    return new Response("Not found", { status: 404 });
  },
};
`;

const startLifecycleWorker = () =>
  startTestWorker({
    name: "workflows-lifecycle-test",
    compatibilityDate: "2026-03-09",
    compatibilityFlags: [],
    modules: [{ name: "main.js", type: "ESModule", content: LIFECYCLE_SCRIPT }],
    workflows: [
      { workflowName: "LIFECYCLE_WORKFLOW", className: "LifecycleWorkflow" },
    ],
    bindings: [
      Workflows.local({
        binding: "LIFECYCLE_WORKFLOW",
        workflowName: "LIFECYCLE_WORKFLOW",
        className: "LifecycleWorkflow",
      }),
    ],
  });

// A single worker that owns two workflows. Each owned workflow contributes a
// `workflows:<name>` Engine service plus a *shared* `workflows:storage`
// service; the storage service must only be created once.
const TWO_WORKFLOWS_SCRIPT = `
import { WorkflowEntrypoint } from "cloudflare:workers";
export class AlphaWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    await step.do("alpha step", async () => "alpha-done");
    return "alpha-output";
  }
}
export class BetaWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    await step.do("beta step", async () => "beta-done");
    return "beta-output";
  }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/create") {
      const alpha = await env.ALPHA_WORKFLOW.create({ id: "alpha" });
      const beta = await env.BETA_WORKFLOW.create({ id: "beta" });
      return Response.json({ alpha: alpha.id, beta: beta.id });
    }
    if (url.pathname === "/status") {
      const id = url.searchParams.get("id");
      const binding = id === "beta" ? env.BETA_WORKFLOW : env.ALPHA_WORKFLOW;
      const instance = await binding.get(id);
      return Response.json(await instance.status());
    }
    return new Response("not found", { status: 404 });
  },
};
`;

// `excludeTestServices: true` keeps the real wall-clock Clock. Without it,
// `@effect/vitest` provides a TestClock and `Effect.sleep` would block (since
// nothing advances the virtual clock). The workflow engine's `pause`/`restart`
// flow relies on a real timer firing in `workerd` for the in-flight step, and
// we observe it from Node by polling on the real clock.
layer(localRuntimeLayer, { excludeTestServices: true })(
  "Workflows binding lifecycle",
  (it) => {
    it.effect(
      "pause and resume a running workflow",
      () =>
        Effect.gen(function* () {
          const worker = yield* startLifecycleWorker();
          const id = "pause-resume-test";

          const createData = yield* worker.fetchJson<{ id: string }>(
            `/create?id=${id}`,
          );
          expect(createData.id).toBe(id);

          yield* pollStepOutput(worker, id, "step-1-done");

          const pauseData = yield* worker.fetchJson<InstanceStatus>(
            `/pause?id=${id}`,
          );
          expect(pauseData).toHaveProperty("status");

          yield* pollStatus(worker, id, "paused");

          const resumeData = yield* worker.fetchJson<InstanceStatus>(
            `/resume?id=${id}`,
          );
          expect(resumeData).toHaveProperty("status");

          const final = yield* pollStatus(worker, id, "complete");
          expect(final.output).toBe("workflow-complete");
        }),
      { timeout: 30_000 },
    );

    it.effect(
      "terminate a running workflow",
      () =>
        Effect.gen(function* () {
          const worker = yield* startLifecycleWorker();
          const id = "terminate-test";

          const createRes = yield* worker.fetch(`/create?id=${id}`);
          expect(createRes.status).toBe(200);

          yield* pollStepOutput(worker, id, "step-1-done");

          const terminateData = yield* worker.fetchJson<InstanceStatus>(
            `/terminate?id=${id}`,
          );
          expect(terminateData).toHaveProperty("status");

          yield* pollStatus(worker, id, "terminated");
        }),
      { timeout: 30_000 },
    );

    it.effect(
      "restart a running workflow",
      () =>
        Effect.gen(function* () {
          const worker = yield* startLifecycleWorker();
          const id = "restart-test";

          yield* worker.fetch(`/create?id=${id}`);

          yield* pollStepOutput(worker, id, "step-1-done");

          const restartData = yield* worker.fetchJson<InstanceStatus>(
            `/restart?id=${id}`,
          );
          expect(restartData).toHaveProperty("status");

          const final = yield* pollStatus(worker, id, "complete");
          expect(final.output).toBe("workflow-complete");
        }),
      { timeout: 30_000 },
    );

    // Regression: a worker that owns more than one workflow must start. Each
    // owned workflow contributes a `workflows:<name>` Engine service plus a
    // *shared* `workflows:storage` service that must be created only once.
    it.effect(
      "a worker can own two workflows without duplicating workflows:storage",
      () =>
        Effect.gen(function* () {
          const worker = yield* startTestWorker({
            name: "workflows-multi-test",
            compatibilityDate: "2026-03-09",
            compatibilityFlags: [],
            modules: [
              {
                name: "main.js",
                type: "ESModule",
                content: TWO_WORKFLOWS_SCRIPT,
              },
            ],
            workflows: [
              { workflowName: "ALPHA_WORKFLOW", className: "AlphaWorkflow" },
              { workflowName: "BETA_WORKFLOW", className: "BetaWorkflow" },
            ],
            bindings: [
              Workflows.local({
                binding: "ALPHA_WORKFLOW",
                workflowName: "ALPHA_WORKFLOW",
                className: "AlphaWorkflow",
              }),
              Workflows.local({
                binding: "BETA_WORKFLOW",
                workflowName: "BETA_WORKFLOW",
                className: "BetaWorkflow",
              }),
            ],
          });

          const createRes = yield* worker.fetch(`/create`);
          expect(createRes.status).toBe(200);

          const alpha = yield* pollStatus(worker, "alpha", "complete");
          expect(alpha.output).toBe("alpha-output");

          const beta = yield* pollStatus(worker, "beta", "complete");
          expect(beta.output).toBe("beta-output");
        }),
      { timeout: 30_000 },
    );
  },
);

// Cross-instance test: a workflow defined by one `Runtime` (the owner) is
// invoked from a workflow binding declared in a *different* `Runtime` (the
// consumer). The consumer must NOT host its own Engine — instead, its
// wrapped binding is routed through the dev-registry proxy to the owner.
//
// This test runs both runtimes in-process by nesting two `Effect.provide(
// localRuntimeLayer)` blocks. They communicate via the on-disk dev
// registry, which we point at a temp dir via MINIFLARE_REGISTRY_PATH.

const CROSS_INSTANCE_OWNER_SCRIPT = `
import { WorkflowEntrypoint } from "cloudflare:workers";
export class CrossWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const first = await step.do("step-1", async () => "from-owner");
    return { ok: true, payload: first };
  }
}
export default {
  async fetch() {
    // Owner exposes no HTTP API; the consumer drives the workflow.
    return new Response("owner-alive");
  },
};
`;

const CROSS_INSTANCE_CONSUMER_SCRIPT = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const id = url.searchParams.get("id") ?? "cross-instance-test";
    if (url.pathname === "/create") {
      const instance = await env.CROSS_WORKFLOW.create({ id });
      return Response.json({ id: instance.id });
    }
    if (url.pathname === "/status") {
      const instance = await env.CROSS_WORKFLOW.get(id);
      return Response.json(await instance.status());
    }
    return new Response("not found", { status: 404 });
  },
};
`;

layer(localRuntimeLayer, { excludeTestServices: true })(
  "Workflows binding cross-instance",
  (it) => {
    it.effect(
      "consumer binding routes to the owner's engine via the dev registry",
      () =>
        Effect.gen(function* () {
          // Owner: defines the WorkflowEntrypoint class and hosts the Engine.
          // Ownership comes from `workflows` — no local binding is required.
          yield* startTestWorker({
            name: "cross-owner",
            compatibilityDate: "2026-03-09",
            compatibilityFlags: [],
            modules: [
              {
                name: "main.js",
                type: "ESModule",
                content: CROSS_INSTANCE_OWNER_SCRIPT,
              },
            ],
            workflows: [
              { workflowName: "CROSS_WORKFLOW", className: "CrossWorkflow" },
            ],
            bindings: [],
          });

          // Consumer: declares the binding with `scriptName` pointing at
          // the owner. It does NOT define `CrossWorkflow`, so its Workflows
          // plugin must skip engine creation and route through the proxy.
          const consumer = yield* startTestWorker({
            name: "cross-consumer",
            compatibilityDate: "2026-03-09",
            compatibilityFlags: [],
            modules: [
              {
                name: "main.js",
                type: "ESModule",
                content: CROSS_INSTANCE_CONSUMER_SCRIPT,
              },
            ],
            bindings: [
              Workflows.local({
                binding: "CROSS_WORKFLOW",
                workflowName: "CROSS_WORKFLOW",
                className: "CrossWorkflow",
                scriptName: "cross-owner",
              }),
            ],
          });

          yield* waitForRegistryEntry({
            kind: "workflow",
            scriptName: "cross-owner",
            workflowName: "CROSS_WORKFLOW",
          });

          const id = "cross-instance-1";
          const createRes = yield* consumer.fetch(`/create?id=${id}`);
          expect(createRes.status).toBe(200);

          const result = yield* pollStatus(consumer, id, "complete");
          expect(result).toMatchObject({
            status: "complete",
            output: { ok: true, payload: "from-owner" },
          });
        }),
      { timeout: 30_000 },
    );
  },
);

const pollStatus = (
  worker: TestWorker,
  id: string,
  expected: InstanceStatus["status"],
) =>
  poll<InstanceStatus>(
    worker,
    `/status?id=${id}`,
    (json) => json.status === expected,
  );

const pollStepOutput = (worker: TestWorker, id: string, expected: string) =>
  poll<{ __LOCAL_DEV_STEP_OUTPUTS?: ReadonlyArray<string> }>(
    worker,
    `/status?id=${id}`,
    (json) => json.__LOCAL_DEV_STEP_OUTPUTS?.includes(expected) ?? false,
  );
