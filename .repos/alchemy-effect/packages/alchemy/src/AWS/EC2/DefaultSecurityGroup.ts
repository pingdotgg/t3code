import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import type {
  SecurityGroupArn,
  SecurityGroupId,
  SecurityGroupRuleData,
} from "./SecurityGroup.ts";
import {
  declaredSecurityGroupRuleIds,
  expandSecurityGroupRules,
  observedSecurityGroupRuleKey,
  resolveSecurityGroupRules,
  securityGroupRuleKey,
} from "./SecurityGroupRule.ts";
import type { VpcId } from "./Vpc.ts";

class DefaultSecurityGroupNotFound extends Data.TaggedError(
  "DefaultSecurityGroupNotFound",
)<{ vpcId: VpcId }> {}

class InvalidDefaultSecurityGroupRules extends Data.TaggedError(
  "InvalidDefaultSecurityGroupRules",
)<{ message: string }> {}

class DefaultSecurityGroupRulesNotConverged extends Data.TaggedError(
  "DefaultSecurityGroupRulesNotConverged",
)<{ groupId: SecurityGroupId }> {}

/** An observed rule on the AWS-created default security group. */
export interface DefaultSecurityGroupRuleAttributes<IsEgress extends boolean> {
  /** The physical rule ID, retained when only its description changes. */
  securityGroupRuleId: string;
  /** The IP protocol name or number returned by AWS. */
  ipProtocol: string;
  /** The first port, or ICMP type. */
  fromPort?: number;
  /** The last port, or ICMP code. */
  toPort?: number;
  /** The canonical IPv4 source or destination CIDR. */
  cidrIpv4?: string;
  /** The canonical IPv6 source or destination CIDR. */
  cidrIpv6?: string;
  /** The source or destination security group ID. */
  referencedGroupId?: string;
  /** The source or destination managed prefix list ID. */
  prefixListId?: string;
  /** The description observed in AWS. */
  description?: string;
  /** Whether the rule controls outbound rather than inbound traffic. */
  isEgress: IsEgress;
}

/** Properties for a VPC's AWS-created `default` security group. */
export interface DefaultSecurityGroupProps {
  /** The VPC whose AWS-created `default` security group is managed. */
  vpcId: VpcId;

  /**
   * Desired inline inbound rules. Omitted, undefined, and [] all remove inline
   * inbound rules, including AWS's initial self-reference rule. Standalone
   * rules owned by current declarations in this stack and stage are preserved.
   * @default []
   */
  ingress?: SecurityGroupRuleData[];

  /**
   * Desired inline outbound rules. Omitted or undefined restores IPv4
   * allow-all outbound; [] removes inline outbound rules. Standalone rules
   * owned by current declarations in this stack and stage are preserved.
   * @default [{ ipProtocol: "-1", cidrIpv4: "0.0.0.0/0" }]
   */
  egress?: SecurityGroupRuleData[];
}

export interface DefaultSecurityGroup extends Resource<
  "AWS.EC2.DefaultSecurityGroup",
  DefaultSecurityGroupProps,
  {
    /** The ID of the AWS-created default security group. */
    groupId: SecurityGroupId;
    /** The ARN of the default security group. */
    groupArn: SecurityGroupArn;
    /** The AWS-assigned group name, always `default`. */
    groupName: string;
    /** The AWS-assigned description of the group. */
    description: string;
    /** The VPC that owns this default security group. */
    vpcId: VpcId;
    /** The AWS account that owns the group. */
    ownerId: string;
    /** The complete inbound rule set observed after reconciliation. */
    ingressRules: DefaultSecurityGroupRuleAttributes<false>[];
    /** The complete outbound rule set observed after reconciliation. */
    egressRules: DefaultSecurityGroupRuleAttributes<true>[];
  },
  never,
  Providers
> {}

