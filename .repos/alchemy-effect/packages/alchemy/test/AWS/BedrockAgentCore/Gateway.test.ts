import * as AWS from "@/AWS";
import { Gateway } from "@/AWS/BedrockAgentCore";
import { Role } from "@/AWS/IAM/Role.ts";
import * as Test from "@/Test/Alchemy";
import * as control from "@distilled.cloud/aws/bedrock-agentcore-control";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe.
test.provider(
  "getGateway on a nonexistent id fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        control.getGateway({
          gatewayIdentifier: "alchemy-nonexistent-probe-0000000000",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

const assertGatewayGone = (gatewayIdentifier: string) =>
  Effect.gen(function* () {
    const status = yield* control.getGateway({ gatewayIdentifier }).pipe(
      Effect.map((r) => r.status as string),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed("GONE" as string),
      ),
    );
    if (status !== "GONE") {
      return yield* Effect.fail(
        new Error(`gateway still exists (status: ${status})`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(12),
      ]),
    }),
  );

const gatewayStack = (description: string) =>
  Effect.gen(function* () {
    const role = yield* Role("GatewayRole", {
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
    });
    const gateway = yield* Gateway("McpGateway", {
      description,
      roleArn: role.roleArn,
      authorizerType: "AWS_IAM",
      tags: { fixture: "agentcore-gateway" },
    });
    return { gateway };
  });

test.provider(
  "create IAM-authorized MCP gateway, verify, update description, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { gateway } = yield* stack.deploy(gatewayStack("initial"));

      expect(gateway.gatewayId).toBeTruthy();
      expect(gateway.gatewayArn).toContain(":gateway/");
      expect(gateway.status).toBe("READY");
      expect(gateway.gatewayUrl).toBeTruthy();

      // out-of-band verification via distilled
      const observed = yield* control.getGateway({
        gatewayIdentifier: gateway.gatewayId,
      });
      expect(observed.status).toBe("READY");
      expect(observed.authorizerType).toBe("AWS_IAM");
      expect(observed.protocolType).toBe("MCP");

      // update in place — same gateway id, new description
      const { gateway: updated } = yield* stack.deploy(gatewayStack("updated"));
      expect(updated.gatewayId).toBe(gateway.gatewayId);
      const observedUpdated = yield* control.getGateway({
        gatewayIdentifier: gateway.gatewayId,
      });
      const description = observedUpdated.description;
      expect(
        description !== undefined && Redacted.isRedacted(description)
          ? Redacted.value(description)
          : description,
      ).toBe("updated");

      yield* stack.destroy();
      yield* assertGatewayGone(gateway.gatewayId);
    }),
  { timeout: 240_000 },
);
