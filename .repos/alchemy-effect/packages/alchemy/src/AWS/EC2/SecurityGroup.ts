import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, createTagsList, diffTags } from "../../Tags.ts";
import type { AccountID } from "../Environment.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";
import { retryWhileLingeringEnis } from "./LingeringEnis.ts";
import type { VpcId } from "./Vpc.ts";

export type SecurityGroupId<ID extends string = string> = `sg-${ID}`;
export const SecurityGroupId = <ID extends string>(
  id: ID,
): ID & SecurityGroupId<ID> => `sg-${id}` as ID & SecurityGroupId<ID>;

export type SecurityGroupArn<
  GroupId extends SecurityGroupId = SecurityGroupId,
> = `arn:aws:ec2:${RegionID}:${AccountID}:security-group/${GroupId}`;

/**
 * Ingress or egress rule for a security group.
 */
export interface SecurityGroupRuleData {
  /**
   * The IP protocol name or number.
   * Use -1 to specify all protocols.
   */
  ipProtocol: string;

  /**
   * The start of the port range.
   * For ICMP, use the ICMP type number.
   */
  fromPort?: number;

  /**
   * The end of the port range.
   * For ICMP, use the ICMP code.
   */
  toPort?: number;

  /**
   * IPv4 CIDR ranges to allow.
   */
  cidrIpv4?: string;

  /**
   * IPv6 CIDR ranges to allow.
   */
  cidrIpv6?: string;

  /**
   * ID of a security group to allow traffic from/to.
   */
  referencedGroupId?: SecurityGroupId;

  /**
   * ID of a prefix list.
   */
  prefixListId?: string;

  /**
   * Description for the rule.
   */
  description?: string;
}

export interface SecurityGroupProps {
  /**
   * The VPC to create the security group in.
   */
  vpcId: VpcId;

  /**
   * The name of the security group.
   * If not provided, a name will be generated.
   */
  groupName?: string;

  /**
   * A description for the security group.
   * @default "Managed by Alchemy"
   */
  description?: string;

  /**
   * Inbound rules for the security group.
   */
  ingress?: SecurityGroupRuleData[];

  /**
   * Outbound rules for the security group.
   * If not specified, allows all outbound traffic by default.
   */
  egress?: SecurityGroupRuleData[];

  /**
   * Tags to assign to the security group.
   */
  tags?: Record<string, string>;
}

export interface SecurityGroup extends Resource<
  "AWS.EC2.SecurityGroup",
  SecurityGroupProps,
  {
    /**
     * The ID of the security group.
     */
    groupId: SecurityGroupId;

    /**
     * The Amazon Resource Name (ARN) of the security group.
     */
    groupArn: SecurityGroupArn;

    /**
     * The name of the security group.
     */
    groupName: string;

    /**
     * The description of the security group.
     */
    description: string;

    /**
     * The ID of the VPC for the security group.
     */
    vpcId: VpcId;

    /**
     * The ID of the AWS account that owns the security group.
     */
    ownerId: string;

    /**
     * The inbound rules associated with the security group.
     */
    ingressRules?: Array<{
      securityGroupRuleId: string;
      ipProtocol: string;
      fromPort?: number;
      toPort?: number;
      cidrIpv4?: string;
      cidrIpv6?: string;
      referencedGroupId?: string;
      prefixListId?: string;
      description?: string;
      isEgress: false;
    }>;

    /**
     * The outbound rules associated with the security group.
     */
    egressRules?: Array<{
      securityGroupRuleId: string;
      ipProtocol: string;
      fromPort?: number;
      toPort?: number;
      cidrIpv4?: string;
      cidrIpv6?: string;
      referencedGroupId?: string;
      prefixListId?: string;
      description?: string;
      isEgress: true;
    }>;
  },
  never,
  Providers
