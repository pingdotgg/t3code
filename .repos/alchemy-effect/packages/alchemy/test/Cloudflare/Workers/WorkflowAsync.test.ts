import { adopt } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { WorkflowResource } from "@/Cloudflare/Workflows/Workflow";
import { generateWorkflowName } from "@/Cloudflare/Workflows/WorkflowName";
import { sha256 } from "@/Util/sha256";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Exit from "effect/Exit";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as TestCore from "@/Test/Core";
import * as queues from "@distilled.cloud/cloudflare/queues";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as workflows from "@distilled.cloud/cloudflare/workflows";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { requestWorker } from "../Utils/WorkerRequest.ts";
import ColdEffectWorker, {
  COLD_EFFECT_WORKFLOW_NAME,
} from "./fixtures/workflow-async/effect-worker.ts";
import { AsyncWorkflowWorker } from "./fixtures/workflow-async/stack.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const retry = Effect.retry({
  schedule: Schedule.spaced("3 seconds"),
  times: 10,
});
const hostMain = `${import.meta.dirname}/fixtures/workflow-async/worker.ts`;
const consumerMain = `${import.meta.dirname}/fixtures/workflow-async/consumer.ts`;

const WorkflowStatus = Schema.Struct({
  status: Schema.String,
  output: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        greeting: Schema.String,
        workflowName: Schema.optional(Schema.String),
      }),
    ),
  ),
  error: Schema.optional(
    Schema.NullOr(Schema.Struct({ message: Schema.optional(Schema.String) })),
  ),
});

const WorkflowEvents = Schema.Array(
  Schema.Struct({
    type: Schema.String,
    source: Schema.Struct({ type: Schema.String, workflowName: Schema.String }),
    payload: Schema.Struct({ instanceId: Schema.String }),
  }),
);

const EnvResponse = Schema.Struct({
  greeting: Schema.String,
  config: Schema.String,
  effect: Schema.String,
  output: Schema.String,
  asset: Schema.String,
});

const getJson = <A>(url: string, schema: Schema.Decoder<A>) =>
  Effect.gen(function* () {
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    return yield* client.get(url).pipe(
      Effect.flatMap((res) => res.json),
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      retry,
    );
  });

const runWorkflowToCompletion = (url: string, expectedWorkflowName?: string) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const client = HttpClient.filterStatusOk(http);
    if (expectedWorkflowName !== undefined) {
      const identity = yield* getJson(
        `${url}/workflow/identity`,
        Schema.Struct({ workflowName: Schema.optional(Schema.String) }),
      ).pipe(
        Effect.tap((identity) =>
          Effect.logInfo("Workflow identity readiness", {
            expected: expectedWorkflowName,
            observed: identity.workflowName,
          }),
        ),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (identity) => identity.workflowName === expectedWorkflowName,
          times: 10,
        }),
        Effect.timeout("30 seconds"),
      );
      expect(identity.workflowName).toBe(expectedWorkflowName);
      const rejected = yield* http.post(`${url}/workflow/start/world`, {
        headers: {
          "x-expected-workflow-name": `${expectedWorkflowName}-stale`,
        },
      });
      yield* rejected.text;
      expect(rejected.status).toBe(409);
    }
    const { instanceId } = yield* client
      .post(
        `${url}/workflow/start/world`,
        expectedWorkflowName === undefined
          ? undefined
          : { headers: { "x-expected-workflow-name": expectedWorkflowName } },
      )
      .pipe(
        Effect.flatMap((res) => res.json),
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Struct({ instanceId: Schema.String }),
          ),
        ),
        retry,
      );

    const status = yield* getJson(
      `${url}/workflow/status/${instanceId}`,
      WorkflowStatus,
    ).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("3 seconds"),
        until: (s) => s.status === "complete" || s.status === "errored",
        times: 10,
      }),
      Effect.timeout("60 seconds"),
    );
    if (status.status !== "complete") {
      return yield* Effect.fail(
        new Error(`workflow ${status.status}: ${JSON.stringify(status.error)}`),
      );
    }
    expect(status.error).toBeFalsy();
    expect(status.output?.greeting).toBe("Hello, world!");
    return { ...status, instanceId };
  });

const readWorkflowBinding = (scriptName: string) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const settings = yield* workers.getScriptScriptAndVersionSetting({
      accountId,
      scriptName,
    });
    const bindings = (settings.bindings ?? []).filter(
      (binding) => binding.type === "workflow",
    );
    expect(bindings).toHaveLength(1);
    return bindings[0]!;
  });

const expectWorkerGone = (accountId: string, scriptName: string) =>
  workers.getScriptScriptAndVersionSetting({ accountId, scriptName }).pipe(
    Effect.as(false),
    Effect.catchTag("WorkerNotFound", () => Effect.succeed(true)),
    Effect.catchTag("WorkerHasNoVersions", () => Effect.succeed(false)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: Boolean,
      times: 10,
    }),
    Effect.tap((gone) => Effect.sync(() => expect(gone).toBe(true))),
  );

const expectWorkflowGone = (accountId: string, workflowName: string) =>
  workflows.getWorkflow({ accountId, workflowName }).pipe(
    Effect.as(false),
    Effect.catchTag("WorkflowNotFound", () => Effect.succeed(true)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: Boolean,
      times: 10,
    }),
    Effect.tap((gone) => Effect.sync(() => expect(gone).toBe(true))),
  );

const bindingSnapshot = (binding: Cloudflare.Workflows.WorkflowBinding) => ({
  kind: binding.kind,
  name: binding.name,
  className: binding.className,
  workflowName: binding.workflowName,
  scriptName: binding.scriptName,
  workflowIsOutput: Output.isOutput(binding.workflowName),
  scriptIsOutput: Output.isOutput(binding.scriptName),
});

