import * as AWS from "@/AWS";
import { CapacityProvider } from "@/AWS/ECS";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

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
        expect(p.capacityProviderArn).toMatch(
          /^arn:aws:ecs:[^:]+:\d+:capacity-provider\//,
        );
      }
    }).pipe(logLevel),
  { timeout: 120_000 },
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
      expect(
        all.some((p) => p.capacityProviderArn === deployed.capacityProviderArn),
      ).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 600_000 },
);