> {}
/**
 * An EC2 security group — a stateful virtual firewall that controls inbound
 * (`ingress`) and outbound (`egress`) traffic for resources in a VPC. Rules can
 * allow traffic from CIDR ranges, IPv6 ranges, managed prefix lists, or other
 * security groups. Because it is stateful, return traffic for an allowed
 * connection is permitted automatically regardless of the opposite-direction
 * rules.
 *
 * If no `egress` rules are specified, all outbound traffic is allowed by
 * default. Changing the `vpcId` or `groupName` replaces the security group.
 *
 * @resource
 * @section Creating a Security Group
 * Every security group belongs to a VPC. `groupName` and `description` are
 * optional — alchemy generates a deterministic name and a default description
 * when they are omitted. Both the VPC and the name are immutable, so changing
 * either replaces the group.
 *
 * @example Empty Security Group
 * ```typescript
 * const sg = yield* AWS.EC2.SecurityGroup("AppSg", {
 *   vpcId: vpc.vpcId,
 * });
 * ```
 *
 * With no rules, this group denies all inbound traffic and (since no `egress` is
 * given) allows all outbound. It's a useful starting point you attach rules to
 * later, or a target other groups can reference.
 *
 * @example Named group with a description
 * ```typescript
 * const sg = yield* AWS.EC2.SecurityGroup("AppSg", {
 *   vpcId: vpc.vpcId,
 *   groupName: "app-tier",
 *   description: "Application tier security group",
 * });
 * ```
 *
 * Set an explicit `groupName` when you need a stable, human-readable identifier
 * (for example to reference the group by name elsewhere). The `description` is
 * shown in the EC2 console and cannot be changed after creation.
 *
 * @section Ingress Rules
 * Inbound rules are declared inline via `ingress`. Each rule specifies an
 * `ipProtocol` (`tcp`, `udp`, `icmp`, or `-1` for all), an optional port range
 * (`fromPort`/`toPort`), and a source — most commonly an IPv4 `cidrIpv4`.
 *
 * @example Allow HTTP and HTTPS from anywhere
 * ```typescript
 * const webSg = yield* AWS.EC2.SecurityGroup("WebSecurityGroup", {
 *   vpcId: vpc.vpcId,
 *   description: "Web tier security group",
 *   ingress: [
 *     {
 *       ipProtocol: "tcp",
 *       fromPort: 80,
 *       toPort: 80,
 *       cidrIpv4: "0.0.0.0/0",
 *       description: "Allow HTTP",
 *     },
 *     {
 *       ipProtocol: "tcp",
 *       fromPort: 443,
 *       toPort: 443,
 *       cidrIpv4: "0.0.0.0/0",
 *       description: "Allow HTTPS",
 *     },
 *   ],
 *   tags: { Name: "web-sg" },
 * });
 * ```
 *
 * Two rules open the standard web ports to the whole internet (`0.0.0.0/0`).
 * Setting `fromPort` equal to `toPort` opens a single port; widen the range to
 * open a contiguous span.
 *
 * @section Egress Rules
 * Outbound traffic is governed by `egress`. If you omit it entirely, the group
 * keeps AWS's default "allow all outbound" rule. Supplying `egress` replaces
 * that default with exactly the rules you list — so you must re-add an
 * allow-all rule if you still want unrestricted outbound.
 *
 * @example Restrict outbound to HTTPS only
 * ```typescript
 * const lockedSg = yield* AWS.EC2.SecurityGroup("LockedSg", {
 *   vpcId: vpc.vpcId,
 *   description: "Outbound restricted to HTTPS",
 *   egress: [
 *     {
 *       ipProtocol: "tcp",
 *       fromPort: 443,
 *       toPort: 443,
 *       cidrIpv4: "0.0.0.0/0",
 *       description: "Allow outbound HTTPS",
 *     },
 *   ],
 * });
 * ```
 *
 * This locks egress down to port 443 only — useful for instances that should
 * only call out to HTTPS APIs. Any other outbound traffic (DNS, NTP, etc.) would
 * need explicit rules added here.
 *
 * @section Referencing Other Groups
 * Instead of a CIDR, a rule's source can be another security group via
 * `referencedGroupId`. This is the idiomatic way to express tier-to-tier trust
 * ("the database accepts connections from anything in the app tier") without
 * pinning IP addresses.
 *
 * @example Database tier allowing traffic from the web tier
 * ```typescript
 * const dbSg = yield* AWS.EC2.SecurityGroup("DbSecurityGroup", {
 *   vpcId: vpc.vpcId,
 *   description: "Database tier security group",
 *   ingress: [
 *     {
 *       ipProtocol: "tcp",
 *       fromPort: 5432,
 *       toPort: 5432,
 *       referencedGroupId: webSg.groupId,
 *       description: "Allow PostgreSQL from web tier",
 *     },
 *   ],
 *   tags: { Name: "db-sg" },
 * });
 * ```
 *
 * Only instances in `webSg` can reach PostgreSQL on this group, regardless of
 * their IPs. As the web tier scales up and down, the rule keeps working without
 * any change.
 *
 * @section IPv6, Prefix Lists & ICMP
 * Beyond IPv4 CIDRs, a rule source can be an IPv6 range (`cidrIpv6`) or a managed
 * prefix list (`prefixListId`). For ICMP, set `ipProtocol: "icmp"` and use
 * `fromPort`/`toPort` as the ICMP type and code (`-1` for all).
 *
 * @example Mixed IPv6, prefix-list, and ICMP rules
 * ```typescript
 * const sg = yield* AWS.EC2.SecurityGroup("EdgeSg", {
 *   vpcId: vpc.vpcId,
 *   description: "Edge security group",
 *   ingress: [
 *     {
 *       ipProtocol: "tcp",
 *       fromPort: 443,
 *       toPort: 443,
 *       cidrIpv6: "::/0",
 *       description: "Allow HTTPS over IPv6",
 *     },
 *     {
 *       ipProtocol: "tcp",
 *       fromPort: 22,
 *       toPort: 22,
 *       prefixListId: "pl-0123456789abcdef0",
 *       description: "Allow SSH from corporate prefix list",
 *     },
 *     {
 *       ipProtocol: "icmp",
 *       fromPort: -1,
 *       toPort: -1,
 *       cidrIpv4: "10.0.0.0/16",
 *       description: "Allow all ICMP from within the VPC",
 *     },
 *   ],
 * });
 * ```
 *
 * Prefix lists let you reference a centrally-maintained set of CIDRs (e.g. your
 * corporate egress IPs) by ID, so the rule updates automatically as the list
 * changes. The ICMP rule with type/code `-1` permits ping and other ICMP within
 * the VPC.
 */
