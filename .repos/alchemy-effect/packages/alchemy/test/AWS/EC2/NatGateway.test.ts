import * as AWS from "@/AWS";
import { EIP, InternetGateway, NatGateway, Subnet, Vpc } from "@/AWS/EC2";
import * as Provider from "@/Provider";
import * as Test from "./VpcTest.ts";
import * as EC2 from "@distilled.cloud/aws/ec2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { assertEipGone, assertVpcGone } from "./Gone.ts";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// NAT gateways take ~1–2 min to become `available` and ~1–2 min to delete, so a
// full create + list + destroy cycle exceeds the 240s factory test budget.
// They also require a free VPC quota slot and an Internet Gateway attached to
// the VPC (a public NAT gateway fails with `Gateway.NotAttached` otherwise).
// Gate behind AWS_TEST_NAT_GATEWAY=1 so an account with headroom runs it
// unchanged; the list() implementation itself is exercised by this body.
test.provider.skipIf(!process.env.AWS_TEST_NAT_GATEWAY)(
  "list enumerates the deployed NAT Gateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const azResult = yield* EC2.describeAvailabilityZones({});
      const az1 = azResult.AvailabilityZones?.find(
        (az) => az.State === "available",
      )?.ZoneName!;

      // Phase 1: stand up the VPC + IGW + subnet + EIP. The IGW must be
      // attached before the NAT gateway is created, so split the deploy.
      yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("ListNatVpc", {
            cidrBlock: "10.0.0.0/16",
          });

          yield* InternetGateway("ListNatIgw", {
            vpcId: vpc.vpcId,
          });

          yield* Subnet("ListNatSubnet", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.0.1.0/24",
            availabilityZone: az1,
            mapPublicIpOnLaunch: true,
          });

          yield* EIP("ListNatEip", {});
        }),
      );

      // Phase 2: add the NAT gateway now that the IGW is attached.
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("ListNatVpc", {
            cidrBlock: "10.0.0.0/16",
          });

          const igw = yield* InternetGateway("ListNatIgw", {
            vpcId: vpc.vpcId,
          });

          const subnet = yield* Subnet("ListNatSubnet", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.0.1.0/24",
            availabilityZone: az1,
            mapPublicIpOnLaunch: true,
          });

          const eip = yield* EIP("ListNatEip", {});

          const natGateway = yield* NatGateway("ListNatGateway", {
            subnetId: subnet.subnetId,
            allocationId: eip.allocationId,
          });

          return { vpc, eip, igw, natGateway };
        }),
      );

      const provider = yield* Provider.findProvider(NatGateway);
      const all = yield* provider.list();

      expect(
        all.some((x) => x.natGatewayId === deployed.natGateway.natGatewayId),
      ).toBe(true);

      yield* stack.destroy();

      // Zero-orphan proof: the EIP is released and the VPC (which cannot
      // delete while the NAT gateway/subnet/IGW exist) is gone.
      yield* assertEipGone(deployed.eip.allocationId);
      yield* assertVpcGone(deployed.vpc.vpcId);
    }).pipe(logLevel),
  { timeout: 900_000 },
);
