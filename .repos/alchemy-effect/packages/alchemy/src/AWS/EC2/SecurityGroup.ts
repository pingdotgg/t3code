import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import type { ScopedPlanStatusSession } from "../../Report.ts";
import { Resource } from "../../Resource.ts";
import { Stack } from "../../Stack.ts";
import { State, isActionState } from "../../State/State.ts";
import {
  createAlchemyTagFilters,
  createInternalTags,
  createTagsList,
  diffTags,
} from "../../Tags.ts";
import type { AccountID } from "../Environment.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";
import { retryWhileLingeringEnis } from "./LingeringEnis.ts";
import {
  expandSecurityGroupRules,
  observedSecurityGroupRuleKey,
  securityGroupRuleKey,
} from "./SecurityGroupRule.ts";
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
 * Inline rules are authoritative: undeclared rules are removed even if they
 * carry Alchemy tags. Standalone `SecurityGroupRule` resources declared in the
 * same stack and stage retain ownership of their persisted physical rule IDs;
 * their own providers manage their updates and deletion. Cloud tags alone do
 * not establish ownership.
 *
 * ### Creating a Security Group
 * Every security group belongs to a VPC. `groupName` and `description` are
 * optional — alchemy generates a deterministic name and a default description
 * when they are omitted. Both the VPC and the name are immutable, so changing
 * either replaces the group.
 *
 * **Example:** Empty Security Group
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
 * **Example:** Named group with a description
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
 * ### Ingress Rules
 * Inbound rules are declared inline via `ingress`. Each rule specifies an
 * `ipProtocol` (`tcp`, `udp`, `icmp`, or `-1` for all), an optional port range
 * (`fromPort`/`toPort`), and a source — most commonly an IPv4 `cidrIpv4`.
 *
 * **Example:** Allow HTTP and HTTPS from anywhere
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
 * ### Egress Rules
 * Outbound traffic is governed by `egress`. If you omit it entirely, the group
 * enforces the default "allow all outbound" rule. Supplying `egress` replaces
 * that default with exactly the rules you list — so you must re-add an
 * allow-all rule if you still want unrestricted outbound.
 *
 * **Example:** Restrict outbound to HTTPS only
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
 * ### Updating Inline Rules
 * Changing a rule description updates the existing physical rule in place.
 * Adding or removing a rule leaves unrelated rule IDs unchanged. Redeploying
 * unchanged code repairs missing rules and removes undeclared rules.
 *
 * **Example:** Change a description without replacing the rule
 * ```diff lang="typescript"
 * const sg = yield* AWS.EC2.SecurityGroup("AppSg", {
 *   vpcId: vpc.vpcId,
 *   ingress: [{
 *     ipProtocol: "tcp",
 *     fromPort: 443,
 *     toPort: 443,
 *     cidrIpv4: "10.0.0.0/16",
 * -    description: "HTTPS",
 * +    description: "Internal HTTPS",
 *   }],
 * });
 * ```
 *
 * Removing `description` resets it to an empty description without replacing
 * the rule.
 *
 * ### Restoring Default Rules
 * Omitting `ingress` restores no inbound rules. Omitting `egress` restores the
 * default IPv4 allow-all outbound rule; `egress: []` disables outbound traffic.
 * These defaults apply on creation, property removal, and drift repair.
 *
 * **Example:** Reset custom outbound rules to the default
 * ```diff lang="typescript"
 * const sg = yield* AWS.EC2.SecurityGroup("AppSg", {
 *   vpcId: vpc.vpcId,
 * -  egress: [{
 * -    ipProtocol: "tcp",
 * -    fromPort: 443,
 * -    toPort: 443,
 * -    cidrIpv4: "0.0.0.0/0",
 * -  }],
 * });
 * ```
 *
 * ### Composing Standalone Rules
 * Standalone rules must be declared in the same stack and stage as this group.
 * Pass the group's `groupId` output to order creation and updates. Ownership is
 * verified against each current declaration's persisted physical rule ID.
 * Removing a declaration ends that ownership; tags alone do not protect rules.
 * Cross-stack or cross-stage rule ownership is unsupported: this group removes
 * rules declared elsewhere when reconciling its authoritative configuration.
 *
 * **Example:** Add a standalone rule in the group's stack
 * ```typescript
 * yield* AWS.EC2.SecurityGroupRule("HttpsIngress", {
 *   groupId: sg.groupId,
 *   type: "ingress",
 *   ipProtocol: "tcp",
 *   fromPort: 443,
 *   toPort: 443,
 *   cidrIpv4: "10.0.0.0/16",
 * });
 * ```
 *
 * ### Referencing Other Groups
 * Instead of a CIDR, a rule's source can be another security group via
 * `referencedGroupId`. This is the idiomatic way to express tier-to-tier trust
 * ("the database accepts connections from anything in the app tier") without
 * pinning IP addresses.
 *
 * **Example:** Database tier allowing traffic from the web tier
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
 * ### IPv6, Prefix Lists & ICMP
 * Beyond IPv4 CIDRs, a rule source can be an IPv6 range (`cidrIpv6`) or a managed
 * prefix list (`prefixListId`). For ICMP, set `ipProtocol: "icmp"` and use
 * `fromPort`/`toPort` as the ICMP type and code (`-1` for all).
 *
 * **Example:** Mixed IPv6, prefix-list, and ICMP rules
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
 *
 * @resource
 */
