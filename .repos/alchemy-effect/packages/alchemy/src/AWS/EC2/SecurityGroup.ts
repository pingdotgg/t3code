import * as ec2 from "@distilled.cloud/aws/ec2";
import { Region } from "@distilled.cloud/aws/Region";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, createTagsList, diffTags } from "../../Tags.ts";
import type { AccountID } from "../Environment.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { RegionID } from "../Region.ts";
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
export const SecurityGroup = Resource<SecurityGroup>("AWS.EC2.SecurityGroup");

export const SecurityGroupProvider = () =>
  Provider.effect(
    SecurityGroup,
    Effect.gen(function* () {
      const region = yield* Region;
      const { accountId } = yield* AWSEnvironment;

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
        ec2.describeSecurityGroupRules({
          Filters: [{ Name: "group-id", Values: [groupId] }],
        });

      const toAttrs = (
        sg: ec2.SecurityGroup,
        rules: ec2.SecurityGroupRule[],
      ): SecurityGroup["Attributes"] => ({
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
          const rulesResult = yield* describeSecurityGroupRules(output.groupId);
          return toAttrs(sg, rulesResult.SecurityGroupRules ?? []);
        }),

        diff: Effect.fn(function* ({ id, news, olds, output }) {
          if (!isResolved(news)) return;
          // VPC change requires replacement
          if (news.vpcId !== olds.vpcId) {
            return { action: "replace" };
          }

          // Group name change requires replacement
          const newGroupName = yield* createGroupName(id, news.groupName);
          const oldGroupName = output?.groupName
            ? output.groupName
            : yield* createGroupName(id, olds.groupName);
          if (newGroupName !== oldGroupName) {
            return { action: "replace" };
          }

          // Other changes can be updated in-place
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const groupName = yield* createGroupName(id, news.groupName);
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
            const result = yield* ec2.createSecurityGroup({
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
            });
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
          const currentRulesResult = yield* describeSecurityGroupRules(groupId);
          const currentRules = currentRulesResult.SecurityGroupRules ?? [];
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
          return toAttrs(finalSg, finalRules.SecurityGroupRules ?? []);
        }),

        delete: Effect.fn(function* ({ output, session }) {
          const groupId = output.groupId;

          yield* session.note(`Deleting Security Group: ${groupId}`);

          yield* ec2
            .deleteSecurityGroup({
              GroupId: groupId,
              DryRun: false,
            })
            .pipe(
              Effect.catchTag("InvalidGroup.NotFound", () => Effect.void),
              // Retry on dependency violations (e.g., ENIs still using the security group)
              Effect.retry({
                while: (e) => {
                  return (
                    e._tag === "DependencyViolation" ||
                    (e._tag === "ValidationError" &&
                      e.message?.includes("DependencyViolation"))
                  );
                },
                schedule: Schedule.fixed(5000).pipe(
                  Schedule.both(Schedule.recurs(30)), // Up to ~2.5 minutes
                  Schedule.tapOutput(([, attempt]) =>
                    session.note(
                      `Waiting for dependencies to clear... (attempt ${attempt + 1})`,
                    ),
                  ),
                ),
              }),
            );

          yield* session.note(`Security Group ${groupId} deleted`);
        }),
      };
    }),
  );
