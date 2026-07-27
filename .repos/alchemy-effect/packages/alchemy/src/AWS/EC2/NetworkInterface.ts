import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import type { ScopedPlanStatusSession } from "../../Cli/Cli.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, createTagsList, diffTags } from "../../Tags.ts";
import type { AccountID } from "../Environment.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { RegionID } from "../Region.ts";
import type { Providers } from "../Providers.ts";
import type { SecurityGroupId } from "./SecurityGroup.ts";
import type { SubnetId } from "./Subnet.ts";
import type { VpcId } from "./Vpc.ts";

export type NetworkInterfaceId<ID extends string = string> = `eni-${ID}`;
export const NetworkInterfaceId = <ID extends string>(
  id: ID,
): ID & NetworkInterfaceId<ID> => `eni-${id}` as ID & NetworkInterfaceId<ID>;

export type NetworkInterfaceArn =
  `arn:aws:ec2:${RegionID}:${AccountID}:network-interface/${NetworkInterfaceId}`;

export interface NetworkInterfaceProps {
  /**
   * The ID of the subnet to create the network interface in. Required.
   * Changing it replaces the interface.
   */
  subnetId: SubnetId;

  /**
   * A description for the network interface. Mutable in place.
   */
  description?: string;

  /**
   * The primary private IPv4 address to assign. If omitted, AWS selects one
   * from the subnet range. Changing it replaces the interface.
   */
  privateIpAddress?: string;

  /**
   * Additional (secondary) private IPv4 addresses to assign at creation.
   */
  privateIpAddresses?: string[];

  /**
   * The security groups to associate with the interface. Mutable in place.
   */
  securityGroupIds?: SecurityGroupId[];

  /**
   * Whether source/destination checking is enabled. Disable it for NAT
   * instances and other appliances that forward traffic. Mutable in place.
   * @default true
   */
  sourceDestCheck?: boolean;

  /**
   * The type of network interface.
   * @default "interface"
   */
  interfaceType?: ec2.NetworkInterfaceCreationType;

  /**
   * Tags to assign to the network interface. Merged with alchemy auto-tags
   * (alchemy::stack, alchemy::stage, alchemy::id).
   */
  tags?: Record<string, string>;
}

export interface NetworkInterface extends Resource<
  "AWS.EC2.NetworkInterface",
  NetworkInterfaceProps,
  {
    /**
     * The ID of the network interface.
     */
    networkInterfaceId: NetworkInterfaceId;

    /**
     * The Amazon Resource Name (ARN) of the network interface.
     */
    networkInterfaceArn: NetworkInterfaceArn;

    /**
     * The ID of the subnet the interface is in.
     */
    subnetId: SubnetId;

    /**
     * The ID of the VPC the interface is in.
     */
    vpcId: VpcId;

    /**
     * The Availability Zone of the interface.
     */
    availabilityZone: string;

    /**
     * The primary private IPv4 address.
     */
    privateIpAddress?: string;

    /**
     * All private IPv4 addresses assigned to the interface.
     */
    privateIpAddresses: string[];

    /**
     * The MAC address of the interface.
     */
    macAddress?: string;

    /**
     * The security groups associated with the interface.
     */
    securityGroupIds: SecurityGroupId[];

    /**
     * Whether source/destination checking is enabled.
     */
    sourceDestCheck: boolean;

    /**
     * The current status of the interface.
     */
    status: ec2.NetworkInterfaceStatus;

    /**
     * The ID of the AWS account that owns the interface.
     */
    ownerId?: string;
  },
  never,
  Providers
> {}
/**
 * An Elastic Network Interface (ENI) — a virtual network card in a VPC subnet
 * with its own private IPs, MAC address, and security groups. Attach one to an
 * instance via a {@link NetworkInterfaceAttachment} for stable-IP and
 * multi-homing patterns.
 *
 * Changing `subnetId` or the primary `privateIpAddress` replaces the interface.
 * `description`, `securityGroupIds`, and `sourceDestCheck` are applied in place.
 *
 * @resource
 * @section Creating a Network Interface
 * @example Basic ENI
 * ```typescript
 * const eni = yield* AWS.EC2.NetworkInterface("AppEni", {
 *   subnetId: subnet.subnetId,
 *   description: "stable IP for the app server",
 *   securityGroupIds: [securityGroup.groupId],
 * });
 * ```
 *
 * The interface gets a private IP from the subnet's range. Its IP survives
 * instance replacement — detach it from a failed instance and attach it to a
 * new one to keep the same address.
 *
 * @section Fixed Private IP
 * @example ENI with a Fixed Private IP
 * ```typescript
 * const eni = yield* AWS.EC2.NetworkInterface("FixedIpEni", {
 *   subnetId: subnet.subnetId,
 *   privateIpAddress: "10.0.1.50",
 *   securityGroupIds: [securityGroup.groupId],
 * });
 * ```
 *
 * Pinning `privateIpAddress` gives the interface a predictable address —
 * useful for appliances and services other resources reference by IP.
 *
 * @section Forwarding Appliances
 * @example ENI with Source/Dest Check Disabled
 * ```typescript
 * const eni = yield* AWS.EC2.NetworkInterface("NatEni", {
 *   subnetId: subnet.subnetId,
 *   sourceDestCheck: false,
 *   securityGroupIds: [securityGroup.groupId],
 * });
 * ```
 *
 * Disable `sourceDestCheck` when the interface belongs to a NAT instance,
 * firewall, or router that forwards packets not addressed to itself.
 */
