import * as ec2 from "@distilled.cloud/aws/ec2";
import { Region } from "@distilled.cloud/aws/Region";
import * as Effect from "effect/Effect";
import * as Namespace from "../../Namespace.ts";
import type { EIP as EIPResource } from "./EIP.ts";
import { EIP } from "./EIP.ts";
import type { InternetGateway as InternetGatewayResource } from "./InternetGateway.ts";
import { InternetGateway } from "./InternetGateway.ts";
import type { NatGateway as NatGatewayResource } from "./NatGateway.ts";
import { NatGateway } from "./NatGateway.ts";
import type { Route as RouteResource } from "./Route.ts";
import { Route } from "./Route.ts";
import type { RouteTable as RouteTableResource } from "./RouteTable.ts";
import { RouteTable } from "./RouteTable.ts";
import type { RouteTableAssociation as RouteTableAssociationResource } from "./RouteTableAssociation.ts";
import { RouteTableAssociation } from "./RouteTableAssociation.ts";
import type { Subnet as SubnetResource } from "./Subnet.ts";
import { Subnet } from "./Subnet.ts";
import type { Vpc as VpcResource } from "./Vpc.ts";
import { Vpc } from "./Vpc.ts";
import type { VpcEndpoint as VpcEndpointResource } from "./VpcEndpoint.ts";
import { VpcEndpoint } from "./VpcEndpoint.ts";

export type NetworkNat = "none" | "single" | "per-az";

export type NetworkGatewayEndpoint = "s3" | "dynamodb";

export interface NetworkProps {
  /**
   * IPv4 CIDR block for the VPC.
   * @example "10.42.0.0/16"
   */
  cidrBlock: string;

  /**
   * Number of Availability Zones to span or an explicit ordered list of zone names.
   * Defaults to 2 available zones.
   */
  availabilityZones?: number | string[];

  /**
   * NAT strategy for private subnets.
   * - `"none"` keeps private subnets isolated
   * - `"single"` creates one shared NAT gateway
   * - `"per-az"` creates one NAT gateway per Availability Zone
   * @default "none"
   */
  nat?: NetworkNat;

  /**
   * Gateway endpoints to attach to the private route tables.
   * Supported in v1: S3 and DynamoDB.
   */
  gatewayEndpoints?: NetworkGatewayEndpoint[];

  /**
   * Whether DNS resolution is supported for the VPC.
   * @default true
   */
  enableDnsSupport?: boolean;

  /**
   * Whether instances launched in the VPC receive DNS hostnames.
   * @default true
   */
  enableDnsHostnames?: boolean;

  /**
   * Tags to apply to all created resources.
   */
  tags?: Record<string, string>;
}

export interface NetworkResources {
  availabilityZones: string[];
  vpc: VpcResource;
  internetGateway?: InternetGatewayResource;
  elasticIps: EIPResource[];
  natGateways: NatGatewayResource[];
  publicSubnets: SubnetResource[];
  privateSubnets: SubnetResource[];
  publicRouteTables: RouteTableResource[];
  privateRouteTables: RouteTableResource[];
  publicRoutes: RouteResource[];
  privateRoutes: RouteResource[];
  publicRouteAssociations: RouteTableAssociationResource[];
  privateRouteAssociations: RouteTableAssociationResource[];
  gatewayEndpoints: VpcEndpointResource[];
  vpcId: VpcResource["vpcId"];
  publicSubnetIds: Array<SubnetResource["subnetId"]>;
  privateSubnetIds: Array<SubnetResource["subnetId"]>;
}

export type Network = Effect.Success<ReturnType<typeof Network>>;

/**
 * Creates a production-shaped VPC network from the low-level EC2 primitives.
 *
 * `Network` is the ergonomic entry point for users who want a ready-to-use VPC
 * layout without manually creating route tables, internet gateways, NAT
 * gateways, and subnet associations by hand.
 *
 * The helper still returns the underlying canonical resources so callers can
 * keep composing with raw `AWS.EC2.*` APIs when they need more control.
 *
 * @example Minimal network
 * ```typescript
 * const network = yield* AWS.EC2.Network("AppNetwork", {
 *   cidrBlock: "10.42.0.0/16",
 * });
 * ```
 *
 * @example ECS-ready network with shared NAT
 * ```typescript
 * const network = yield* AWS.EC2.Network("AppNetwork", {
 *   cidrBlock: "10.42.0.0/16",
 *   availabilityZones: 2,
 *   nat: "single",
 *   gatewayEndpoints: ["s3"],
 * });
 *
 * yield* AWS.ECS.Service("ApiService", {
 *   cluster,
 *   task: apiTask,
 *   vpcId: network.vpcId,
 *   subnets: network.publicSubnetIds,
 *   assignPublicIp: true,
 * });
 * ```
 */
