import * as AWS from "@alchemy.run/aws";
import { TargetGroup } from "@alchemy.run/aws/ELBv2";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import * as Drift from "alchemy/Drift";
import * as Provider from "alchemy/Provider";
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

      expect(all.some((tg) => tg.targetGroupArn === deployed.targetGroup.targetGroupArn)).toBe(
        true,
      );

      yield* stack.destroy();

      // Out-of-band: the target group is gone after destroy.
      const after = yield* elbv2
        .describeTargetGroups({
          TargetGroupArns: [deployed.targetGroup.targetGroupArn],
        })
        .pipe(
          Effect.map((r) => r.TargetGroups?.length ?? 0),
          Effect.catchTag("TargetGroupNotFoundException", () => Effect.succeed(0)),
        );
      expect(after).toBe(0);
    }),
  {
    tags: ["provider:aws", "provider:aws:ec2", "provider:aws:elbv2", "live"],
    timeout: 240_000,
  },
);

const targetGroupAttributes = (targetGroupArn: string) =>
  elbv2
    .describeTargetGroupAttributes({ TargetGroupArn: targetGroupArn })
    .pipe(
      Effect.map((r) =>
        Object.fromEntries((r.Attributes ?? []).map((a) => [a.Key ?? "", a.Value ?? ""])),
      ),
    );

// #1969: attribute changes made outside alchemy are detected as drift and
// repaired back to the declared values. Undeclared attributes (AWS defaults)
// never surface.
test.provider(
  "detects and repairs out-of-band attribute drift",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const defaultVpc = yield* getDefaultVpc;
      const attributes = {
        "stickiness.enabled": "true",
        "stickiness.type": "lb_cookie",
        "deregistration_delay.timeout_seconds": "30",
      };
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* TargetGroup("DriftTargetGroup", {
            vpcId: defaultVpc.vpcId,
            port: 80,
            protocol: "HTTP",
            targetType: "ip",
            attributes,
            healthCheckPath: "/health",
            tags: { team: "declared" },
          });
        }),
      );
      const arn = deployed.targetGroupArn;
      expect(deployed.attributes).toEqual(attributes);
      expect(yield* targetGroupAttributes(arn)).toMatchObject(attributes);

      const target = { name: stack.name, stage: stack.stage };
      const clean = yield* Drift.detect(target).pipe(Effect.provide(stack.state));
      expect(clean.resources.DriftTargetGroup?.action).toBe("unchanged");

      // Drift a declared attribute and an undeclared one out of band.
      yield* elbv2.modifyTargetGroupAttributes({
        TargetGroupArn: arn,
        Attributes: [
          { Key: "stickiness.enabled", Value: "false" },
          { Key: "slow_start.duration_seconds", Value: "60" },
        ],
      });
      // #2688: the declared health check and the tags drift too.
      yield* elbv2.modifyTargetGroup({ TargetGroupArn: arn, HealthCheckPath: "/oob" });
      yield* elbv2.addTags({ ResourceArns: [arn], Tags: [{ Key: "team", Value: "out-of-band" }] });

      const drifted = yield* Drift.detect(target).pipe(Effect.provide(stack.state));
      expect(drifted.resources.DriftTargetGroup).toMatchObject({
        action: "drifted",
        attr: {
          attributes: { ...attributes, "stickiness.enabled": "false" },
          healthCheck: { HealthCheckPath: "/oob" },
          tags: { team: "out-of-band" },
        },
      });

      const repaired = yield* Drift.repair(target).pipe(Effect.provide(stack.state));
      expect(repaired.resources.DriftTargetGroup).toMatchObject({
        action: "repaired",
        attr: { attributes },
      });
      const live = yield* targetGroupAttributes(arn);
      expect(live).toMatchObject(attributes);
      // Undeclared attributes are not alchemy's to reset.
      expect(live["slow_start.duration_seconds"]).toBe("60");
      const [group] = (yield* elbv2.describeTargetGroups({ TargetGroupArns: [arn] })).TargetGroups!;
      expect(group?.HealthCheckPath).toBe("/health");

      const settled = yield* Drift.detect(target).pipe(Effect.provide(stack.state));
      expect(settled.resources.DriftTargetGroup?.action).toBe("unchanged");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:aws", "provider:aws:ec2", "provider:aws:elbv2", "live"],
    timeout: 240_000,
  },
);
