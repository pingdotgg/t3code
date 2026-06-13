import * as AWS from "@/AWS";
import {
  EgressOnlyInternetGateway,
  EIP,
  InternetGateway,
  NatGateway,
  NetworkAcl,
  NetworkAclAssociation,
  NetworkAclEntry,
  Route,
  RouteTable,
  RouteTableAssociation,
  SecurityGroup,
  Subnet,
  Vpc,
  VpcEndpoint,
} from "@/AWS/EC2";
import * as Test from "@/Test/Vitest";
import * as EC2 from "@distilled.cloud/aws/ec2";
import * as ec2 from "@distilled.cloud/aws/ec2";
import { expect } from "@effect/vitest";
import { Data, Schedule } from "effect";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const { test } = Test.make({ providers: AWS.providers() });

test.provider.skip(
  "VPC evolution: from simple to complex",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Get available AZs for multi-AZ stages
      const azResult = yield* EC2.describeAvailabilityZones({});
      const availableAzs =
        azResult.AvailabilityZones?.filter((az) => az.State === "available") ??
        [];
      const az1 = availableAzs[0]?.ZoneName!;
      const az2 = availableAzs[1]?.ZoneName!;

      // =========================================================================
      // STAGE 1: Bare Minimum VPC
      // User starts with just a VPC - the most basic setup
      // =========================================================================
      yield* Effect.log("=== Stage 1: Bare Minimum VPC ===");
      {
        const myVpc = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Vpc("MyVpc", {
              cidrBlock: "10.0.0.0/16",
            });
          }),
        );

        // Verify VPC was created
        expect(myVpc.vpcId).toMatch(/^vpc-/);
        expect(myVpc.cidrBlock).toEqual("10.0.0.0/16");
        expect(myVpc.state).toEqual("available");

        const vpcResult = yield* EC2.describeVpcs({
          VpcIds: [myVpc.vpcId],
        });
        expect(vpcResult.Vpcs?.[0]?.CidrBlock).toEqual("10.0.0.0/16");
      }

      // =========================================================================
      // STAGE 2: Add Internet Connectivity
      // User needs public internet access - add IGW, public subnet, route table
      // Tests: VPC update (DNS settings), IGW create, Subnet create, Route create
      // =========================================================================
      yield* Effect.log("=== Stage 2: Add Internet Connectivity ===");
      {
        const _stack = yield* stack.deploy(
          Effect.gen(function* () {
            const myVpc = yield* Vpc("MyVpc", {
              cidrBlock: "10.0.0.0/16",
              enableDnsSupport: true,
              enableDnsHostnames: true,
            });

            const internetGateway = yield* InternetGateway("InternetGateway", {
              vpcId: myVpc.vpcId,
            });

            const publicSubnet1 = yield* Subnet("PublicSubnet1", {
              vpcId: myVpc.vpcId,
              cidrBlock: "10.0.1.0/24",
              availabilityZone: az1,
              mapPublicIpOnLaunch: true,
            });

            const publicRouteTable = yield* RouteTable("PublicRouteTable", {
              vpcId: myVpc.vpcId,
            });

            const internetRoute = yield* Route("InternetRoute", {
              routeTableId: publicRouteTable.routeTableId,
              destinationCidrBlock: "0.0.0.0/0",
              gatewayId: internetGateway.internetGatewayId,
            });

            const publicSubnet1Association = yield* RouteTableAssociation(
              "PublicSubnet1Association",
              {
                routeTableId: publicRouteTable.routeTableId,
                subnetId: publicSubnet1.subnetId,
              },
            );

            return {
              myVpc,
              internetGateway,
              publicSubnet1,
              publicRouteTable,
              internetRoute,
              publicSubnet1Association,
            };
          }),
        );

        // Verify IGW
        expect(_stack.internetGateway.internetGatewayId).toMatch(/^igw-/);
        expect(_stack.internetGateway.vpcId).toEqual(_stack.myVpc.vpcId);

        // Verify public subnet
        expect(_stack.publicSubnet1.subnetId).toMatch(/^subnet-/);
        expect(_stack.publicSubnet1.mapPublicIpOnLaunch).toEqual(true);
        expect(_stack.publicSubnet1.availabilityZone).toEqual(az1);

        // Verify route to IGW
        expect(_stack.internetRoute.state).toEqual("active");
        expect(_stack.internetRoute.gatewayId).toEqual(
          _stack.internetGateway.internetGatewayId,
        );

        // Verify association
        expect(_stack.publicSubnet1Association.associationId).toMatch(
          /^rtbassoc-/,
        );
      }

      // =========================================================================
      // STAGE 3: Add Private Subnet
      // User needs private resources (databases, internal services)
      // Tests: Adding private subnet with separate route table (no internet)
      // =========================================================================
      yield* Effect.log("=== Stage 3: Add Private Subnet ===");
      {
        const _stack = yield* stack.deploy(
          Effect.gen(function* () {
            const myVpc = yield* Vpc("MyVpc", {
              cidrBlock: "10.0.0.0/16",
              enableDnsSupport: true,
              enableDnsHostnames: true,
            });

            const internetGateway = yield* InternetGateway("InternetGateway", {
              vpcId: myVpc.vpcId,
            });

            const publicSubnet1 = yield* Subnet("PublicSubnet1", {
              vpcId: myVpc.vpcId,
              cidrBlock: "10.0.1.0/24",
              availabilityZone: az1,
              mapPublicIpOnLaunch: true,
            });

            const privateSubnet1 = yield* Subnet("PrivateSubnet1", {
              vpcId: myVpc.vpcId,
              cidrBlock: "10.0.10.0/24",
              availabilityZone: az1,
            });

            const publicRouteTable = yield* RouteTable("PublicRouteTable", {
              vpcId: myVpc.vpcId,
            });

            const privateRouteTable = yield* RouteTable("PrivateRouteTable", {
              vpcId: myVpc.vpcId,
            });

            const internetRoute = yield* Route("InternetRoute", {
              routeTableId: publicRouteTable.routeTableId,
              destinationCidrBlock: "0.0.0.0/0",
              gatewayId: internetGateway.internetGatewayId,
            });

            const publicSubnet1Association = yield* RouteTableAssociation(
              "PublicSubnet1Association",
              {
                routeTableId: publicRouteTable.routeTableId,
                subnetId: publicSubnet1.subnetId,
              },
            );

            const privateSubnet1Association = yield* RouteTableAssociation(
              "PrivateSubnet1Association",
              {
                routeTableId: privateRouteTable.routeTableId,
                subnetId: privateSubnet1.subnetId,
              },
            );

            return {
              myVpc,
              internetGateway,
              publicSubnet1,
              privateSubnet1,
              publicRouteTable,
              privateRouteTable,
              internetRoute,
              publicSubnet1Association,
              privateSubnet1Association,
            };
          }),
        );

        // Verify private subnet
        expect(_stack.privateSubnet1.subnetId).toMatch(/^subnet-/);
        expect(_stack.privateSubnet1.mapPublicIpOnLaunch).toBeFalsy();

        // Verify private route table has NO internet route
        const privateRtResult = yield* EC2.describeRouteTables({
          RouteTableIds: [_stack.privateRouteTable.routeTableId],
        });
        const privateRoutes = privateRtResult.RouteTables?.[0]?.Routes ?? [];
        const privateInternetRoute = privateRoutes.find(
          (r) => r.DestinationCidrBlock === "0.0.0.0/0",
        );
        expect(privateInternetRoute).toBeUndefined();
      }

      // =========================================================================
      // STAGE 4: Multi-AZ Expansion
      // User needs high availability - add subnets in second AZ
      // Tests: Adding subnets in second AZ, sharing route tables
      // =========================================================================
      yield* Effect.log("=== Stage 4: Multi-AZ Expansion ===");
      {
        const _stack = yield* stack.deploy(
          Effect.gen(function* () {
            const myVpc = yield* Vpc("MyVpc", {
              cidrBlock: "10.0.0.0/16",
              enableDnsSupport: true,
              enableDnsHostnames: true,
            });

            const internetGateway = yield* InternetGateway("InternetGateway", {
              vpcId: myVpc.vpcId,
            });

            // AZ1 subnets
            const publicSubnet1 = yield* Subnet("PublicSubnet1", {
              vpcId: myVpc.vpcId,
              cidrBlock: "10.0.1.0/24",
              availabilityZone: az1,
              mapPublicIpOnLaunch: true,
            });

            const privateSubnet1 = yield* Subnet("PrivateSubnet1", {
              vpcId: myVpc.vpcId,
              cidrBlock: "10.0.10.0/24",
              availabilityZone: az1,
            });

            // AZ2 subnets
            const publicSubnet2 = yield* Subnet("PublicSubnet2", {
              vpcId: myVpc.vpcId,
              cidrBlock: "10.0.2.0/24",
              availabilityZone: az2,
              mapPublicIpOnLaunch: true,
            });

            const privateSubnet2 = yield* Subnet("PrivateSubnet2", {
              vpcId: myVpc.vpcId,
              cidrBlock: "10.0.11.0/24",
              availabilityZone: az2,
            });

            const publicRouteTable = yield* RouteTable("PublicRouteTable", {
              vpcId: myVpc.vpcId,
            });

            const privateRouteTable = yield* RouteTable("PrivateRouteTable", {
              vpcId: myVpc.vpcId,
            });

            const internetRoute = yield* Route("InternetRoute", {
              routeTableId: publicRouteTable.routeTableId,
              destinationCidrBlock: "0.0.0.0/0",
              gatewayId: internetGateway.internetGatewayId,
            });

            // AZ1 associations
            const publicSubnet1Association = yield* RouteTableAssociation(
              "PublicSubnet1Association",
              {
                routeTableId: publicRouteTable.routeTableId,
                subnetId: publicSubnet1.subnetId,
              },
            );

            const privateSubnet1Association = yield* RouteTableAssociation(
              "PrivateSubnet1Association",
              {
                routeTableId: privateRouteTable.routeTableId,
                subnetId: privateSubnet1.subnetId,
              },
            );

            // AZ2 associations (share route tables)
            const publicSubnet2Association = yield* RouteTableAssociation(
              "PublicSubnet2Association",
              {
                routeTableId: publicRouteTable.routeTableId,
                subnetId: publicSubnet2.subnetId,
              },
            );

            const privateSubnet2Association = yield* RouteTableAssociation(
              "PrivateSubnet2Association",
              {
                routeTableId: privateRouteTable.routeTableId,
                subnetId: privateSubnet2.subnetId,
              },
            );

            return {
              myVpc,
              internetGateway,
              publicSubnet1,
              privateSubnet1,
              publicSubnet2,
              privateSubnet2,
              publicRouteTable,
              privateRouteTable,
              internetRoute,
              publicSubnet1Association,
              privateSubnet1Association,
              publicSubnet2Association,
              privateSubnet2Association,
            };
          }),
        );

        // Verify subnets are in different AZs
        expect(_stack.publicSubnet1.availabilityZone).toEqual(az1);
        expect(_stack.publicSubnet2.availabilityZone).toEqual(az2);
        expect(_stack.privateSubnet1.availabilityZone).toEqual(az1);
        expect(_stack.privateSubnet2.availabilityZone).toEqual(az2);

        // Verify all 4 associations exist
        expect(_stack.publicSubnet1Association.associationId).toMatch(
          /^rtbassoc-/,
        );
        expect(_stack.publicSubnet2Association.associationId).toMatch(
          /^rtbassoc-/,
        );
        expect(_stack.privateSubnet1Association.associationId).toMatch(
          /^rtbassoc-/,
        );
        expect(_stack.privateSubnet2Association.associationId).toMatch(
          /^rtbassoc-/,
        );

        // Verify both public subnets share the same route table
        expect(_stack.publicSubnet1Association.routeTableId).toEqual(
          _stack.publicSubnet2Association.routeTableId,
        );
      }

      // =========================================================================
      // STAGE 5: Update Tags and Properties
      // User needs better organization - add tags for production
      // Tests: Tag updates on existing resources
      // =========================================================================
      yield* Effect.log("=== Stage 5: Update Tags and Properties ===");
      {
        const _stack = yield* stack.deploy(
          Effect.gen(function* () {
            const myVpc = yield* Vpc("MyVpc", {
              cidrBlock: "10.0.0.0/16",
              enableDnsSupport: true,
              enableDnsHostnames: true,
              tags: {
                Name: "production-vpc",
                Environment: "production",
              },
            });

            const internetGateway = yield* InternetGateway("InternetGateway", {
              vpcId: myVpc.vpcId,
              tags: {
                Name: "production-igw",
              },
            });

            const publicSubnet1 = yield* Subnet("PublicSubnet1", {
              vpcId: myVpc.vpcId,
              cidrBlock: "10.0.1.0/24",
              availabilityZone: az1,
              mapPublicIpOnLaunch: true,
              tags: { Name: "public-1a", Tier: "public" },
            });

            const privateSubnet1 = yield* Subnet("PrivateSubnet1", {
              vpcId: myVpc.vpcId,
              cidrBlock: "10.0.10.0/24",
              availabilityZone: az1,
              tags: { Name: "private-1a", Tier: "private" },
            });

            const publicSubnet2 = yield* Subnet("PublicSubnet2", {
              vpcId: myVpc.vpcId,
              cidrBlock: "10.0.2.0/24",
              availabilityZone: az2,
              mapPublicIpOnLaunch: true,
              tags: { Name: "public-1b", Tier: "public" },
            });

            const privateSubnet2 = yield* Subnet("PrivateSubnet2", {
              vpcId: myVpc.vpcId,
              cidrBlock: "10.0.11.0/24",
              availabilityZone: az2,
              tags: { Name: "private-1b", Tier: "private" },
            });

            const publicRouteTable = yield* RouteTable("PublicRouteTable", {
              vpcId: myVpc.vpcId,
              tags: { Name: "public-rt" },
            });

            const privateRouteTable = yield* RouteTable("PrivateRouteTable", {
              vpcId: myVpc.vpcId,
              tags: { Name: "private-rt" },
            });

            const internetRoute = yield* Route("InternetRoute", {
              routeTableId: publicRouteTable.routeTableId,
              destinationCidrBlock: "0.0.0.0/0",
              gatewayId: internetGateway.internetGatewayId,
            });

            const publicSubnet1Association = yield* RouteTableAssociation(
              "PublicSubnet1Association",
              {
                routeTableId: publicRouteTable.routeTableId,
                subnetId: publicSubnet1.subnetId,
              },
            );

            const privateSubnet1Association = yield* RouteTableAssociation(
              "PrivateSubnet1Association",
              {
                routeTableId: privateRouteTable.routeTableId,
                subnetId: privateSubnet1.subnetId,
              },
            );

            const publicSubnet2Association = yield* RouteTableAssociation(
              "PublicSubnet2Association",
              {
                routeTableId: publicRouteTable.routeTableId,
                subnetId: publicSubnet2.subnetId,
              },
            );

            const privateSubnet2Association = yield* RouteTableAssociation(
              "PrivateSubnet2Association",
              {
                routeTableId: privateRouteTable.routeTableId,
                subnetId: privateSubnet2.subnetId,
              },
            );

            return {
              myVpc,
              internetGateway,
              publicSubnet1,
              privateSubnet1,
              publicSubnet2,
              privateSubnet2,
              publicRouteTable,
              privateRouteTable,
              internetRoute,
              publicSubnet1Association,
              privateSubnet1Association,
              publicSubnet2Association,
              privateSubnet2Association,
            };
          }),
        );

        // Verify tags were applied by checking AWS (with retry for eventual consistency)
        yield* assertVpcTags(_stack.myVpc.vpcId, {
          Name: "production-vpc",
          Environment: "production",
        });
      }

      // =========================================================================
      // STAGE 6: Re-associate Subnet to Different Route Table
      // User wants to move PublicSubnet2 to a dedicated route table
      // Tests: Route table association update (replaceRouteTableAssociation)
      // =========================================================================
      yield* Effect.log("=== Stage 6: Re-associate Subnet ===");
      {
        const _stack = yield* stack.deploy(
          Effect.gen(function* () {
            const myVpc = yield* Vpc("MyVpc", {
              cidrBlock: "10.0.0.0/16",
              enableDnsSupport: true,
              enableDnsHostnames: true,
              tags: {
                Name: "production-vpc",
                Environment: "production",
              },
            });

            const internetGateway = yield* InternetGateway("InternetGateway", {
              vpcId: myVpc.vpcId,
              tags: { Name: "production-igw" },
            });

            const publicSubnet1 = yield* Subnet("PublicSubnet1", {
              vpcId: myVpc.vpcId,
              cidrBlock: "10.0.1.0/24",
              availabilityZone: az1,
              mapPublicIpOnLaunch: true,
              tags: { Name: "public-1a", Tier: "public" },
            });

            const privateSubnet1 = yield* Subnet("PrivateSubnet1", {
              vpcId: myVpc.vpcId,
              cidrBlock: "10.0.10.0/24",
              availabilityZone: az1,
              tags: { Name: "private-1a", Tier: "private" },
            });

            const publicSubnet2 = yield* Subnet("PublicSubnet2", {
              vpcId: myVpc.vpcId,
              cidrBlock: "10.0.2.0/24",
              availabilityZone: az2,
              mapPublicIpOnLaunch: true,
              tags: { Name: "public-1b", Tier: "public" },
            });

            const privateSubnet2 = yield* Subnet("PrivateSubnet2", {
              vpcId: myVpc.vpcId,
              cidrBlock: "10.0.11.0/24",
              availabilityZone: az2,
              tags: { Name: "private-1b", Tier: "private" },
            });

            const publicRouteTable = yield* RouteTable("PublicRouteTable", {
              vpcId: myVpc.vpcId,
              tags: { Name: "public-rt" },
            });

            const privateRouteTable = yield* RouteTable("PrivateRouteTable", {
              vpcId: myVpc.vpcId,
              tags: { Name: "private-rt" },
            });

            // NEW: Dedicated route table for AZ2 public subnet
            const publicRouteTable2 = yield* RouteTable("PublicRouteTable2", {
              vpcId: myVpc.vpcId,
              tags: { Name: "public-rt-az2" },
            });

            const internetRoute = yield* Route("InternetRoute", {
              routeTableId: publicRouteTable.routeTableId,
              destinationCidrBlock: "0.0.0.0/0",
              gatewayId: internetGateway.internetGatewayId,
            });

            // NEW: Internet route for AZ2 public route table
            const internetRoute2 = yield* Route("InternetRoute2", {
              routeTableId: publicRouteTable2.routeTableId,
              destinationCidrBlock: "0.0.0.0/0",
              gatewayId: internetGateway.internetGatewayId,
            });

            const publicSubnet1Association = yield* RouteTableAssociation(
              "PublicSubnet1Association",
              {
                routeTableId: publicRouteTable.routeTableId,
                subnetId: publicSubnet1.subnetId,
              },
            );

            const privateSubnet1Association = yield* RouteTableAssociation(
              "PrivateSubnet1Association",
              {
                routeTableId: privateRouteTable.routeTableId,
                subnetId: privateSubnet1.subnetId,
              },
            );

            // CHANGED: PublicSubnet2 now uses PublicRouteTable2
            const publicSubnet2Association = yield* RouteTableAssociation(
              "PublicSubnet2Association",
              {
                routeTableId: publicRouteTable2.routeTableId,
                subnetId: publicSubnet2.subnetId,
              },
            );

            const privateSubnet2Association = yield* RouteTableAssociation(
              "PrivateSubnet2Association",
              {
                routeTableId: privateRouteTable.routeTableId,
                subnetId: privateSubnet2.subnetId,
              },
            );

            return {
              myVpc,
              internetGateway,
              publicSubnet1,
              privateSubnet1,
              publicSubnet2,
              privateSubnet2,
              publicRouteTable,
              privateRouteTable,
              publicRouteTable2,
              internetRoute,
              internetRoute2,
              publicSubnet1Association,
              privateSubnet1Association,
              publicSubnet2Association,
              privateSubnet2Association,
            };
          }),
        );

        // Verify PublicSubnet2 is now associated with a different route table
        expect(_stack.publicSubnet2Association.routeTableId).toEqual(
          _stack.publicRouteTable2.routeTableId,
        );
        expect(_stack.publicSubnet2Association.routeTableId).not.toEqual(
          _stack.publicSubnet1Association.routeTableId,
        );

        // Verify the new route table has an internet route
        expect(_stack.internetRoute2.state).toEqual("active");
      }

      // =========================================================================
      // STAGE 7: Scale Down
      // User removes AZ2 resources (cost savings)
      // Tests: Resource deletion, dependency ordering during delete
      // =========================================================================
      yield* Effect.log("=== Stage 7: Scale Down ===");
      {
        const _stack = yield* stack.deploy(
          Effect.gen(function* () {
            const myVpc = yield* Vpc("MyVpc", {
              cidrBlock: "10.0.0.0/16",
              enableDnsSupport: true,
              enableDnsHostnames: true,
              tags: {
                Name: "production-vpc",
                Environment: "production",
              },
            });

            const internetGateway = yield* InternetGateway("InternetGateway", {
              vpcId: myVpc.vpcId,
              tags: { Name: "production-igw" },
            });

            // Only AZ1 subnets remain
            const publicSubnet1 = yield* Subnet("PublicSubnet1", {
              vpcId: myVpc.vpcId,
              cidrBlock: "10.0.1.0/24",
              availabilityZone: az1,
              mapPublicIpOnLaunch: true,
              tags: { Name: "public-1a", Tier: "public" },
            });

            const privateSubnet1 = yield* Subnet("PrivateSubnet1", {
              vpcId: myVpc.vpcId,
              cidrBlock: "10.0.10.0/24",
              availabilityZone: az1,
              tags: { Name: "private-1a", Tier: "private" },
            });

            const publicRouteTable = yield* RouteTable("PublicRouteTable", {
              vpcId: myVpc.vpcId,
              tags: { Name: "public-rt" },
            });

            const privateRouteTable = yield* RouteTable("PrivateRouteTable", {
              vpcId: myVpc.vpcId,
              tags: { Name: "private-rt" },
            });

            const internetRoute = yield* Route("InternetRoute", {
              routeTableId: publicRouteTable.routeTableId,
              destinationCidrBlock: "0.0.0.0/0",
              gatewayId: internetGateway.internetGatewayId,
            });

            const publicSubnet1Association = yield* RouteTableAssociation(
              "PublicSubnet1Association",
              {
                routeTableId: publicRouteTable.routeTableId,
                subnetId: publicSubnet1.subnetId,
              },
            );

            const privateSubnet1Association = yield* RouteTableAssociation(
              "PrivateSubnet1Association",
              {
                routeTableId: privateRouteTable.routeTableId,
                subnetId: privateSubnet1.subnetId,
              },
            );

            // Note: PublicSubnet2, PrivateSubnet2, PublicRouteTable2, InternetRoute2,
            // and their associations are NOT included - they will be deleted

            return {
              myVpc,
              internetGateway,
              publicSubnet1,
              privateSubnet1,
              publicRouteTable,
              privateRouteTable,
              internetRoute,
              publicSubnet1Association,
              privateSubnet1Association,
            };
          }),
        );

        // Verify only 2 subnets exist now
        const subnetsResult = yield* EC2.describeSubnets({
          Filters: [{ Name: "vpc-id", Values: [_stack.myVpc.vpcId] }],
        });
        expect(subnetsResult.Subnets).toHaveLength(2);

        // Verify remaining subnets are in AZ1
        for (const subnet of subnetsResult.Subnets ?? []) {
          expect(subnet.AvailabilityZone).toEqual(az1);
        }
      }

      // =========================================================================
      // STAGE 8: Add NAT Gateway for Private Subnet Internet Access
      // User needs private instances to access internet for updates
      // Tests: EIP create, NAT Gateway create with state waiting
      // =========================================================================
      yield* Effect.log("=== Stage 8: Add NAT Gateway ===");
      {
        const _stack = yield* stack.deploy(
          Effect.gen(function* () {
            const myVpc = yield* Vpc("MyVpc", {
              cidrBlock: "10.0.0.0/16",
              enableDnsSupport: true,
              enableDnsHostnames: true,
              tags: {
                Name: "production-vpc",
                Environment: "production",
              },
            });

            const internetGateway = yield* InternetGateway("InternetGateway", {
              vpcId: myVpc.vpcId,
              tags: { Name: "production-igw" },
            });

            const publicSubnet1 = yield* Subnet("PublicSubnet1", {
              vpcId: myVpc.vpcId,
              cidrBlock: "10.0.1.0/24",
              availabilityZone: az1,
              mapPublicIpOnLaunch: true,
              tags: { Name: "public-1a", Tier: "public" },
            });

            const privateSubnet1 = yield* Subnet("PrivateSubnet1", {
              vpcId: myVpc.vpcId,
              cidrBlock: "10.0.10.0/24",
              availabilityZone: az1,
              tags: { Name: "private-1a", Tier: "private" },
            });

            const publicRouteTable = yield* RouteTable("PublicRouteTable", {
              vpcId: myVpc.vpcId,
              tags: { Name: "public-rt" },
            });

            const privateRouteTable = yield* RouteTable("PrivateRouteTable", {
              vpcId: myVpc.vpcId,
              tags: { Name: "private-rt" },
            });

            const internetRoute = yield* Route("InternetRoute", {
              routeTableId: publicRouteTable.routeTableId,
              destinationCidrBlock: "0.0.0.0/0",
              gatewayId: internetGateway.internetGatewayId,
            });

            // NEW: Elastic IP for NAT Gateway
            const natEip = yield* EIP("NatEip", {
              tags: { Name: "nat-eip" },
            });

            // NEW: NAT Gateway in public subnet
            const natGateway = yield* NatGateway("NatGateway", {
              subnetId: publicSubnet1.subnetId,
              allocationId: natEip.allocationId,
              tags: { Name: "production-nat" },
            });

            // NEW: Route from private subnet to NAT Gateway
            const natRoute = yield* Route("NatRoute", {
              routeTableId: privateRouteTable.routeTableId,
              destinationCidrBlock: "0.0.0.0/0",
              natGatewayId: natGateway.natGatewayId,
            });

            const publicSubnet1Association = yield* RouteTableAssociation(
              "PublicSubnet1Association",
              {
                routeTableId: publicRouteTable.routeTableId,
                subnetId: publicSubnet1.subnetId,
              },
            );

            const privateSubnet1Association = yield* RouteTableAssociation(
              "PrivateSubnet1Association",
              {
                routeTableId: privateRouteTable.routeTableId,
                subnetId: privateSubnet1.subnetId,
              },
            );

            return {
              myVpc,
              internetGateway,
              publicSubnet1,
              privateSubnet1,
              publicRouteTable,
              privateRouteTable,
              internetRoute,
              natEip,
              natGateway,
              natRoute,
              publicSubnet1Association,
              privateSubnet1Association,
            };
          }),
        );

        // Verify EIP
        expect(_stack.natEip.allocationId).toMatch(/^eipalloc-/);
        expect(_stack.natEip.publicIp).toBeDefined();

        // Verify NAT Gateway
        expect(_stack.natGateway.natGatewayId).toMatch(/^nat-/);
        expect(_stack.natGateway.state).toEqual("available");
        expect(_stack.natGateway.publicIp).toEqual(_stack.natEip.publicIp);

        // Verify NAT route is active
        expect(_stack.natRoute.state).toEqual("active");
        expect(_stack.natRoute.natGatewayId).toEqual(
          _stack.natGateway.natGatewayId,
        );

        // Verify private route table now has internet route via NAT
        const privateRtResult = yield* EC2.describeRouteTables({
          RouteTableIds: [_stack.privateRouteTable.routeTableId],
        });
        const privateRoutes = privateRtResult.RouteTables?.[0]?.Routes ?? [];
        const privateInternetRoute = privateRoutes.find(
          (r) => r.DestinationCidrBlock === "0.0.0.0/0",
        );
        expect(privateInternetRoute?.NatGatewayId).toEqual(
          _stack.natGateway.natGatewayId,
        );
      }

      // =========================================================================
      // STAGE 9: Add Security Groups
      // User needs to control instance access
      // Tests: Security Group with inline ingress/egress rules
      // =========================================================================
      yield* Effect.log("=== Stage 9: Add Security Groups ===");
      {
        const _stack = yield* stack.deploy(
          Effect.gen(function* () {
            const myVpc = yield* Vpc("MyVpc", {
              cidrBlock: "10.0.0.0/16",
              enableDnsSupport: true,
              enableDnsHostnames: true,
              tags: {
                Name: "production-vpc",
                Environment: "production",
              },
            });

            const internetGateway = yield* InternetGateway("InternetGateway", {
              vpcId: myVpc.vpcId,
              tags: { Name: "production-igw" },
            });

            const publicSubnet1 = yield* Subnet("PublicSubnet1", {
              vpcId: myVpc.vpcId,
              cidrBlock: "10.0.1.0/24",
              availabilityZone: az1,
              mapPublicIpOnLaunch: true,
              tags: { Name: "public-1a", Tier: "public" },
            });

            const privateSubnet1 = yield* Subnet("PrivateSubnet1", {
              vpcId: myVpc.vpcId,
              cidrBlock: "10.0.10.0/24",
              availabilityZone: az1,
              tags: { Name: "private-1a", Tier: "private" },
            });

            const publicRouteTable = yield* RouteTable("PublicRouteTable", {
              vpcId: myVpc.vpcId,
              tags: { Name: "public-rt" },
            });

            const privateRouteTable = yield* RouteTable("PrivateRouteTable", {
              vpcId: myVpc.vpcId,
              tags: { Name: "private-rt" },
            });

            const internetRoute = yield* Route("InternetRoute", {
              routeTableId: publicRouteTable.routeTableId,
              destinationCidrBlock: "0.0.0.0/0",
              gatewayId: internetGateway.internetGatewayId,
            });

            const natEip = yield* EIP("NatEip", {
              tags: { Name: "nat-eip" },
            });

            const natGateway = yield* NatGateway("NatGateway", {
              subnetId: publicSubnet1.subnetId,
              allocationId: natEip.allocationId,
              tags: { Name: "production-nat" },
            });

            const natRoute = yield* Route("NatRoute", {
              routeTableId: privateRouteTable.routeTableId,
              destinationCidrBlock: "0.0.0.0/0",
              natGatewayId: natGateway.natGatewayId,
            });

            // NEW: Web security group allowing HTTP/HTTPS
            const webSecurityGroup = yield* SecurityGroup("WebSecurityGroup", {
              vpcId: myVpc.vpcId,
              description: "Web tier security group",
              ingress: [
                {
                  ipProtocol: "tcp",
                  fromPort: 80,
                  toPort: 80,
                  cidrIpv4: "0.0.0.0/0",
                  description: "Allow HTTP",
                },
                {
                  ipProtocol: "tcp",
                  fromPort: 443,
                  toPort: 443,
                  cidrIpv4: "0.0.0.0/0",
                  description: "Allow HTTPS",
                },
              ],
              egress: [
                {
                  ipProtocol: "-1",
                  cidrIpv4: "0.0.0.0/0",
                  description: "Allow all outbound",
                },
              ],
              tags: { Name: "web-sg" },
            });

            // NEW: Database security group allowing access from web tier
            const dbSecurityGroup = yield* SecurityGroup("DbSecurityGroup", {
              vpcId: myVpc.vpcId,
              description: "Database tier security group",
              ingress: [
                {
                  ipProtocol: "tcp",
                  fromPort: 5432,
                  toPort: 5432,
                  referencedGroupId: webSecurityGroup.groupId,
                  description: "Allow PostgreSQL from web tier",
                },
              ],
              egress: [
                {
                  ipProtocol: "-1",
                  cidrIpv4: "0.0.0.0/0",
                  description: "Allow all outbound",
                },
              ],
              tags: { Name: "db-sg" },
            });

            const publicSubnet1Association = yield* RouteTableAssociation(
              "PublicSubnet1Association",
              {
                routeTableId: publicRouteTable.routeTableId,
                subnetId: publicSubnet1.subnetId,
              },
            );

            const privateSubnet1Association = yield* RouteTableAssociation(
              "PrivateSubnet1Association",
              {
                routeTableId: privateRouteTable.routeTableId,
                subnetId: privateSubnet1.subnetId,
              },
            );

            return {
              myVpc,
              internetGateway,
              publicSubnet1,
              privateSubnet1,
              publicRouteTable,
              privateRouteTable,
              internetRoute,
              natEip,
              natGateway,
              natRoute,
              webSecurityGroup,
              dbSecurityGroup,
              publicSubnet1Association,
              privateSubnet1Association,
            };
          }),
        );

        // Verify Web Security Group
        expect(_stack.webSecurityGroup.groupId).toMatch(/^sg-/);
        expect(_stack.webSecurityGroup.vpcId).toEqual(_stack.myVpc.vpcId);
        expect(_stack.webSecurityGroup.ingressRules).toHaveLength(2);
        expect(_stack.webSecurityGroup.egressRules).toHaveLength(1);

        // Verify DB Security Group references Web Security Group
        expect(_stack.dbSecurityGroup.groupId).toMatch(/^sg-/);
        expect(_stack.dbSecurityGroup.ingressRules).toHaveLength(1);
        expect(
          _stack.dbSecurityGroup.ingressRules?.[0]?.referencedGroupId,
        ).toEqual(_stack.webSecurityGroup.groupId);
      }

      // =========================================================================
      // STAGE 10: Scale Down - Remove NAT Gateway and Security Groups
      // User scales down to basic VPC for cost savings
      // Tests: NAT Gateway delete with state waiting, Security Group delete
      // =========================================================================
      yield* Effect.log("=== Stage 10: Scale Down to Basic VPC ===");
      {
        const _stack = yield* stack.deploy(
          Effect.gen(function* () {
            const myVpc = yield* Vpc("MyVpc", {
              cidrBlock: "10.0.0.0/16",
              enableDnsSupport: true,
              enableDnsHostnames: true,
              tags: {
                Name: "production-vpc",
                Environment: "production",
              },
            });

            const internetGateway = yield* InternetGateway("InternetGateway", {
              vpcId: myVpc.vpcId,
              tags: { Name: "production-igw" },
            });

            const publicSubnet1 = yield* Subnet("PublicSubnet1", {
              vpcId: myVpc.vpcId,
              cidrBlock: "10.0.1.0/24",
              availabilityZone: az1,
              mapPublicIpOnLaunch: true,
              tags: { Name: "public-1a", Tier: "public" },
            });

            const privateSubnet1 = yield* Subnet("PrivateSubnet1", {
              vpcId: myVpc.vpcId,
              cidrBlock: "10.0.10.0/24",
              availabilityZone: az1,
              tags: { Name: "private-1a", Tier: "private" },
            });

            const publicRouteTable = yield* RouteTable("PublicRouteTable", {
              vpcId: myVpc.vpcId,
              tags: { Name: "public-rt" },
            });

            const privateRouteTable = yield* RouteTable("PrivateRouteTable", {
              vpcId: myVpc.vpcId,
              tags: { Name: "private-rt" },
            });

            const internetRoute = yield* Route("InternetRoute", {
              routeTableId: publicRouteTable.routeTableId,
              destinationCidrBlock: "0.0.0.0/0",
              gatewayId: internetGateway.internetGatewayId,
            });

            const publicSubnet1Association = yield* RouteTableAssociation(
              "PublicSubnet1Association",
              {
                routeTableId: publicRouteTable.routeTableId,
                subnetId: publicSubnet1.subnetId,
              },
            );

            const privateSubnet1Association = yield* RouteTableAssociation(
              "PrivateSubnet1Association",
              {
                routeTableId: privateRouteTable.routeTableId,
                subnetId: privateSubnet1.subnetId,
              },
            );

            // Note: NAT Gateway, EIP, NatRoute, and Security Groups are NOT included
            // They will be deleted

            return {
              myVpc,
              internetGateway,
              publicSubnet1,
              privateSubnet1,
              publicRouteTable,
              privateRouteTable,
              internetRoute,
              publicSubnet1Association,
              privateSubnet1Association,
            };
          }),
        );

        // Verify NAT Gateway is deleted
        const natGwResult = yield* ec2
          .describeNatGateways({
            Filter: [{ Name: "vpc-id", Values: [_stack.myVpc.vpcId] }],
          })
          .pipe(
            Effect.map((r) =>
              r.NatGateways?.filter((gw) => gw.State !== "deleted"),
            ),
          );
        expect(natGwResult).toHaveLength(0);

        // Verify Security Groups are deleted (only default should remain)
        const sgResult = yield* EC2.describeSecurityGroups({
          Filters: [{ Name: "vpc-id", Values: [_stack.myVpc.vpcId] }],
        });
        expect(sgResult.SecurityGroups).toHaveLength(1); // Only default SG
        expect(sgResult.SecurityGroups?.[0]?.GroupName).toEqual("default");
      }

      // =========================================================================
      // STAGE 11: Final Cleanup
      // Destroy everything and verify
      // =========================================================================
      yield* Effect.log("=== Stage 11: Final Cleanup ===");
      const vpcResult = yield* EC2.describeVpcs({
        Filters: [{ Name: "tag:Name", Values: ["production-vpc"] }],
      });
      const capturedVpcId = vpcResult.Vpcs?.[0]?.VpcId;

      yield* stack.destroy();

      // Verify VPC is deleted
      if (capturedVpcId) {
        yield* EC2.describeVpcs({ VpcIds: [capturedVpcId] }).pipe(
          Effect.flatMap(() => Effect.fail(new Error("VPC still exists"))),
          Effect.catchTag("InvalidVpcID.NotFound", () => Effect.void),
        );
      }

      yield* Effect.log("=== All stages completed successfully! ===");
    }).pipe(logLevel),
  { timeout: 1_000_000 },
);