/**
 * Declaratively manages the rules of the AWS-created `default` security group
 * in one VPC. AWS creates this group named `default` whenever it creates a
 * VPC; Alchemy looks it up by VPC ID and name, never creates it, and never
 * deletes it.
 *
 * Inline rules use the same defaults as `SecurityGroup`: omitted or undefined
 * `ingress` means no inline inbound rules, and omitted or undefined `egress`
 * means IPv4 allow-all outbound. Passing `[]` means no inline rules in that
 * direction, not unmanaged rules. Defaults apply on initial management,
 * property removal, adoption, and drift repair; AWS's initial self-ingress
 * rule is removed, not restored.
 *
 * Current standalone `SecurityGroupRule` declarations in the same stack and
 * stage retain ownership of their persisted physical rule IDs. Other rules
 * are removed even if they carry Alchemy tags. This resource manages rules,
 * not ownership of the AWS-created group; do not also manage this group with
 * a `SecurityGroup` resource or a second `DefaultSecurityGroup` manager.
 *
 * Removing this Alchemy resource leaves both the default group and its last
 * applied rules unchanged. Deleting its VPC removes the group as part of AWS's
 * VPC lifecycle.
 *
 * ### Default Inline Rules
 * **Example:** Remove AWS self-ingress and allow outbound IPv4
 * ```typescript
 * const vpc = yield* AWS.EC2.Vpc("Vpc", { cidrBlock: "10.0.0.0/16" });
 * const group = yield* AWS.EC2.DefaultSecurityGroup("DefaultSecurityGroup", {
 *   vpcId: vpc.vpcId,
 * });
 * ```
 *
 * **Example:** Explicit undefined has the same meaning as omission
 * ```typescript
 * yield* AWS.EC2.DefaultSecurityGroup("DefaultSecurityGroup", {
 *   vpcId: vpc.vpcId,
 *   ingress: undefined,
 *   egress: undefined,
 * });
 * ```
 *
 * ### Closing the Default Security Group
 * **Example:** Deny all traffic when there are no owned standalone rules
 * ```typescript
 * const vpc = yield* AWS.EC2.Vpc("Vpc", { cidrBlock: "10.0.0.0/16" });
 * yield* AWS.EC2.DefaultSecurityGroup("DefaultSecurityGroup", {
 *   vpcId: vpc.vpcId,
 *   ingress: [],
 *   egress: [],
 * });
 * ```
 *
 * ### Updating Rules
 * **Example:** Allow only internal HTTPS
 * ```typescript
 * yield* AWS.EC2.DefaultSecurityGroup("DefaultSecurityGroup", {
 *   vpcId: vpc.vpcId,
 *   ingress: [{
 *     ipProtocol: "tcp",
 *     fromPort: 443,
 *     toPort: 443,
 *     cidrIpv4: "10.0.0.0/16",
 *     description: "Internal HTTPS",
 *   }],
 *   egress: [],
 * });
 * ```
 *
 * Unchanged deployments repair missing rules and remove undeclared rules.
 * Updates leave unrelated rule IDs untouched; description changes update in
 * place, and removing a description clears it. Equivalent protocol names,
 * canonical CIDRs, rule order, and duplicate rules do not cause rule churn.
 * Duplicates with conflicting descriptions are rejected before any writes.
 * A rule with several source fields expands into one AWS rule per source.
 *
 * ### Restoring Default Inline Rules
 * **Example:** Remove explicit rule lists to restore defaults
 * ```diff lang="typescript"
 * yield* AWS.EC2.DefaultSecurityGroup("DefaultSecurityGroup", {
 *   vpcId: vpc.vpcId,
 * -  ingress: [],
 * -  egress: [],
 * });
 * ```
 *
 * This still denies inline inbound access but restores IPv4 allow-all outbound.
 * Removing these properties is different from removing the manager itself:
 * deleting the manager leaves its last-applied rules, with no baseline restore.
 *
 * ### Composing Standalone Rules
 * **Example:** Restrict outbound traffic with a standalone rule
 * ```typescript
 * const group = yield* AWS.EC2.DefaultSecurityGroup("DefaultSecurityGroup", {
 *   vpcId: vpc.vpcId,
 *   ingress: [],
 *   egress: [],
 * });
 * yield* AWS.EC2.SecurityGroupRule("HttpsEgress", {
 *   group: group,
 *   type: "egress",
 *   ipProtocol: "tcp",
 *   fromPort: 443,
 *   toPort: 443,
 *   cidrIpv4: "10.0.0.0/16",
 * });
 * ```
 *
 * Pass the whole manager as `group` so rule creation and updates wait for its
 * inline reconciliation. Only `group.groupId` is consumed by the rule provider;
 * unrelated manager attributes do not trigger rule updates. The stable ID is
 * still available for replacement planning. The ID-only `groupId` form cannot
 * enforce this ordering when the manager updates without changing its ID.
 * Standalone ingress composes the same way. Omitting `egress` instead would
 * retain the default allow-all rule alongside this standalone rule. A current
 * declaration and its persisted physical ID establish ownership, not cloud
 * tags. Removing a declaration ends that protection; its provider handles
 * deletion. Cross-stack or cross-stage rule ownership is unsupported.
 * Inline and standalone rules must have distinct identities. If a standalone
 * rule owns IPv4 allow-all egress, set `egress: []` to disable the inline default.
 *
 * ### Changing VPCs
 * **Example:** Manage another VPC's default group
 * ```typescript
 * yield* AWS.EC2.DefaultSecurityGroup("DefaultSecurityGroup", {
 *   vpcId: otherVpc.vpcId,
 *   ingress: [],
 *   egress: [],
 * });
 * ```
 *
 * Changing `vpcId` replaces the Alchemy resource, not either AWS-owned group,
 * including when the destination VPC is created or replaced in the same deploy.
 * The previous group's last-applied rules remain unchanged. Keep the old VPC
 * declared until replacement finishes, then remove it separately if desired.
 *
 * @resource
 */
