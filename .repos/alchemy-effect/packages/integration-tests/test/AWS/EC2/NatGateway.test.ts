import * as AWS from "@alchemy.run/aws";
import { EIP, InternetGateway, NatGateway, Subnet, Vpc } from "@alchemy.run/aws/EC2";
import { expect } from "@alchemy.run/test";
import * as EC2 from "@distilled.cloud/aws/ec2";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { assertEipGone, assertVpcGone } from "./Gone.ts";
import * as Test from "./VpcTest.ts";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

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
      const az1 = azResult.AvailabilityZones?.find((az) => az.State === "available")?.ZoneName!;

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

      expect(all.some((x) => x.natGatewayId === deployed.natGateway.natGatewayId)).toBe(true);

      yield* stack.destroy();

      // Zero-orphan proof: the EIP is released and the VPC (which cannot
      // delete while the NAT gateway/subnet/IGW exist) is gone.
      yield* assertEipGone(deployed.eip.allocationId);
      yield* assertVpcGone(deployed.vpc.vpcId);
    }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:ec2", "live"], timeout: 900_000 },
);

test.provider.skipIf(!!process.env.FAST)(
  "regional NAT gateways in automatic and manual mode",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const azResult = yield* EC2.describeAvailabilityZones({});
      const [az1, az2] = (azResult.AvailabilityZones ?? [])
        .filter((az) => az.State === "available" && az.ZoneType === "availability-zone")
        .map((az) => az.ZoneName!);

      const network = Effect.gen(function* () {
        const vpc = yield* Vpc("RegionalNatVpc", {
          cidrBlock: "10.0.0.0/16",
        });
        const igw = yield* InternetGateway("RegionalNatIgw", {
          vpcId: vpc.vpcId,
        });
        const eip1 = yield* EIP("RegionalNatEip1", {});
        const eip2 = yield* EIP("RegionalNatEip2", {});
        return { vpc, igw, eip1, eip2 };
      });

      // A regional NAT gateway needs the IGW attached before it is created.
      yield* stack.deploy(network);

      const regional = (layout: "one-zone" | "two-zones" | "moved") =>
        Effect.gen(function* () {
          const { vpc, igw, eip1, eip2 } = yield* network;
          const autoNat = yield* NatGateway("RegionalAutoNat", {
            availabilityMode: "regional",
            vpcId: vpc.vpcId,
          });
          const manualNat = yield* NatGateway("RegionalManualNat", {
            availabilityMode: "regional",
            vpcId: vpc.vpcId,
            availabilityZoneAddresses:
              layout === "one-zone"
                ? [{ availabilityZone: az1, allocationIds: [eip1.allocationId] }]
                : layout === "two-zones"
                  ? [
                      { availabilityZone: az1, allocationIds: [eip1.allocationId] },
                      { availabilityZone: az2, allocationIds: [eip2.allocationId] },
                    ]
                  : [
                      {
                        availabilityZone: az1,
                        allocationIds: [eip1.allocationId, eip2.allocationId],
                      },
                    ],
            maxDrainDurationSeconds: 1,
          });
          return { vpc, igw, eip1, eip2, autoNat, manualNat };
        });

      const describe = (natGatewayId: string) =>
        EC2.describeNatGateways({ NatGatewayIds: [natGatewayId] }).pipe(
          Effect.map((r) => r.NatGateways![0]!),
        );

      const created = yield* stack.deploy(regional("one-zone"));

      const auto = yield* describe(created.autoNat.natGatewayId);
      expect(auto.AvailabilityMode).toBe("regional");
      expect(auto.VpcId).toBe(created.vpc.vpcId);
      expect(auto.SubnetId).toBeUndefined();
      expect(auto.AutoProvisionZones).toBe("enabled");
      expect(created.autoNat.availabilityMode).toBe("regional");

      const manual = yield* describe(created.manualNat.natGatewayId);
      expect(manual.AvailabilityMode).toBe("regional");
      expect(manual.AutoProvisionZones).toBe("disabled");
      expect(
        manual.NatGatewayAddresses?.find((a) => a.AllocationId === created.eip1.allocationId)
          ?.AvailabilityZone,
      ).toBe(az1);

      // Adding a zone associates its Elastic IP in place.
      const updated = yield* stack.deploy(regional("two-zones"));
      expect(updated.manualNat.natGatewayId).toBe(created.manualNat.natGatewayId);
      const expanded = yield* describe(updated.manualNat.natGatewayId);
      const addresses = (expanded.NatGatewayAddresses ?? []).filter(
        (a) => a.Status !== "disassociating" && a.Status !== "failed",
      );
      expect(
        addresses.find((a) => a.AllocationId === created.eip1.allocationId)?.AvailabilityZone,
      ).toBe(az1);
      expect(
        addresses.find((a) => a.AllocationId === created.eip2.allocationId)?.AvailabilityZone,
      ).toBe(az2);
      // The deploy waits for the association to settle.
      expect(addresses.find((a) => a.AllocationId === created.eip2.allocationId)?.Status).toBe(
        "succeeded",
      );

      // Moving an Elastic IP to another zone disassociates it, waits for the
      // (short) drain, then associates it in the new zone — in place.
      const moved = yield* stack.deploy(regional("moved"));
      expect(moved.manualNat.natGatewayId).toBe(created.manualNat.natGatewayId);
      const contracted = yield* describe(moved.manualNat.natGatewayId);
      const live = (contracted.NatGatewayAddresses ?? []).filter(
        (a) => a.Status !== "disassociating" && a.Status !== "failed",
      );
      expect(
        live
          .filter((a) => a.AllocationId === created.eip2.allocationId)
          .map((a) => a.AvailabilityZone),
      ).toEqual([az1]);

      yield* stack.destroy();

      yield* assertEipGone(created.eip1.allocationId);
      yield* assertEipGone(created.eip2.allocationId);
      yield* assertVpcGone(created.vpc.vpcId);
    }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:ec2", "live"], timeout: 900_000 },
);