test.provider(
  "async worker workflow binding is a direct first-deployment queue subscription source",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const program = Effect.gen(function* () {
        const worker = yield* AsyncWorkflowWorker;
        const queue = yield* Cloudflare.Queues.Queue("WorkflowEventsQueue");
        const subscription = yield* Cloudflare.Queues.Subscription(
          "WorkflowEvents",
          {
            source: worker.env.MY_WORKFLOW,
            events: ["instance.completed", "instance.errored"],
            queueId: queue.queueId,
          },
        );
        expect(subscription.Props.source).toEqual({
          type: "workflows.workflow",
          workflowName: worker.env.MY_WORKFLOW.workflowName,
        });
        yield* Cloudflare.Queues.Consumer("WorkflowEventsConsumer", {
          queueId: queue.queueId,
          scriptName: worker.workerName,
          settings: { batchSize: 1, maxWaitTimeMs: 1000 },
        });
        return {
          worker,
          queue,
          subscription,
          binding: bindingSnapshot(worker.env.MY_WORKFLOW),
          env: {
            greeting: worker.env.GREETING,
            config: worker.env.CONFIG,
            effect: worker.env.EFFECT,
            output: worker.env.OUTPUT,
            outputIsOutput: Output.isOutput(worker.env.OUTPUT),
            assets: worker.env.ASSETS,
          },
        };
      });
      const deployed = yield* stack.deploy(program);
      const plan = yield* stack.plan(program);
      expect(plan.resources.Greeting.downstream).toContain("WorkflowEvents");
      expect(
        Object.values(plan.resources).filter(
          (node) => node.resource.Type === "Cloudflare.Workflow",
        ),
      ).toHaveLength(1);

      const { binding, worker, queue, subscription } = deployed;
      expect(binding.workflowIsOutput).toBe(true);
      expect(binding.scriptIsOutput).toBe(true);
      expect(binding.kind).toBe("Cloudflare.Workflow");
      expect(binding.name).toBe("Greeting");
      expect(binding.className).toBe("MyWorkflow");
      expect(binding.scriptName).toBe(worker.workerName);
      expect(deployed.env).toEqual({
        greeting: "hello",
        config: "configured",
        effect: "effect",
        output: "output",
        outputIsOutput: true,
        assets: { kind: "Cloudflare.Workers.Assets" },
      });

      const uploaded = yield* readWorkflowBinding(worker.workerName);
      expect(uploaded.workflowName).toBe(binding.workflowName);
      expect(uploaded.className).toBe(binding.className);
      const observed = yield* workflows.getWorkflow({
        accountId,
        workflowName: binding.workflowName,
      });
      expect(observed.name).toBe(binding.workflowName);
      expect(observed.scriptName).toBe(binding.scriptName);
      expect(observed.className).toBe(binding.className);
      const source = {
        type: "workflows.workflow",
        workflowName: binding.workflowName,
      };
      expect(subscription.source).toEqual(source);
      expect(plan.resources.WorkflowEvents.state).toHaveProperty(
        "props.source",
        source,
      );
      const liveSubscription = yield* queues.getSubscription({
        accountId,
        subscriptionId: subscription.subscriptionId,
      });
      expect(liveSubscription.source).toEqual(expect.objectContaining(source));
      expect(liveSubscription.destination.queueId).toBe(queue.queueId);

      expect(yield* getJson(`${worker.url}/env`, EnvResponse)).toEqual({
        greeting: "hello",
        config: "configured",
        effect: "effect",
        output: "output",
        asset: "workflow asset\n",
      });
      const { instanceId } = yield* runWorkflowToCompletion(worker.url!);
      const events = yield* getJson(
        `${worker.url}/events`,
        WorkflowEvents,
      ).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (events) =>
            events.some((event) => event.payload.instanceId === instanceId),
          times: 10,
        }),
        Effect.timeout("60 seconds"),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "cf.workflows.workflow.instance.completed",
          source: expect.objectContaining(source),
          payload: expect.objectContaining({ instanceId }),
        }),
      );
      yield* Effect.logInfo(
        `Workflow queue lifecycle delivery: ${JSON.stringify(events)}`,
      );

      yield* stack.destroy();
      yield* expectWorkerGone(accountId, worker.workerName);
      yield* expectWorkflowGone(accountId, binding.workflowName);
      const queueGone = yield* queues
        .getQueue({ accountId, queueId: queue.queueId })
        .pipe(
          Effect.as(false),
          Effect.catchTag("QueueNotFound", () => Effect.succeed(true)),
        );
      expect(queueGone).toBe(true);
      const subscriptionGone = yield* queues
        .getSubscription({
          accountId,
          subscriptionId: subscription.subscriptionId,
        })
        .pipe(
          Effect.as(false),
          Effect.catchTag("SubscriptionNotFound", () => Effect.succeed(true)),
        );
      expect(subscriptionGone).toBe(true);
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:queue",
      "provider:cloudflare:worker",
      "provider:cloudflare:workflow",
      "live",
    ],
    timeout: 120_000,
  },
);

const expectWorkflowEvent = (
  url: string,
  instanceId: string,
  workflowName: string,
) =>
  getJson(`${url}/events`, WorkflowEvents).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (events) =>
        events.some((event) => event.payload.instanceId === instanceId),
      times: 10,
    }),
    Effect.timeout("60 seconds"),
    Effect.tap((events) =>
      Effect.sync(() =>
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "cf.workflows.workflow.instance.completed",
            source: { type: "workflows.workflow", workflowName },
            payload: expect.objectContaining({ instanceId }),
          }),
        ),
      ),
    ),
  );

const expectWorkflowSubscriptionGone = (
  accountId: string,
  subscriptionId: string,
  queueId: string,
) =>
  Effect.gen(function* () {
    expect(
      yield* queues.getSubscription({ accountId, subscriptionId }).pipe(
        Effect.as(false),
        Effect.catchTag("SubscriptionNotFound", () => Effect.succeed(true)),
      ),
    ).toBe(true);
    expect(
      yield* queues.getQueue({ accountId, queueId }).pipe(
        Effect.as(false),
        Effect.catchTag("QueueNotFound", () => Effect.succeed(true)),
      ),
    ).toBe(true);
  });