export const Network = (id: string, props: NetworkProps) =>
  Namespace.push(
    id,
    Effect.gen(function* () {
      const availabilityZones = yield* resolveAvailabilityZones(
        props.availabilityZones,
      );
      const subnetCidrs = deriveSubnetCidrs(
        props.cidrBlock,
        availabilityZones.length,
      );
      const tags = props.tags;

      const vpc = yield* Vpc("Vpc", {
        cidrBlock: props.cidrBlock,
        enableDnsSupport: props.enableDnsSupport ?? true,
        enableDnsHostnames: props.enableDnsHostnames ?? true,
        tags,
      });

      const internetGateway = yield* InternetGateway("InternetGateway", {
        vpcId: vpc.vpcId,
        tags,
      });

      const publicSubnets: SubnetResource[] = [];
      const privateSubnets: SubnetResource[] = [];

      for (const [index, availabilityZone] of availabilityZones.entries()) {
        const publicSubnet = yield* Subnet(`PublicSubnet${index + 1}`, {
          vpcId: vpc.vpcId,
          cidrBlock: subnetCidrs.public[index],
          availabilityZone,
          mapPublicIpOnLaunch: true,
          tags: {
            ...tags,
            Tier: "public",
          },
        });
        publicSubnets.push(publicSubnet);

        const privateSubnet = yield* Subnet(`PrivateSubnet${index + 1}`, {
          vpcId: vpc.vpcId,
          cidrBlock: subnetCidrs.private[index],
          availabilityZone,
          tags: {
            ...tags,
            Tier: "private",
          },
        });
        privateSubnets.push(privateSubnet);
      }

      const publicRouteTable = yield* RouteTable("PublicRouteTable", {
        vpcId: vpc.vpcId,
        tags: {
          ...tags,
          Tier: "public",
        },
      });

      const publicInternetRoute = yield* Route("PublicInternetRoute", {
        routeTableId: publicRouteTable.routeTableId,
        destinationCidrBlock: "0.0.0.0/0",
        gatewayId: internetGateway.internetGatewayId,
      });

      const publicRouteAssociations: RouteTableAssociationResource[] = [];

      for (const [index, subnet] of publicSubnets.entries()) {
        publicRouteAssociations.push(
          yield* RouteTableAssociation(`PublicSubnetAssociation${index + 1}`, {
            routeTableId: publicRouteTable.routeTableId,
            subnetId: subnet.subnetId,
          }),
        );
      }

      const nat = props.nat ?? "none";
      const elasticIps: EIPResource[] = [];
      const natGateways: NatGatewayResource[] = [];
      const privateRouteTables: RouteTableResource[] = [];
      const privateRoutes: RouteResource[] = [];
      const privateRouteAssociations: RouteTableAssociationResource[] = [];

      if (nat === "per-az") {
        for (const [index, subnet] of publicSubnets.entries()) {
          const eip = yield* EIP(`NatEip${index + 1}`, {
            domain: "vpc",
            tags,
          });
          elasticIps.push(eip);

          const natGateway = yield* NatGateway(`NatGateway${index + 1}`, {
            subnetId: subnet.subnetId,
            allocationId: eip.allocationId,
            connectivityType: "public",
            tags,
          });
          natGateways.push(natGateway);

          const privateRouteTable = yield* RouteTable(
            `PrivateRouteTable${index + 1}`,
            {
              vpcId: vpc.vpcId,
              tags: {
                ...tags,
                Tier: "private",
              },
            },
          );
          privateRouteTables.push(privateRouteTable);

          privateRoutes.push(
            yield* Route(`PrivateInternetRoute${index + 1}`, {
              routeTableId: privateRouteTable.routeTableId,
              destinationCidrBlock: "0.0.0.0/0",
              natGatewayId: natGateway.natGatewayId,
            }),
          );

          privateRouteAssociations.push(
            yield* RouteTableAssociation(
              `PrivateSubnetAssociation${index + 1}`,
              {
                routeTableId: privateRouteTable.routeTableId,
                subnetId: privateSubnets[index].subnetId,
              },
            ),
          );
        }
      } else {
        const privateRouteTable = yield* RouteTable("PrivateRouteTable", {
          vpcId: vpc.vpcId,
          tags: {
            ...tags,
            Tier: "private",
          },
        });
        privateRouteTables.push(privateRouteTable);

        if (nat === "single") {
          const eip = yield* EIP("NatEip", {
            domain: "vpc",
            tags,
          });
          elasticIps.push(eip);

          const natGateway = yield* NatGateway("NatGateway", {
            subnetId: publicSubnets[0].subnetId,
            allocationId: eip.allocationId,
            connectivityType: "public",
            tags,
          });
          natGateways.push(natGateway);

          privateRoutes.push(
            yield* Route("PrivateInternetRoute", {
              routeTableId: privateRouteTable.routeTableId,
              destinationCidrBlock: "0.0.0.0/0",
              natGatewayId: natGateway.natGatewayId,
            }),
          );
        }

        for (const [index, subnet] of privateSubnets.entries()) {
          privateRouteAssociations.push(
            yield* RouteTableAssociation(
              `PrivateSubnetAssociation${index + 1}`,
              {
                routeTableId: privateRouteTable.routeTableId,
                subnetId: subnet.subnetId,
              },
            ),
          );
        }
      }

      const region = yield* Region;
      const gatewayEndpoints: VpcEndpointResource[] = [];
      for (const service of uniqueGatewayEndpoints(props.gatewayEndpoints)) {
        gatewayEndpoints.push(
          yield* VpcEndpoint(`${toEndpointId(service)}Endpoint`, {
            vpcId: vpc.vpcId,
            serviceName: `com.amazonaws.${region}.${service}`,
            vpcEndpointType: "Gateway",
            routeTableIds: privateRouteTables.map(
              (table) => table.routeTableId,
            ),
            tags,
          }),
        );
      }

      return {
        availabilityZones,
        vpc,
        internetGateway,
        elasticIps,
        natGateways,
        publicSubnets,
        privateSubnets,
        publicRouteTables: [publicRouteTable],
        privateRouteTables,
        publicRoutes: [publicInternetRoute],
        privateRoutes,
        publicRouteAssociations,
        privateRouteAssociations,
        gatewayEndpoints,
        vpcId: vpc.vpcId,
        publicSubnetIds: publicSubnets.map((subnet) => subnet.subnetId),
        privateSubnetIds: privateSubnets.map((subnet) => subnet.subnetId),
      } satisfies NetworkResources;
    }).pipe(Effect.orDie),
  );

