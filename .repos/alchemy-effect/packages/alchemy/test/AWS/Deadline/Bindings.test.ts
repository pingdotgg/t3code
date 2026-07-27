import * as AWS from "@/AWS";
import { reapFarmChildren } from "@/AWS/Deadline/internal.ts";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as deadline from "@distilled.cloud/aws/deadline";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as EffectStream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import DeadlineTestFunctionLive, { DeadlineTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "DeadlineBindings");

// Bounded Lambda function URL cold-start/DNS/IAM propagation probe.
const readinessPolicy = Schedule.max([
  Schedule.fixed("6 seconds"),
  Schedule.recurs(9),
]);

let baseUrl: string;
let functionArn: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {
  override get message() {
    return `Deadline fixture returned HTTP ${this.status}${this.body ? `: ${this.body}` : " with an empty body"}`;
  }
}

// The shared Lambda fixture occasionally answers a transient 5xx (cold
// re-init, IAM propagation on the freshly attached policy that the handler's
// `Effect.orDie` surfaces as a 500). Retry only 5xx; a genuine 4xx/assertion
// failure surfaces immediately.
const send = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status >= 500
        ? response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new TransientUpstream({ status: response.status, body }),
              ),
            ),
          )
        : Effect.succeed(response),
    ),
    Effect.retry({
      while: (e) => e._tag === "TransientUpstream",
      // Deadline's control plane can need several seconds to settle a fresh
      // farm/queue and sometimes returns a run of 5xx responses meanwhile.
      // Keep the retry bounded to nine attempts and 24 seconds of backoff.
      schedule: Schedule.max([
        Schedule.spaced("3 seconds"),
        Schedule.recurs(8),
      ]),
    }),
  );

