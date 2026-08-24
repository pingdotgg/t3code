import * as AWS from "@/AWS";
import { Subnet } from "@/AWS/EC2";
import { Cluster } from "@/AWS/ECS/Cluster.ts";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import OneShotTask from "./fixtures/oneshot-task.ts";
import { getDefaultVpc } from "../DefaultVpc.ts";
import EcsBindingsTestFunctionLive, {
  EcsBindingsTestFunction,
} from "./handler.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "EcsBindings");

// Infra the fixture Lambda references via `Resource.ref(...)` (see
// handler.ts): a public subnet in the default VPC, a scratch cluster, and the
// one-shot busybox task definition. Yielded by BOTH deploy phases so the
// second (Lambda) deploy doesn't delete them.
const infra = Effect.gen(function* () {
  // ECS bindings are not EC2 VPC coverage. Reuse the standing default VPC so
  // this fixture does not compete for the account's small VPC quota during a
  // high-concurrency AWS sweep. The stack still owns its subnet, preserving
  // Resource.ref coverage and deterministic cleanup.
  const vpc = yield* getDefaultVpc;
  const subnet = yield* Subnet("EcsBindingsSubnet", {
    vpcId: vpc.vpcId,
    cidrBlock: vpc.subnetCidrBlock(240),
    mapPublicIpOnLaunch: true,
  });
  const cluster = yield* Cluster("EcsBindingsCluster", {
    clusterName: "alchemy-test-ecs-bindings",
  });
  const task = yield* OneShotTask;
  return { cluster, task, subnet };
});

// Deploy is heavy: default-VPC subnet + cluster + the one-shot task definition
// + Lambda. Keep readiness polling bounded after the deploy completes.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(10),
]);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// Retry transient fixture 5xx (cold re-init under parallel load); a genuine
// 4xx/assertion failure is surfaced immediately.
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
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(6),
      ]),
    }),
  );

interface RunResponse {
  taskArn?: string;
  lastStatus?: string;
  failures?: { reason?: string; detail?: string }[];
}

interface DescribedTask {
  taskArn?: string;
  lastStatus?: string;
  stoppedReason?: string;
  startedBy?: string;
  containers?: { name?: string; exitCode?: number; lastStatus?: string }[];
}

const runTask = (body: { command?: string[]; startedBy?: string }) =>
  send(
    HttpClientRequest.bodyJsonUnsafe(
      HttpClientRequest.post(`${baseUrl}/run`),
      body,
    ),
  ).pipe(
    Effect.flatMap((r) => r.json),
    Effect.map((json) => json as RunResponse),
  );

const describeTask = (taskArn: string) =>
  send(
    HttpClientRequest.get(
      `${baseUrl}/describe?task=${encodeURIComponent(taskArn)}`,
    ),
  ).pipe(
    Effect.flatMap((r) => r.json),
    Effect.map(
      (json) =>
        (json as { tasks?: DescribedTask[] }).tasks?.[0] as
          | DescribedTask
          | undefined,
    ),
  );

// Poll the fixture's /describe route until the task reaches STOPPED.
// Bounded: 16 × 5s = 80s of polling. A one-shot busybox task typically stops
// within ~40s, but ECS can remain DEPROVISIONING for around a minute when the
// account is under a high-concurrency test sweep.
const describeUntilStopped = (taskArn: string) =>
  describeTask(taskArn).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (t) => t?.lastStatus === "STOPPED",
      times: 16,
    }),
  );