test.provider(
  "Workflow.ref same-stack and WorkflowResource sources deliver queue events without duplicate ownership",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const program = (reference: boolean) =>
        Effect.gen(function* () {
          const worker = yield* AsyncWorkflowWorker;
          const workflow = reference
            ? yield* Cloudflare.Workflow.ref("Greeting")
            : yield* WorkflowResource("Greeting", {
                className: "MyWorkflow",
                scriptName: worker.workerName,
              });
          expect(workflow.Type).toBe("Cloudflare.Workflow");
          expect(Output.isOutput(workflow.workflowName)).toBe(true);
          if (reference) {
            expect(typeof workflow).toBe("function");
            expect(Output.isOutput(workflow)).toBe(true);
          }
          const queue = yield* Cloudflare.Queues.Queue("RefEventsQueue");
          const subscription = yield* Cloudflare.Queues.Subscription(
            "RefEvents",
            {
              source: workflow,
              events: ["instance.completed"],
              queueId: queue.queueId,
            },
          );
          expect(subscription.Props.source).toEqual({
            type: "workflows.workflow",
            workflowName: expect.anything(),
          });
          yield* Cloudflare.Queues.Consumer("RefEventsConsumer", {
            queueId: queue.queueId,
            scriptName: worker.workerName,
            settings: { batchSize: 1, maxWaitTimeMs: 1000 },
          });
          return {
            worker,
            queue,
            subscription,
            workflowName: workflow.workflowName,
          };
        });
      const firstPlan = yield* stack.plan(program(false));
      expect(firstPlan.resources.Greeting.downstream).toContain("RefEvents");
      const first = yield* stack.deploy(program(false));
      const original = yield* workflows.getWorkflow({
        accountId,
        workflowName: first.workflowName,
      });
      // Resource refs read persisted state, so deploy the host before using one.
      const deployed = yield* stack.deploy(program(true));
      const plan = yield* stack.plan(program(true));
      expect(
        Object.values(plan.resources).filter(
          (node) => node.resource.Type === "Cloudflare.Workflow",
        ),
      ).toHaveLength(1);
      expect(deployed.workflowName).toBe(first.workflowName);
      expect(deployed.subscription.subscriptionId).toBe(
        first.subscription.subscriptionId,
      );
      const source = {
        type: "workflows.workflow",
        workflowName: first.workflowName,
      };
      expect(plan.resources.RefEvents.state).toHaveProperty(
        "props.source",
        source,
      );
      const observed = yield* queues.getSubscription({
        accountId,
        subscriptionId: deployed.subscription.subscriptionId,
      });
      expect(observed.source).toEqual(expect.objectContaining(source));
      expect(observed.destination.queueId).toBe(deployed.queue.queueId);
      const { instanceId } = yield* runWorkflowToCompletion(
        deployed.worker.url!,
      ).pipe(
        Effect.retry({
          schedule: Schedule.spaced("3 seconds"),
          times: 2,
          while: (error) =>
            error instanceof Error &&
            error.message ===
              'workflow errored: {"message":"Worker not found."}',
        }),
      );
      yield* expectWorkflowEvent(
        deployed.worker.url!,
        instanceId,
        first.workflowName,
      );

      yield* stack.deploy(AsyncWorkflowWorker);
      yield* expectWorkflowSubscriptionGone(
        accountId,
        deployed.subscription.subscriptionId,
        deployed.queue.queueId,
      );
      expect(
        (yield* workflows.getWorkflow({
          accountId,
          workflowName: first.workflowName,
        })).id,
      ).toBe(original.id);
      expect(yield* readWorkflowName(deployed.worker.workerName)).toBe(
        first.workflowName,
      );
      yield* stack.destroy();
      yield* expectWorkerGone(accountId, deployed.worker.workerName);
      yield* expectWorkflowGone(accountId, first.workflowName);
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:queue",
      "provider:cloudflare:worker",
      "provider:cloudflare:workflow",
      "live",
    ],
    timeout: 120_000,
  },
);

test.provider(
  "Workflow.ref cross-stack and cross-stage source delivers queue events without owning the host",
  (stack) => {
    const host = TestCore.scratchStack(
      { providers: Cloudflare.providers(), stage: `${stack.stage}-host` },
      "WorkflowRefHost",
      "test/Cloudflare/Workers/WorkflowAsync.test.ts",
    );
    return Effect.gen(function* () {
      yield* stack.destroy();
      yield* host.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const hosted = yield* host.deploy(
        Effect.gen(function* () {
          const worker = yield* AsyncWorkflowWorker;
          return { worker, workflowName: worker.env.MY_WORKFLOW.workflowName };
        }),
      );
      const original = yield* workflows.getWorkflow({
        accountId,
        workflowName: hosted.workflowName,
      });
      const program = Effect.gen(function* () {
        const worker = yield* Cloudflare.Worker("RefEventsWorker", {
          main: hostMain,
          env: { EVENTS: Cloudflare.DurableObject("WorkflowEvents") },
        });
        const queue = yield* Cloudflare.Queues.Queue("RefEventsQueue");
        const Subscription = yield* Cloudflare.Queues.Subscription;
        const subscription = yield* Subscription(
          "RefEvents",
          Effect.gen(function* () {
            return {
              source: yield* Cloudflare.Workflow.ref("Greeting", {
                stack: host.name,
                stage: host.stage,
              }),
              events: ["instance.completed"],
              queueId: queue.queueId,
            };
          }),
        );
        yield* Cloudflare.Queues.Consumer("RefEventsConsumer", {
          queueId: queue.queueId,
          scriptName: worker.workerName,
          settings: { batchSize: 1, maxWaitTimeMs: 1000 },
        });
        return { worker, queue, subscription };
      });
      const deployed = yield* stack.deploy(program);
      const plan = yield* stack.plan(program);
      expect(
        Object.values(plan.resources).filter(
          (node) => node.resource.Type === "Cloudflare.Workflow",
        ),
      ).toHaveLength(0);
      const source = {
        type: "workflows.workflow",
        workflowName: hosted.workflowName,
      };
      expect(plan.resources.RefEvents.state).toHaveProperty(
        "props.source",
        source,
      );
      expect(deployed.subscription.source).toEqual(source);
      const observed = yield* queues.getSubscription({
        accountId,
        subscriptionId: deployed.subscription.subscriptionId,
      });
      expect(observed.source).toEqual(expect.objectContaining(source));
      expect(observed.destination.queueId).toBe(deployed.queue.queueId);
      const { instanceId } = yield* runWorkflowToCompletion(hosted.worker.url!);
      yield* expectWorkflowEvent(
        deployed.worker.url!,
        instanceId,
        hosted.workflowName,
      );

      yield* stack.destroy();
      yield* expectWorkerGone(accountId, deployed.worker.workerName);
      yield* expectWorkflowSubscriptionGone(
        accountId,
        deployed.subscription.subscriptionId,
        deployed.queue.queueId,
      );
      expect(
        (yield* workflows.getWorkflow({
          accountId,
          workflowName: hosted.workflowName,
        })).id,
      ).toBe(original.id);
      expect(yield* readWorkflowName(hosted.worker.workerName)).toBe(
        hosted.workflowName,
      );
      yield* host.destroy();
      yield* expectWorkerGone(accountId, hosted.worker.workerName);
      yield* expectWorkflowGone(accountId, hosted.workflowName);
    }).pipe(
      logLevel,
      Effect.ensuring(
        stack.destroy().pipe(Effect.andThen(host.destroy()), Effect.ignore),
      ),
    );
  },
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:queue",
      "provider:cloudflare:worker",
      "provider:cloudflare:workflow",
      "live",
    ],
    timeout: 120_000,
  },
);