const resolveAvailabilityZones = (input?: number | string[]) =>
  Effect.gen(function* () {
    if (Array.isArray(input)) {
      if (input.length === 0) {
        return yield* Effect.fail(
          new Error("EC2.Network requires at least one availability zone"),
        );
      }
      if (new Set(input).size !== input.length) {
        return yield* Effect.fail(
          new Error(
            "EC2.Network availabilityZones must not contain duplicates",
          ),
        );
      }
      return input;
    }

    const desiredCount = input ?? 2;
    if (!Number.isInteger(desiredCount) || desiredCount <= 0) {
      return yield* Effect.fail(
        new Error(
          "EC2.Network availabilityZones count must be a positive integer",
        ),
      );
    }

    const result = yield* ec2.describeAvailabilityZones({});
    const zones = (result.AvailabilityZones ?? [])
      .filter((zone) => zone.State === "available" && zone.ZoneName)
      .map((zone) => zone.ZoneName!)
      .sort((a, b) => a.localeCompare(b));

    if (zones.length < desiredCount) {
      return yield* Effect.fail(
        new Error(
          `EC2.Network requested ${desiredCount} availability zones, but only ${zones.length} are available`,
        ),
      );
    }

    return zones.slice(0, desiredCount);
  });

const deriveSubnetCidrs = (cidrBlock: string, azCount: number) => {
  const [baseAddress, prefixText] = cidrBlock.split("/");
  const prefix = Number(prefixText);
  if (!baseAddress || !Number.isInteger(prefix) || prefix < 0 || prefix > 28) {
    throw new Error(
      `EC2.Network requires a valid IPv4 CIDR block, got '${cidrBlock}'`,
    );
  }

  const totalSubnets = azCount * 2;
  const additionalBits = Math.ceil(Math.log2(totalSubnets));
  const subnetPrefix = Math.max(prefix + additionalBits, 24);

  if (subnetPrefix > 28) {
    throw new Error(
      `EC2.Network CIDR block '${cidrBlock}' is too small for ${totalSubnets} subnets`,
    );
  }

  const subnetSize = 2 ** (32 - subnetPrefix);
  const base = toNetworkAddress(baseAddress, prefix);

  return {
    public: Array.from({ length: azCount }, (_, index) =>
      toCidr(base + subnetSize * index, subnetPrefix),
    ),
    private: Array.from({ length: azCount }, (_, index) =>
      toCidr(base + subnetSize * (index + azCount), subnetPrefix),
    ),
  };
};

const toNetworkAddress = (ip: string, prefix: number) => {
  const value = ipv4ToNumber(ip);
  const blockSize = 2 ** (32 - prefix);
  return Math.floor(value / blockSize) * blockSize;
};

const ipv4ToNumber = (ip: string) => {
  const octets = ip.split(".").map((part) => Number(part));
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    throw new Error(`Invalid IPv4 address '${ip}'`);
  }

  return (
    octets[0] * 256 ** 3 + octets[1] * 256 ** 2 + octets[2] * 256 + octets[3]
  );
};

const numberToIpv4 = (value: number) =>
  [
    Math.floor(value / 256 ** 3) % 256,
    Math.floor(value / 256 ** 2) % 256,
    Math.floor(value / 256) % 256,
    value % 256,
  ].join(".");

const toCidr = (value: number, prefix: number) =>
  `${numberToIpv4(value)}/${prefix}`;

const uniqueGatewayEndpoints = (services: NetworkGatewayEndpoint[] = []) => [
  ...new Set(services),
];

const toEndpointId = (service: NetworkGatewayEndpoint) =>
  service === "s3" ? "S3" : "DynamoDb";