test.provider.skip(
  "Comprehensive VPC with all components",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Get available AZs
      const azResult = yield* EC2.describeAvailabilityZones({});
      const availableAzs =
        azResult.AvailabilityZones?.filter((az) => az.State === "available") ??
        [];
      const az1 = availableAzs[0]?.ZoneName!;
      const az2 = availableAzs[1]?.ZoneName!;

      // =========================================================================
      // Define all resources for a production-ready VPC
      // =========================================================================
      const _stack = yield* stack.deploy(
        Effect.gen(function* () {
          // VPC with DNS enabled and IPv6 for egress-only IGW
          const myVpc = yield* Vpc("MyVpc", {
            cidrBlock: "10.0.0.0/16",
            enableDnsSupport: true,
            enableDnsHostnames: true,
            amazonProvidedIpv6CidrBlock: true,
            tags: {
              Name: "comprehensive-vpc",
              Environment: "test",
            },
          });

          // Internet Gateway for public internet access
          const internetGateway = yield* InternetGateway("InternetGateway", {
            vpcId: myVpc.vpcId,
            tags: { Name: "comprehensive-igw" },
          });

          // Egress-Only Internet Gateway for IPv6 outbound traffic from private subnets
          const egressOnlyIgw = yield* EgressOnlyInternetGateway(
            "EgressOnlyIgw",
            {
              vpcId: myVpc.vpcId,
              tags: { Name: "comprehensive-eigw" },
            },
          );

          // Public Subnets in two AZs
          const publicSubnet1 = yield* Subnet("PublicSubnet1", {
            vpcId: myVpc.vpcId,
            cidrBlock: "10.0.1.0/24",
            availabilityZone: az1,
            mapPublicIpOnLaunch: true,
            tags: { Name: "public-1a", Tier: "public" },
          });

          const publicSubnet2 = yield* Subnet("PublicSubnet2", {
            vpcId: myVpc.vpcId,
            cidrBlock: "10.0.2.0/24",
            availabilityZone: az2,
            mapPublicIpOnLaunch: true,
            tags: { Name: "public-1b", Tier: "public" },
          });

          // Private Subnets in two AZs
          const privateSubnet1 = yield* Subnet("PrivateSubnet1", {
            vpcId: myVpc.vpcId,
            cidrBlock: "10.0.10.0/24",
            availabilityZone: az1,
            tags: { Name: "private-1a", Tier: "private" },
          });

          const privateSubnet2 = yield* Subnet("PrivateSubnet2", {
            vpcId: myVpc.vpcId,
            cidrBlock: "10.0.11.0/24",
            availabilityZone: az2,
            tags: { Name: "private-1b", Tier: "private" },
          });

          // Route Tables
          const publicRouteTable = yield* RouteTable("PublicRouteTable", {
            vpcId: myVpc.vpcId,
            tags: { Name: "public-rt" },
          });

          const privateRouteTable1 = yield* RouteTable("PrivateRouteTable1", {
            vpcId: myVpc.vpcId,
            tags: { Name: "private-rt-1" },
          });

          const privateRouteTable2 = yield* RouteTable("PrivateRouteTable2", {
            vpcId: myVpc.vpcId,
            tags: { Name: "private-rt-2" },
          });

          // Internet route for public subnets
          const internetRoute = yield* Route("InternetRoute", {
            routeTableId: publicRouteTable.routeTableId,
            destinationCidrBlock: "0.0.0.0/0",
            gatewayId: internetGateway.internetGatewayId,
          });

          // NAT Gateway with EIP for AZ1
          const natEip1 = yield* EIP("NatEip1", {
            tags: { Name: "nat-eip-1" },
          });

          const natGateway1 = yield* NatGateway("NatGateway1", {
            subnetId: publicSubnet1.subnetId,
            allocationId: natEip1.allocationId,
            tags: { Name: "nat-gateway-1" },
          });

          // NAT Gateway with EIP for AZ2
          const natEip2 = yield* EIP("NatEip2", {
            tags: { Name: "nat-eip-2" },
          });

          const natGateway2 = yield* NatGateway("NatGateway2", {
            subnetId: publicSubnet2.subnetId,
            allocationId: natEip2.allocationId,
            tags: { Name: "nat-gateway-2" },
          });

          // NAT routes for private subnets (each AZ routes to its own NAT)
          const natRoute1 = yield* Route("NatRoute1", {
            routeTableId: privateRouteTable1.routeTableId,
            destinationCidrBlock: "0.0.0.0/0",
            natGatewayId: natGateway1.natGatewayId,
          });

          const natRoute2 = yield* Route("NatRoute2", {
            routeTableId: privateRouteTable2.routeTableId,
            destinationCidrBlock: "0.0.0.0/0",
            natGatewayId: natGateway2.natGatewayId,
          });

          // Route Table Associations
          const publicSubnet1Association = yield* RouteTableAssociation(
            "PublicSubnet1Association",
            {
              routeTableId: publicRouteTable.routeTableId,
              subnetId: publicSubnet1.subnetId,
            },
          );

          const publicSubnet2Association = yield* RouteTableAssociation(
            "PublicSubnet2Association",
            {
              routeTableId: publicRouteTable.routeTableId,
              subnetId: publicSubnet2.subnetId,
            },
          );

          const privateSubnet1Association = yield* RouteTableAssociation(
            "PrivateSubnet1Association",
            {
              routeTableId: privateRouteTable1.routeTableId,
              subnetId: privateSubnet1.subnetId,
            },
          );

          const privateSubnet2Association = yield* RouteTableAssociation(
            "PrivateSubnet2Association",
            {
              routeTableId: privateRouteTable2.routeTableId,
              subnetId: privateSubnet2.subnetId,
            },
          );

          // Security Groups
          const webSecurityGroup = yield* SecurityGroup("WebSecurityGroup", {
            vpcId: myVpc.vpcId,
            description: "Web tier security group",
            ingress: [
              {
                ipProtocol: "tcp",
                fromPort: 80,
                toPort: 80,
                cidrIpv4: "0.0.0.0/0",
                description: "Allow HTTP",
              },
              {
                ipProtocol: "tcp",
                fromPort: 443,
                toPort: 443,
                cidrIpv4: "0.0.0.0/0",
                description: "Allow HTTPS",
              },
            ],
            egress: [
              {
                ipProtocol: "-1",
                cidrIpv4: "0.0.0.0/0",
                description: "Allow all outbound",
              },
            ],
            tags: { Name: "web-sg" },
          });

          const appSecurityGroup = yield* SecurityGroup("AppSecurityGroup", {
            vpcId: myVpc.vpcId,
            description: "Application tier security group",
            ingress: [
              {
                ipProtocol: "tcp",
                fromPort: 8080,
                toPort: 8080,
                referencedGroupId: webSecurityGroup.groupId,
                description: "Allow from web tier",
              },
            ],
            egress: [
              {
                ipProtocol: "-1",
                cidrIpv4: "0.0.0.0/0",
                description: "Allow all outbound",
              },
            ],
            tags: { Name: "app-sg" },
          });

          const dbSecurityGroup = yield* SecurityGroup("DbSecurityGroup", {
            vpcId: myVpc.vpcId,
            description: "Database tier security group",
            ingress: [
              {
                ipProtocol: "tcp",
                fromPort: 5432,
                toPort: 5432,
                referencedGroupId: appSecurityGroup.groupId,
                description: "Allow PostgreSQL from app tier",
              },
            ],
            egress: [
              {
                ipProtocol: "-1",
                cidrIpv4: "0.0.0.0/0",
                description: "Allow all outbound",
              },
            ],
            tags: { Name: "db-sg" },
          });

          // Network ACL for private subnets with custom rules
          const privateNetworkAcl = yield* NetworkAcl("PrivateNetworkAcl", {
            vpcId: myVpc.vpcId,
            tags: { Name: "private-nacl" },
          });

          // Network ACL Entries (rules)
          // Allow inbound traffic from VPC CIDR
          const privateNaclIngressVpc = yield* NetworkAclEntry(
            "PrivateNaclIngressVpc",
            {
              networkAclId: privateNetworkAcl.networkAclId,
              ruleNumber: 100,
              protocol: "-1", // All protocols
              ruleAction: "allow",
              egress: false,
              cidrBlock: "10.0.0.0/16",
            },
          );

          // Allow inbound ephemeral ports (for NAT return traffic)
          const privateNaclIngressEphemeral = yield* NetworkAclEntry(
            "PrivateNaclIngressEphemeral",
            {
              networkAclId: privateNetworkAcl.networkAclId,
              ruleNumber: 200,
              protocol: "6", // TCP
              ruleAction: "allow",
              egress: false,
              cidrBlock: "0.0.0.0/0",
              portRange: { from: 1024, to: 65535 },
            },
          );

          // Allow all outbound traffic
          const privateNaclEgressAll = yield* NetworkAclEntry(
            "PrivateNaclEgressAll",
            {
              networkAclId: privateNetworkAcl.networkAclId,
              ruleNumber: 100,
              protocol: "-1", // All protocols
              ruleAction: "allow",
              egress: true,
              cidrBlock: "0.0.0.0/0",
            },
          );

          // Network ACL Associations - associate private subnets with the custom NACL
          const privateSubnet1NaclAssoc = yield* NetworkAclAssociation(
            "PrivateSubnet1NaclAssoc",
            {
              networkAclId: privateNetworkAcl.networkAclId,
              subnetId: privateSubnet1.subnetId,
            },
          );

          const privateSubnet2NaclAssoc = yield* NetworkAclAssociation(
            "PrivateSubnet2NaclAssoc",
            {
              networkAclId: privateNetworkAcl.networkAclId,
              subnetId: privateSubnet2.subnetId,
            },
          );

          // VPC Gateway Endpoint for S3 (reduces NAT costs and improves latency)
          const s3Endpoint = yield* VpcEndpoint("S3Endpoint", {
            vpcId: myVpc.vpcId,
            serviceName: `com.amazonaws.${
              (yield* EC2.describeAvailabilityZones({})).AvailabilityZones?.[0]
                ?.RegionName
            }.s3`,
            vpcEndpointType: "Gateway",
            routeTableIds: [
              privateRouteTable1.routeTableId,
              privateRouteTable2.routeTableId,
            ],
            tags: { Name: "s3-endpoint" },
          });

          return {
            myVpc,
            internetGateway,
            egressOnlyIgw,
            publicSubnet1,
            publicSubnet2,
            privateSubnet1,
            privateSubnet2,
            publicRouteTable,
            privateRouteTable1,
            privateRouteTable2,
            internetRoute,
            natEip1,
            natEip2,
            natGateway1,
            natGateway2,
            natRoute1,
            natRoute2,
            publicSubnet1Association,
            publicSubnet2Association,
            privateSubnet1Association,
            privateSubnet2Association,
            webSecurityGroup,
            appSecurityGroup,
            dbSecurityGroup,
            privateNetworkAcl,
            privateNaclIngressVpc,
            privateNaclIngressEphemeral,
            privateNaclEgressAll,
            privateSubnet1NaclAssoc,
            privateSubnet2NaclAssoc,
            s3Endpoint,
          };
        }),
      );

      // =========================================================================
      // Verify VPC
      // =========================================================================
      expect(_stack.myVpc.vpcId).toMatch(/^vpc-/);
      expect(_stack.myVpc.cidrBlock).toEqual("10.0.0.0/16");
      expect(_stack.myVpc.state).toEqual("available");

      const vpcResult = yield* EC2.describeVpcs({
        VpcIds: [_stack.myVpc.vpcId],
      });
      expect(vpcResult.Vpcs?.[0]?.CidrBlock).toEqual("10.0.0.0/16");
      // EnableDnsSupport and EnableDnsHostnames are not present in the describeVpcs output.
      // Instead, use describeVpcAttribute for these:
      const dnsSupport = yield* EC2.describeVpcAttribute({
        VpcId: _stack.myVpc.vpcId,
        Attribute: "enableDnsSupport",
      });
      expect(dnsSupport.EnableDnsSupport?.Value).toBeTruthy();

      const dnsHostnames = yield* EC2.describeVpcAttribute({
        VpcId: _stack.myVpc.vpcId,
        Attribute: "enableDnsHostnames",
      });
      expect(dnsHostnames.EnableDnsHostnames?.Value).toBeTruthy();

      // Verify VPC has IPv6 CIDR block
      expect(_stack.myVpc.ipv6CidrBlockAssociationSet).toBeDefined();
      expect(_stack.myVpc.ipv6CidrBlockAssociationSet?.length).toBeGreaterThan(
        0,
      );

      // =========================================================================
      // Verify Internet Gateway
      // =========================================================================
      expect(_stack.internetGateway.internetGatewayId).toMatch(/^igw-/);
      expect(_stack.internetGateway.vpcId).toEqual(_stack.myVpc.vpcId);

      // =========================================================================
      // Verify Egress-Only Internet Gateway
      // =========================================================================
      expect(_stack.egressOnlyIgw.egressOnlyInternetGatewayId).toMatch(
        /^eigw-/,
      );
      expect(_stack.egressOnlyIgw.attachments).toBeDefined();
      expect(_stack.egressOnlyIgw.attachments?.[0]?.vpcId).toEqual(
        _stack.myVpc.vpcId,
      );

      // =========================================================================
      // Verify Subnets
      // =========================================================================
      expect(_stack.publicSubnet1.subnetId).toMatch(/^subnet-/);
      expect(_stack.publicSubnet1.availabilityZone).toEqual(az1);
      expect(_stack.publicSubnet1.mapPublicIpOnLaunch).toEqual(true);

      expect(_stack.publicSubnet2.subnetId).toMatch(/^subnet-/);
      expect(_stack.publicSubnet2.availabilityZone).toEqual(az2);
      expect(_stack.publicSubnet2.mapPublicIpOnLaunch).toEqual(true);

      expect(_stack.privateSubnet1.subnetId).toMatch(/^subnet-/);
      expect(_stack.privateSubnet1.availabilityZone).toEqual(az1);
      expect(_stack.privateSubnet1.mapPublicIpOnLaunch).toBeFalsy();

      expect(_stack.privateSubnet2.subnetId).toMatch(/^subnet-/);
      expect(_stack.privateSubnet2.availabilityZone).toEqual(az2);
      expect(_stack.privateSubnet2.mapPublicIpOnLaunch).toBeFalsy();

      // Verify 4 subnets total
      const subnetsResult = yield* EC2.describeSubnets({
        Filters: [{ Name: "vpc-id", Values: [_stack.myVpc.vpcId] }],
      });
      expect(subnetsResult.Subnets).toHaveLength(4);

      // =========================================================================
      // Verify NAT Gateways and EIPs
      // =========================================================================
      expect(_stack.natEip1.allocationId).toMatch(/^eipalloc-/);
      expect(_stack.natEip1.publicIp).toBeDefined();

      expect(_stack.natEip2.allocationId).toMatch(/^eipalloc-/);
      expect(_stack.natEip2.publicIp).toBeDefined();

      expect(_stack.natGateway1.natGatewayId).toMatch(/^nat-/);
      expect(_stack.natGateway1.state).toEqual("available");
      expect(_stack.natGateway1.publicIp).toEqual(_stack.natEip1.publicIp);
      expect(_stack.natGateway1.subnetId).toEqual(
        _stack.publicSubnet1.subnetId,
      );

      expect(_stack.natGateway2.natGatewayId).toMatch(/^nat-/);
      expect(_stack.natGateway2.state).toEqual("available");
      expect(_stack.natGateway2.publicIp).toEqual(_stack.natEip2.publicIp);
      expect(_stack.natGateway2.subnetId).toEqual(
        _stack.publicSubnet2.subnetId,
      );

      // =========================================================================
      // Verify Routes
      // =========================================================================
      // Internet route to IGW
      expect(_stack.internetRoute.state).toEqual("active");
      expect(_stack.internetRoute.gatewayId).toEqual(
        _stack.internetGateway.internetGatewayId,
      );

      // NAT routes
      expect(_stack.natRoute1.state).toEqual("active");
      expect(_stack.natRoute1.natGatewayId).toEqual(
        _stack.natGateway1.natGatewayId,
      );

      expect(_stack.natRoute2.state).toEqual("active");
      expect(_stack.natRoute2.natGatewayId).toEqual(
        _stack.natGateway2.natGatewayId,
      );

      // Verify public route table has internet route
      const publicRtResult = yield* EC2.describeRouteTables({
        RouteTableIds: [_stack.publicRouteTable.routeTableId],
      });
      const publicRoutes = publicRtResult.RouteTables?.[0]?.Routes ?? [];
      const publicInternetRoute = publicRoutes.find(
        (r) => r.DestinationCidrBlock === "0.0.0.0/0",
      );
      expect(publicInternetRoute?.GatewayId).toEqual(
        _stack.internetGateway.internetGatewayId,
      );

      // Verify private route tables have NAT routes
      const private1RtResult = yield* EC2.describeRouteTables({
        RouteTableIds: [_stack.privateRouteTable1.routeTableId],
      });
      const private1Routes = private1RtResult.RouteTables?.[0]?.Routes ?? [];
      const private1NatRoute = private1Routes.find(
        (r) => r.DestinationCidrBlock === "0.0.0.0/0",
      );
      expect(private1NatRoute?.NatGatewayId).toEqual(
        _stack.natGateway1.natGatewayId,
      );

      const private2RtResult = yield* EC2.describeRouteTables({
        RouteTableIds: [_stack.privateRouteTable2.routeTableId],
      });
      const private2Routes = private2RtResult.RouteTables?.[0]?.Routes ?? [];
      const private2NatRoute = private2Routes.find(
        (r) => r.DestinationCidrBlock === "0.0.0.0/0",
      );
      expect(private2NatRoute?.NatGatewayId).toEqual(
        _stack.natGateway2.natGatewayId,
      );

      // =========================================================================
      // Verify Route Table Associations
      // =========================================================================
      expect(_stack.publicSubnet1Association.associationId).toMatch(
        /^rtbassoc-/,
      );
      expect(_stack.publicSubnet2Association.associationId).toMatch(
        /^rtbassoc-/,
      );
      expect(_stack.privateSubnet1Association.associationId).toMatch(
        /^rtbassoc-/,
      );
      expect(_stack.privateSubnet2Association.associationId).toMatch(
        /^rtbassoc-/,
      );

      // Both public subnets share the same route table
      expect(_stack.publicSubnet1Association.routeTableId).toEqual(
        _stack.publicSubnet2Association.routeTableId,
      );

      // Private subnets have their own route tables (for HA NAT)
      expect(_stack.privateSubnet1Association.routeTableId).not.toEqual(
        _stack.privateSubnet2Association.routeTableId,
      );

      // =========================================================================
      // Verify Security Groups
      // =========================================================================
      expect(_stack.webSecurityGroup.groupId).toMatch(/^sg-/);
      expect(_stack.webSecurityGroup.vpcId).toEqual(_stack.myVpc.vpcId);
      expect(_stack.webSecurityGroup.ingressRules).toHaveLength(2);
      // TODO(sam): why is it 2 when we only have 1? is it a default or egress only ingress?
      expect(_stack.webSecurityGroup.egressRules).toHaveLength(2);

      expect(_stack.appSecurityGroup.groupId).toMatch(/^sg-/);
      expect(_stack.appSecurityGroup.vpcId).toEqual(_stack.myVpc.vpcId);
      expect(_stack.appSecurityGroup.ingressRules).toHaveLength(1);
      expect(
        _stack.appSecurityGroup.ingressRules?.[0]?.referencedGroupId,
      ).toEqual(_stack.webSecurityGroup.groupId);

      expect(_stack.dbSecurityGroup.groupId).toMatch(/^sg-/);
      expect(_stack.dbSecurityGroup.vpcId).toEqual(_stack.myVpc.vpcId);
      expect(_stack.dbSecurityGroup.ingressRules).toHaveLength(1);
      expect(
        _stack.dbSecurityGroup.ingressRules?.[0]?.referencedGroupId,
      ).toEqual(_stack.appSecurityGroup.groupId);

      // Verify security groups in AWS
      const sgResult = yield* EC2.describeSecurityGroups({
        Filters: [{ Name: "vpc-id", Values: [_stack.myVpc.vpcId] }],
      });
      // 4 security groups: default + web + app + db
      expect(sgResult.SecurityGroups).toHaveLength(4);

      // =========================================================================
      // Verify Network ACL
      // =========================================================================
      expect(_stack.privateNetworkAcl.networkAclId).toMatch(/^acl-/);
      expect(_stack.privateNetworkAcl.vpcId).toEqual(_stack.myVpc.vpcId);
      expect(_stack.privateNetworkAcl.isDefault).toEqual(false);

      // Verify Network ACL in AWS
      const naclResult = yield* EC2.describeNetworkAcls({
        NetworkAclIds: [_stack.privateNetworkAcl.networkAclId],
      });
      expect(naclResult.NetworkAcls).toHaveLength(1);
      expect(naclResult.NetworkAcls?.[0]?.VpcId).toEqual(_stack.myVpc.vpcId);

      // =========================================================================
      // Verify Network ACL Entries
      // =========================================================================
      expect(_stack.privateNaclIngressVpc.networkAclId).toEqual(
        _stack.privateNetworkAcl.networkAclId,
      );
      expect(_stack.privateNaclIngressVpc.ruleNumber).toEqual(100);
      expect(_stack.privateNaclIngressVpc.egress).toEqual(false);
      expect(_stack.privateNaclIngressVpc.ruleAction).toEqual("allow");

      expect(_stack.privateNaclIngressEphemeral.ruleNumber).toEqual(200);
      expect(_stack.privateNaclIngressEphemeral.portRange).toEqual({
        from: 1024,
        to: 65535,
      });

      expect(_stack.privateNaclEgressAll.egress).toEqual(true);
      expect(_stack.privateNaclEgressAll.ruleNumber).toEqual(100);

      // =========================================================================
      // Verify Network ACL Associations
      // =========================================================================
      expect(_stack.privateSubnet1NaclAssoc.associationId).toMatch(
        /^aclassoc-/,
      );
      expect(_stack.privateSubnet1NaclAssoc.networkAclId).toEqual(
        _stack.privateNetworkAcl.networkAclId,
      );
      expect(_stack.privateSubnet1NaclAssoc.subnetId).toEqual(
        _stack.privateSubnet1.subnetId,
      );

      expect(_stack.privateSubnet2NaclAssoc.associationId).toMatch(
        /^aclassoc-/,
      );
      expect(_stack.privateSubnet2NaclAssoc.subnetId).toEqual(
        _stack.privateSubnet2.subnetId,
      );

      // =========================================================================
      // Verify VPC Endpoint for S3
      // =========================================================================
      expect(_stack.s3Endpoint.vpcEndpointId).toMatch(/^vpce-/);
      expect(_stack.s3Endpoint.vpcEndpointType).toEqual("Gateway");
      expect(_stack.s3Endpoint.vpcId).toEqual(_stack.myVpc.vpcId);
      expect(_stack.s3Endpoint.state).toEqual("available");
      expect(_stack.s3Endpoint.routeTableIds).toContain(
        _stack.privateRouteTable1.routeTableId,
      );
      expect(_stack.s3Endpoint.routeTableIds).toContain(
        _stack.privateRouteTable2.routeTableId,
      );

      // Verify VPC Endpoint in AWS
      const vpceResult = yield* EC2.describeVpcEndpoints({
        VpcEndpointIds: [_stack.s3Endpoint.vpcEndpointId],
      });
      expect(vpceResult.VpcEndpoints).toHaveLength(1);
      expect(vpceResult.VpcEndpoints?.[0]?.VpcEndpointType).toEqual("Gateway");

      // =========================================================================
      // Verify Tags
      // =========================================================================
      yield* assertVpcTags(_stack.myVpc.vpcId, {
        Name: "comprehensive-vpc",
        Environment: "test",
      });

      // =========================================================================
      // Idempotency check - apply again and verify no changes
      // =========================================================================
      yield* Effect.log("=== Idempotency Check: Re-applying stack ===");
      const stack2 = yield* stack.deploy(
        Effect.gen(function* () {
          // VPC with DNS enabled and IPv6 for egress-only IGW
          const myVpc = yield* Vpc("MyVpc", {
            cidrBlock: "10.0.0.0/16",
            enableDnsSupport: true,
            enableDnsHostnames: true,
            amazonProvidedIpv6CidrBlock: true,
            tags: {
              Name: "comprehensive-vpc",
              Environment: "test",
            },
          });

          // Internet Gateway for public internet access
          const internetGateway = yield* InternetGateway("InternetGateway", {
            vpcId: myVpc.vpcId,
            tags: { Name: "comprehensive-igw" },
          });

          // Egress-Only Internet Gateway for IPv6 outbound traffic from private subnets
          const egressOnlyIgw = yield* EgressOnlyInternetGateway(
            "EgressOnlyIgw",
            {
              vpcId: myVpc.vpcId,
              tags: { Name: "comprehensive-eigw" },
            },
          );

          // Public Subnets in two AZs
          const publicSubnet1 = yield* Subnet("PublicSubnet1", {
            vpcId: myVpc.vpcId,
            cidrBlock: "10.0.1.0/24",
            availabilityZone: az1,
            mapPublicIpOnLaunch: true,
            tags: { Name: "public-1a", Tier: "public" },
          });

          const publicSubnet2 = yield* Subnet("PublicSubnet2", {
            vpcId: myVpc.vpcId,
            cidrBlock: "10.0.2.0/24",
            availabilityZone: az2,
            mapPublicIpOnLaunch: true,
            tags: { Name: "public-1b", Tier: "public" },
          });

          // Private Subnets in two AZs
          const privateSubnet1 = yield* Subnet("PrivateSubnet1", {
            vpcId: myVpc.vpcId,
            cidrBlock: "10.0.10.0/24",
            availabilityZone: az1,
            tags: { Name: "private-1a", Tier: "private" },
          });

          const privateSubnet2 = yield* Subnet("PrivateSubnet2", {
            vpcId: myVpc.vpcId,
            cidrBlock: "10.0.11.0/24",
            availabilityZone: az2,
            tags: { Name: "private-1b", Tier: "private" },
          });

          // Route Tables
          const publicRouteTable = yield* RouteTable("PublicRouteTable", {
            vpcId: myVpc.vpcId,
            tags: { Name: "public-rt" },
          });

          const privateRouteTable1 = yield* RouteTable("PrivateRouteTable1", {
            vpcId: myVpc.vpcId,
            tags: { Name: "private-rt-1" },
          });

          const privateRouteTable2 = yield* RouteTable("PrivateRouteTable2", {
            vpcId: myVpc.vpcId,
            tags: { Name: "private-rt-2" },
          });

          // Internet route for public subnets
          const internetRoute = yield* Route("InternetRoute", {
            routeTableId: publicRouteTable.routeTableId,
            destinationCidrBlock: "0.0.0.0/0",
            gatewayId: internetGateway.internetGatewayId,
          });

          // NAT Gateway with EIP for AZ1
          const natEip1 = yield* EIP("NatEip1", {
            tags: { Name: "nat-eip-1" },
          });

          const natGateway1 = yield* NatGateway("NatGateway1", {
            subnetId: publicSubnet1.subnetId,
            allocationId: natEip1.allocationId,
            tags: { Name: "nat-gateway-1" },
          });

          // NAT Gateway with EIP for AZ2
          const natEip2 = yield* EIP("NatEip2", {
            tags: { Name: "nat-eip-2" },
          });

          const natGateway2 = yield* NatGateway("NatGateway2", {
            subnetId: publicSubnet2.subnetId,
            allocationId: natEip2.allocationId,
            tags: { Name: "nat-gateway-2" },
          });

          // NAT routes for private subnets (each AZ routes to its own NAT)
          const natRoute1 = yield* Route("NatRoute1", {
            routeTableId: privateRouteTable1.routeTableId,
            destinationCidrBlock: "0.0.0.0/0",
            natGatewayId: natGateway1.natGatewayId,
          });

          const natRoute2 = yield* Route("NatRoute2", {
            routeTableId: privateRouteTable2.routeTableId,
            destinationCidrBlock: "0.0.0.0/0",
            natGatewayId: natGateway2.natGatewayId,
          });

          // Route Table Associations
          const publicSubnet1Association = yield* RouteTableAssociation(
            "PublicSubnet1Association",
            {
              routeTableId: publicRouteTable.routeTableId,
              subnetId: publicSubnet1.subnetId,
            },
          );

          const publicSubnet2Association = yield* RouteTableAssociation(
            "PublicSubnet2Association",
            {
              routeTableId: publicRouteTable.routeTableId,
              subnetId: publicSubnet2.subnetId,
            },
          );

          const privateSubnet1Association = yield* RouteTableAssociation(
            "PrivateSubnet1Association",
            {
              routeTableId: privateRouteTable1.routeTableId,
              subnetId: privateSubnet1.subnetId,
            },
          );

          const privateSubnet2Association = yield* RouteTableAssociation(
            "PrivateSubnet2Association",
            {
              routeTableId: privateRouteTable2.routeTableId,
              subnetId: privateSubnet2.subnetId,
            },
          );

          // Security Groups
          const webSecurityGroup = yield* SecurityGroup("WebSecurityGroup", {
            vpcId: myVpc.vpcId,
            description: "Web tier security group",
            ingress: [
              {
                ipProtocol: "tcp",
                fromPort: 80,
                toPort: 80,
                cidrIpv4: "0.0.0.0/0",
                description: "Allow HTTP",
              },
              {
                ipProtocol: "tcp",
                fromPort: 443,
                toPort: 443,
                cidrIpv4: "0.0.0.0/0",
                description: "Allow HTTPS",
              },
            ],
            egress: [
              {
                ipProtocol: "-1",
                cidrIpv4: "0.0.0.0/0",
                description: "Allow all outbound",
              },
            ],
            tags: { Name: "web-sg" },
          });

          const appSecurityGroup = yield* SecurityGroup("AppSecurityGroup", {
            vpcId: myVpc.vpcId,
            description: "Application tier security group",
            ingress: [
              {
                ipProtocol: "tcp",
                fromPort: 8080,
                toPort: 8080,
                referencedGroupId: webSecurityGroup.groupId,
                description: "Allow from web tier",
              },
            ],
            egress: [
              {
                ipProtocol: "-1",
                cidrIpv4: "0.0.0.0/0",
                description: "Allow all outbound",
              },
            ],
            tags: { Name: "app-sg" },
          });

          const dbSecurityGroup = yield* SecurityGroup("DbSecurityGroup", {
            vpcId: myVpc.vpcId,
            description: "Database tier security group",
            ingress: [
              {
                ipProtocol: "tcp",
                fromPort: 5432,
                toPort: 5432,
                referencedGroupId: appSecurityGroup.groupId,
                description: "Allow PostgreSQL from app tier",
              },
            ],
            egress: [
              {
                ipProtocol: "-1",
                cidrIpv4: "0.0.0.0/0",
                description: "Allow all outbound",
              },
            ],
            tags: { Name: "db-sg" },
          });

          // Network ACL for private subnets with custom rules
          const privateNetworkAcl = yield* NetworkAcl("PrivateNetworkAcl", {
            vpcId: myVpc.vpcId,
            tags: { Name: "private-nacl" },
          });

          // Network ACL Entries (rules)
          // Allow inbound traffic from VPC CIDR
          const privateNaclIngressVpc = yield* NetworkAclEntry(
            "PrivateNaclIngressVpc",
            {
              networkAclId: privateNetworkAcl.networkAclId,
              ruleNumber: 100,
              protocol: "-1", // All protocols
              ruleAction: "allow",
              egress: false,
              cidrBlock: "10.0.0.0/16",
            },
          );

          // Allow inbound ephemeral ports (for NAT return traffic)
          const privateNaclIngressEphemeral = yield* NetworkAclEntry(
            "PrivateNaclIngressEphemeral",
            {
              networkAclId: privateNetworkAcl.networkAclId,
              ruleNumber: 200,
              protocol: "6", // TCP
              ruleAction: "allow",
              egress: false,
              cidrBlock: "0.0.0.0/0",
              portRange: { from: 1024, to: 65535 },
            },
          );

          // Allow all outbound traffic
          const privateNaclEgressAll = yield* NetworkAclEntry(
            "PrivateNaclEgressAll",
            {
              networkAclId: privateNetworkAcl.networkAclId,
              ruleNumber: 100,
              protocol: "-1", // All protocols
              ruleAction: "allow",
              egress: true,
              cidrBlock: "0.0.0.0/0",
            },
          );

          // Network ACL Associations - associate private subnets with the custom NACL
          const privateSubnet1NaclAssoc = yield* NetworkAclAssociation(
            "PrivateSubnet1NaclAssoc",
            {
              networkAclId: privateNetworkAcl.networkAclId,
              subnetId: privateSubnet1.subnetId,
            },
          );

          const privateSubnet2NaclAssoc = yield* NetworkAclAssociation(
            "PrivateSubnet2NaclAssoc",
            {
              networkAclId: privateNetworkAcl.networkAclId,
              subnetId: privateSubnet2.subnetId,
            },
          );

          // VPC Gateway Endpoint for S3 (reduces NAT costs and improves latency)
          const s3Endpoint = yield* VpcEndpoint("S3Endpoint", {
            vpcId: myVpc.vpcId,
            serviceName: `com.amazonaws.${
              (yield* EC2.describeAvailabilityZones({})).AvailabilityZones?.[0]
                ?.RegionName
            }.s3`,
            vpcEndpointType: "Gateway",
            routeTableIds: [
              privateRouteTable1.routeTableId,
              privateRouteTable2.routeTableId,
            ],
            tags: { Name: "s3-endpoint" },
          });

          return {
            myVpc,
            internetGateway,
            egressOnlyIgw,
            publicSubnet1,
            publicSubnet2,
            privateSubnet1,
            privateSubnet2,
            publicRouteTable,
            privateRouteTable1,
            privateRouteTable2,
            internetRoute,
            natEip1,
            natEip2,
            natGateway1,
            natGateway2,
            natRoute1,
            natRoute2,
            publicSubnet1Association,
            publicSubnet2Association,
            privateSubnet1Association,
            privateSubnet2Association,
            webSecurityGroup,
            appSecurityGroup,
            dbSecurityGroup,
            privateNetworkAcl,
            privateNaclIngressVpc,
            privateNaclIngressEphemeral,
            privateNaclEgressAll,
            privateSubnet1NaclAssoc,
            privateSubnet2NaclAssoc,
            s3Endpoint,
          };
        }),
      );

      // All IDs should remain the same
      expect(stack2.myVpc.vpcId).toEqual(_stack.myVpc.vpcId);
      expect(stack2.internetGateway.internetGatewayId).toEqual(
        _stack.internetGateway.internetGatewayId,
      );
      expect(stack2.egressOnlyIgw.egressOnlyInternetGatewayId).toEqual(
        _stack.egressOnlyIgw.egressOnlyInternetGatewayId,
      );
      expect(stack2.natGateway1.natGatewayId).toEqual(
        _stack.natGateway1.natGatewayId,
      );
      expect(stack2.natGateway2.natGatewayId).toEqual(
        _stack.natGateway2.natGatewayId,
      );
      expect(stack2.privateNetworkAcl.networkAclId).toEqual(
        _stack.privateNetworkAcl.networkAclId,
      );
      expect(stack2.s3Endpoint.vpcEndpointId).toEqual(
        _stack.s3Endpoint.vpcEndpointId,
      );

      // =========================================================================
      // Cleanup
      // =========================================================================
      yield* Effect.log("=== Cleanup: Destroying all resources ===");
      const capturedVpcId = _stack.myVpc.vpcId;

      yield* stack.destroy();

      // Verify VPC is deleted
      yield* EC2.describeVpcs({ VpcIds: [capturedVpcId] }).pipe(
        Effect.flatMap(() => Effect.fail(new Error("VPC still exists"))),
        Effect.catchTag("InvalidVpcID.NotFound", () => Effect.void),
      );

      yield* Effect.log(
        "=== Comprehensive VPC test completed successfully! ===",
      );
    }).pipe(logLevel),
  { timeout: 1_000_000 },
);