export const SecurityGroup = Resource<SecurityGroup>("AWS.EC2.SecurityGroup");

export const SecurityGroupProvider = () =>
  Provider.effect(
    SecurityGroup,
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

      const createGroupName = (id: string, name: string | undefined) =>
        Effect.gen(function* () {
          if (name) return name;
          return yield* createPhysicalName({ id, maxLength: 255 });
        });

      const describeSecurityGroup = (groupId: string) =>
        ec2.describeSecurityGroups({ GroupIds: [groupId] }).pipe(
          Effect.map((r) => r.SecurityGroups?.[0]),
          Effect.flatMap((sg) =>
            sg
              ? Effect.succeed(sg)
              : Effect.fail(new Error(`Security Group ${groupId} not found`)),
          ),
        );

      const describeSecurityGroupRules = (groupId: string) =>
        ec2.describeSecurityGroupRules
          .items({
            Filters: [{ Name: "group-id", Values: [groupId] }],
          })
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );

      const toAttrs = Effect.fn(function* (
        sg: ec2.SecurityGroup,
        rules: ec2.SecurityGroupRule[],
      ) {
        const { accountId, region } = yield* AWSEnvironment.current;
        return {
          groupId: sg.GroupId as SecurityGroupId,
          groupArn:
            `arn:aws:ec2:${region}:${accountId}:security-group/${sg.GroupId as SecurityGroupId}` as SecurityGroupArn,
          groupName: sg.GroupName!,
          description: sg.Description!,
          vpcId: sg.VpcId as VpcId,
          ownerId: sg.OwnerId!,
          ingressRules: rules
            .filter((r) => !r.IsEgress)
            .map((r) => ({
              securityGroupRuleId: r.SecurityGroupRuleId!,
              ipProtocol: r.IpProtocol!,
              fromPort: r.FromPort,
              toPort: r.ToPort,
              cidrIpv4: r.CidrIpv4,
              cidrIpv6: r.CidrIpv6,
              referencedGroupId: r.ReferencedGroupInfo?.GroupId,
              prefixListId: r.PrefixListId,
              description: r.Description,
              isEgress: false as const,
            })),
          egressRules: rules
            .filter((r) => r.IsEgress)
            .map((r) => ({
              securityGroupRuleId: r.SecurityGroupRuleId!,
              ipProtocol: r.IpProtocol!,
              fromPort: r.FromPort,
              toPort: r.ToPort,
              cidrIpv4: r.CidrIpv4,
              cidrIpv6: r.CidrIpv6,
              referencedGroupId: r.ReferencedGroupInfo?.GroupId,
              prefixListId: r.PrefixListId,
              description: r.Description,
              isEgress: true as const,
            })),
        } satisfies SecurityGroup["Attributes"];
      });

      const toIpPermission = (
        rule: SecurityGroupRuleData,
      ): ec2.IpPermission => ({
        IpProtocol: rule.ipProtocol,
        FromPort: rule.fromPort,
        ToPort: rule.toPort,
        IpRanges: rule.cidrIpv4
          ? [{ CidrIp: rule.cidrIpv4, Description: rule.description }]
          : undefined,
        Ipv6Ranges: rule.cidrIpv6
          ? [{ CidrIpv6: rule.cidrIpv6, Description: rule.description }]
          : undefined,
        UserIdGroupPairs: rule.referencedGroupId
          ? [
              {
                GroupId: rule.referencedGroupId as string,
                Description: rule.description,
              },
            ]
          : undefined,
        PrefixListIds: rule.prefixListId
          ? [
              {
                PrefixListId: rule.prefixListId as string,
                Description: rule.description,
              },
            ]
          : undefined,
      });

      return {
        stables: ["groupId", "groupArn", "ownerId"],

        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          const sg = yield* describeSecurityGroup(output.groupId);
          const rules = yield* describeSecurityGroupRules(output.groupId);
          return yield* toAttrs(sg, rules);
        }),

        list: () =>
          Effect.gen(function* () {
            const groups = yield* ec2.describeSecurityGroups.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.SecurityGroups ?? []).filter(
                    (sg): sg is ec2.SecurityGroup & { GroupId: string } =>
                      sg.GroupId != null &&
                      // Every VPC's `default` group is AWS-managed and can
                      // never be deleted (CannotDelete) — don't enumerate it.
                      sg.GroupName !== "default",
                  ),
                ),
              ),
            );
            return yield* Effect.forEach(
              groups,
              (sg) =>
                Effect.gen(function* () {
                  const rules = yield* describeSecurityGroupRules(sg.GroupId);
                  return yield* toAttrs(sg, rules);
                }),
              { concurrency: 10 },
            );
          }),

        diff: Effect.fn(function* ({ id, news, olds, output }) {
          if (!isResolved(news)) return;
          // VPC change requires replacement
          if (news.vpcId !== olds.vpcId) {
            return { action: "replace" };
          }

          // Group name change requires replacement
          const oldGroupName =
            output?.groupName ?? (yield* createGroupName(id, olds.groupName));
          // Auto-generated names are engine-owned: the deployed name stays
          // authoritative even if the generator would name this id differently
          // today. Only an explicit user-provided name can force a replace.
          const newGroupName = news.groupName ?? oldGroupName;
          if (newGroupName !== oldGroupName) {
            return { action: "replace" };
          }

          // Other changes can be updated in-place
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          // Prefer the deployed name: regenerating would target a different
          // resource if the generator's output for this id ever drifts. (An
          // explicit groupName change arrives here as a fresh replacement
          // instance with no output.)
          const groupName =
            output?.groupName ?? (yield* createGroupName(id, news.groupName));
          const desiredTags = yield* createTags(id, news.tags);

          // Observe — find the SG via cached id, else fall through to create.
          let sg: ec2.SecurityGroup | undefined;
          if (output?.groupId) {
            const lookup = yield* ec2
              .describeSecurityGroups({ GroupIds: [output.groupId] })
              .pipe(
                Effect.catchTag("InvalidGroup.NotFound", () =>
                  Effect.succeed({ SecurityGroups: [] }),
                ),
              );
            sg = lookup.SecurityGroups?.[0];
          }

          // Ensure — create the SG when missing.
          if (sg === undefined) {
            yield* session.note(`Creating Security Group: ${groupName}`);
            const result = yield* ec2
              .createSecurityGroup({
                GroupName: groupName,
                Description: news.description ?? "Managed by Alchemy",
                VpcId: news.vpcId as string,
                TagSpecifications: [
                  {
                    ResourceType: "security-group",
                    Tags: createTagsList(desiredTags),
                  },
                ],
                DryRun: false,
              })
              .pipe(
                // A just-created VPC can lag visibility to the SG service
                // (EC2 eventual consistency), so the create races with
                // `InvalidVpcID.NotFound`. Retry, bounded.
                Effect.retry({
                  while: (e) => e._tag === "InvalidVpcID.NotFound",
                  schedule: Schedule.max([
                    Schedule.fixed("1 second"),
                    Schedule.recurs(15),
                  ]),
                }),
              );
            const newGroupId = result.GroupId! as SecurityGroupId;
            yield* session.note(`Security Group created: ${newGroupId}`);
            sg = yield* describeSecurityGroup(newGroupId);
          }

          const groupId = sg.GroupId! as SecurityGroupId;

          // Sync tags — observed cloud tags vs desired.
          const currentTags = Object.fromEntries(
            (sg.Tags ?? []).map((t) => [t.Key!, t.Value!]),
          ) as Record<string, string>;
          const { removed: removedTags, upsert: upsertTags } = diffTags(
            currentTags,
            desiredTags,
          );
          if (removedTags.length > 0) {
            yield* ec2.deleteTags({
              Resources: [groupId],
              Tags: removedTags.map((key) => ({ Key: key })),
              DryRun: false,
            });
          }
          if (upsertTags.length > 0) {
            yield* ec2.createTags({
              Resources: [groupId],
              Tags: upsertTags,
              DryRun: false,
            });
          }

          // Sync ingress + egress rules — revoke whatever is observed and
          // reapply the desired set. SG rule diffing on this SDK is non-
          // trivial because each rule has many possible source shapes
          // (cidr/group ref/prefix list), so the simplest convergent strategy
          // is full-replace each reconcile. Default egress (-1, 0.0.0.0/0)
          // is restored when no explicit egress is desired.
          const currentRules = yield* describeSecurityGroupRules(groupId);
          const currentIngress = currentRules.filter((r) => !r.IsEgress);
          const currentEgress = currentRules.filter((r) => r.IsEgress);
          if (currentIngress.length > 0) {
            yield* ec2
              .revokeSecurityGroupIngress({
                GroupId: groupId,
                SecurityGroupRuleIds: currentIngress.map(
                  (r) => r.SecurityGroupRuleId!,
                ),
                DryRun: false,
              })
              .pipe(
                Effect.catchTag(
                  "InvalidPermission.NotFound",
                  () => Effect.void,
                ),
              );
          }
          if (currentEgress.length > 0) {
            yield* ec2
              .revokeSecurityGroupEgress({
                GroupId: groupId,
                SecurityGroupRuleIds: currentEgress.map(
                  (r) => r.SecurityGroupRuleId!,
                ),
                DryRun: false,
              })
              .pipe(
                Effect.catchTag(
                  "InvalidPermission.NotFound",
                  () => Effect.void,
                ),
              );
          }
          if (news.ingress && news.ingress.length > 0) {
            yield* ec2.authorizeSecurityGroupIngress({
              GroupId: groupId,
              IpPermissions: news.ingress.map(toIpPermission),
              DryRun: false,
            });
            yield* session.note(`Applied ${news.ingress.length} ingress rules`);
          }
          if (news.egress && news.egress.length > 0) {
            yield* ec2.authorizeSecurityGroupEgress({
              GroupId: groupId,
              IpPermissions: news.egress.map(toIpPermission),
              DryRun: false,
            });
            yield* session.note(`Applied ${news.egress.length} egress rules`);
          } else {
            yield* ec2.authorizeSecurityGroupEgress({
              GroupId: groupId,
              IpPermissions: [
                {
                  IpProtocol: "-1",
                  IpRanges: [{ CidrIp: "0.0.0.0/0" }],
                },
              ],
              DryRun: false,
            });
          }

          // Re-read final state.
          const finalSg = yield* describeSecurityGroup(groupId);
          const finalRules = yield* describeSecurityGroupRules(groupId);
          return yield* toAttrs(finalSg, finalRules);
        }),

        delete: Effect.fn(function* ({ output, session }) {
          const groupId = output.groupId;

          yield* session.note(`Deleting Security Group: ${groupId}`);

          // DependencyViolation means ENIs still reference the group — ALB,
          // ECS task, or VPC-attached Lambda ENIs release minutes after the
          // owning resource is deleted. Lambda Hyperplane ENIs are reaped
          // explicitly between attempts (they otherwise linger up to ~20
          // minutes and used to force a second `destroy` run).
          yield* retryWhileLingeringEnis(
            ec2
              .deleteSecurityGroup({
                GroupId: groupId,
                DryRun: false,
              })
              .pipe(
                Effect.catchTag("InvalidGroup.NotFound", () => Effect.void),
              ),
            {
              scope: { name: "group-id", value: groupId },
              isDependencyViolation: (e) =>
                e._tag === "DependencyViolation" ||
                (e._tag === "ValidationError" &&
                  (e.message?.includes("DependencyViolation") ?? false)),
              session,
            },
          );

          yield* session.note(`Security Group ${groupId} deleted`);
        }),
      };
    }),
  );