export const DefaultSecurityGroup = Resource<DefaultSecurityGroup>(
  "AWS.EC2.DefaultSecurityGroup",
);

export const DefaultSecurityGroupProvider = () =>
  Provider.effect(
    DefaultSecurityGroup,
    Effect.gen(function* () {
      const describeGroup = (vpcId: VpcId) =>
        ec2
          .describeSecurityGroups({
            Filters: [
              { Name: "vpc-id", Values: [vpcId] },
              { Name: "group-name", Values: ["default"] },
            ],
          })
          .pipe(
            // Filtering by a deleted VPC returns an empty collection.
            Effect.map((result) => result.SecurityGroups?.[0]),
          );

      const describeRules = (groupId: SecurityGroupId) =>
        ec2.describeSecurityGroupRules
          .items({ Filters: [{ Name: "group-id", Values: [groupId] }] })
          .pipe(
            Stream.runCollect,
            Effect.map((rules) => Array.from(rules)),
          );

      const toAttrs = Effect.fn(function* (
        group: ec2.SecurityGroup,
        rules: ec2.SecurityGroupRule[],
      ) {
        const { accountId, region } = yield* AWSEnvironment.current;
        const toRule =
          <IsEgress extends boolean>(isEgress: IsEgress) =>
          (rule: ec2.SecurityGroupRule) => ({
            securityGroupRuleId: rule.SecurityGroupRuleId!,
            ipProtocol: rule.IpProtocol!,
            fromPort: rule.FromPort,
            toPort: rule.ToPort,
            cidrIpv4: rule.CidrIpv4,
            cidrIpv6: rule.CidrIpv6,
            referencedGroupId: rule.ReferencedGroupInfo?.GroupId,
            prefixListId: rule.PrefixListId,
            description: rule.Description,
            isEgress,
          });
        return {
          groupId: group.GroupId as SecurityGroupId,
          groupArn:
            `arn:aws:ec2:${region}:${accountId}:security-group/${group.GroupId}` as SecurityGroupArn,
          groupName: group.GroupName!,
          description: group.Description!,
          vpcId: group.VpcId as VpcId,
          ownerId: group.OwnerId!,
          ingressRules: rules
            .filter((rule) => !rule.IsEgress)
            .map(toRule(false)),
          egressRules: rules.filter((rule) => rule.IsEgress).map(toRule(true)),
        } satisfies DefaultSecurityGroup["Attributes"];
      });

      const toPermission = (rule: SecurityGroupRuleData): ec2.IpPermission => ({
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
          ? [{ GroupId: rule.referencedGroupId, Description: rule.description }]
          : undefined,
        PrefixListIds: rule.prefixListId
          ? [{ PrefixListId: rule.prefixListId, Description: rule.description }]
          : undefined,
      });

      const desiredRules = Effect.fn(function* (
        rules: SecurityGroupRuleData[],
      ) {
        if (
          rules.some(
            (rule) =>
              !rule.ipProtocol ||
              ![
                rule.cidrIpv4,
                rule.cidrIpv6,
                rule.referencedGroupId,
                rule.prefixListId,
              ].some(Boolean),
          )
        ) {
          return yield* new InvalidDefaultSecurityGroupRules({
            message: "Every rule must specify a protocol and a source.",
          });
        }
        const desired = new Map<string, SecurityGroupRuleData>();
        for (const rule of expandSecurityGroupRules(rules)) {
          const key = securityGroupRuleKey({ ...rule, description: undefined });
          const previous = desired.get(key);
          if (
            previous &&
            securityGroupRuleKey(previous) !== securityGroupRuleKey(rule)
          ) {
            return yield* new InvalidDefaultSecurityGroupRules({
              message: "Duplicate rules must have the same description.",
            });
          }
          desired.set(key, rule);
        }
        return desired;
      });

      const rulesMatch = (
        rules: ec2.SecurityGroupRule[],
        ingress: Map<string, SecurityGroupRuleData>,
        egress: Map<string, SecurityGroupRuleData>,
      ) =>
        [false, true].every((isEgress) => {
          const observed = rules.filter((rule) => !!rule.IsEgress === isEgress);
          const desired = [...(isEgress ? egress : ingress).values()];
          return (
            JSON.stringify(
              observed.map(observedSecurityGroupRuleKey).sort(),
            ) === JSON.stringify(desired.map(securityGroupRuleKey).sort())
          );
        });

      const syncRules = Effect.fn(function* (
        groupId: SecurityGroupId,
        isEgress: boolean,
        desired: Map<string, SecurityGroupRuleData>,
        observed: ec2.SecurityGroupRule[],
      ) {
        const current = new Map(
          observed.map((rule) => [
            observedSecurityGroupRuleKey({ ...rule, Description: undefined }),
            rule,
          ]),
        );
        for (const [key, rule] of current) {
          const wanted = desired.get(key);
          if (!wanted) {
            const request = {
              GroupId: groupId,
              SecurityGroupRuleIds: [rule.SecurityGroupRuleId!],
              DryRun: false,
            };
            yield* Effect.gen(function* () {
              if (isEgress) yield* ec2.revokeSecurityGroupEgress(request);
              else yield* ec2.revokeSecurityGroupIngress(request);
            }).pipe(
              Effect.catchTag(
                [
                  "InvalidPermission.NotFound",
                  "InvalidSecurityGroupRuleId.NotFound",
                ],
                () => Effect.void,
              ),
            );
          } else if ((wanted.description ?? "") !== (rule.Description ?? "")) {
            yield* ec2
              .modifySecurityGroupRules({
                GroupId: groupId,
                SecurityGroupRules: [
                  {
                    SecurityGroupRuleId: rule.SecurityGroupRuleId!,
                    SecurityGroupRule: {
                      IpProtocol: rule.IpProtocol,
                      FromPort: rule.FromPort,
                      ToPort: rule.ToPort,
                      CidrIpv4: rule.CidrIpv4,
                      CidrIpv6: rule.CidrIpv6,
                      ReferencedGroupId: rule.ReferencedGroupInfo?.GroupId,
                      PrefixListId: rule.PrefixListId,
                      Description: wanted.description ?? "",
                    },
                  },
                ],
              })
              .pipe(
                Effect.catchTag("InvalidSecurityGroupRuleId.NotFound", () =>
                  Effect.fail(
                    new DefaultSecurityGroupRulesNotConverged({ groupId }),
                  ),
                ),
              );
          }
        }
        for (const [key, rule] of desired) {
          if (current.has(key)) continue;
          const request = {
            GroupId: groupId,
            IpPermissions: [toPermission(rule)],
            DryRun: false,
          };
          yield* (
            isEgress
              ? ec2.authorizeSecurityGroupEgress(request)
              : ec2.authorizeSecurityGroupIngress(request)
          ).pipe(
            // Re-observe a racing authorization rather than assuming its description.
            Effect.catchTag("InvalidPermission.Duplicate", () =>
              Effect.fail(
                new DefaultSecurityGroupRulesNotConverged({ groupId }),
              ),
            ),
          );
        }
      });

      return {
        stables: ["groupId", "groupArn", "groupName", "ownerId"],

        read: Effect.fn(function* ({ olds, output }) {
          const vpcId = output?.vpcId ?? olds?.vpcId;
          if (!vpcId) return undefined;
          const group = yield* describeGroup(vpcId);
          if (!group?.GroupId) return undefined;
          return yield* toAttrs(
            group,
            yield* describeRules(group.GroupId as SecurityGroupId),
          );
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          // An unresolved VPC must not expose the previous group's stable identity.
          if (
            !("vpcId" in news) ||
            !isResolved(news.vpcId) ||
            news.vpcId !== olds.vpcId
          ) {
            return { action: "replace" };
          }
          if (!isResolved(news.ingress) || !isResolved(news.egress)) return;
          const ingress = yield* desiredRules(
            resolveSecurityGroupRules(news.ingress, false),
          );
          const egress = yield* desiredRules(
            resolveSecurityGroupRules(news.egress, true),
          );
          const group = yield* describeGroup(news.vpcId);
          if (!group?.GroupId) return { action: "update", stables: [] };
          const groupId = group.GroupId as SecurityGroupId;
          const owned = yield* declaredSecurityGroupRuleIds(groupId);
          const observed = (yield* describeRules(groupId)).filter(
            (rule) => !owned.has(rule.SecurityGroupRuleId!),
          );
          if (!rulesMatch(observed, ingress, egress))
            return { action: "update" };
        }),

        reconcile: Effect.fn(function* ({ news, session }) {
          // Validate both directions before changing either one.
          const ingress = yield* desiredRules(
            resolveSecurityGroupRules(news.ingress, false),
          );
          const egress = yield* desiredRules(
            resolveSecurityGroupRules(news.egress, true),
          );
          const group = yield* describeGroup(news.vpcId).pipe(
            Effect.flatMap((group) =>
              group?.GroupId
                ? Effect.succeed(group)
                : Effect.fail(
                    new DefaultSecurityGroupNotFound({ vpcId: news.vpcId }),
                  ),
            ),
            // AWS may expose the VPC before its default group is visible.
            Effect.retry({
              while: (error) => error._tag === "DefaultSecurityGroupNotFound",
              schedule: Schedule.spaced("1 second"),
              times: 8,
            }),
          );
          const groupId = group.GroupId as SecurityGroupId;
          const owned = yield* declaredSecurityGroupRuleIds(groupId);
          const inlineRules = (rules: ec2.SecurityGroupRule[]) =>
            rules.filter((rule) => !owned.has(rule.SecurityGroupRuleId!));
          const finalRules = yield* Effect.gen(function* () {
            const observed = yield* describeRules(groupId);
            const inline = inlineRules(observed);
            if (rulesMatch(inline, ingress, egress)) return observed;
            yield* syncRules(
              groupId,
              false,
              ingress,
              inline.filter((rule) => !rule.IsEgress),
            );
            yield* syncRules(
              groupId,
              true,
              egress,
              inline.filter((rule) => rule.IsEgress),
            );
            const final = yield* describeRules(groupId);
            if (!rulesMatch(inlineRules(final), ingress, egress)) {
              return yield* new DefaultSecurityGroupRulesNotConverged({
                groupId,
              });
            }
            return final;
          }).pipe(
            Effect.retry({
              while: (error) =>
                error._tag === "DefaultSecurityGroupRulesNotConverged",
              schedule: Schedule.spaced("1 second"),
              times: 8,
            }),
          );
          yield* session.note(`Reconciled default security group: ${groupId}`);
          return yield* toAttrs(group, finalRules);
        }),

        // AWS owns the default group. Intentionally leave it and its rules as-is.
        delete: () => Effect.void,
      };
    }),
  );