describe("ECS Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      // scratchStack state is in-memory, so this destroy is a tag-based
      // cloud sweep — it is what reclaims resources any previous
      // (possibly interrupted) run left behind. Do not remove it.
      yield* Effect.logInfo("ECS bindings setup: destroying previous stack");
      yield* sharedStack.destroy();

      // Phase 1: deploy the infra alone so its state exists before the
      // Lambda's `Resource.ref(...)`s resolve (refs read stack state, not
      // the in-flight plan — see handler.ts).
      yield* Effect.logInfo("ECS bindings setup: deploying infra (phase 1)");
      yield* sharedStack.deploy(infra);

      // Phase 2: same infra (idempotent re-reconcile) + the fixture Lambda.
      yield* Effect.logInfo("ECS bindings setup: deploying fixture (phase 2)");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          yield* infra;
          return yield* EcsBindingsTestFunction;
        }).pipe(Effect.provide(EcsBindingsTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      const readinessUrl = `${baseUrl}/list`;

      yield* Effect.logInfo(
        `ECS bindings setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `ECS bindings setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
      yield* Effect.logInfo("ECS bindings setup: fixture ready");
    }),
    // High-concurrency full-suite sweeps starve the container build/push +
    // phase-2 Lambda bundle. After a nuke the ECR repo is gone, so every
    // round is a cold build — 210s tripped at c96 (convergence round 6).
    { timeout: 330_000 },
  );

  // NO_DESTROY=1 keeps the deployment around between runs while iterating —
  // without it an interrupted run tears everything down and the next run
  // pays the full cold build again.
  afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), {
    timeout: 180_000,
  });

  describe("RunTask", () => {
    test.provider(
      "runs a one-shot Fargate task",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* runTask({ startedBy: "alchemy-run-test" });
          expect(response.failures ?? []).toEqual([]);
          expect(response.taskArn).toMatch(/:task\//);
          // RunTask returns the task in its initial state.
          expect(response.lastStatus).toBeTruthy();
        }),
      { timeout: 120_000 },
    );
  });

  describe("DescribeTasks", () => {
    test.provider(
      "observes a one-shot task run to completion with exit code 0",
      (_stack) =>
        Effect.gen(function* () {
          const run = yield* runTask({ startedBy: "alchemy-describe-test" });
          expect(run.taskArn).toBeTruthy();

          const stopped = yield* describeUntilStopped(run.taskArn!);
          expect(stopped?.lastStatus).toBe("STOPPED");
          expect(stopped?.startedBy).toBe("alchemy-describe-test");
          expect(stopped?.containers?.[0]?.exitCode).toBe(0);
        }),
      { timeout: 240_000 },
    );

    test.provider(
      "reports MISSING for an unknown task id",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(
              `${baseUrl}/describe?task=00000000000000000000000000000000`,
            ),
          ).pipe(Effect.flatMap((r) => r.json));
          const failures = (response as { failures?: { reason?: string }[] })
            .failures;
          expect(failures?.length).toBe(1);
          expect(failures?.[0]?.reason).toBe("MISSING");
        }),
      { timeout: 60_000 },
    );
  });

  describe("ListTasks", () => {
    test.provider(
      "lists tasks in the bound cluster by startedBy",
      (_stack) =>
        Effect.gen(function* () {
          const run = yield* runTask({ startedBy: "alchemy-list-test" });
          expect(run.taskArn).toBeTruthy();

          // A one-shot echo task can stop before we ever observe it RUNNING,
          // so poll the STOPPED listing until it appears (stopped tasks stay
          // listed for ~an hour).
          const taskArns = yield* send(
            HttpClientRequest.get(
              `${baseUrl}/list?status=STOPPED&startedBy=alchemy-list-test`,
            ),
          ).pipe(
            Effect.flatMap((r) => r.json),
            Effect.map(
              (json) => (json as { taskArns: string[] }).taskArns ?? [],
            ),
            Effect.repeat({
              schedule: Schedule.spaced("5 seconds"),
              until: (arns) => arns.includes(run.taskArn!),
              times: 10,
            }),
          );
          expect(taskArns).toContain(run.taskArn!);
        }),
      { timeout: 240_000 },
    );
  });

  describe("ListServices", () => {
    test.provider(
      "lists services in the bound cluster (none deployed)",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/services`),
          ).pipe(Effect.flatMap((r) => r.json));
          expect((response as { serviceArns: string[] }).serviceArns).toEqual(
            [],
          );
        }),
      { timeout: 60_000 },
    );
  });

  describe("DescribeServices", () => {
    test.provider(
      "reports MISSING for an unknown service",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(
              `${baseUrl}/describe-services?service=alchemy-no-such-service`,
            ),
          ).pipe(Effect.flatMap((r) => r.json));
          const failures = (response as { failures?: { reason?: string }[] })
            .failures;
          expect(failures?.length).toBe(1);
          expect(failures?.[0]?.reason).toBe("MISSING");
        }),
      { timeout: 60_000 },
    );
  });

  describe("ListContainerInstances", () => {
    test.provider(
      "returns no container instances for a Fargate-only cluster",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/container-instances`),
          ).pipe(Effect.flatMap((r) => r.json));
          expect(
            (response as { containerInstanceArns: string[] })
              .containerInstanceArns,
          ).toEqual([]);
        }),
      { timeout: 60_000 },
    );
  });

  describe("TaskProtection", () => {
    test.provider(
      "get/update task protection round-trips for a standalone task",
      (_stack) =>
        Effect.gen(function* () {
          // Task protection only applies to service-managed tasks; for a
          // standalone RunTask task AWS reports TASK_NOT_VALID (as a failure
          // entry or a typed InvalidParameterException). Either way the
          // probe proves IAM, the cluster injection, and (for /protect) the
          // Duration → expiresInMinutes mapping reached AWS intact.
          const run = yield* runTask({
            command: ["sh", "-c", "sleep 300"],
            startedBy: "alchemy-protection-test",
          });
          expect(run.taskArn).toBeTruthy();

          interface ProtectionResponse {
            error?: string;
            failures?: { reason?: string }[];
            protectedTasks?: unknown[];
          }
          const isTaskNotValid = (r: ProtectionResponse): boolean =>
            r.error === "InvalidParameterException" ||
            r.failures?.[0]?.reason === "TASK_NOT_VALID";

          const protect = (yield* send(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/protect`),
              { taskArn: run.taskArn },
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as ProtectionResponse;
          expect(isTaskNotValid(protect)).toBe(true);

          const protection = (yield* send(
            HttpClientRequest.get(
              `${baseUrl}/protection?task=${encodeURIComponent(run.taskArn!)}`,
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as ProtectionResponse;
          expect(isTaskNotValid(protection)).toBe(true);

          // Clean up the sleeping task.
          yield* send(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/stop`),
              { taskArn: run.taskArn, reason: "protection test done" },
            ),
          );
        }),
      { timeout: 120_000 },
    );
  });

  describe("StopTask", () => {
    test.provider(
      "stops a long-running task with a reason",
      (_stack) =>
        Effect.gen(function* () {
          // Override the one-shot command so the task stays alive until
          // stopped (containerOverrides replaces the image CMD).
          const run = yield* runTask({
            command: ["sh", "-c", "sleep 300"],
            startedBy: "alchemy-stop-test",
          });
          expect(run.taskArn).toBeTruthy();

          const stop = yield* send(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/stop`),
              { taskArn: run.taskArn, reason: "alchemy stop test" },
            ),
          ).pipe(Effect.flatMap((r) => r.json));
          expect((stop as { taskArn?: string }).taskArn).toBe(run.taskArn);
          expect((stop as { desiredStatus?: string }).desiredStatus).toBe(
            "STOPPED",
          );

          const stopped = yield* describeUntilStopped(run.taskArn!);
          expect(stopped?.lastStatus).toBe("STOPPED");
          expect(stopped?.stoppedReason).toBe("alchemy stop test");
        }),
      { timeout: 240_000 },
    );
  });
});
