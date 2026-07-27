import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, createTagsList, diffTags } from "../../Tags.ts";
import type { AccountID } from "../Environment.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";
import type { VpcId } from "./Vpc.ts";

export type NetworkAclId<ID extends string = string> = `acl-${ID}`;
export const NetworkAclId = <ID extends string>(
  id: ID,
): ID & NetworkAclId<ID> => `acl-${id}` as ID & NetworkAclId<ID>;

export type NetworkAclArn<ID extends NetworkAclId = NetworkAclId> =
  `arn:aws:ec2:${RegionID}:${AccountID}:network-acl/${ID}`;

export interface NetworkAclProps {
  /**
   * The VPC to create the network ACL in.
   */
  vpcId: VpcId;

  /**
   * Tags to assign to the network ACL.
   */
  tags?: Record<string, string>;
}

export interface NetworkAcl extends Resource<
  "AWS.EC2.NetworkAcl",
  NetworkAclProps,
  {
    /**
     * The ID of the network ACL.
     */
    networkAclId: NetworkAclId;
    /**
     * The Amazon Resource Name (ARN) of the network ACL.
     */
    networkAclArn: NetworkAclArn;
    /**
     * The ID of the VPC the network ACL belongs to.
     */
    vpcId: VpcId;
    /**
     * Whether this is the default network ACL for the VPC.
     */
    isDefault: boolean;
    /**
     * The ID of the AWS account that owns the network ACL.
     */
    ownerId: string;
    /**
     * The rule entries (inbound and outbound) currently defined on the ACL.
     */
    entries?: Array<{
      /** The rule number; rules are evaluated lowest to highest. */
      ruleNumber: number;
      /** The protocol number ("-1" means all protocols). */
      protocol: string;
      /** Whether the rule allows or denies matching traffic. */
      ruleAction: ec2.RuleAction;
      /** Whether this is an egress (outbound) rule. */
      egress: boolean;
      /** The IPv4 CIDR block the rule applies to. */
      cidrBlock?: string;
      /** The IPv6 CIDR block the rule applies to. */
      ipv6CidrBlock?: string;
      /** The ICMP type and code, for ICMP rules. */
      icmpTypeCode?: {
        code?: number;
        type?: number;
      };
      /** The port range, for TCP/UDP rules. */
      portRange?: {
        from?: number;
        to?: number;
      };
    }>;
    /**
     * The subnet associations currently attached to the network ACL.
     */
    associations?: Array<{
      /** The ID of the association between the ACL and the subnet. */
      networkAclAssociationId: string;
      /** The ID of the associated network ACL. */
      networkAclId: string;
      /** The ID of the associated subnet. */
      subnetId: string;
    }>;
  },
  never,
  Providers
> {}
/**
 * A network ACL — a stateless firewall that controls inbound and outbound
 * traffic at the *subnet* level, evaluated as an ordered list of numbered
 * allow/deny rules.
 *
 * Unlike security groups (which are stateful and attach to interfaces), a
 * network ACL is associated with subnets and evaluates return traffic
 * independently, so you typically pair each inbound rule with a matching
 * ephemeral-port outbound rule. The ACL itself only takes `vpcId` and `tags`;
 * the actual rules live in `NetworkAclEntry` resources and subnet attachments
 * in `NetworkAclAssociation` resources. Changing `vpcId` replaces the ACL.
 *
 * @resource
 * @section Creating Network ACLs
 * @example Basic Network ACL
 * ```typescript
 * const acl = yield* AWS.EC2.NetworkAcl("PrivateNetworkAcl", {
 *   vpcId: vpc.vpcId,
 *   tags: { Name: "private-nacl" },
 * });
 * ```
 * This creates an empty custom ACL in the VPC — it starts with only the implicit
 * default-deny rules, so until you add entries it blocks all traffic on any
 * subnet you associate with it.
 *
 * @section Composing Rules and Associations
 * A network ACL is only useful once you attach rules and point subnets at it.
 * The typical pattern is one `NetworkAcl`, several `NetworkAclEntry` rules, and
 * one `NetworkAclAssociation` per subnet.
 * @example Network ACL with an Inbound Rule and Subnet Association
 * ```typescript
 * const acl = yield* AWS.EC2.NetworkAcl("PrivateNetworkAcl", {
 *   vpcId: vpc.vpcId,
 * });
 *
 * const allowVpc = yield* AWS.EC2.NetworkAclEntry("AllowVpc", {
 *   networkAclId: acl.networkAclId,
 *   ruleNumber: 100,
 *   protocol: "-1",
 *   ruleAction: "allow",
 *   egress: false,
 *   cidrBlock: "10.0.0.0/16",
 * });
 *
 * const association = yield* AWS.EC2.NetworkAclAssociation("SubnetAssoc", {
 *   networkAclId: acl.networkAclId,
 *   subnetId: privateSubnet.subnetId,
 * });
 * ```
 * The entry allows all traffic from within the VPC CIDR and the association
 * makes the subnet use this ACL instead of the VPC default. Build up the full
 * rule set by adding more `NetworkAclEntry` resources with increasing
 * `ruleNumber`s.
 */
export const NetworkAcl = Resource<NetworkAcl>("AWS.EC2.NetworkAcl");

