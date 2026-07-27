import * as AWS from "@/AWS";
import { Subnet } from "@/AWS/EC2";
import { Listener, LoadBalancer, TargetGroup } from "@/AWS/ELBv2";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as EC2 from "@distilled.cloud/aws/ec2";
import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { getDefaultVpc } from "../DefaultVpc.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Canonical `list()` test for a load-balancer-scoped resource. A Listener
// belongs to a LoadBalancer (describeListeners requires a LoadBalancerArn), so
// `list()` enumerates every load balancer first and then every listener per
// LB. We deploy two stack-owned subnets in the standing default VPC (two AZs,
// required for an application LB) plus LoadBalancer + TargetGroup + Listener,
// resolve the provider with the typed `findProvider` helper, call `list()`, and
// assert the deployed listener appears in the exhaustive result. Reusing the
// VPC avoids contending for the account's small VPC quota in parallel sweeps.
test.provider(
  "list enumerates the deployed listener",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const azResult = yield* EC2.describeAvailabilityZones({});
      const availableAzs =
        azResult.AvailabilityZones?.filter((az) => az.State === "available") ??
        [];
      const az1 = availableAzs[0]?.ZoneName!;
      const az2 = availableAzs[1]?.ZoneName!;
      const defaultVpc = yield* getDefaultVpc;

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const subnet1 = yield* Subnet("ListSubnet1", {
            vpcId: defaultVpc.vpcId,
            cidrBlock: defaultVpc.subnetCidrBlock(232),
            availabilityZone: az1,
          });

          const subnet2 = yield* Subnet("ListSubnet2", {
            vpcId: defaultVpc.vpcId,
            cidrBlock: defaultVpc.subnetCidrBlock(233),
            availabilityZone: az2,
          });

          const loadBalancer = yield* LoadBalancer("ListLoadBalancer", {
            type: "application",
            scheme: "internal",
            subnets: [subnet1.subnetId, subnet2.subnetId],
          });

          const targetGroup = yield* TargetGroup("ListTargetGroup", {
            vpcId: defaultVpc.vpcId,
            port: 80,
            protocol: "HTTP",
            targetType: "ip",
          });

          const listener = yield* Listener("ListListener", {
            loadBalancerArn: loadBalancer.loadBalancerArn,
            targetGroupArn: targetGroup.targetGroupArn,
            port: 80,
            protocol: "HTTP",
            // Raw listener attribute — synced via modifyListenerAttributes
            // and verified out of band below.
            attributes: { "routing.http.response.server.enabled": "false" },
          });

          return { listener };
        }),
      );

      expect(deployed.listener.listenerArn).toBeDefined();

      // Out-of-band: the listener attribute reached the cloud.
      const attrs = yield* elbv2.describeListenerAttributes({
        ListenerArn: deployed.listener.listenerArn,
      });
      expect(
        attrs.Attributes?.find(
          (a) => a.Key === "routing.http.response.server.enabled",
        )?.Value,
      ).toBe("false");

      const provider = yield* Provider.findProvider(Listener);
      const all = yield* provider.list();

      expect(
        all.some((l) => l.listenerArn === deployed.listener.listenerArn),
      ).toBe(true);

      yield* stack.destroy();

      // Out-of-band: the listener is gone after destroy.
      const after = yield* elbv2
        .describeListeners({ ListenerArns: [deployed.listener.listenerArn] })
        .pipe(
          Effect.map((r) => r.Listeners?.length ?? 0),
          Effect.catchTag("ListenerNotFoundException", () => Effect.succeed(0)),
        );
      expect(after).toBe(0);
    }),
  { timeout: 240_000 },
);