test.provider(
  "async worker workflow binding accepts scriptName and exposes cross-script identity without duplicate resources",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const deploy = (withConsumer: boolean) =>
        stack.deploy(
          Effect.gen(function* () {
            const host = yield* AsyncWorkflowWorker;
            const consumer = withConsumer
              ? yield* Cloudflare.Worker(
                  "WorkflowConsumer",
                  Effect.succeed({
                    main: consumerMain,
                    env: {
                      MY_WORKFLOW: Cloudflare.Workflow<{ value: string }>(
                        "RemoteGreeting",
                        {
                          className: "MyWorkflow",
                          scriptName: host.workerName,
                        },
                      ),
                    },
                  }),
                )
              : undefined;
            return {
              host,
              consumer,
              hostBinding: bindingSnapshot(host.env.MY_WORKFLOW),
              consumerBinding: consumer
                ? bindingSnapshot(consumer.env.MY_WORKFLOW)
                : undefined,
            };
          }),
        );
      const first = yield* deploy(false);
      const hostWorkflow = yield* workflows.getWorkflow({
        accountId,
        workflowName: first.hostBinding.workflowName,
      });
      const deployed = yield* deploy(true);
      const { host, consumer, hostBinding, consumerBinding } = deployed;
      expect(consumerBinding?.workflowIsOutput).toBe(true);
      expect(consumerBinding?.scriptIsOutput).toBe(true);
      expect(consumerBinding?.workflowName).toBe(hostBinding.workflowName);
      expect(consumerBinding?.scriptName).toBe(host.workerName);
      expect(consumerBinding?.name).toBe("RemoteGreeting");
      expect(
        (yield* readWorkflowBinding(consumer!.workerName)).workflowName,
      ).toBe(hostBinding.workflowName);
      const all = yield* workflows.listWorkflows
        .items({ accountId })
        .pipe(Stream.runCollect);
      const owned = Array.from(all).filter(
        (workflow) =>
          workflow.scriptName === host.workerName ||
          workflow.scriptName === consumer!.workerName,
      );
      expect(owned).toHaveLength(1);
      expect(owned[0]?.id).toBe(hostWorkflow.id);
      expect(owned[0]?.name).toBe(hostBinding.workflowName);
      yield* runWorkflowToCompletion(consumer!.url!);

      yield* stack.destroy();
      yield* expectWorkerGone(accountId, consumer!.workerName);
      yield* expectWorkerGone(accountId, host.workerName);
      yield* expectWorkflowGone(accountId, hostBinding.workflowName);
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

const waitForAppliedStepLimit = (workflowName: string, expected: number) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const versions = yield* workflows.listVersions
      .items({ accountId, workflowName })
      .pipe(Stream.runCollect);
    return Array.from(versions).some(
      (version) => version.limits?.steps === expected,
    );
  }).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: Boolean,
      times: 10,
    }),
    Effect.tap((applied) => Effect.sync(() => expect(applied).toBe(true))),
  );

test.provider(
  "async worker workflow binding applies a per-workflow step limit",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* Cloudflare.Worker("limits-workflow-worker", {
            main: hostMain,
            env: {
              MY_WORKFLOW: Cloudflare.Workflow("MyWorkflow", {
                limits: { steps: 100 },
              }),
            },
          });
          return { worker, workflowName: worker.env.MY_WORKFLOW.workflowName };
        }),
      );
      yield* waitForAppliedStepLimit(deployed.workflowName, 100);
      yield* stack.destroy();
      yield* expectWorkerGone(accountId, deployed.worker.workerName);
      yield* expectWorkflowGone(accountId, deployed.workflowName);
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

const scheduledWorkflowMain = `${import.meta.dirname}/fixtures/workflow-schedules/async-worker.ts`;
const waitForAppliedSchedules = (workflowName: string, expected: string[]) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const workflow = yield* workflows.getWorkflow({ accountId, workflowName });
    const crons = (workflow.schedules ?? []).map((schedule) => schedule.cron);
    return crons;
  }).pipe(
    Effect.flatMap((crons) =>
      crons.length === expected.length &&
      crons.every((cron, index) => cron === expected[index])
        ? Effect.succeed(crons)
        : Effect.fail(
            new Error(`schedules not applied yet: ${JSON.stringify(crons)}`),
          ),
    ),
    retry,
  );

