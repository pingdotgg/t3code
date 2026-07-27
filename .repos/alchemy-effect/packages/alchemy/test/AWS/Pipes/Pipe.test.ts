import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as pipes from "@distilled.cloud/aws/pipes";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: AWS.providers() });

const unwrap = (
  value: string | Redacted.Redacted<string> | undefined,
): string | undefined =>
  value === undefined
    ? undefined
    : Redacted.isRedacted(value)
      ? Redacted.value(value)
      : value;

const firstFilterPattern = (
  described: pipes.DescribePipeResponse,
): string | undefined =>
  unwrap(described.SourceParameters?.FilterCriteria?.Filters?.[0]?.Pattern);

// Read/receive statements the pipes.amazonaws.com role needs on the source
// queue, plus send on the target queue.
const pipeRole = (source: AWS.SQS.Queue, target: AWS.SQS.Queue) =>
  AWS.IAM.Role("LifecyclePipeRole", {
    assumeRolePolicyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: "pipes.amazonaws.com" },
          Action: ["sts:AssumeRole"],
        },
      ],
    },
    inlinePolicies: {
      PipeSource: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: [
              "sqs:ReceiveMessage",
              "sqs:DeleteMessage",
              "sqs:GetQueueAttributes",
            ],
            Resource: [source.queueArn],
          },
        ],
      },
      PipeTarget: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["sqs:SendMessage"],
            Resource: [target.queueArn],
          },
        ],
      },
    },
  });

describe("AWS.Pipes.Pipe", () => {
  test.provider(
    "lifecycle: create SQS→SQS pipe with filter, update filter, destroy",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const filterA = JSON.stringify({ body: { type: ["order.created"] } });
        const filterB = JSON.stringify({ body: { type: ["order.updated"] } });

        const deployPipe = (pattern: string) =>
          stack.deploy(
            Effect.gen(function* () {
              const source = yield* AWS.SQS.Queue("LifecycleSourceQueue");
              const target = yield* AWS.SQS.Queue("LifecycleTargetQueue");
              const role = yield* pipeRole(source, target);
              return yield* AWS.Pipes.Pipe("LifecyclePipe", {
                source: source.queueArn,
                target: target.queueArn,
                roleArn: role.roleArn,
                sourceParameters: {
                  FilterCriteria: { Filters: [{ Pattern: pattern }] },
                  SqsQueueParameters: { BatchSize: 1 },
                },
              });
            }),
          );

        // Create — the provider waits (bounded) for RUNNING before
        // returning, so the deployed attributes already reflect it.
        const created = yield* deployPipe(filterA);
        expect(created.currentState).toEqual("RUNNING");

        // Out-of-band verification via distilled.
        const describedA = yield* pipes.describePipe({
          Name: created.pipeName,
        });
        expect(describedA.CurrentState).toEqual("RUNNING");
        expect(firstFilterPattern(describedA)).toEqual(filterA);
        expect(
          describedA.SourceParameters?.SqsQueueParameters?.BatchSize,
        ).toEqual(1);

        // Update the filter criteria in place (same source → no replace).
        const updated = yield* deployPipe(filterB);
        expect(updated.pipeArn).toEqual(created.pipeArn);
        const describedB = yield* pipes.describePipe({
          Name: updated.pipeName,
        });
        expect(firstFilterPattern(describedB)).toEqual(filterB);
        expect(describedB.CurrentState).toEqual("RUNNING");

        // Destroy — the provider's delete waits until describePipe reports
        // NotFound, so a single typed check suffices here.
        yield* stack.destroy();
        const gone = yield* pipes.describePipe({ Name: created.pipeName }).pipe(
          Effect.map(() => false),
          Effect.catchTag("NotFoundException", () => Effect.succeed(true)),
        );
        expect(gone).toBe(true);
      }),
    { timeout: 240_000 },
  );

  test.provider(
    "replacement: changing the source replaces the pipe",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        // Keep BOTH candidate source queues deployed across every step —
        // replacing the pipe while simultaneously removing its old source
        // dependency deadlocks the engine.
        const deployPipe = (useSecondSource: boolean) =>
          stack.deploy(
            Effect.gen(function* () {
              const sourceA = yield* AWS.SQS.Queue("ReplaceSourceQueueA");
              const sourceB = yield* AWS.SQS.Queue("ReplaceSourceQueueB");
              const target = yield* AWS.SQS.Queue("ReplaceTargetQueue");
              const role = yield* AWS.IAM.Role("ReplacePipeRole", {
                assumeRolePolicyDocument: {
                  Version: "2012-10-17",
                  Statement: [
                    {
                      Effect: "Allow",
                      Principal: { Service: "pipes.amazonaws.com" },
                      Action: ["sts:AssumeRole"],
                    },
                  ],
                },
                inlinePolicies: {
                  PipeAccess: {
                    Version: "2012-10-17",
                    Statement: [
                      {
                        Effect: "Allow",
                        Action: [
                          "sqs:ReceiveMessage",
                          "sqs:DeleteMessage",
                          "sqs:GetQueueAttributes",
                        ],
                        Resource: [sourceA.queueArn, sourceB.queueArn],
                      },
                      {
                        Effect: "Allow",
                        Action: ["sqs:SendMessage"],
                        Resource: [target.queueArn],
                      },
                    ],
                  },
                },
              });
              const active = useSecondSource ? sourceB : sourceA;
              const pipe = yield* AWS.Pipes.Pipe("ReplacePipe", {
                source: active.queueArn,
                target: target.queueArn,
                roleArn: role.roleArn,
              });
              return { pipe, sourceA, sourceB };
            }),
          );

        const first = yield* deployPipe(false);
        expect(first.pipe.currentState).toEqual("RUNNING");

        const second = yield* deployPipe(true);
        // Replacement mints a new instance: new physical name + ARN.
        expect(second.pipe.pipeArn).not.toEqual(first.pipe.pipeArn);

        const described = yield* pipes.describePipe({
          Name: second.pipe.pipeName,
        });
        expect(described.Source).toEqual(second.sourceB.queueArn);

        // The replaced pipe is deleted.
        const oldGone = yield* pipes
          .describePipe({ Name: first.pipe.pipeName })
          .pipe(
            Effect.map(() => false),
            Effect.catchTag("NotFoundException", () => Effect.succeed(true)),
          );
        expect(oldGone).toBe(true);

        yield* stack.destroy();
      }),
    { timeout: 240_000 },
  );
});
