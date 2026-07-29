/**
 * Live test for `StateMachine.fromProgram`: deploy a typed `Sfn` program
 * (Lambda invoke + retry, inline Map, Choice, typed Fail + catchTag) as an
 * EXPRESS workflow, execute it synchronously, and assert the execution
 * output — alongside a raw-ASL `StateMachine` in the same stack proving the
 * low-level `definition` path is unchanged.
 */
import * as AWS from "@/AWS";
import * as Lambda from "@/AWS/Lambda";
import { StateMachine } from "@/AWS/StepFunctions";
import * as Test from "@/Test/Alchemy";
import * as sfn from "@distilled.cloud/aws/sfn";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import {
  makeOrderProgram,
  type OrderOutput,
} from "./fixtures/order-program.ts";

const { test } = Test.make({ providers: AWS.providers() });

const doublerMain = new URL("./fixtures/doubler.ts", import.meta.url).pathname;

const plain = (
  value: string | Redacted.Redacted<string> | undefined,
): string | undefined =>
  value === undefined
    ? undefined
    : typeof value === "string"
      ? value
      : Redacted.value(value);

/**
 * A sync execution finished in a non-SUCCEEDED state. Fresh execution
 * roles propagate eventually — the first executions can fail on IAM — so
 * the caller retries this tag on a bounded schedule.
 */
class ExecutionNotSucceeded extends Data.TaggedError("ExecutionNotSucceeded")<{
  readonly status: string;
  readonly error: string | undefined;
  readonly cause: string | undefined;
}> {}

test.provider(
  "fromProgram deploys and executes a typed program; raw definition path unchanged",
  (stack) =>
    Effect.gen(function* () {
      const outputs = yield* stack.deploy(
        Effect.gen(function* () {
          const doubler = yield* Lambda.Function("SfnDoubler", {
            main: doublerMain,
            handler: "handler",
            isExternal: true,
            url: false,
            timeout: Duration.seconds(15),
          });
          const machine = yield* StateMachine.fromProgram("OrderProgram", {
            type: "EXPRESS",
            program: makeOrderProgram(doubler),
          });
          // raw ASL path, same stack — stays first-class underneath
          const raw = yield* StateMachine("RawWorkflow", {
            definition: {
              Comment: "raw",
              StartAt: "Done",
              States: {
                Done: { Type: "Pass", Result: { ok: true }, End: true },
              },
            },
          });
          return { machine, raw };
        }),
      );

      expect(outputs.machine.stateMachineArn).toContain(":stateMachine:");
      expect(outputs.machine.type).toBe("EXPRESS");

      // the compiled definition round-trips as JSONata ASL
      const described = yield* sfn.describeStateMachine({
        stateMachineArn: outputs.machine.stateMachineArn,
      });
      const definition = JSON.parse(plain(described.definition)!) as {
        QueryLanguage: string;
        StartAt: string;
        States: Record<string, { Type: string }>;
      };
      expect(definition.QueryLanguage).toBe("JSONata");
      const stateTypes = Object.values(definition.States).map((s) => s.Type);
      expect(stateTypes).toContain("Task");
      expect(stateTypes).toContain("Map");
      expect(stateTypes).toContain("Choice");

      // execute synchronously and assert the program's output end-to-end;
      // retry non-SUCCEEDED results through IAM propagation on the fresh
      // execution role (bounded)
      const result = yield* sfn
        .startSyncExecution({
          stateMachineArn: outputs.machine.stateMachineArn,
          input: JSON.stringify({ value: 6, items: [1, 2, 3] }),
        })
        .pipe(
          Effect.flatMap((execution) =>
            execution.status === "SUCCEEDED"
              ? Effect.succeed(execution)
              : Effect.fail(
                  new ExecutionNotSucceeded({
                    status: execution.status,
                    error: plain(execution.error),
                    cause: plain(execution.cause),
                  }),
                ),
          ),
          Effect.retry({
            while: (e) => e._tag === "ExecutionNotSucceeded",
            schedule: Schedule.max([
              Schedule.fixed("3 seconds"),
              Schedule.recurs(10),
            ]),
          }),
        );
      const output = JSON.parse(plain(result.output)!) as OrderOutput;
      expect(output).toEqual({
        doubled: 12,
        items: [2, 4, 6],
        size: "big",
        recovered: "no stock",
      });

      // Choice's false branch: small input
      const small = yield* sfn
        .startSyncExecution({
          stateMachineArn: outputs.machine.stateMachineArn,
          input: JSON.stringify({ value: 2, items: [] }),
        })
        .pipe(
          Effect.flatMap((execution) =>
            execution.status === "SUCCEEDED"
              ? Effect.succeed(execution)
              : Effect.fail(
                  new ExecutionNotSucceeded({
                    status: execution.status,
                    error: plain(execution.error),
                    cause: plain(execution.cause),
                  }),
                ),
          ),
          Effect.retry({
            while: (e) => e._tag === "ExecutionNotSucceeded",
            schedule: Schedule.max([
              Schedule.fixed("3 seconds"),
              Schedule.recurs(5),
            ]),
          }),
        );
      const smallOutput = JSON.parse(plain(small.output)!) as OrderOutput;
      expect(smallOutput.size).toBe("small");
      expect(smallOutput.items).toEqual([]);

      // raw path: definition stored verbatim (modulo formatting)
      const rawDescribed = yield* sfn.describeStateMachine({
        stateMachineArn: outputs.raw.stateMachineArn,
      });
      expect(JSON.parse(plain(rawDescribed.definition)!).Comment).toBe("raw");

      yield* stack.destroy();
    }),
  { timeout: 180_000 },
);
