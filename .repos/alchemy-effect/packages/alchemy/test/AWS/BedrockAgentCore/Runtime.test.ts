import * as AWS from "@/AWS";
import { Runtime } from "@/AWS/BedrockAgentCore";
import { Role } from "@/AWS/IAM/Role.ts";
import * as Test from "@/Test/Alchemy";
import * as control from "@distilled.cloud/aws/bedrock-agentcore-control";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag this provider's read/delete paths depend on.
test.provider(
  "getAgentRuntime on a nonexistent id fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        control.getAgentRuntime({
          agentRuntimeId: "alchemy_nonexistent_probe-0000000000",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

const assertRuntimeGone = (agentRuntimeId: string) =>
  Effect.gen(function* () {
    const status = yield* control.getAgentRuntime({ agentRuntimeId }).pipe(
      Effect.map((r) => r.status as string),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed("GONE" as string),
      ),
    );
    if (status !== "GONE") {
      return yield* Effect.fail(
        new Error(`runtime still exists (status: ${status})`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(18),
      ]),
    }),
  );

// The full lifecycle needs a deployable agent container image in ECR —
// something a CI account cannot fabricate cheaply. Gate behind
// AWS_TEST_AGENTCORE=1 and provide the image via AWS_TEST_AGENTCORE_IMAGE
// (an ECR image URI in the same account/region, e.g. built from the
// AgentCore starter toolkit).
test.provider.skipIf(
  !process.env.AWS_TEST_AGENTCORE || !process.env.AWS_TEST_AGENTCORE_IMAGE,
)(
  "create container-backed agent runtime, verify, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { runtime } = yield* stack.deploy(
        Effect.gen(function* () {
          const role = yield* Role("RuntimeRole", {
            assumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "bedrock-agentcore.amazonaws.com" },
                  Action: ["sts:AssumeRole"],
                },
              ],
            },
            managedPolicyArns: [
              "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
            ],
          });
          const runtime = yield* Runtime("TestAgent", {
            agentRuntimeArtifact: {
              containerConfiguration: {
                containerUri: process.env.AWS_TEST_AGENTCORE_IMAGE!,
              },
            },
            roleArn: role.roleArn,
            tags: { fixture: "agentcore-runtime" },
          });
          return { runtime };
        }),
      );

      expect(runtime.agentRuntimeId).toBeTruthy();
      expect(runtime.agentRuntimeArn).toContain(":runtime/");
      expect(runtime.status).toBe("READY");
      expect(runtime.agentRuntimeVersion).toBeTruthy();

      // out-of-band verification via distilled
      const observed = yield* control.getAgentRuntime({
        agentRuntimeId: runtime.agentRuntimeId,
      });
      expect(observed.status).toBe("READY");

      yield* stack.destroy();
      yield* assertRuntimeGone(runtime.agentRuntimeId);
    }),
  { timeout: 600_000 },
);
