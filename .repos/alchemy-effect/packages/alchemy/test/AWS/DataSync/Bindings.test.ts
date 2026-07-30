import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import DataSyncTestFunctionLive, { DataSyncTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "DataSyncBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;
let functionArn: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// The shared Lambda fixture occasionally answers a transient 5xx under load
// (cold re-init, IAM propagation on the freshly attached policy that the
// handler's `Effect.orDie` surfaces as a 500). Retry only 5xx; a genuine
// 4xx/assertion failure surfaces immediately.
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

const getJson = (path: string) =>
  send(HttpClientRequest.get(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

const postJson = (path: string) =>
  send(HttpClientRequest.post(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

describe.sequential("DataSync Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "DataSync test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("DataSync test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* DataSyncTestFunction;
        }).pipe(Effect.provide(DataSyncTestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");
      functionArn = attrs.functionArn;

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `DataSync test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `DataSync test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 300_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 180_000 });

  describe("binding registration", () => {
    test.provider("all six capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/bindings")) as { bound: string[] };
        expect(response.bound).toHaveLength(6);
        expect(response.bound).toContain("startTaskExecution");
        expect(response.bound).toContain("cancelTaskExecution");
      }),
    );
  });

  describe("DescribeTask", () => {
    test.provider(
      "reads the bound task's detail (injected task arn)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/task")) as {
            taskArn: string;
            status: string;
          };
          expect(response.taskArn).toContain(":task/task-");
          expect(typeof response.status).toBe("string");
        }),
    );
  });

  describe("StartTaskExecution / ListTaskExecutions / DescribeTaskExecution / UpdateTaskExecution / CancelTaskExecution", () => {
    test.provider(
      "starts a run, observes it, throttles, cancels, and waits it out",
      (_stack) =>
        Effect.gen(function* () {
          // Start: the freshly-propagated IAM role can transiently fail the
          // location access test (typed LocationAccessTestFailed, reported
          // by the route as ok:false) — re-poll bounded.
          const started = (yield* postJson("/start").pipe(
            Effect.repeat({
              schedule: Schedule.spaced("10 seconds"),
              until: (r): boolean => (r as { ok: boolean }).ok === true,
              times: 12,
            }),
          )) as { ok: boolean; executionArn?: string; tag?: string };
          expect(started.ok).toBe(true);
          expect(started.executionArn).toContain("/execution/exec-");
          const executionArn = started.executionArn!;
          const query = `?arn=${encodeURIComponent(executionArn)}`;

          // Describe: the run reports a status.
          const execution = (yield* getJson(`/execution${query}`)) as {
            status: string;
          };
          expect(typeof execution.status).toBe("string");

          // List: the run is enumerated under the bound task.
          const executions = (yield* getJson("/executions")) as {
            arns: string[];
          };
          expect(executions.arns).toContain(executionArn);

          // Throttle: valid only in launching/preparing/transferring/
          // verifying — either it lands or DataSync rejects it with the
          // typed InvalidRequestException the route reports.
          const throttled = (yield* postJson(`/throttle${query}`)) as {
            updated: boolean;
            tag?: string;
          };
          if (!throttled.updated) {
            expect(throttled.tag).toBe("InvalidRequestException");
          }

          // Cancel: a queued/launching run is cancellable; if the empty
          // transfer raced to completion, DataSync rejects with the typed
          // InvalidRequestException instead.
          const cancelled = (yield* postJson(`/cancel${query}`)) as {
            cancelled: boolean;
            tag?: string;
          };
          if (!cancelled.cancelled) {
            expect(cancelled.tag).toBe("InvalidRequestException");
          }

          // Observe the run after the cancel: a cancelled queued run parks
          // in CANCELLING (sometimes for minutes) before landing in ERROR —
          // any of the three proves the round-trip. `stack.destroy()`
          // deletes the task cleanly even with a CANCELLING execution, so
          // there is no need to wait for a terminal state.
          const observed = (yield* getJson(`/execution${query}`)) as {
            status: string;
          };
          expect(["CANCELLING", "ERROR", "SUCCESS"]).toContain(observed.status);
        }),
      { timeout: 240_000 },
    );
  });

  describe("consumeTaskEvents", () => {
    test.provider(
      "the deploy created an EventBridge rule targeting the function",
      (_stack) =>
        Effect.gen(function* () {
          // Out-of-band via distilled: the fixture's consumeTaskEvents must
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
