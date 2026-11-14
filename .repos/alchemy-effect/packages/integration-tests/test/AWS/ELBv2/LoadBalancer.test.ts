import * as AWS from "@alchemy.run/aws";
import { Subnet } from "@alchemy.run/aws/EC2";
import { Listener, LoadBalancer, TargetGroup } from "@alchemy.run/aws/ELBv2";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as EC2 from "@distilled.cloud/aws/ec2";
import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import * as Drift from "alchemy/Drift";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { getDefaultVpc } from "../DefaultVpc.ts";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// Reuse the account/region default VPC and carve stack-owned subnets (subnets
// don't count against the VPC limit). An ALB needs subnets in at least two AZs.
test.provider(
  "list enumerates the deployed load balancer",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const azResult = yield* EC2.describeAvailabilityZones({});
      const azs =
        azResult.AvailabilityZones?.filter((az) => az.State === "available").flatMap((az) =>
          az.ZoneName ? [az.ZoneName] : [],
        ) ?? [];
      const [az1, az2] = azs;
      expect(az1).toBeTruthy();
      expect(az2).toBeTruthy();

      const defaultVpc = yield* getDefaultVpc;

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const subnet1 = yield* Subnet("ListLbSubnet1", {
            vpcId: defaultVpc.vpcId,
            cidrBlock: defaultVpc.subnetCidrBlock(222),
            availabilityZone: az1,
          });

          const subnet2 = yield* Subnet("ListLbSubnet2", {
            vpcId: defaultVpc.vpcId,
            cidrBlock: defaultVpc.subnetCidrBlock(223),
            availabilityZone: az2,
          });

          const loadBalancer = yield* LoadBalancer("ListLb", {
            subnets: [subnet1.subnetId, subnet2.subnetId],
            scheme: "internal",
            type: "application",
          });

          return { loadBalancer };
        }),
      );

      const provider = yield* Provider.findProvider(LoadBalancer);
      const all = yield* provider.list();

      expect(all.some((x) => x.loadBalancerArn === deployed.loadBalancer.loadBalancerArn)).toBe(
        true,
      );

      yield* stack.destroy();

      // Out-of-band: the load balancer is gone after destroy.
      const after = yield* elbv2
        .describeLoadBalancers({
          LoadBalancerArns: [deployed.loadBalancer.loadBalancerArn],
        })
        .pipe(
          Effect.map((r) => r.LoadBalancers?.length ?? 0),
          Effect.catchTag("LoadBalancerNotFoundException", () => Effect.succeed(0)),
        );
      expect(after).toBe(0);
    }).pipe(logLevel),
  {
    tags: ["provider:aws", "provider:aws:ec2", "provider:aws:elbv2", "live"],
    timeout: 600_000,
  },
);

const toRecord = (attributes: readonly { Key?: string; Value?: string }[] | undefined) =>
  Object.fromEntries((attributes ?? []).map((a) => [a.Key ?? "", a.Value ?? ""]));

// #1969: load balancer and listener attribute changes made outside alchemy are
// detected as drift and repaired back to the declared values.
test.provider(
  "detects and repairs out-of-band attribute drift",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const azResult = yield* EC2.describeAvailabilityZones({});
      const [az1, az2] =
        azResult.AvailabilityZones?.filter((az) => az.State === "available").flatMap((az) =>
          az.ZoneName ? [az.ZoneName] : [],
        ) ?? [];
      const defaultVpc = yield* getDefaultVpc;

      const lbAttributes = { "idle_timeout.timeout_seconds": "3600" };
      const listenerAttributes = { "routing.http.response.server.enabled": "false" };
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const subnet1 = yield* Subnet("DriftLbSubnet1", {
            vpcId: defaultVpc.vpcId,
            cidrBlock: defaultVpc.subnetCidrBlock(224),
            availabilityZone: az1,
          });
          const subnet2 = yield* Subnet("DriftLbSubnet2", {
            vpcId: defaultVpc.vpcId,
            cidrBlock: defaultVpc.subnetCidrBlock(225),
            availabilityZone: az2,
          });
          const loadBalancer = yield* LoadBalancer("DriftLb", {
            subnets: [subnet1.subnetId, subnet2.subnetId],
            scheme: "internal",
            type: "application",
            attributes: lbAttributes,
          });
          const targetGroup = yield* TargetGroup("DriftLbTargetGroup", {
            vpcId: defaultVpc.vpcId,
            port: 80,
            protocol: "HTTP",
            targetType: "ip",
          });
          const listener = yield* Listener("DriftLbListener", {
            loadBalancerArn: loadBalancer.loadBalancerArn,
            targetGroupArn: targetGroup.targetGroupArn,
            port: 80,
            protocol: "HTTP",
            attributes: listenerAttributes,
          });
          return { loadBalancer, listener };
        }),
      );
      const lbArn = deployed.loadBalancer.loadBalancerArn;
      const listenerArn = deployed.listener.listenerArn;
      expect(deployed.loadBalancer.attributes).toEqual(lbAttributes);
      expect(deployed.listener.attributes).toEqual(listenerAttributes);

      const target = { name: stack.name, stage: stack.stage };
      const clean = yield* Drift.detect(target).pipe(Effect.provide(stack.state));
      // #1968: ELB returns subnets in its own order; that is not drift.
      expect(clean.resources.DriftLb?.action).toBe("unchanged");
      expect(clean.resources.DriftLb?.attr.attributes).toEqual(lbAttributes);
      expect(clean.resources.DriftLbListener?.action).toBe("unchanged");

      yield* elbv2.modifyLoadBalancerAttributes({
        LoadBalancerArn: lbArn,
        Attributes: [{ Key: "idle_timeout.timeout_seconds", Value: "60" }],
      });
      yield* elbv2.modifyListenerAttributes({
        ListenerArn: listenerArn,
        Attributes: [{ Key: "routing.http.response.server.enabled", Value: "true" }],
      });

      const drifted = yield* Drift.detect(target).pipe(Effect.provide(stack.state));
      expect(drifted.resources.DriftLb).toMatchObject({
        action: "drifted",
        attr: { attributes: { "idle_timeout.timeout_seconds": "60" } },
      });
      expect(drifted.resources.DriftLbListener).toMatchObject({
        action: "drifted",
        attr: { attributes: { "routing.http.response.server.enabled": "true" } },
      });

      const repaired = yield* Drift.repair(target).pipe(Effect.provide(stack.state));
      expect(repaired.resources.DriftLb).toMatchObject({
        action: "repaired",
        attr: { attributes: lbAttributes },
      });
      expect(repaired.resources.DriftLbListener?.action).toBe("repaired");
      expect(
        toRecord(
          (yield* elbv2.describeLoadBalancerAttributes({ LoadBalancerArn: lbArn })).Attributes,
        ),
      ).toMatchObject(lbAttributes);
      expect(
        toRecord(
          (yield* elbv2.describeListenerAttributes({ ListenerArn: listenerArn })).Attributes,
        ),
      ).toMatchObject(listenerAttributes);

      const settled = yield* Drift.detect(target).pipe(Effect.provide(stack.state));
      expect(settled.resources.DriftLb?.action).toBe("unchanged");
      expect(settled.resources.DriftLbListener?.action).toBe("unchanged");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:aws", "provider:aws:ec2", "provider:aws:elbv2", "live"],
    timeout: 600_000,
  },
);