export const NetworkInterface = Resource<NetworkInterface>(
  "AWS.EC2.NetworkInterface",
);

export const NetworkInterfaceProvider = () =>
  Provider.effect(
    NetworkInterface,
    Effect.gen(function* () {
      return {
        stables: [
          "networkInterfaceId",
          "networkInterfaceArn",
          "subnetId",
          "vpcId",
          "availabilityZone",
          "ownerId",
        ],

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          if (
            olds.subnetId !== news.subnetId ||
            olds.privateIpAddress !== news.privateIpAddress
          ) {
            return { action: "replace" };
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const alchemyTags = yield* createInternalTags(id);
          const desiredTags = { ...alchemyTags, ...news.tags };

          // 1. OBSERVE — output is only an id cache.
          let eni: ec2.NetworkInterface | undefined;
          if (output?.networkInterfaceId) {
            const lookup = yield* ec2
              .describeNetworkInterfaces({
                NetworkInterfaceIds: [output.networkInterfaceId],
              })
              .pipe(
                Effect.catchTag("InvalidNetworkInterfaceID.NotFound", () =>
                  Effect.succeed({ NetworkInterfaces: [] }),
                ),
              );
            eni = lookup.NetworkInterfaces?.[0];
          }

          // 2. ENSURE — create the interface when missing.
          if (eni === undefined) {
            const secondary = (news.privateIpAddresses ?? []).map((ip) => ({
              Primary: false,
              PrivateIpAddress: ip,
            }));
            const created = yield* ec2.createNetworkInterface({
              SubnetId: news.subnetId,
              Description: news.description,
              PrivateIpAddress: news.privateIpAddress,
              PrivateIpAddresses: secondary.length > 0 ? secondary : undefined,
              Groups: news.securityGroupIds,
              InterfaceType: news.interfaceType,
              TagSpecifications: [
                {
                  ResourceType: "network-interface",
                  Tags: createTagsList(desiredTags),
                },
              ],
              DryRun: false,
            });
            eni = created.NetworkInterface!;
            yield* session.note(
              `Network interface created: ${eni.NetworkInterfaceId}`,
            );
            eni = yield* waitForNetworkInterface(
              eni.NetworkInterfaceId!,
              session,
            );
          }

          const eniId = eni.NetworkInterfaceId! as NetworkInterfaceId;

          // 3. SYNC — description, security groups, source/dest check.
          if (
            news.description !== undefined &&
            news.description !== (eni.Description ?? "")
          ) {
            yield* ec2.modifyNetworkInterfaceAttribute({
              NetworkInterfaceId: eniId,
              Description: { Value: news.description },
              DryRun: false,
            });
            yield* session.note("Updated network interface description");
          }

          if (news.securityGroupIds !== undefined) {
            const observed = (eni.Groups ?? []).map((g) => g.GroupId!).sort();
            const desired = [...news.securityGroupIds].sort();
            if (JSON.stringify(observed) !== JSON.stringify(desired)) {
              yield* ec2.modifyNetworkInterfaceAttribute({
                NetworkInterfaceId: eniId,
                Groups: news.securityGroupIds,
                DryRun: false,
              });
              yield* session.note("Updated network interface security groups");
            }
          }

          const desiredSourceDestCheck = news.sourceDestCheck ?? true;
          if ((eni.SourceDestCheck ?? true) !== desiredSourceDestCheck) {
            yield* ec2.modifyNetworkInterfaceAttribute({
              NetworkInterfaceId: eniId,
              SourceDestCheck: { Value: desiredSourceDestCheck },
              DryRun: false,
            });
            yield* session.note(
              `Updated source/dest check: ${desiredSourceDestCheck}`,
            );
          }

          // 3b. SYNC TAGS — diff against observed cloud tags.
          const currentTags = Object.fromEntries(
            (eni.TagSet ?? []).map((t) => [t.Key!, t.Value!]),
          ) as Record<string, string>;
          const { removed, upsert } = diffTags(currentTags, desiredTags);
          if (removed.length > 0) {
            yield* ec2.deleteTags({
              Resources: [eniId],
              Tags: removed.map((key) => ({ Key: key })),
              DryRun: false,
            });
          }
          if (upsert.length > 0) {
            yield* ec2.createTags({
              Resources: [eniId],
              Tags: upsert,
              DryRun: false,
            });
          }

          // 4. RETURN fresh attributes.
          const finalLookup = yield* ec2.describeNetworkInterfaces({
            NetworkInterfaceIds: [eniId],
          });
          const final = finalLookup.NetworkInterfaces?.[0] ?? eni;
          return toNetworkInterfaceAttributes(final, region, accountId);
        }),

        // Enumerate every network interface in the ambient account/region.
        list: () =>
          Effect.gen(function* () {
            const { accountId, region } = yield* AWSEnvironment.current;
            const chunk = yield* ec2.describeNetworkInterfaces
              .pages({})
              .pipe(Stream.runCollect);
            return Array.from(chunk).flatMap((page) =>
              (page.NetworkInterfaces ?? []).map((n) =>
                toNetworkInterfaceAttributes(n, region, accountId),
              ),
            );
          }),

        delete: Effect.fn(function* ({ output, session }) {
          const eniId = output.networkInterfaceId;
          yield* session.note(`Deleting network interface: ${eniId}`);
          yield* ec2
            .deleteNetworkInterface({
              NetworkInterfaceId: eniId,
              DryRun: false,
            })
            .pipe(
              Effect.tapError(Effect.logDebug),
              Effect.catchTag(
                "InvalidNetworkInterfaceID.NotFound",
                () => Effect.void,
              ),
              // A just-detached interface can briefly report InUse — retry
              // until the attachment fully clears.
              Effect.retry({
                while: (e) => e._tag === "InvalidNetworkInterface.InUse",
                schedule: Schedule.max([
                  Schedule.fixed(3000),
                  Schedule.recurs(20),
                ]).pipe(
                  Schedule.tap(({ attempt }) =>
                    session.note(
                      `Waiting for interface to detach... (attempt ${attempt + 1})`,
                    ),
                  ),
                ),
              }),
            );
          yield* session.note(`Network interface ${eniId} deleted`);
        }),
      };
    }),
  );