export const SecurityGroup = Resource<SecurityGroup>("AWS.EC2.SecurityGroup");

class InvalidSecurityGroupRules extends Data.TaggedError(
  "InvalidSecurityGroupRules",
)<{
  groupId: string;
  message: string;
}> {}

class SecurityGroupRulesNotSettled extends Data.TaggedError(
  "SecurityGroupRulesNotSettled",
)<{
  groupId: string;
}> {}

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

      const findOwnedGroup = Effect.fn(function* (
        id: string,
        groupName: string,
        vpcId?: VpcId,
      ) {
        return (yield* ec2.describeSecurityGroups({
          Filters: [
            { Name: "group-name", Values: [groupName] },
            ...(vpcId ? [{ Name: "vpc-id", Values: [vpcId] }] : []),
            ...(yield* createAlchemyTagFilters(id)),
          ],
        })).SecurityGroups?.[0];
      });

      const describeSecurityGroupRules = (groupId: string) =>
        ec2.describeSecurityGroupRules
          .items({
            Filters: [{ Name: "group-id", Values: [groupId] }],
          })
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );

      const declaredRuleIds = Effect.fn(function* (groupId: string) {
        const stack = yield* Stack;
        const state = yield* yield* State;
        const ids = new Set<string>();
        for (const resource of Object.values(stack.resources)) {
          if (resource.Type !== "AWS.EC2.SecurityGroupRule" || !resource.Props)
            continue;
          const row = yield* state.get({
            stack: stack.name,
            stage: stack.stage,
            fqn: resource.FQN,
          });
          if (
            !row ||
            isActionState(row) ||
            row.resourceType !== "AWS.EC2.SecurityGroupRule"
          )
            continue;
          const attrs = row.attr ?? ("old" in row ? row.old.attr : undefined);
          if (
            attrs?.groupId === groupId &&
            typeof attrs.securityGroupRuleId === "string"
          ) {
            ids.add(attrs.securityGroupRuleId);
          }
        }
        return ids;
      });

      const desiredEgress = (
        props: SecurityGroupProps,
      ): SecurityGroupRuleData[] =>
        props.egress ?? [{ ipProtocol: "-1", cidrIpv4: "0.0.0.0/0" }];
      const rulesMatch = (
        observed: ec2.SecurityGroupRule[],
        desired: SecurityGroupRuleData[],
      ) =>
        JSON.stringify(observed.map(observedSecurityGroupRuleKey).sort()) ===
        JSON.stringify(
          expandSecurityGroupRules(desired).map(securityGroupRuleKey).sort(),
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

      const syncRules = Effect.fn(function* (
        groupId: SecurityGroupId,
        isEgress: boolean,
        desired: SecurityGroupRuleData[],
        observed: ec2.SecurityGroupRule[],
        session: ScopedPlanStatusSession,
      ) {
        if (
          desired.some((rule) =>
            [
              rule.cidrIpv4,
              rule.cidrIpv6,
              rule.referencedGroupId,
              rule.prefixListId,
            ].every((source) => !source),
          )
        ) {
          return yield* new InvalidSecurityGroupRules({
            groupId,
            message: "Inline rules must specify a source.",
          });
        }
        const desiredByKey = new Map<string, SecurityGroupRuleData>();
        for (const rule of expandSecurityGroupRules(desired)) {
          const key = securityGroupRuleKey({ ...rule, description: undefined });
          if (!rule.ipProtocol || desiredByKey.has(key)) {
            return yield* new InvalidSecurityGroupRules({
              groupId,
              message:
                "Inline rules must have a protocol, a source, and distinct identities.",
            });
          }
          desiredByKey.set(key, rule);
        }
        if (rulesMatch(observed, desired)) return;
        const current: Array<{
          key: string;
          id: string;
          rule: ec2.SecurityGroupRule;
        }> = [];
        for (const rule of observed) {
          const key = observedSecurityGroupRuleKey({
            ...rule,
            Description: undefined,
          });
          if (
            rule.IpProtocol === undefined ||
            rule.SecurityGroupRuleId === undefined
          ) {
            return yield* new InvalidSecurityGroupRules({
              groupId,
              message: "EC2 returned a rule without its identity or source.",
            });
          }
          current.push({ key, id: rule.SecurityGroupRuleId, rule });
        }
        const removed = current.filter(({ key }) => !desiredByKey.has(key));
        if (removed.length > 0) {
          const request = {
            GroupId: groupId,
            SecurityGroupRuleIds: removed.map(({ id }) => id),
            DryRun: false,
          };
          yield* isEgress
            ? ec2
                .revokeSecurityGroupEgress(request)
                .pipe(
                  Effect.catchTag(
                    [
                      "InvalidPermission.NotFound",
                      "InvalidSecurityGroupRuleId.NotFound",
                    ],
                    () => Effect.void,
                  ),
                )
            : ec2
                .revokeSecurityGroupIngress(request)
                .pipe(
                  Effect.catchTag(
                    [
                      "InvalidPermission.NotFound",
                      "InvalidSecurityGroupRuleId.NotFound",
                    ],
                    () => Effect.void,
                  ),
                );
        }
        const descriptions = current.flatMap(({ key, id, rule }) => {
          const desired = desiredByKey.get(key);
          return desired === undefined ||
            (desired.description ?? "") === (rule.Description ?? "")
            ? []
            : [
                {
                  SecurityGroupRuleId: id,
                  SecurityGroupRule: {
                    IpProtocol: rule.IpProtocol,
                    FromPort: rule.FromPort,
                    ToPort: rule.ToPort,
                    CidrIpv4: rule.CidrIpv4,
                    CidrIpv6: rule.CidrIpv6,
                    ReferencedGroupId: rule.ReferencedGroupInfo?.GroupId,
                    PrefixListId: rule.PrefixListId,
                    Description: desired.description ?? "",
                  },
                },
              ];
        });
        if (descriptions.length > 0) {
          yield* ec2.modifySecurityGroupRules({
            GroupId: groupId,
            SecurityGroupRules: descriptions,
          });
        }
        const added = [...desiredByKey]
          .filter(([key]) => !current.some((rule) => rule.key === key))
          .map(([, rule]) => rule);
        if (added.length > 0) {
          const authorize = isEgress
            ? ec2.authorizeSecurityGroupEgress
            : ec2.authorizeSecurityGroupIngress;
          yield* authorize({
            GroupId: groupId,
            IpPermissions: added.map(toIpPermission),
            DryRun: false,
          });
        }
        yield* session.note(
          `Reconciled ${isEgress ? "egress" : "ingress"} rules`,
        );
      });

      return {
        stables: ["groupId", "groupArn", "ownerId"],

        read: Effect.fn(function* ({ id, olds, output }) {
          const sg = output
            ? yield* describeSecurityGroup(output.groupId).pipe(
                Effect.catchTag("InvalidGroup.NotFound", () =>
                  Effect.succeed(undefined),
                ),
              )
            : yield* findOwnedGroup(
                id,
                yield* createGroupName(id, olds?.groupName),
                olds?.vpcId,
              );
          if (!sg?.GroupId) return undefined;
          const rules = yield* describeSecurityGroupRules(sg.GroupId);
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

          if (output) {
            const group = yield* describeSecurityGroup(output.groupId).pipe(
              Effect.catchTag("InvalidGroup.NotFound", () =>
                Effect.succeed(undefined),
              ),
            );
            if (group === undefined) return { action: "update", stables: [] };
            const owned = yield* declaredRuleIds(output.groupId);
            const observed = (yield* describeSecurityGroupRules(
              output.groupId,
            )).filter((rule) => !owned.has(rule.SecurityGroupRuleId!));
            if (
              !rulesMatch(
                observed.filter((rule) => !rule.IsEgress),
                news.ingress ?? [],
              ) ||
              !rulesMatch(
                observed.filter((rule) => rule.IsEgress),
                desiredEgress(news),
              )
            ) {
              return { action: "update" };
            }
          }
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

          if (sg === undefined) {
            sg = yield* findOwnedGroup(id, groupName, news.vpcId);
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
                  schedule: Schedule.fixed("1 second"),
                  times: 8,
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

          // Only current declarations with persisted physical ownership are delegated.
          const owned = yield* declaredRuleIds(groupId);
          const currentRules = yield* describeSecurityGroupRules(groupId);
          const currentIngress = currentRules.filter(
            (rule) => !rule.IsEgress && !owned.has(rule.SecurityGroupRuleId!),
          );
          const currentEgress = currentRules.filter(
            (rule) => rule.IsEgress && !owned.has(rule.SecurityGroupRuleId!),
          );
          yield* syncRules(
            groupId,
            false,
            news.ingress ?? [],
            currentIngress,
            session,
          );
          yield* syncRules(
            groupId,
            true,
            desiredEgress(news),
            currentEgress,
            session,
          );

          // Re-read final state.
          const finalSg = yield* describeSecurityGroup(groupId);
          const matches = (rules: ec2.SecurityGroupRule[]) => {
            const inline = rules.filter(
              (rule) => !owned.has(rule.SecurityGroupRuleId!),
            );
            return (
              rulesMatch(
                inline.filter((rule) => !rule.IsEgress),
                news.ingress ?? [],
              ) &&
              rulesMatch(
                inline.filter((rule) => rule.IsEgress),
                desiredEgress(news),
              )
            );
          };
          const finalRules = yield* describeSecurityGroupRules(groupId).pipe(
            Effect.repeat({
              until: matches,
              schedule: Schedule.spaced("1 second"),
              times: 8,
            }),
          );
          if (!matches(finalRules)) {
            return yield* Effect.fail(
              new SecurityGroupRulesNotSettled({ groupId }),
            );
          }
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
