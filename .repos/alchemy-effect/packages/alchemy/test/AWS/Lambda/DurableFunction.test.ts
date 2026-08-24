import * as AWS from "@/AWS";
import { encodeDurableEnvelope } from "@/AWS/Lambda/DurableBridge.ts";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as Lambda from "@distilled.cloud/aws/lambda";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import DurableFlowLive, { DurableFlow } from "./fixtures/durable-handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "LambdaDurable");

const unwrapSensitive = (
  value: string | Redacted.Redacted<string> | undefined,
): string | undefined =>
  value === undefined
    ? undefined
    : Redacted.isRedacted(value)
      ? Redacted.value(value)
      : value;

describe("Lambda DurableFunction", () => {
  // Ungated typed-error probe: proves the durable-execution management API is
  // reachable in this region and that its errors are typed tags in the
  // distilled union — at near-zero cost, forever.
  test.provider(
    "durable management API returns typed errors",
    (_stack) =>
      Effect.gen(function* () {
        const result = yield* Effect.result(
          Lambda.listDurableExecutionsByFunction({
            FunctionName: "alchemy-durable-probe-nonexistent",
          }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("ResourceNotFoundException");
        }
      }),
    { timeout: 30_000 },
  );

  // Full lifecycle: a real deploy (bundling + vendoring the Durable Execution
  // SDK + waiting out IAM role propagation) plus a live durable execution with
  // a suspend/resume.
  describe("lifecycle", () => {
    let functionName: string;

    beforeAll(
      Effect.gen(function* () {
        yield* Effect.logInfo("Durable test setup: destroying previous stack");
        yield* sharedStack.destroy();
        yield* Effect.logInfo(
          "Durable test setup: deploying the DurableFunction",
        );
        const outputs = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const flow = yield* DurableFlow;
            return { functionName: flow.functionName };
          }).pipe(Effect.provide(DurableFlowLive)),
        );
        functionName = outputs.functionName;
        expect(functionName).toBeTruthy();
      }),
      { timeout: 420_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 120_000 });

    test.provider(
      "runs a 2-step + sleep orchestration to completion",
      (_stack) =>
        Effect.gen(function* () {
          // Durable executions must target a QUALIFIED ARN (a published
          // version or alias) — invoking the unqualified function is rejected
          // with `InvalidParameterValueException`. Publish a version and pin
          // the execution to it. The freshly-deployed code may still be
          // updating, so retry while the function reports a pending update.
          const published = yield* Lambda.publishVersion({
            FunctionName: functionName,
          }).pipe(
            Effect.retry({
              while: (e) => e._tag === "ResourceConflictException",
              schedule: Schedule.spaced("3 seconds"),
              times: 20,
            }),
          );
          const qualifier = published.Version!;
          expect(qualifier).toBeTruthy();

          // Start: async Invoke with the alchemy envelope and an idempotent
          // execution name (safe to re-run — same name + same payload
          // reattaches to the existing execution).
          const started = yield* Lambda.invoke({
            FunctionName: functionName,
            Qualifier: qualifier,
            InvocationType: "Event",
            DurableExecutionName: "durable-test-flow-1",
            Payload: encodeDurableEnvelope("DurableFlow", {
              orderId: "order-1",
            }),
          });
          expect(started.StatusCode).toBe(202);

          // Resolve the execution ARN — from the Invoke response when
          // present, otherwise via the list API (bounded).
          const executionArn = started.DurableExecutionArn
            ? started.DurableExecutionArn
            : yield* Lambda.listDurableExecutionsByFunction({
                FunctionName: functionName,
                DurableExecutionName: "durable-test-flow-1",
              }).pipe(
                Effect.map(
                  (r) => r.DurableExecutions?.[0]?.DurableExecutionArn,
                ),
                Effect.repeat({
                  schedule: Schedule.spaced("2 seconds"),
                  until: (arn) => arn !== undefined,
                  times: 10,
                }),
                Effect.map((arn) => arn!),
              );

          // The flow sleeps 5s mid-way (a real suspend/resume), so poll the
          // execution to a terminal state with a bounded schedule.
          const execution = yield* Lambda.getDurableExecution({
            DurableExecutionArn: executionArn,
          }).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("3 seconds"),
              until: (r) => r.Status !== "RUNNING",
              times: 30,
            }),
          );

          expect(execution.Status).toBe("SUCCEEDED");
          const result = JSON.parse(unwrapSensitive(execution.Result) ?? "{}");
          expect(result).toEqual({
            orderId: "order-1",
            reserved: true,
            total: 42,
          });
        }),
      { timeout: 150_000 },
    );
  });
});
