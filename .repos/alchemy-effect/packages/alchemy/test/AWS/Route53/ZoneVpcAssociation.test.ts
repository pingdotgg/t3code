import * as AWS from "@/AWS";
import { Vpc } from "@/AWS/EC2";
import {
  HostedZone,
  VpcAssociationAuthorization,
  ZoneVpcAssociation,
} from "@/AWS/Route53";
import * as Test from "@/Test/Alchemy";
import * as route53 from "@distilled.cloud/aws/route-53";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const VPC_REGION = "us-west-2";

const assertZoneGone = (id: string) =>
  route53.getHostedZone({ Id: id }).pipe(
    Effect.flatMap(() => Effect.fail(new Error("hosted zone still exists"))),
    Effect.catchTag("NoSuchHostedZone", () => Effect.void),
    Effect.retry({
      while: (e) => e instanceof Error,
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "associate a second VPC with a private zone and authorize it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          // Route 53 requires DNS support + hostnames on associated VPCs.
          const primary = yield* Vpc("PrimaryVpc", {
            cidrBlock: "10.61.0.0/24",
            enableDnsSupport: true,
            enableDnsHostnames: true,
          });
          const secondary = yield* Vpc("SecondaryVpc", {
            cidrBlock: "10.62.0.0/24",
            enableDnsSupport: true,
            enableDnsHostnames: true,
          });
          const zone = yield* HostedZone("PrivateZone", {
            name: "alchemy-test-assoc.internal",
            privateZone: true,
            vpc: { vpcId: primary.vpcId, vpcRegion: VPC_REGION },
            forceDestroy: true,
          });
          const association = yield* ZoneVpcAssociation("SecondaryAssoc", {
            hostedZoneId: zone.id,
            vpcId: secondary.vpcId,
            vpcRegion: VPC_REGION,
          });
          const authorization = yield* VpcAssociationAuthorization(
            "SecondaryAuth",
            {
              hostedZoneId: zone.id,
              vpcId: secondary.vpcId,
              vpcRegion: VPC_REGION,
            },
          );
          return { zone, association, authorization, secondary };
        }),
      );

      expect(deployed.association.hostedZoneId).toBe(deployed.zone.id);
      expect(deployed.association.vpcId).toBe(deployed.secondary.vpcId);
      expect(deployed.authorization.vpcId).toBe(deployed.secondary.vpcId);

      // Out-of-band: the zone reports both VPCs.
      const detail = yield* route53.getHostedZone({ Id: deployed.zone.id });
      const vpcIds = (detail.VPCs ?? []).map((vpc) => vpc.VPCId);
      expect(vpcIds).toContain(deployed.secondary.vpcId);
      expect(vpcIds).toHaveLength(2);

      // Out-of-band: the authorization is listed for the zone.
      const authorizations = yield* route53.listVPCAssociationAuthorizations({
        HostedZoneId: deployed.zone.id,
      });
      expect((authorizations.VPCs ?? []).map((vpc) => vpc.VPCId)).toContain(
        deployed.secondary.vpcId,
      );

      // Removing just the association (keeping zone + VPCs) disassociates.
      const remaining = yield* stack.deploy(
        Effect.gen(function* () {
          const primary = yield* Vpc("PrimaryVpc", {
            cidrBlock: "10.61.0.0/24",
            enableDnsSupport: true,
            enableDnsHostnames: true,
          });
          const secondary = yield* Vpc("SecondaryVpc", {
            cidrBlock: "10.62.0.0/24",
            enableDnsSupport: true,
            enableDnsHostnames: true,
          });
          const zone = yield* HostedZone("PrivateZone", {
            name: "alchemy-test-assoc.internal",
            privateZone: true,
            vpc: { vpcId: primary.vpcId, vpcRegion: VPC_REGION },
            forceDestroy: true,
          });
          return { zone, secondary };
        }),
      );

      const detailAfter = yield* route53.getHostedZone({
        Id: remaining.zone.id,
      });
      const vpcIdsAfter = (detailAfter.VPCs ?? []).map((vpc) => vpc.VPCId);
      expect(vpcIdsAfter).not.toContain(remaining.secondary.vpcId);
      expect(vpcIdsAfter).toHaveLength(1);

      const authorizationsAfter =
        yield* route53.listVPCAssociationAuthorizations({
          HostedZoneId: remaining.zone.id,
        });
      expect(authorizationsAfter.VPCs ?? []).toHaveLength(0);

      yield* stack.destroy();
      yield* assertZoneGone(deployed.zone.id);
    }),
  { timeout: 180_000 },
);
