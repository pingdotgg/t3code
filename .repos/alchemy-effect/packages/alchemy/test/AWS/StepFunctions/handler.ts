import * as Lambda from "@/AWS/Lambda";
import * as SQS from "@/AWS/SQS";
import * as StepFunctions from "@/AWS/StepFunctions";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

const plain = (
  value: string | Redacted.Redacted<string> | undefined,
): string | undefined =>
  value === undefined
    ? undefined
    : typeof value === "string"
      ? value
      : Redacted.value(value);

export class SFNTestFunction extends Lambda.Function<Lambda.Function>()(
  "SFNTestFunction",
) {}

export default SFNTestFunction.make(
  {
    main,
    url: true,
    // routes long-poll SQS/GetActivityTask (up to 60s when no task is
    // scheduled) and round-trip whole workflows — AWS's 3s default
    // intermittently times out under cold starts
    timeout: Duration.seconds(75),
  },
  Effect.gen(function* () {
    // EXPRESS workflow for synchronous invocation
    const express = yield* StepFunctions.StateMachine("TestExpressMachine", {
      type: "EXPRESS",
      definition: {
        StartAt: "Echo",
        States: {
          Echo: {
            Type: "Pass",
            Parameters: { "echo.$": "$", greeting: "hello" },
            End: true,
          },
        },
      },
    });

    // STANDARD workflow for async start + describe polling
    const standard = yield* StepFunctions.StateMachine("TestStandardMachine", {
      definition: {
        StartAt: "Done",
        States: {
          Done: { Type: "Pass", Result: { done: true }, End: true },
        },
      },
    });

    // Callback-pattern workflow: parks on .waitForTaskToken after sending
    // the task token to an SQS queue.
    const callbackQueue = yield* SQS.Queue("CallbackQueue");
    const callback = yield* StepFunctions.StateMachine("TestCallbackMachine", {
      definition: {
        StartAt: "WaitForCallback",
        States: {
          WaitForCallback: {
            Type: "Task",
            Resource: "arn:aws:states:::sqs:sendMessage.waitForTaskToken",
            Parameters: {
              QueueUrl: callbackQueue.queueUrl,
              MessageBody: {
                "token.$": "$$.Task.Token",
                "executionArn.$": "$$.Execution.Id",
              },
            },
            TimeoutSeconds: 300,
            End: true,
          },
        },
      },
      policyStatements: [
        {
          Effect: "Allow",
          Action: ["sqs:SendMessage"],
          Resource: [callbackQueue.queueArn],
        },
      ],
    });

    // Activity-worker workflow: a Task state that parks on an Activity ARN
    // until a worker polls it with GetActivityTask and completes it.
    const activity = yield* StepFunctions.Activity("PollActivity", {});
    const activityMachine = yield* StepFunctions.StateMachine(
      "TestActivityMachine",
      {
        definition: {
          StartAt: "WaitForWorker",
          States: {
            WaitForWorker: {
              Type: "Task",
              Resource: activity.activityArn,
              TimeoutSeconds: 300,
              End: true,
            },
          },
        },
      },
    );

    // Distributed Map workflow: produces a Map Run per execution for the
    // ListMapRuns/DescribeMapRun/UpdateMapRun bindings.
    const mapMachine = yield* StepFunctions.StateMachine("TestMapMachine", {
      definition: {
        StartAt: "MapItems",
        States: {
          MapItems: {
            Type: "Map",
            ItemsPath: "$.items",
            MaxConcurrency: 1,
            ItemProcessor: {
              ProcessorConfig: {
                Mode: "DISTRIBUTED",
                ExecutionType: "EXPRESS",
              },
              StartAt: "PassItem",
              States: { PassItem: { Type: "Pass", End: true } },
            },
            End: true,
          },
        },
      },
      // A Distributed Map's execution role starts (and observes) child
      // EXPRESS executions of the machine itself — self-referential, so
      // grant service-wide.
      policyStatements: [
        {
          Effect: "Allow",
          Action: [
            "states:StartExecution",
            "states:DescribeExecution",
            "states:StopExecution",
          ],
          Resource: ["*"],
        },
      ],
    });

    // Event source: subscribe the host to this machine's execution status
    // changes. The deploy proves the EventBridge rule + invoke permission
    // wiring (and that Output-valued ARNs resolve inside the pattern).
    yield* StepFunctions.consumeExecutionEvents(
      { stateMachines: [standard], statuses: ["SUCCEEDED", "FAILED"] },
      (events) =>
        Stream.runForEach(events, (event) =>
          Effect.log(
            `execution ${event.detail.executionArn}: ${event.detail.status}`,
          ),
        ),
    );

    const startSyncExecution = yield* StepFunctions.StartSyncExecution(express);
    const startExecution = yield* StepFunctions.StartExecution(standard);
    const startCallbackExecution =
      yield* StepFunctions.StartExecution(callback);
    const describeStandardExecution =
      yield* StepFunctions.DescribeExecution(standard);
    const describeCallbackExecution =
      yield* StepFunctions.DescribeExecution(callback);
    const stopExecution = yield* StepFunctions.StopExecution(callback);
    const sendTaskSuccess = yield* StepFunctions.SendTaskSuccess();
    const sendTaskFailure = yield* StepFunctions.SendTaskFailure();
    const sendTaskHeartbeat = yield* StepFunctions.SendTaskHeartbeat();
    const validateDefinition =
      yield* StepFunctions.ValidateStateMachineDefinition();
    const testState = yield* StepFunctions.TestState();
    const receiveMessage = yield* SQS.ReceiveMessage(callbackQueue);
    const deleteMessage = yield* SQS.DeleteMessage(callbackQueue);

    const startActivityExecution =
      yield* StepFunctions.StartExecution(activityMachine);
    const describeActivityExecution =
      yield* StepFunctions.DescribeExecution(activityMachine);
    const getActivityTask = yield* StepFunctions.GetActivityTask(activity);
    const listExecutions = yield* StepFunctions.ListExecutions(standard);
    const getExecutionHistory =
      yield* StepFunctions.GetExecutionHistory(standard);
    const redriveExecution = yield* StepFunctions.RedriveExecution(standard);
    const startMapExecution = yield* StepFunctions.StartExecution(mapMachine);
    const describeMapExecution =
      yield* StepFunctions.DescribeExecution(mapMachine);
    const listMapRuns = yield* StepFunctions.ListMapRuns(mapMachine);
    const describeMapRun = yield* StepFunctions.DescribeMapRun(mapMachine);
    const updateMapRun = yield* StepFunctions.UpdateMapRun(mapMachine);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/health") {
          return HttpServerResponse.text("ok");
        }

        if (request.method === "POST" && pathname === "/start-sync") {
          const body = (yield* request.json) as unknown as { input?: string };
          const result = yield* startSyncExecution({ input: body.input });
          return yield* HttpServerResponse.json({
            executionArn: result.executionArn,
            status: result.status,
            output: plain(result.output),
            error: plain(result.error),
            cause: plain(result.cause),
          });
        }

        if (request.method === "POST" && pathname === "/start") {
          const body = (yield* request.json) as unknown as { input?: string };
          const result = yield* startExecution({ input: body.input });
          return yield* HttpServerResponse.json({
            executionArn: result.executionArn,
          });
        }

        if (request.method === "POST" && pathname === "/start-callback") {
          const result = yield* startCallbackExecution();
          return yield* HttpServerResponse.json({
            executionArn: result.executionArn,
          });
        }

        if (request.method === "GET" && pathname === "/describe-standard") {
          const executionArn = url.searchParams.get("executionArn")!;
          const result = yield* describeStandardExecution({ executionArn });
          return yield* HttpServerResponse.json({
            status: result.status,
            output: plain(result.output),
          });
        }

        if (request.method === "GET" && pathname === "/describe-callback") {
          const executionArn = url.searchParams.get("executionArn")!;
          const result = yield* describeCallbackExecution({ executionArn });
          return yield* HttpServerResponse.json({
            status: result.status,
            output: plain(result.output),
            error: plain(result.error),
          });
        }

        if (request.method === "GET" && pathname === "/receive-token") {
          const result = yield* receiveMessage({
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: 5,
            // resurface quickly if a failed invocation consumed the message
            VisibilityTimeout: 15,
          });
          const message = result.Messages?.[0];
          if (!message?.Body) {
            return yield* HttpServerResponse.json({ token: null });
          }
          yield* deleteMessage({ ReceiptHandle: message.ReceiptHandle! });
          const parsed = JSON.parse(message.Body) as {
            token: string;
            executionArn: string;
          };
          return yield* HttpServerResponse.json({
            token: parsed.token,
            executionArn: parsed.executionArn,
          });
        }

        if (request.method === "POST" && pathname === "/task-success") {
          const body = (yield* request.json) as unknown as {
            token: string;
            output: string;
          };
          yield* sendTaskSuccess({
            taskToken: body.token,
            output: body.output,
          });
          return yield* HttpServerResponse.json({ sent: true });
        }

        if (request.method === "POST" && pathname === "/task-failure") {
          const body = (yield* request.json) as unknown as {
            token: string;
            error?: string;
            cause?: string;
          };
          yield* sendTaskFailure({
            taskToken: body.token,
            error: body.error,
            cause: body.cause,
          });
          return yield* HttpServerResponse.json({ sent: true });
        }

        if (request.method === "POST" && pathname === "/task-heartbeat") {
          const body = (yield* request.json) as unknown as { token: string };
          yield* sendTaskHeartbeat({ taskToken: body.token });
          return yield* HttpServerResponse.json({ sent: true });
        }

        if (request.method === "POST" && pathname === "/validate-definition") {
          const body = (yield* request.json) as unknown as {
            definition: string;
            type?: "STANDARD" | "EXPRESS";
          };
          const report = yield* validateDefinition({
            definition: body.definition,
            type: body.type,
            severity: "ERROR",
          });
          return yield* HttpServerResponse.json({
            result: report.result,
            diagnostics: report.diagnostics.map((diagnostic) => ({
              severity: diagnostic.severity,
              code: plain(diagnostic.code),
              message: plain(diagnostic.message),
            })),
          });
        }

        if (request.method === "POST" && pathname === "/test-state") {
          const body = (yield* request.json) as unknown as {
            definition: string;
            input?: string;
          };
          const result = yield* testState({
            definition: body.definition,
            input: body.input,
          });
          return yield* HttpServerResponse.json({
            status: result.status,
            output: plain(result.output),
            error: plain(result.error),
          });
        }

        if (request.method === "POST" && pathname === "/stop") {
          const body = (yield* request.json) as unknown as {
            executionArn: string;
          };
          const result = yield* stopExecution({
            executionArn: body.executionArn,
            error: "TestStop",
            cause: "stopped by integration test",
          });
          return yield* HttpServerResponse.json({
            stopDate: result.stopDate.toISOString(),
          });
        }

        if (request.method === "POST" && pathname === "/start-activity") {
          const result = yield* startActivityExecution();
          return yield* HttpServerResponse.json({
            executionArn: result.executionArn,
          });
        }

        if (request.method === "GET" && pathname === "/activity-task") {
          const task = yield* getActivityTask({
            workerName: "sfn-bindings-test",
          });
          return yield* HttpServerResponse.json({
            taskToken: task.taskToken ?? null,
            input: plain(task.input) ?? null,
          });
        }

        if (request.method === "GET" && pathname === "/describe-activity") {
          const executionArn = url.searchParams.get("executionArn")!;
          const result = yield* describeActivityExecution({ executionArn });
          return yield* HttpServerResponse.json({
            status: result.status,
            output: plain(result.output),
          });
        }

        if (request.method === "GET" && pathname === "/list-executions") {
          const statusFilter = url.searchParams.get("status") ?? undefined;
          const result = yield* listExecutions({
            statusFilter: statusFilter as "SUCCEEDED" | undefined,
          });
          return yield* HttpServerResponse.json({
            count: result.executions.length,
            executionArns: result.executions.map((e) => e.executionArn),
          });
        }

        if (request.method === "GET" && pathname === "/history") {
          const executionArn = url.searchParams.get("executionArn")!;
          const result = yield* getExecutionHistory({
            executionArn,
            reverseOrder: true,
            maxResults: 20,
          });
          return yield* HttpServerResponse.json({
            count: result.events.length,
            lastType: result.events[0]?.type ?? null,
          });
        }

        if (request.method === "POST" && pathname === "/redrive") {
          const body = (yield* request.json) as unknown as {
            executionArn: string;
          };
          const result = yield* redriveExecution({
            executionArn: body.executionArn,
          }).pipe(
            Effect.map(() => ({ redriven: true as const })),
            Effect.catchTag("ExecutionNotRedrivable", () =>
              Effect.succeed({
                redriven: false as const,
                error: "ExecutionNotRedrivable",
              }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "POST" && pathname === "/start-map") {
          const result = yield* startMapExecution({
            input: JSON.stringify({ items: [1, 2] }),
          });
          return yield* HttpServerResponse.json({
            executionArn: result.executionArn,
          });
        }

        if (request.method === "GET" && pathname === "/describe-map") {
          const executionArn = url.searchParams.get("executionArn")!;
          const result = yield* describeMapExecution({ executionArn });
          return yield* HttpServerResponse.json({ status: result.status });
        }

        if (request.method === "GET" && pathname === "/map-runs") {
          const executionArn = url.searchParams.get("executionArn")!;
          const result = yield* listMapRuns({ executionArn });
          return yield* HttpServerResponse.json({
            mapRunArns: result.mapRuns.map((run) => run.mapRunArn),
          });
        }

        if (request.method === "GET" && pathname === "/describe-map-run") {
          const mapRunArn = url.searchParams.get("mapRunArn")!;
          const result = yield* describeMapRun({ mapRunArn });
          return yield* HttpServerResponse.json({
            status: result.status,
            maxConcurrency: result.maxConcurrency,
            succeeded: result.itemCounts?.succeeded,
          });
        }

        if (request.method === "POST" && pathname === "/update-map-run") {
          const body = (yield* request.json) as unknown as {
            mapRunArn: string;
            maxConcurrency?: number;
          };
          // UpdateMapRun targets in-progress Map Runs; a completed one
          // answers with the typed ValidationException — either way the
          // IAM grant and typed union are exercised.
          const result = yield* updateMapRun({
            mapRunArn: body.mapRunArn,
            maxConcurrency: body.maxConcurrency ?? 2,
          }).pipe(
            Effect.map(() => ({ updated: true as const })),
            Effect.catchTag("ValidationException", () =>
              Effect.succeed({
                updated: false as const,
                error: "ValidationException",
              }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        StepFunctions.StartExecutionHttp,
        StepFunctions.StartSyncExecutionHttp,
        StepFunctions.DescribeExecutionHttp,
        StepFunctions.StopExecutionHttp,
        StepFunctions.SendTaskSuccessHttp,
        StepFunctions.SendTaskFailureHttp,
        StepFunctions.SendTaskHeartbeatHttp,
        StepFunctions.ValidateStateMachineDefinitionHttp,
        StepFunctions.TestStateHttp,
        StepFunctions.GetActivityTaskHttp,
        StepFunctions.ListExecutionsHttp,
        StepFunctions.GetExecutionHistoryHttp,
        StepFunctions.RedriveExecutionHttp,
        StepFunctions.ListMapRunsHttp,
        StepFunctions.DescribeMapRunHttp,
        StepFunctions.UpdateMapRunHttp,
        Lambda.EventSource,
        SQS.ReceiveMessageHttp,
        SQS.DeleteMessageHttp,
      ),
    ),
  ),
);