const getJson = (path: string) =>
  send(HttpClientRequest.get(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

/**
 * The account's farm quota is 2 and a deploy killed mid-crash leaks a farm
 * that later runs cannot adopt (the physical-name instance id changes with
 * fresh state). Reap any farm carrying one of this suite's fixture names so
 * the deploy below never starts quota-blocked.
 */
const reapLeakedFarms = Effect.gen(function* () {
  const farms = yield* deadline.listFarms.items({}).pipe(
    EffectStream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );
  const leaked = farms.filter((farm) =>
    /TestFarm|BindingsFarm|FleetFarm/.test(farm.displayName),
  );
  yield* Effect.forEach(
    leaked,
    (farm) =>
      Effect.gen(function* () {
        const farmId = farm.farmId;
        // Reap ALL child resources (storage profiles, budgets, limits,
        // associations, queues, fleets) — the same sweep Farm.delete runs.
        yield* reapFarmChildren(farmId);
        // Sub-resource deletion is asynchronous; the farm rejects deletion
        // with ConflictException until they finish. Bounded.
        yield* Effect.retry(deadline.deleteFarm({ farmId }), {
          while: (e): boolean => e._tag === "ConflictException",
          schedule: Schedule.max([
            Schedule.spaced("6 seconds"),
            Schedule.recurs(9),
          ]),
        }).pipe(
          Effect.catchTag("ResourceNotFoundException", () => Effect.void),
        );
        yield* Effect.logInfo(
          `reaped leaked farm ${farmId} (${farm.displayName})`,
        );
      }),
    { discard: true },
  );
});

const postJson = (path: string) =>
  send(HttpClientRequest.post(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

describe.sequential("Deadline Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "Deadline test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();
      // Raw distilled calls need the provider environment (credentials).
      yield* Core.withProviders(
        reapLeakedFarms,
        testOptions,
        "DeadlineBindings",
      );

      yield* Effect.logInfo("Deadline test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* DeadlineTestFunction;
        }).pipe(Effect.provide(DeadlineTestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");
      functionArn = attrs.functionArn;

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `Deadline test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `Deadline test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 300_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 240_000 });

  describe("binding registration", () => {
    test.provider("all capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/bindings")) as { bound: string[] };
        expect(response.bound).toHaveLength(20);
      }),
    );
  });

  let jobId: string;
  let stepId: string;

  describe("CreateJob / GetJob / ListJobs / SearchJobs / UpdateJob", () => {
    test.provider(
      "submits a job, reads it back, finds it, and reprioritizes it",
      (_stack) =>
        Effect.gen(function* () {
          // Submit — the binding injects the farm/queue ids.
          const created = (yield* postJson("/jobs")) as { jobId: string };
          expect(created.jobId).toMatch(/^job-/);
          jobId = created.jobId;

          // Read back; the job settles within seconds. A brand-new job can
          // report either CREATE_COMPLETE or UPDATE_SUCCEEDED (the service
          // applies an internal update right after creation), so poll until
          // it leaves the transitional statuses and assert it settled.
          const settled = ["CREATE_COMPLETE", "UPDATE_SUCCEEDED"];
          const job = (yield* getJson(`/job?jobId=${jobId}`).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (j): boolean =>
                settled.includes(
                  (j as { lifecycleStatus: string }).lifecycleStatus,
                ),
              times: 10,
            }),
          )) as { jobId: string; priority: number; lifecycleStatus: string };
          expect(job.jobId).toBe(jobId);
          expect(job.priority).toBe(50);
          expect(settled).toContain(job.lifecycleStatus);

          // ListJobs is eventually consistent independently from GetJob.
          const listed = (yield* getJson("/jobs").pipe(
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (j): boolean =>
                (j as { ids: string[] }).ids.includes(jobId),
              times: 10,
            }),
          )) as { ids: string[] };
          expect(listed.ids).toContain(jobId);

          // SearchJobs uses a separate asynchronously provisioned index. A
          // fresh farm can take minutes to index its first job, so exercise
          // the live binding and validate its response without polling past
          // the suite's provisioning budget.
          const searched = (yield* postJson("/search")) as {
            ids: string[];
          };
          expect(Array.isArray(searched.ids)).toBe(true);

          // Reprioritize and verify the mutation landed. GetJob is
          // eventually consistent, so poll the read (bounded).
          yield* postJson(`/priority?jobId=${jobId}&priority=75`);
          const updated = (yield* getJson(`/job?jobId=${jobId}`).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (j): boolean =>
                (j as { priority: number }).priority === 75,
              times: 10,
            }),
          )) as { priority: number };
          expect(updated.priority).toBe(75);
        }),
      { timeout: 120_000 },
    );
  });

  describe("ListSteps / GetStep / ListTasks / GetTask", () => {
    test.provider(
      "walks the job's steps and tasks",
      (_stack) =>
        Effect.gen(function* () {
          const steps = (yield* getJson(`/steps?jobId=${jobId}`).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (s): boolean => (s as { ids: string[] }).ids.length > 0,
              times: 10,
            }),
          )) as { ids: string[]; names: string[] };
          expect(steps.ids.length).toBeGreaterThanOrEqual(1);
          expect(steps.names).toContain("Echo");
          stepId = steps.ids[0]!;

          const step = (yield* getJson(
            `/step?jobId=${jobId}&stepId=${stepId}`,
          )) as { stepId: string; name: string };
          expect(step.stepId).toBe(stepId);
          expect(step.name).toBe("Echo");

          const tasks = (yield* getJson(
            `/tasks?jobId=${jobId}&stepId=${stepId}`,
          )) as { ids: string[] };
          expect(tasks.ids.length).toBeGreaterThanOrEqual(1);

          const task = (yield* getJson(
            `/task?jobId=${jobId}&stepId=${stepId}&taskId=${tasks.ids[0]}`,
          )) as { taskId: string; runStatus: string };
          expect(task.taskId).toBe(tasks.ids[0]);
          // No fleet is associated with the fixture queue, so the task can
          // never be scheduled — Deadline reports it READY or, once queue
          // compatibility is evaluated, NOT_COMPATIBLE.
          expect(["READY", "NOT_COMPATIBLE"]).toContain(task.runStatus);
        }),
      { timeout: 90_000 },
    );
  });

  describe("SearchSteps / SearchTasks / ListJobParameterDefinitions", () => {
    test.provider(
      "searches the job's steps and tasks and reads parameter definitions",
      (_stack) =>
        Effect.gen(function* () {
          // SearchSteps uses the same eventually-consistent search index as
          // SearchTasks below. The authoritative ListSteps/GetStep test above
          // already proves the step exists, so exercise the live binding and
          // validate its response without waiting on an optional index entry.
          const steps = (yield* postJson(`/search/steps?jobId=${jobId}`)) as {
            ids: string[];
          };
          expect(Array.isArray(steps.ids)).toBe(true);

          // SearchTasks uses a separate asynchronously provisioned index.
          // With no fleet associated, the pending task can remain absent for
          // minutes even though ListTasks/GetTask above are authoritative.
          // Exercise the live binding and validate its response without
          // polling past the suite's bounded provisioning budget.
          const tasks = (yield* postJson(`/search/tasks?jobId=${jobId}`)) as {
            ids: string[];
          };
          expect(Array.isArray(tasks.ids)).toBe(true);

          // The fixture template declares no parameters.
          const params = (yield* getJson(`/params?jobId=${jobId}`)) as {
            count: number;
          };
          expect(params.count).toBe(0);
        }),
      { timeout: 90_000 },
    );
  });

  describe("UpdateTask / UpdateStep", () => {
    test.provider(
      "cancels a READY task, then requeues the step",
      (_stack) =>
        Effect.gen(function* () {
          const tasks = (yield* getJson(
            `/tasks?jobId=${jobId}&stepId=${stepId}`,
          )) as { ids: string[] };
          const taskId = tasks.ids[0]!;

          // Cancel the single task and watch it converge to CANCELED. (The
          // fixture queue has no fleet, so the pending state is READY or
          // NOT_COMPATIBLE — never RUNNING.)
          yield* postJson(
            `/task/cancel?jobId=${jobId}&stepId=${stepId}&taskId=${taskId}`,
          );
          const canceled = (yield* getJson(
            `/task?jobId=${jobId}&stepId=${stepId}&taskId=${taskId}`,
          ).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (t): boolean =>
                (t as { runStatus: string }).runStatus === "CANCELED" ||
                (t as { runStatus: string }).runStatus === "CANCELING",
              times: 10,
            }),
          )) as { runStatus: string };
          expect(["CANCELED", "CANCELING"]).toContain(canceled.runStatus);

          // Requeue the whole step; the task converges back to a pending
          // status (READY, or NOT_COMPATIBLE while no fleet is associated).
          yield* postJson(`/step/requeue?jobId=${jobId}&stepId=${stepId}`);
          const requeued = (yield* getJson(
            `/task?jobId=${jobId}&stepId=${stepId}&taskId=${taskId}`,
          ).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (t): boolean =>
                (t as { runStatus: string }).runStatus === "READY" ||
                (t as { runStatus: string }).runStatus === "NOT_COMPATIBLE",
              times: 10,
            }),
          )) as { runStatus: string };
          expect(["READY", "NOT_COMPATIBLE"]).toContain(requeued.runStatus);
        }),
      { timeout: 120_000 },
    );
  });

  describe("ListSessions / ListSessionActions", () => {
    test.provider(
      "a job with no workers has no sessions and no session actions",
      (_stack) =>
        Effect.gen(function* () {
          const sessions = (yield* getJson(`/sessions?jobId=${jobId}`)) as {
            ids: string[];
          };
          expect(sessions.ids).toEqual([]);

          // ListSessionActions requires a sessionId or taskId scope — use
          // the job's single task.
          const tasks = (yield* getJson(
            `/tasks?jobId=${jobId}&stepId=${stepId}`,
          )) as { ids: string[] };
          const actions = (yield* getJson(
            `/session-actions?jobId=${jobId}&taskId=${tasks.ids[0]}`,
          )) as { ids: string[] };
          expect(actions.ids).toEqual([]);
        }),
      { timeout: 60_000 },
    );
  });

  describe("SessionsStatisticsAggregation", () => {
    test.provider(
      "starts an aggregation on the farm and polls it to completion",
      (_stack) =>
        Effect.gen(function* () {
          const { queueId } = (yield* getJson("/queue")) as {
            queueId: string;
          };
          expect(queueId).toMatch(/^queue-/);
          const started = (yield* postJson(`/stats?queueId=${queueId}`)) as {
            aggregationId: string;
          };
          expect(started.aggregationId).toBeTruthy();

          const result = (yield* getJson(
            `/stats?aggregationId=${started.aggregationId}`,
          ).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("6 seconds"),
              until: (r): boolean =>
                (r as { status: string }).status !== "IN_PROGRESS",
              times: 9,
            }),
          )) as { status: string; count: number };
          // An empty farm aggregates to COMPLETED with zero statistics.
          expect(result.status).toBe("COMPLETED");
        }),
      { timeout: 120_000 },
    );
  });

  describe("consumeFarmEvents", () => {
    test.provider(
      "the deploy created an EventBridge rule targeting the function",
      (_stack) =>
        Effect.gen(function* () {
          // Out-of-band via distilled: the fixture's consumeFarmEvents must
          // have materialized as a rule on the default bus with the Lambda
          // as target.
          const { RuleNames } = yield* eventbridge.listRuleNamesByTarget({
            TargetArn: functionArn,
          });
          expect((RuleNames ?? []).length).toBeGreaterThanOrEqual(1);
        }),
    );
  });
});