test.provider(
  "async worker workflow binding applies native cron schedules",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const yearly = "0 0 1 1 *";
      const other = "0 0 2 1 *";
      const deployWith = (schedules: string[]) =>
        stack.deploy(
          Effect.gen(function* () {
            const worker = yield* Cloudflare.Worker(
              "scheduled-workflow-worker",
              {
                main: scheduledWorkflowMain,
                env: {
                  HOURLY: Cloudflare.Workflow("HourlyWorkflow", {
                    className: "HourlyWorkflow",
                    schedules,
                  }),
                },
              },
            );
            return { worker, workflowName: worker.env.HOURLY.workflowName };
          }),
        );
      const created = yield* deployWith([yearly]);
      expect(
        yield* waitForAppliedSchedules(created.workflowName, [yearly]),
      ).toEqual([yearly]);
      yield* deployWith([other]);
      expect(
        yield* waitForAppliedSchedules(created.workflowName, [other]),
      ).toEqual([other]);
      yield* deployWith([]);
      expect(yield* waitForAppliedSchedules(created.workflowName, [])).toEqual(
        [],
      );
      yield* stack.destroy();
      yield* expectWorkerGone(accountId, created.worker.workerName);
      yield* expectWorkflowGone(accountId, created.workflowName);
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

const namedWorkflowMain = `${import.meta.dirname}/fixtures/workflow-async/worker.ts`;
const physicalName = (scratch: Test.ScratchStack) =>
  sha256(`${scratch.name}:${scratch.stage}`).pipe(
    Effect.map((hash) => `alchemy-workflow-${hash.slice(0, 16)}`),
  );
const readWorkflowName = (scriptName: string) =>
  readWorkflowBinding(scriptName).pipe(
    Effect.map((binding) => binding.workflowName),
  );

const namedHost = (workflowName?: string, schedules?: string[]) =>
  Cloudflare.Worker("NamedHost", {
    main: namedWorkflowMain,
    env: {
      MY_WORKFLOW: Cloudflare.Workflow("MyWorkflow", {
        workflowName,
        schedules,
      }),
    },
  });

test.provider(
  "physical names preserve defaults, replace on rename, and retain schedules",
  (scratch) =>
    Effect.gen(function* () {
      yield* scratch.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const explicit = yield* physicalName(scratch);
      const original = yield* scratch.deploy(namedHost());
      const generated = yield* readWorkflowName(original.workerName);
      expect(generated).toBe(
        yield* generateWorkflowName(original.workerName, "MyWorkflow"),
      );
      const first = yield* workflows.getWorkflow({
        accountId,
        workflowName: generated,
      });

      yield* scratch.deploy(namedHost(generated));
      expect(
        (yield* workflows.getWorkflow({ accountId, workflowName: generated }))
          .id,
      ).toBe(first.id);

      const renamed = yield* scratch.deploy(namedHost(explicit, ["0 0 1 1 *"]));
      const replacement = yield* workflows.getWorkflow({
        accountId,
        workflowName: explicit,
      });
      expect(replacement.id).not.toBe(first.id);
      expect(yield* readWorkflowName(renamed.workerName)).toBe(explicit);
      yield* expectWorkflowGone(accountId, generated);
      expect(yield* waitForAppliedSchedules(explicit, ["0 0 1 1 *"])).toEqual([
        "0 0 1 1 *",
      ]);

      const preserved = yield* scratch.deploy(namedHost());
      expect(yield* readWorkflowName(preserved.workerName)).toBe(explicit);
      const observed = yield* workflows.getWorkflow({
        accountId,
        workflowName: explicit,
      });
      expect(observed.id).toBe(replacement.id);
      expect(observed.schedules?.map((schedule) => schedule.cron)).toEqual([
        "0 0 1 1 *",
      ]);
      const terminal = yield* runWorkflowToCompletion(preserved.url!).pipe(
        Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 2 }),
      );
      expect(terminal.output?.workflowName).toBe(explicit);

      yield* scratch.deploy(namedHost(undefined, []));
      expect(yield* waitForAppliedSchedules(explicit, [])).toEqual([]);
      yield* scratch.destroy();
      yield* expectWorkflowGone(accountId, explicit);
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

test.provider(
  "direct workflow sources with Effect props preserve explicit identity through omission and rename",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const explicit = yield* physicalName(stack);
      const program = (workflowName?: string) =>
        Effect.gen(function* () {
          const worker = yield* Cloudflare.Worker("IdentityHost", {
            main: hostMain,
            env: {
              MY_WORKFLOW: Cloudflare.Workflow("IdentityWorkflow", {
                className: "MyWorkflow",
                workflowName,
              }),
              WORKFLOW_NAME: workflowName ?? explicit,
              EVENTS: Cloudflare.DurableObject("WorkflowEvents"),
            },
          });
          const queue = yield* Cloudflare.Queues.Queue("IdentityQueue");
          const subscription = yield* Cloudflare.Queues.Subscription(
            "IdentityEvents",
            Effect.succeed({
              source: worker.env.MY_WORKFLOW,
              events: ["instance.completed"],
              queueId: queue.queueId,
            }),
          );
          expect(subscription.Props.source).toEqual({
            type: "workflows.workflow",
            workflowName: worker.env.MY_WORKFLOW.workflowName,
          });
          yield* Cloudflare.Queues.Consumer("IdentityConsumer", {
            queueId: queue.queueId,
            scriptName: worker.workerName,
            settings: { batchSize: 1, maxWaitTimeMs: 1000 },
          });
          return {
            worker,
            queue,
            subscription,
            binding: bindingSnapshot(worker.env.MY_WORKFLOW),
          };
        });
      const identities: string[] = [];
      const subscriptions: string[] = [];
      const deployments = yield* Effect.forEach(
        [explicit, undefined, `${explicit}-renamed`],
        (name) =>
          Effect.gen(function* () {
            const deployed = yield* stack.deploy(program(name));
            const expected = name ?? explicit;
            const { worker, binding, subscription } = deployed;
            expect(binding.workflowIsOutput).toBe(true);
            expect(binding.scriptIsOutput).toBe(true);
            expect(binding.workflowName).toBe(expected);
            expect(binding.scriptName).toBe(worker.workerName);
            expect(yield* readWorkflowName(worker.workerName)).toBe(expected);
            const observed = yield* workflows.getWorkflow({
              accountId,
              workflowName: binding.workflowName,
            });
            expect(observed.name).toBe(expected);
            expect(observed.scriptName).toBe(binding.scriptName);
            identities.push(observed.id!);
            subscriptions.push(subscription.subscriptionId);
            const source = {
              type: "workflows.workflow",
              workflowName: expected,
            };
            const liveSubscription = yield* queues.getSubscription({
              accountId,
              subscriptionId: subscription.subscriptionId,
            });
            expect(liveSubscription.source).toEqual(
              expect.objectContaining(source),
            );
            expect(liveSubscription.destination.queueId).toBe(
              deployed.queue.queueId,
            );
            const plan = yield* stack.plan(program(name));
            expect(plan.resources.IdentityWorkflow.downstream).toContain(
              "IdentityEvents",
            );
            expect(plan.resources.IdentityEvents.state).toHaveProperty(
              "props.source",
              source,
            );
            yield* Effect.logInfo("Workflow delivery phase", {
              phase: name ?? "omitted",
              workflow: observed,
              subscription: liveSubscription,
            });
            const terminal = yield* runWorkflowToCompletion(
              worker.url!,
              expected,
            );
            expect(terminal.output?.workflowName).toBe(expected);
            const terminalObservedAt = yield* Clock.currentTimeMillis;
            yield* Effect.logInfo("Workflow terminal", {
              ...terminal,
              observedAt: terminalObservedAt,
            });
            const client = HttpClient.filterStatusOk(
              yield* HttpClient.HttpClient,
            );
            const events = yield* client.get(`${worker.url}/events`).pipe(
              Effect.flatMap((response) =>
                Effect.gen(function* () {
                  const body = yield* response.json.pipe(
                    Effect.flatMap(Schema.decodeUnknownEffect(WorkflowEvents)),
                  );
                  yield* Effect.logInfo("Workflow event poll", {
                    readAt: response.headers["x-events-read-at"],
                    cache: response.headers["cf-cache-status"],
                    age: response.headers.age,
                    events: body,
                  });
                  return body;
                }),
              ),
              retry,
              // Live Queue dispatch has taken 55 seconds after Workflow completion.
              Effect.repeat({
                schedule: Schedule.spaced("5800 millis"),
                until: (events) =>
                  events.some(
                    (event) => event.payload.instanceId === terminal.instanceId,
                  ),
                times: 10,
              }),
              Effect.timeoutOrElse({
                duration: "60 seconds",
                orElse: () => Effect.succeed([]),
              }),
            );
            if (
              !events.some(
                (event) => event.payload.instanceId === terminal.instanceId,
              )
            ) {
              const diagnostics = yield* Effect.gen(function* () {
                yield* Effect.logInfo(
                  "Workflow event diagnostics",
                  JSON.stringify({
                    queue: yield* queues.getQueue({
                      accountId,
                      queueId: deployed.queue.queueId,
                    }),
                    metrics: yield* queues.getMetricsQueue({
                      accountId,
                      queueId: deployed.queue.queueId,
                    }),
                    subscription: yield* queues.getSubscription({
                      accountId,
                      subscriptionId: subscription.subscriptionId,
                    }),
                    storage: yield* getJson(
                      `${worker.url}/events/diagnostics?instance=${terminal.instanceId}`,
                      Schema.Unknown,
                    ),
                  }),
                );
                const probeId = `probe-${terminal.instanceId}`;
                yield* queues.bulkPushMessages({
                  accountId,
                  queueId: deployed.queue.queueId,
                  messages: [
                    {
                      contentType: "json",
                      body: { type: "diagnostic.queue.probe", probeId },
                    },
                  ],
                });
                yield* Effect.logInfo("Queue probe accepted", { probeId });
                const messages = (snapshot: unknown): unknown[] =>
                  typeof snapshot === "object" &&
                  snapshot !== null &&
                  "entries" in snapshot &&
                  Array.isArray(snapshot.entries)
                    ? snapshot.entries.flatMap((entry: unknown) =>
                        Array.isArray(entry) ? [entry[1]] : [],
                      )
                    : [];
                const hasProbe = (snapshot: unknown) =>
                  messages(snapshot).some(
                    (body) =>
                      typeof body === "object" &&
                      body !== null &&
                      "type" in body &&
                      body.type === "diagnostic.queue.probe" &&
                      "probeId" in body &&
                      body.probeId === probeId,
                  );
                const hasOriginal = (snapshot: unknown) =>
                  messages(snapshot).some(
                    (body) =>
                      typeof body === "object" &&
                      body !== null &&
                      "payload" in body &&
                      typeof body.payload === "object" &&
                      body.payload !== null &&
                      "instanceId" in body.payload &&
                      body.payload.instanceId === terminal.instanceId,
                  );
                const probeStorage = yield* client
                  .get(`${worker.url}/events/diagnostics?probe=${probeId}`)
                  .pipe(
                    Effect.flatMap((response) => response.json),
                    Effect.tap((snapshot) =>
                      Effect.gen(function* () {
                        const observedAt = yield* Clock.currentTimeMillis;
                        yield* Effect.logInfo(
                          "Queue delivery sample",
                          JSON.stringify({
                            observedAt,
                            elapsedMs: observedAt - terminalObservedAt,
                            originalPresent: hasOriginal(snapshot),
                            probePresent: hasProbe(snapshot),
                            storage: snapshot,
                          }),
                        );
                      }),
                    ),
                    Effect.repeat({
                      schedule: Schedule.spaced("3 seconds"),
                      until: (snapshot) =>
                        hasOriginal(snapshot) && hasProbe(snapshot),
                      times: 9,
                    }),
                  );
                yield* Effect.logInfo(
                  "Queue probe delivery",
                  JSON.stringify({
                    probeId,
                    observedAt: yield* Clock.currentTimeMillis,
                    originalPresent: hasOriginal(probeStorage),
                    probePresent: hasProbe(probeStorage),
                    storage: probeStorage,
                    metrics: yield* queues.getMetricsQueue({
                      accountId,
                      queueId: deployed.queue.queueId,
                    }),
                  }),
                );
              }).pipe(Effect.timeout("30 seconds"), Effect.exit);
              if (Exit.isFailure(diagnostics)) {
                yield* Effect.logWarning(
                  "Workflow event diagnostics failed",
                  Cause.pretty(diagnostics.cause),
                );
              }
            }
            expect(events).toContainEqual(
              expect.objectContaining({
                type: "cf.workflows.workflow.instance.completed",
                source: expect.objectContaining(source),
                payload: expect.objectContaining({
                  instanceId: terminal.instanceId,
                }),
              }),
            );
            return deployed;
          }),
      );
      expect(identities[1]).toBe(identities[0]);
      expect(identities[2]).not.toBe(identities[0]);
      expect(subscriptions[1]).toBe(subscriptions[0]);
      expect(subscriptions[2]).not.toBe(subscriptions[0]);
      yield* expectWorkflowGone(accountId, explicit);
      const final = deployments[2]!;
      yield* stack.destroy();
      yield* expectWorkerGone(accountId, final.worker.workerName);
      yield* expectWorkflowGone(accountId, `${explicit}-renamed`);
      expect(
        yield* queues
          .getQueue({ accountId, queueId: final.queue.queueId })
          .pipe(
            Effect.as(false),
            Effect.catchTag("QueueNotFound", () => Effect.succeed(true)),
          ),
      ).toBe(true);
      for (const subscriptionId of new Set(subscriptions)) {
        expect(
          yield* queues.getSubscription({ accountId, subscriptionId }).pipe(
            Effect.as(false),
            Effect.catchTag("SubscriptionNotFound", () => Effect.succeed(true)),
          ),
        ).toBe(true);
      }
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:queue",
      "provider:cloudflare:worker",
      "provider:cloudflare:workflow",
      "live",
    ],
    timeout: 120_000,
  },
);