const toNetworkInterfaceAttributes = (
  eni: ec2.NetworkInterface,
  region: RegionID,
  accountId: AccountID,
): NetworkInterface["Attributes"] => {
  const eniId = eni.NetworkInterfaceId! as NetworkInterfaceId;
  return {
    networkInterfaceId: eniId,
    networkInterfaceArn:
      `arn:aws:ec2:${region}:${accountId}:network-interface/${eniId}` as NetworkInterfaceArn,
    subnetId: eni.SubnetId! as SubnetId,
    vpcId: eni.VpcId! as VpcId,
    availabilityZone: eni.AvailabilityZone!,
    privateIpAddress: eni.PrivateIpAddress,
    privateIpAddresses: (eni.PrivateIpAddresses ?? [])
      .map((p) => p.PrivateIpAddress!)
      .filter((ip): ip is string => ip !== undefined),
    macAddress: eni.MacAddress,
    securityGroupIds: (eni.Groups ?? [])
      .map((g) => g.GroupId! as SecurityGroupId)
      .filter((g): g is SecurityGroupId => g !== undefined),
    sourceDestCheck: eni.SourceDestCheck ?? true,
    status: eni.Status ?? "available",
    ownerId: eni.OwnerId,
  };
};

class NetworkInterfacePending extends Data.TaggedError(
  "NetworkInterfacePending",
)<{
  networkInterfaceId: string;
  status: string;
}> {}

/**
 * Wait for the network interface to reach an `available` (or in-use) status.
 */
const waitForNetworkInterface = (
  networkInterfaceId: string,
  session?: ScopedPlanStatusSession,
) =>
  Effect.gen(function* () {
    const result = yield* ec2.describeNetworkInterfaces({
      NetworkInterfaceIds: [networkInterfaceId],
    });
    const eni = result.NetworkInterfaces?.[0];
    if (!eni) {
      return yield* Effect.fail(
        new Error(`Network interface ${networkInterfaceId} not found`),
      );
    }
    if (eni.Status === "available" || eni.Status === "in-use") {
      return eni;
    }
    return yield* new NetworkInterfacePending({
      networkInterfaceId,
      status: eni.Status!,
    });
  }).pipe(
    Effect.retry({
      while: (e) => e instanceof NetworkInterfacePending,
      schedule: Schedule.max([
        Schedule.fixed(2000),
        Schedule.recurs(20), // max ~40s
      ]).pipe(
        Schedule.tap(({ attempt }) =>
          session
            ? session.note(
                `Waiting for network interface... (${(attempt + 1) * 2}s)`,
              )
            : Effect.void,
        ),
      ),
    }),
  );
