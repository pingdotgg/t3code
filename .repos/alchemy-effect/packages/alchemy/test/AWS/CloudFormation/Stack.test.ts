import * as AWS from "@/AWS";
import { Stack as CfnStack } from "@/AWS/CloudFormation";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as CloudFormation from "@distilled.cloud/aws/cloudformation";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

class StackStillExists extends Data.TaggedError("StackStillExists") {}

/** Assert the stack is gone (reads as StackNotFound by name). */
const assertDeleted = Effect.fn(function* (stackName: string) {
  yield* CloudFormation.describeStacks({ StackName: stackName }).pipe(
    Effect.flatMap(() => Effect.fail(new StackStillExists())),
    Effect.retry({
      while: (e) => e._tag === "StackStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(20)]),
    }),
    Effect.catchTag("StackNotFound", () => Effect.void),
  );
});

// A tiny, free template: a single SSM String parameter whose value is a
// template parameter, plus an output echoing the generated parameter name.
const template = JSON.stringify({
  Parameters: { Value: { Type: "String" } },
  Resources: {
    Param: {
      Type: "AWS::SSM::Parameter",
      Properties: { Type: "String", Value: { Ref: "Value" } },
    },
  },
  Outputs: { ParamName: { Value: { Ref: "Param" } } },
});

const stackDef = (value: string, tags?: Record<string, string>) =>
  Effect.gen(function* () {
    const stack = yield* CfnStack("CfnTestStack", {
      templateBody: template,
      parameters: { Value: value },
      tags,
    });
    return { stack };
  });

test.provider(
  "create, no-op, update, delete a CloudFormation stack",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create.
      const { stack: created } = yield* stack.deploy(stackDef("v1"));
      expect(created.stackStatus).toBe("CREATE_COMPLETE");
      expect(created.stackId).toMatch(/^arn:aws:cloudformation:/);
      expect(created.outputs.ParamName).toBeDefined();

      // Verify out-of-band.
      const described = yield* CloudFormation.describeStacks({
        StackName: created.stackId,
      });
      const live = described.Stacks?.[0];
      expect(live?.StackStatus).toBe("CREATE_COMPLETE");
      expect(
        live?.Tags?.some(
          (t) => t.Key === "alchemy::id" && t.Value === "CfnTestStack",
        ),
      ).toBe(true);

      // No-op update (same template + params) — must not error.
      const { stack: noop } = yield* stack.deploy(stackDef("v1"));
      expect(noop.stackStatus).toBe("CREATE_COMPLETE");
      expect(noop.stackId).toBe(created.stackId);

      // Update the template parameter — stack id is stable, status becomes
      // UPDATE_COMPLETE.
      const { stack: updated } = yield* stack.deploy(
        stackDef("v2", { env: "prod" }),
      );
      expect(updated.stackId).toBe(created.stackId);
      expect(updated.stackStatus).toBe("UPDATE_COMPLETE");

      const reDescribed = yield* CloudFormation.describeStacks({
        StackName: created.stackId,
      });
      expect(reDescribed.Stacks?.[0]?.StackStatus).toBe("UPDATE_COMPLETE");
      expect(
        reDescribed.Stacks?.[0]?.Tags?.some(
          (t) => t.Key === "env" && t.Value === "prod",
        ),
      ).toBe(true);

      // Delete + wait gone.
      yield* stack.destroy();
      yield* assertDeleted(created.stackName);
    }).pipe(logLevel),
  { timeout: 300_000 },
);

test.provider(
  "list enumerates the deployed stack",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { stack: created } = yield* stack.deploy(stackDef("v1"));

      const provider = yield* Provider.findProvider(CfnStack);
      const all = yield* provider.list();
      expect(all.some((x) => x.stackId === created.stackId)).toBe(true);

      yield* stack.destroy();
      yield* assertDeleted(created.stackName);
    }).pipe(logLevel),
  { timeout: 300_000 },
);
