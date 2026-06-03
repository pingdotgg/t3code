import * as AWS from "@/AWS";
import { CapacityProvider } from "@/AWS/ECS";
import * as Test from "@/Test/Vitest";
import * as ecs from "@distilled.cloud/aws/ecs";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Skipped by default: requires a pre-provisioned EC2 Auto Scaling Group ARN
// (set via TEST_ASG_ARN) because AutoScalingGroup/LaunchTemplate currently
// have no test infrastructure in this repo. Run locally with:
//   TEST_ASG_ARN=arn:aws:autoscaling:... bun vitest CapacityProvider
test.provider.skipIf(!process.env.TEST_ASG_ARN)(
  "create, update, delete ECS capacity provider",
  (stack) =>
    Effect.gen(function* () {
      const autoScalingGroupArn = process.env.TEST_ASG_ARN!;
      yield* stack.destroy();

      const provider = yield* stack.deploy(
        CapacityProvider("TestCapacityProvider", {
          autoScalingGroupArn,
          managedScaling: {
            status: "ENABLED",
            targetCapacity: 80,
            minimumScalingStepSize: 1,
            maximumScalingStepSize: 10,
          },
          managedTerminationProtection: "DISABLED",
          tags: { env: "test" },
        }),
      );

      expect(provider.capacityProviderArn).toMatch(
        /^arn:aws:ecs:[^:]+:\d+:capacity-provider\//,
      );
      expect(provider.status).toEqual("ACTIVE");
      expect(provider.managedScaling?.targetCapacity).toEqual(80);
      expect(provider.tags.env).toEqual("test");

      const described = yield* ecs.describeCapacityProviders({
        capacityProviders: [provider.name],
        include: ["TAGS"],
      });
      const found = described.capacityProviders?.[0];
      expect(found?.name).toEqual(provider.name);
      expect(
        found?.autoScalingGroupProvider?.managedScaling?.targetCapacity,
      ).toEqual(80);

      const updated = yield* stack.deploy(
        CapacityProvider("TestCapacityProvider", {
          autoScalingGroupArn,
          managedScaling: {
            status: "ENABLED",
            targetCapacity: 60,
            minimumScalingStepSize: 1,
            maximumScalingStepSize: 5,
          },
          managedTerminationProtection: "DISABLED",
          tags: { env: "test", owner: "alchemy" },
        }),
      );

      expect(updated.managedScaling?.targetCapacity).toEqual(60);
      expect(updated.tags.owner).toEqual("alchemy");

      yield* stack.destroy();

      const afterDestroy = yield* ecs.describeCapacityProviders({
        capacityProviders: [provider.name],
      });
      expect(afterDestroy.capacityProviders ?? []).toHaveLength(0);
    }).pipe(logLevel),
  { timeout: 600_000 },
);