export const NetworkAclProvider = () =>
  Provider.effect(
    NetworkAcl,
    Effect.gen(function* () {
      const createTags = Effect.fn(function* (
        id: string,
        tags?: Record<string, string>,
      ) {
        return {
          Name: id,
          ...(yield* createInternalTags(id)),
          ...tags,
        };
      });

      const describeNetworkAcl = (networkAclId: string) =>
        ec2.describeNetworkAcls({ NetworkAclIds: [networkAclId] }).pipe(
          Effect.map((r) => r.NetworkAcls?.[0]),
          Effect.flatMap((acl) =>
            acl
              ? Effect.succeed(acl)
              : Effect.fail(new Error(`Network ACL ${networkAclId} not found`)),
          ),
        );

      const toAttrs = Effect.fn(function* (acl: ec2.NetworkAcl) {
        const { accountId, region } = yield* AWSEnvironment.current;
        return {
          networkAclId: acl.NetworkAclId as NetworkAclId,
          networkAclArn:
            `arn:aws:ec2:${region}:${accountId}:network-acl/${acl.NetworkAclId}` as NetworkAclArn,
          vpcId: acl.VpcId as VpcId,
          isDefault: acl.IsDefault ?? false,
          ownerId: acl.OwnerId!,
          entries: acl.Entries?.map((e) => ({
            ruleNumber: e.RuleNumber!,
            protocol: e.Protocol!,
            ruleAction: e.RuleAction!,
            egress: e.Egress!,
            cidrBlock: e.CidrBlock,
            ipv6CidrBlock: e.Ipv6CidrBlock,
            icmpTypeCode: e.IcmpTypeCode
              ? {
                  code: e.IcmpTypeCode.Code,
                  type: e.IcmpTypeCode.Type,
                }
              : undefined,
            portRange: e.PortRange
              ? {
                  from: e.PortRange.From,
                  to: e.PortRange.To,
                }
              : undefined,
          })),
          associations: acl.Associations?.map((a) => ({
            networkAclAssociationId: a.NetworkAclAssociationId!,
            networkAclId: a.NetworkAclId!,
            subnetId: a.SubnetId!,
          })),
        } satisfies NetworkAcl["Attributes"];
      });

      return {
        stables: ["networkAclId", "networkAclArn", "ownerId", "isDefault"],

        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          const acl = yield* describeNetworkAcl(output.networkAclId);
          return yield* toAttrs(acl);
        }),

        list: () =>
          Effect.gen(function* () {
            const acls = yield* ec2.describeNetworkAcls.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.NetworkAcls ?? []).filter(
                    (acl): acl is ec2.NetworkAcl & { NetworkAclId: string } =>
                      acl.NetworkAclId != null &&
                      // Each VPC's default NACL is AWS-managed and cannot be
                      // deleted (InvalidParameterValue) — don't enumerate it.
                      acl.IsDefault !== true,
                  ),
                ),
              ),
            );
            return yield* Effect.forEach(acls, (acl) => toAttrs(acl));
          }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          // VPC change requires replacement
          if (news.vpcId !== olds.vpcId) {
            return { action: "replace" };
          }
          // Tags can be updated in-place
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const desiredTags = yield* createTags(id, news.tags);

          // Observe — find the NACL via cached id, else fall through to create.
          let acl: ec2.NetworkAcl | undefined;
          if (output?.networkAclId) {
            const lookup = yield* ec2
              .describeNetworkAcls({ NetworkAclIds: [output.networkAclId] })
              .pipe(
                Effect.catchTag("InvalidNetworkAclID.NotFound", () =>
                  Effect.succeed({ NetworkAcls: [] }),
                ),
              );
            acl = lookup.NetworkAcls?.[0];
          }

          // Ensure — create the NACL when missing.
          if (acl === undefined) {
            yield* session.note("Creating Network ACL...");
            const result = yield* ec2.createNetworkAcl({
              VpcId: news.vpcId as string,
              TagSpecifications: [
                {
                  ResourceType: "network-acl",
                  Tags: createTagsList(desiredTags),
                },
              ],
              DryRun: false,
            });
            const newAclId = result.NetworkAcl!.NetworkAclId!;
            yield* session.note(`Network ACL created: ${newAclId}`);
            acl = yield* describeNetworkAcl(newAclId);
          }

          const networkAclId = acl.NetworkAclId!;

          // Sync tags — observed cloud tags vs desired.
          const currentTags = Object.fromEntries(
            (acl.Tags ?? []).map((t) => [t.Key!, t.Value!]),
          ) as Record<string, string>;
          const { removed, upsert } = diffTags(currentTags, desiredTags);
          if (removed.length > 0) {
            yield* ec2.deleteTags({
              Resources: [networkAclId],
              Tags: removed.map((key) => ({ Key: key })),
              DryRun: false,
            });
          }
          if (upsert.length > 0) {
            yield* ec2.createTags({
              Resources: [networkAclId],
              Tags: upsert,
              DryRun: false,
            });
          }

          // Re-read final state.
          const final = yield* describeNetworkAcl(networkAclId);
          return yield* toAttrs(final);
        }),

        delete: Effect.fn(function* ({ output, session }) {
          const networkAclId = output.networkAclId;

          yield* session.note(`Deleting Network ACL: ${networkAclId}`);

          yield* ec2
            .deleteNetworkAcl({
              NetworkAclId: networkAclId,
              DryRun: false,
            })
            .pipe(
              Effect.catchTag(
                "InvalidNetworkAclID.NotFound",
                () => Effect.void,
              ),
              // Retry on dependency violations (e.g., associations still being removed)
              Effect.retry({
                while: (e) => {
                  return e._tag === "DependencyViolation";
                },
                schedule: Schedule.max([
                  Schedule.exponential(1000, 1.5),
                  Schedule.recurs(15),
                ]).pipe(
                  Schedule.tap(({ attempt }) =>
                    session.note(
                      `Waiting for dependencies to clear... (attempt ${attempt})`,
                    ),
                  ),
                ),
              }),
            );

          yield* session.note(`Network ACL ${networkAclId} deleted`);
        }),
      };
    }),
  );
