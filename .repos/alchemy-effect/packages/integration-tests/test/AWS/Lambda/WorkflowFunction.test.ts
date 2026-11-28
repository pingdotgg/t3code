import * as AWS from "@alchemy.run/aws";
import { executionNameOf } from "@alchemy.run/aws/Lambda/WorkflowFunction";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Lambda from "@distilled.cloud/aws/lambda";
import type { Status } from "alchemy/Workflows";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { conformance } from "../../Workflows/conformance/conformance.ts";
import CallerLive, { WorkflowCaller } from "./fixtures/durable-workflows/caller.ts";
import HostLive, { TestWorkflows } from "./fixtures/durable-workflows/host.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "LambdaWorkflowFunction");

class NotReady extends Data.TaggedError("NotReady")<{ readonly message: string }> {}

type RunStatus = Status<unknown, unknown>;

/** A caller route's body, retried until it answers 200. */
const request = <T>(target: string, method: "GET" | "POST" = "GET") =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* method === "POST" ? client.post(target) : client.get(target);
    const body = yield* response.text;
    if (response.status !== 200) {
      return yield* new NotReady({ message: `${method} ${target}: ${response.status}: ${body}` });
    }
    return (body.startsWith("{") ? JSON.parse(body) : body) as T;
  }).pipe(
    Effect.retry({
      while: (error) => error._tag === "NotReady",
      schedule: Schedule.spaced("1 second"),
      times: 5,
    }),
  );

/** A fresh id per run, so a retried test never reads an earlier attempt's execution. */
const freshId = (prefix: string) =>
  Effect.sync(() => `${prefix}-${crypto.randomUUID().slice(0, 8)}`);

describe(
  "Lambda WorkflowFunction",
  { tags: ["provider:aws", "provider:aws:lambda", "live"] },
  () => {
    const deployed = beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const outputs = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* TestWorkflows;
            const caller = yield* WorkflowCaller;
            return {
              functionName: host.functionName,
              version: host.version,
              url: caller.functionUrl,
            };
          }).pipe(Effect.provide(Layer.mergeAll(HostLive, CallerLive))),
        );
        const url = outputs.url!.replace(/\/$/, "");
        // A fresh Function URL can take a while to start serving.
        yield* request(`${url}/ready`).pipe(
          Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 30 }),
        );
        return { functionName: outputs.functionName, aliasVersion: outputs.version!, url };
      }),
      { timeout: 600_000 },
    );
    afterAll(sharedStack.destroy(), { timeout: 120_000 });

    conformance({
      test,
      url: Effect.map(deployed, ({ url }) => url),
      // Each wake-up is a fresh invocation of the host.
      napsWithinMillis: 40_000,
      // Lambda retries a durable step with its own policy.
      recoveryWithinMillis: undefined,
      timeout: 180_000,
      unsupported: { raceAll: "aren't supported on Lambda durable functions" },
    });

    /** Start a Greet run through the caller, and wait for its result. */
    const greet = (id: string) =>
      Effect.gen(function* () {
        const { url } = yield* deployed;
        const { executionId } = yield* request<{ executionId: string }>(
          `${url}/start/Greet/${id}`,
          "POST",
        );
        const status = yield* request<RunStatus>(
          `${url}/status/Greet/${id}?executionId=${executionId}`,
        ).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (current) => current._tag !== "Running" && current._tag !== "NotStarted",
            times: 45,
          }),
        );
        return { executionId, status };
      });

    /** The durable executions of a run, on the host. */
    const executionsOf = (workflow: string, executionId: string) =>
      Effect.gen(function* () {
        const { functionName } = yield* deployed;
        return yield* Lambda.listDurableExecutionsByFunction({
          FunctionName: functionName,
          DurableExecutionName: executionNameOf(workflow, executionId),
        }).pipe(
          Effect.map((page) => page.DurableExecutions ?? []),
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (executions) => executions.length > 0,
            times: 20,
          }),
        );
      });

    test.provider(
      "starts runs on the host's alias",
      (_stack) =>
        Effect.gen(function* () {
          const { aliasVersion } = yield* deployed;
          const run = yield* greet(yield* freshId("alias"));
          expect(run.status).toEqual({ _tag: "Completed", result: "hello world" });
          const [execution] = yield* executionsOf("Greet", run.executionId);
          const { Version } = yield* Lambda.getDurableExecution({
            DurableExecutionArn: execution!.DurableExecutionArn,
          });
          // The version the alias serves, not `$LATEST`.
          expect(Version).toBe(aliasVersion);
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "starting the same execution twice makes one durable execution",
      (_stack) =>
        Effect.gen(function* () {
          const { url } = yield* deployed;
          const id = yield* freshId("twice");
          yield* request(`${url}/start/Greet/${id}`, "POST");
          const run = yield* greet(id);
          expect(run.status).toEqual({ _tag: "Completed", result: "hello world" });
          expect((yield* executionsOf("Greet", run.executionId)).length).toBe(1);
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "an interrupted run finishes its durable execution by itself",
      (_stack) =>
        Effect.gen(function* () {
          const { url } = yield* deployed;
          const id = yield* freshId("interrupt");
          const { executionId } = yield* request<{ executionId: string }>(
            `${url}/start/Approve/${id}`,
            "POST",
          );
          // Interrupt once it's waiting on its signal.
          yield* request<string[]>(`${url}/journal/${id}`).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("1 second"),
              until: (entries) => entries.length > 0,
              times: 30,
            }),
          );
          yield* request(`${url}/interrupt/Approve/${id}?executionId=${executionId}`, "POST");
          // Woken through its callback and finished by itself, not stopped. The
          // result is recorded before the durable execution settles, so poll
          // until it leaves RUNNING.
          const [execution] = yield* executionsOf("Approve", executionId).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: ([first]) => first?.Status !== "RUNNING",
              times: 30,
            }),
          );
          expect(execution!.Status).toBe("SUCCEEDED");
        }),
      { timeout: 180_000 },
    );
  },
);