test.provider(
  "physical names require adoption and preserve adopted identity and schedules",
  (scratch) =>
    Effect.gen(function* () {
      yield* scratch.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const workflowName = yield* physicalName(scratch);
      const host = Cloudflare.Worker("AdoptionHost", {
        main: namedWorkflowMain,
      });
      const deployed = yield* scratch.deploy(host);
      yield* expectWorkflowGone(accountId, workflowName);
      const foreign = yield* workflows.putWorkflow({
        accountId,
        workflowName,
        scriptName: deployed.workerName,
        className: "MyWorkflow",
        schedules: [{ cron: "0 0 1 1 *" }],
      });
      yield* Effect.addFinalizer(() =>
        workflows.deleteWorkflow({ accountId, workflowName }).pipe(
          Effect.catchTag("WorkflowNotFound", () => Effect.void),
          Effect.orDie,
        ),
      );
      const definition = (adopting: boolean, schedules?: string[]) =>
        Effect.gen(function* () {
          const worker = yield* host;
          return yield* WorkflowResource("Adopted", {
            workflowName,
            className: "MyWorkflow",
            scriptName: worker.workerName,
            schedules,
          }).pipe(adopt(adopting));
        });
      const denied = yield* scratch.plan(definition(false)).pipe(Effect.exit);
      expect(Exit.isFailure(denied)).toBe(true);
      if (Exit.isFailure(denied))
        expect(Cause.pretty(denied.cause)).toContain("OwnedBySomeoneElse");
      expect(
        (yield* workflows.getWorkflow({ accountId, workflowName })).id,
      ).toBe(foreign.id);

      const adopted = yield* scratch.deploy(definition(true));
      expect(adopted.workflowName).toBe(workflowName);
      expect(adopted.workflowId).toBe(foreign.id);
      expect(adopted.schedules).toEqual(["0 0 1 1 *"]);
      const updated = yield* scratch.deploy(definition(false, []));
      expect(updated.workflowId).toBe(foreign.id);
      expect(yield* waitForAppliedSchedules(workflowName, [])).toEqual([]);
      yield* scratch.destroy();
      yield* expectWorkflowGone(accountId, workflowName);
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

test.provider(
  "physical names refuse occupied rename targets even with adoption enabled",
  (scratch) =>
    Effect.gen(function* () {
      yield* scratch.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const originalName = yield* physicalName(scratch);
      const occupiedName = `${originalName}-occupied`;
      const occupiedHost = Cloudflare.Worker("OccupiedHost", {
        main: namedWorkflowMain,
        env: {
          MY_WORKFLOW: Cloudflare.Workflow("OccupiedWorkflow", {
            className: "MyWorkflow",
            workflowName: occupiedName,
            schedules: ["0 0 1 1 *"],
          }),
        },
      });
      const definition = (name: string) =>
        Effect.gen(function* () {
          const host = yield* namedHost(name);
          const occupied = yield* occupiedHost;
          return { host, occupied };
        });
      yield* scratch.deploy(definition(originalName));
      const original = yield* workflows.getWorkflow({
        accountId,
        workflowName: originalName,
      });
      const occupied = yield* workflows.getWorkflow({
        accountId,
        workflowName: occupiedName,
      });
      const denied = yield* scratch
        .deploy(definition(occupiedName).pipe(adopt(true)))
        .pipe(Effect.exit);
      expect(Exit.isFailure(denied)).toBe(true);
      if (Exit.isFailure(denied))
        expect(Cause.pretty(denied.cause)).toContain("OwnedBySomeoneElse");
      const untouched = yield* workflows.getWorkflow({
        accountId,
        workflowName: occupiedName,
      });
      expect(untouched.id).toBe(occupied.id);
      expect(untouched.scriptName).toBe(occupied.scriptName);
      expect(untouched.schedules).toEqual(occupied.schedules);
      expect(
        (yield* workflows.getWorkflow({
          accountId,
          workflowName: originalName,
        })).id,
      ).toBe(original.id);
      // Removing the rejected source must not delete the occupied target.
      yield* scratch.deploy(
        Effect.gen(function* () {
          yield* Cloudflare.Worker("NamedHost", { main: namedWorkflowMain });
          yield* occupiedHost;
        }),
      );
      yield* expectWorkflowGone(accountId, originalName);
      expect(
        (yield* workflows.getWorkflow({
          accountId,
          workflowName: occupiedName,
        })).id,
      ).toBe(occupied.id);
      yield* scratch.destroy();
      yield* expectWorkflowGone(accountId, originalName);
      yield* expectWorkflowGone(accountId, occupiedName);
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

test.provider(
  "direct foreign workflow subscription sources do not own the host Workflow",
  (scratch) =>
    Effect.gen(function* () {
      yield* scratch.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const workflowName = yield* physicalName(scratch);
      const host = namedHost(workflowName);
      yield* scratch.deploy(host);
      const original = yield* workflows.getWorkflow({
        accountId,
        workflowName,
      });
      const deployed = yield* scratch.deploy(
        Effect.gen(function* () {
          const worker = yield* host;
          const consumer = yield* Cloudflare.Worker("NamedConsumer", {
            main: namedWorkflowMain,
            env: {
              MY_WORKFLOW: Cloudflare.Workflow("ForeignWorkflow", {
                className: "MyWorkflow",
                scriptName: worker.workerName,
                workflowName,
              }),
            },
          });
          const queue = yield* Cloudflare.Queues.Queue("ForeignEventsQueue");
          const Subscription = yield* Cloudflare.Queues.Subscription;
          const subscription = yield* Subscription("ForeignEvents", {
            source: consumer.env.MY_WORKFLOW,
            events: ["instance.completed"],
            queueId: queue.queueId,
          });
          expect(subscription.Props.source).toEqual({
            type: "workflows.workflow",
            workflowName: consumer.env.MY_WORKFLOW.workflowName,
          });
          return {
            worker,
            consumer,
            queue,
            subscription,
            hostBinding: bindingSnapshot(worker.env.MY_WORKFLOW),
            consumerBinding: bindingSnapshot(consumer.env.MY_WORKFLOW),
          };
        }),
      );
      expect(deployed.hostBinding.workflowName).toBe(workflowName);
      expect(deployed.consumerBinding.workflowName).toBe(workflowName);
      expect(deployed.consumerBinding.scriptName).toBe(
        deployed.worker.workerName,
      );
      expect(deployed.consumerBinding.workflowIsOutput).toBe(true);
      expect(deployed.consumerBinding.scriptIsOutput).toBe(true);
      const source = { type: "workflows.workflow", workflowName };
      expect(deployed.subscription.source).toEqual(source);
      const liveSubscription = yield* queues.getSubscription({
        accountId,
        subscriptionId: deployed.subscription.subscriptionId,
      });
      expect(liveSubscription.source).toEqual(expect.objectContaining(source));
      expect(liveSubscription.destination.queueId).toBe(deployed.queue.queueId);
      const owned = yield* workflows.listWorkflows.items({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((all) =>
          Array.from(all).filter(
            (workflow) =>
              workflow.scriptName === deployed.worker.workerName ||
              workflow.scriptName === deployed.consumer.workerName,
          ),
        ),
      );
      expect(owned).toHaveLength(1);
      expect(owned[0]?.id).toBe(original.id);
      expect(yield* readWorkflowName(deployed.consumer.workerName)).toBe(
        workflowName,
      );
      const terminal = yield* runWorkflowToCompletion(
        deployed.consumer.url!,
      ).pipe(
        Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 2 }),
      );
      expect(terminal.output?.workflowName).toBe(workflowName);
      yield* scratch.deploy(host);
      yield* expectWorkerGone(accountId, deployed.consumer.workerName);
      expect(
        yield* queues
          .getSubscription({
            accountId,
            subscriptionId: deployed.subscription.subscriptionId,
          })
          .pipe(
            Effect.as(false),
            Effect.catchTag("SubscriptionNotFound", () => Effect.succeed(true)),
          ),
      ).toBe(true);
      expect(
        yield* queues
          .getQueue({ accountId, queueId: deployed.queue.queueId })
          .pipe(
            Effect.as(false),
            Effect.catchTag("QueueNotFound", () => Effect.succeed(true)),
          ),
      ).toBe(true);
      expect(
        (yield* workflows.getWorkflow({ accountId, workflowName })).id,
      ).toBe(original.id);
      yield* scratch.destroy();
      yield* expectWorkerGone(accountId, deployed.worker.workerName);
      yield* expectWorkflowGone(accountId, workflowName);
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:queue",
      "provider:cloudflare:worker",
      "provider:cloudflare:workflow",
      "live",
    ],
    timeout: 120_000,
  },
);

for (const dev of [false, true]) {
  const { test: hostTest } = Test.make({
    providers: Cloudflare.providers(),
    dev,
  });

  hostTest.provider(
    `binding-only host changes update dependent scriptName in the same deploy (dev: ${dev})`,
    (scratch) =>
      Effect.gen(function* () {
        yield* scratch.destroy();
        const workflowName = yield* physicalName(scratch);
        const definition = (destination: "A" | "B") =>
          Effect.gen(function* () {
            const a = yield* Cloudflare.Worker("HostA", {
              main: namedWorkflowMain,
            });
            const b = yield* Cloudflare.Worker("HostB", {
              main: namedWorkflowMain,
            });
            const host = destination === "A" ? a : b;
            const workflow = yield* WorkflowResource("MovedWorkflow", {
              workflowName,
              className: "MyWorkflow",
              schedules: ["0 0 1 1 *"],
            });
            yield* workflow.bind`host`({ scriptName: host.workerName });
            const consumer = yield* Cloudflare.Worker("HostConsumer", {
              main: namedWorkflowMain,
              env: { WORKFLOW_SCRIPT_NAME: workflow.scriptName },
            });
            return { host, workflow, consumer };
          });
        const expectScript = (url: string, scriptName: string) =>
          requestWorker(
            HttpClientRequest.get(`${url}/workflow/script-name`).pipe(
              HttpClientRequest.setHeader("cache-control", "no-cache"),
            ),
            { retryDelay: "3 seconds" },
          ).pipe(
            Effect.flatMap((response) =>
              response.text.pipe(
                Effect.flatMap((body) =>
                  response.status === 200
                    ? Effect.succeed(body)
                    : Effect.fail(
                        new Error(
                          `GET ${url}/workflow/script-name: ${response.status}: ${body}`,
                        ),
                      ),
                ),
              ),
            ),
            Effect.repeat({
              schedule: Schedule.spaced("3 seconds"),
              until: (name) => name === scriptName,
              times: 10,
            }),
            Effect.tap((name) =>
              Effect.sync(() => expect(name).toBe(scriptName)),
            ),
            Effect.timeout("45 seconds"),
          );
        const original = yield* scratch.deploy(definition("A"));
        yield* expectScript(original.consumer.url!, original.host.workerName);
        if (dev) {
          expect(original.workflow.workflowId).toMatch(/^dev:/);
          expect(original.consumer.url).toMatch(/^http:\/\/localhost:/);
        }

        const moved = yield* scratch.deploy(definition("B"));
        expect(moved.host.workerName).not.toBe(original.host.workerName);
        expect(moved.workflow.workflowId).toBe(original.workflow.workflowId);
        expect(moved.workflow.scriptName).toBe(moved.host.workerName);
        yield* expectScript(moved.consumer.url!, moved.host.workerName);
        if (!dev) {
          const observed = yield* workflows.getWorkflow({
            accountId: moved.workflow.accountId,
            workflowName,
          });
          expect(observed.id).toBe(original.workflow.workflowId);
          expect(observed.scriptName).toBe(moved.host.workerName);
          expect(observed.schedules?.map((schedule) => schedule.cron)).toEqual([
            "0 0 1 1 *",
          ]);
        }
        yield* scratch.destroy();
        if (!dev) {
          yield* expectWorkflowGone(moved.workflow.accountId, workflowName);
        }
      }).pipe(logLevel),
    {
      tags: [
        "provider:cloudflare",
        "provider:cloudflare:worker",
        "provider:cloudflare:workflow",
        ...(dev ? ["local"] : ["live"]),
      ],
      timeout: 120_000,
    },
  );
}

for (const api of ["async", "Effect"]) {
  test.provider(
    `public ${api} Workflow cold adoption with a new destination Worker`,
    (scratch) =>
      Effect.gen(function* () {
        yield* scratch.destroy();
        const { accountId } = yield* yield* CloudflareEnvironment;
        const workflowName =
          api === "async"
            ? yield* physicalName(scratch)
            : COLD_EFFECT_WORKFLOW_NAME;
        const source = Cloudflare.Worker("ColdAdoptionSource", {
          main: namedWorkflowMain,
        });
        const seededHost = yield* scratch.deploy(source);
        yield* expectWorkflowGone(accountId, workflowName);
        const existing = yield* workflows.putWorkflow({
          accountId,
          workflowName,
          scriptName: seededHost.workerName,
          className: "MyWorkflow",
          schedules: [{ cron: "0 0 1 1 *" }],
        });
        yield* Effect.addFinalizer(() =>
          workflows.deleteWorkflow({ accountId, workflowName }).pipe(
            Effect.catchTag("WorkflowNotFound", () => Effect.void),
            Effect.orDie,
          ),
        );
        const definition = Effect.gen(function* () {
          yield* source;
          if (api === "async") return yield* namedHost(workflowName);
          return yield* ColdEffectWorker;
        });
        const denied = yield* scratch
          .plan(definition.pipe(adopt(false)))
          .pipe(Effect.exit);
        expect(Exit.isFailure(denied)).toBe(true);
        if (Exit.isFailure(denied))
          expect(Cause.pretty(denied.cause)).toContain("OwnedBySomeoneElse");
        const untouched = yield* workflows.getWorkflow({
          accountId,
          workflowName,
        });
        expect(untouched.id).toBe(existing.id);
        expect(untouched.scriptName).toBe(seededHost.workerName);
        expect(untouched.schedules?.map((schedule) => schedule.cron)).toEqual([
          "0 0 1 1 *",
        ]);
        const destination = yield* scratch.deploy(definition.pipe(adopt(true)));
        const adopted = yield* workflows.getWorkflow({
          accountId,
          workflowName,
        });
        expect(adopted.id).toBe(existing.id);
        expect(adopted.scriptName).toBe(destination.workerName);
        expect(adopted.schedules?.map((schedule) => schedule.cron)).toEqual([
          "0 0 1 1 *",
        ]);
        const terminal = yield* runWorkflowToCompletion(destination.url!).pipe(
          Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 2 }),
        );
        expect(terminal.output?.greeting).toBe("Hello, world!");
        expect(terminal.output?.workflowName).toBe(workflowName);
        yield* scratch.destroy();
        yield* expectWorkflowGone(accountId, workflowName);
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
}