// ============================================================================
// Eventually Consistent Check Utilities
// ============================================================================

class TagsNotPropagated extends Data.TaggedError("TagsNotPropagated")<{
  readonly expected: Record<string, string>;
  readonly actual: Record<string, string | undefined>;
}> {}

/**
 * Asserts that a VPC has the expected tags, retrying until eventually consistent.
 */
const assertVpcTags = Effect.fn(function* (
  vpcId: string,
  expectedTags: Record<string, string>,
) {
  yield* EC2.describeVpcs({ VpcIds: [vpcId] }).pipe(
    Effect.flatMap((result) => {
      const tags = result.Vpcs?.[0]?.Tags ?? [];
      const actual: Record<string, string | undefined> = {};

      for (const key of Object.keys(expectedTags)) {
        actual[key] = tags.find((t) => t.Key === key)?.Value;
      }

      const allMatch = Object.entries(expectedTags).every(
        ([key, value]) => actual[key] === value,
      );

      return allMatch
        ? Effect.succeed(result)
        : Effect.fail(
            new TagsNotPropagated({ expected: expectedTags, actual }),
          );
    }),
    Effect.tapError(Effect.log),
    Effect.retry({
      while: (e) => e._tag === "TagsNotPropagated",
      schedule: Schedule.fixed(1000).pipe(Schedule.both(Schedule.recurs(10))),
    }),
  );
});
