import * as AWS from "@alchemy.run/aws";
import { AutoScalingGroup, LaunchTemplate } from "@alchemy.run/aws/AutoScaling";
import { amazonLinux2023 } from "@alchemy.run/aws/EC2";
import { CapacityProvider } from "@alchemy.run/aws/ECS";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as ecs from "@distilled.cloud/aws/ecs";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { getDefaultVpcNetwork } from "../DefaultVpc.ts";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// `list()` enumerates every capacity provider in the account/region via the
// `describeCapacityProviders` op (paginated with `nextToken`), filtering out the
// AWS-managed `FARGATE`/`FARGATE_SPOT` reserved providers. This ungated case
// proves the pagination + typing run live against the real API without needing
// an ASG-backed provider to exist.
test.provider(
  "list enumerates capacity providers in the account/region",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(CapacityProvider);
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);
      // Reserved AWS-managed providers must be filtered out.
      expect(all.some((p) => p.name === "FARGATE")).toBe(false);
      expect(all.some((p) => p.name === "FARGATE_SPOT")).toBe(false);
      // Every returned item carries the full Attributes shape.
      for (const p of all) {
        expect(typeof p.name).toBe("string");
        expect(p.capacityProviderArn).toMatch(/^arn:aws:ecs:[^:]+:\d+:capacity-provider\//);
      }
    }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:ecs", "live"], timeout: 120_000 },
);

// Full deploy + list assertion. Requires a pre-provisioned EC2 Auto Scaling
// Group ARN (set via TEST_ASG_ARN): a real capacity provider cannot be created
// without an ASG, and the distilled `auto-scaling` service is currently
// non-functional against the live API (aws-query Action derivation bug — see
// AutoScalingGroup.test.ts), so an ASG cannot be provisioned in-test. Run with:
//   TEST_ASG_ARN=arn:aws:autoscaling:... bun vitest CapacityProvider
test.provider.skipIf(!process.env.TEST_ASG_ARN)(
  "list includes a deployed capacity provider",
  (stack) =>
    Effect.gen(function* () {
      const autoScalingGroupArn = process.env.TEST_ASG_ARN!;
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        CapacityProvider("ListCapacityProvider", {
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

      const provider = yield* Provider.findProvider(CapacityProvider);
      const all = yield* provider.list();

      expect(all.some((p) => p.name === deployed.name)).toBe(true);
      expect(all.some((p) => p.capacityProviderArn === deployed.capacityProviderArn)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:ecs", "live"], timeout: 600_000 },
);

// A deleted capacity provider stays describable as INACTIVE for a while and
// can no longer be updated. Removing a provider and adding it back (same
// deterministic name) must create a fresh one rather than try to update the
// INACTIVE leftover. The ASG is sized to zero, so no instance launches.
test.provider(
  "recreates a capacity provider that was removed",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { subnetIds } = yield* getDefaultVpcNetwork;
      // Explicit, stage-scoped name: ECS rejects names prefixed with
      // `aws`/`ecs`/`fargate`, which a generated name for this suite would be.
      const providerName = `alchemy-recreated-${stack.stage.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`;

      const program = (withProvider: boolean) =>
        Effect.gen(function* () {
          const template = yield* LaunchTemplate("CapacityTemplate", {
            imageId: amazonLinux2023(),
            instanceType: "t3.micro",
          });
          const group = yield* AutoScalingGroup("CapacityGroup", {
            launchTemplate: template,
            subnetIds: [subnetIds[0] as `subnet-${string}`],
            minSize: 0,
            maxSize: 0,
            desiredCapacity: 0,
          });
          const provider = withProvider
            ? yield* CapacityProvider("RecreatedProvider", {
                name: providerName,
                autoScalingGroupArn: group.autoScalingGroupArn,
                managedTerminationProtection: "DISABLED",
              })
            : undefined;
          return { provider };
        });

      const first = yield* stack.deploy(program(true));
      const name = first.provider!.name;

      yield* stack.deploy(program(false));
      const removed = yield* ecs.describeCapacityProviders({ capacityProviders: [name] });
      expect(removed.capacityProviders?.every((p) => p.status !== "ACTIVE")).toBe(true);

      const second = yield* stack.deploy(program(true));
      expect(second.provider!.name).toBe(name);
      expect(second.provider!.status).toBe("ACTIVE");
      const live = yield* ecs.describeCapacityProviders({ capacityProviders: [name] });
      expect(live.capacityProviders?.some((p) => p.status === "ACTIVE")).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:aws", "provider:aws:autoscaling", "provider:aws:ecs", "live"],
    timeout: 300_000,
  },
);
