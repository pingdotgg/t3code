import * as AWS from "@/AWS";
import { TargetGroup } from "@/AWS/ELBv2";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { getDefaultVpc } from "../DefaultVpc.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Canonical `list()` test for an account/region-scoped resource: a target group
// only needs a VPC id, so reuse the default VPC in the account/region (avoids
// the per-region VPC limit), deploy a TargetGroup, resolve the provider from
// context with the typed `findProvider` helper, call `list()` (which
// exhaustively paginates describeTargetGroups in the account/region), and assert
// the deployed target group appears in the result.
test.provider(
  "list enumerates the deployed target group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const defaultVpc = yield* getDefaultVpc;
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const targetGroup = yield* TargetGroup("ListTargetGroup", {
            vpcId: defaultVpc.vpcId,
            port: 80,
            protocol: "HTTP",
            targetType: "ip",
            // Duration.Input props — verified on the wire below.
            healthCheckInterval: "45 seconds",
            healthCheckTimeout: "20 seconds",
          });

          return { targetGroup };
        }),
      );

      expect(deployed.targetGroup.targetGroupArn).toBeDefined();

      // Out-of-band: Duration.Input health-check props reach the wire as
      // whole seconds.
      const observed = yield* elbv2
        .describeTargetGroups({
          TargetGroupArns: [deployed.targetGroup.targetGroupArn],
        })
        .pipe(Effect.map((r) => r.TargetGroups?.[0]));
      expect(observed?.HealthCheckIntervalSeconds).toBe(45);
      expect(observed?.HealthCheckTimeoutSeconds).toBe(20);

      const provider = yield* Provider.findProvider(TargetGroup);
      const all = yield* provider.list();

      expect(
        all.some(
          (tg) => tg.targetGroupArn === deployed.targetGroup.targetGroupArn,
        ),
      ).toBe(true);

      yield* stack.destroy();

      // Out-of-band: the target group is gone after destroy.
      const after = yield* elbv2
        .describeTargetGroups({
          TargetGroupArns: [deployed.targetGroup.targetGroupArn],
        })
        .pipe(
          Effect.map((r) => r.TargetGroups?.length ?? 0),
          Effect.catchTag("TargetGroupNotFoundException", () =>
            Effect.succeed(0),
          ),
        );
      expect(after).toBe(0);
    }),
  { timeout: 240_000 },
);
