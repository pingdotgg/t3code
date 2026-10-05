import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { deepEqual, isResolved } from "../../Diff.ts";
import * as Output from "../../Output.ts";
import { canonicalCidr } from "../../Utils/ip-address.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { Stack } from "../../Stack.ts";
import { State, isActionState } from "../../State/State.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, createTagsList, diffTags } from "../../Tags.ts";
import {
  getDefaultVpcDefaultSecurityGroupId,
  getDefaultVpcScope,
} from "./defaultVpcScope.ts";
import type {
  SecurityGroupId,
  SecurityGroupRuleData,
} from "./SecurityGroup.ts";

export type SecurityGroupRuleId<ID extends string = string> = `sgr-${ID}`;
export const SecurityGroupRuleId = <ID extends string>(
  id: ID,
): ID & SecurityGroupRuleId<ID> => `sgr-${id}` as ID & SecurityGroupRuleId<ID>;

export interface SecurityGroupRuleProps {
  /**
   * The SecurityGroup or DefaultSecurityGroup resource, or a { groupId } object.
   * Pass the whole resource to wait for its inline-rule reconciliation before
   * creating or updating this rule; an ID-only object does not retain that edge.
   * Only groupId is consumed; other attributes do not change this rule.
   * Specify exactly one of group or groupId.
   */
  group?: {
    /** The security group's physical ID. */
    groupId: SecurityGroupId;
  };

  /**
   * The ID of an existing security group. Retained for ID-only callers; use
   * group with the whole resource when composing inline and standalone rules.
   * Specify exactly one of group or groupId.
   */
  groupId?: SecurityGroupId;

  /**
   * Whether this is an ingress (inbound) or egress (outbound) rule.
   */
  type: "ingress" | "egress";

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
   * IPv4 CIDR range to allow.
   */
  cidrIpv4?: string;

  /**
   * IPv6 CIDR range to allow.
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

  /**
   * Tags to assign to the security group rule.
   */
  tags?: Record<string, string>;
}

export interface SecurityGroupRule extends Resource<
  "AWS.EC2.SecurityGroupRule",
  SecurityGroupRuleProps,
  {
    /**
     * The ID of the security group rule.
     */
    securityGroupRuleId: SecurityGroupRuleId;

    /**
     * The ID of the security group.
     */
    groupId: SecurityGroupId;

    /**
     * The ID of the AWS account that owns the security group.
     */
    groupOwnerId: string;

    /**
     * Whether this is an egress rule.
     */
    isEgress: boolean;

    /**
     * The IP protocol.
     */
    ipProtocol: string;

    /**
     * The start of the port range.
     */
    fromPort?: number;

    /**
     * The end of the port range.
     */
    toPort?: number;

    /**
     * The IPv4 CIDR range.
     */
    cidrIpv4?: string | undefined;

    /**
     * The IPv6 CIDR range.
     */
    cidrIpv6?: string | undefined;

    /**
     * The ID of the referenced security group.
     */
    referencedGroupId?: string;

    /**
     * The ID of the prefix list.
     */
    prefixListId?: string;

    /**
     * The description.
     */
    description?: string | undefined;
  },
  never,
  Providers
> {}
/**
 * A single ingress or egress rule attached to an existing security group,
 * managed as a standalone resource. Use this when you want to manage a
 * security group's rules independently of its inline rules, or to add rules
 * to a group not managed by an Alchemy SecurityGroup resource.
 *
 * Declare the group and rule in the same stack and stage, passing the whole
 * resource as `group` to order rule operations after inline reconciliation.
 * `groupId` remains supported for ID-only callers, but its stable value alone
 * does not order concurrent inline updates. Specify exactly one input form;
 * switching forms with the same physical ID does not replace the rule.
 * The group recognizes the current declaration and its persisted physical
 * rule ID, not cloud tags. Rules in another stack or stage are not protected
 * from the group's reconciliation;
 * cross-stack ownership is unsupported.
 *
 * Changes to protocol, ports, source, or `type` props replace the rule.
 * External edits to protocol, ports, source, description, and tags are repaired
 * on unchanged deployment. Description and tag prop changes update in place.
 *
 * ### Ingress vs Egress
 * The `type` field decides the direction: `"ingress"` for inbound rules and
 * `"egress"` for outbound. Everything else (protocol, ports, source) is shared
 * between the two directions.
 *
 * **Example:** Inbound HTTPS from anywhere
 * ```typescript
 * const httpsRule = yield* AWS.EC2.SecurityGroupRule("HttpsIngress", {
 *   group: sg,
 *   type: "ingress",
 *   ipProtocol: "tcp",
 *   fromPort: 443,
 *   toPort: 443,
 *   cidrIpv4: "0.0.0.0/0",
 *   description: "Allow HTTPS",
 * });
 * ```
 *
 * Opens TCP 443 inbound from the entire internet on the target group. A single
 * port is expressed by setting `fromPort` and `toPort` to the same value.
 *
 * **Example:** Outbound to a database port
 * ```typescript
 * const egressRule = yield* AWS.EC2.SecurityGroupRule("DbEgress", {
 *   group: sg,
 *   type: "egress",
 *   ipProtocol: "tcp",
 *   fromPort: 5432,
 *   toPort: 5432,
 *   cidrIpv4: "10.0.0.0/16",
 *   description: "Allow PostgreSQL to the VPC",
 * });
 * ```
 *
 * This rule allows outbound PostgreSQL within the VPC CIDR. Set `egress: []`
 * on the parent group to remove its default allow-all-outbound rule; adding a
 * standalone egress rule does not remove other rules.
 *
 * ### Rule Sources
 * A rule's source (for ingress) or destination (for egress) is exactly one of:
 * an IPv4 CIDR (`cidrIpv4`), an IPv6 CIDR (`cidrIpv6`), another security group
 * (`referencedGroupId`), or a managed prefix list (`prefixListId`).
 *
 * **Example:** Allow traffic from another security group
 * ```typescript
 * const dbFromWeb = yield* AWS.EC2.SecurityGroupRule("DbFromWeb", {
 *   group: dbSg,
 *   type: "ingress",
 *   ipProtocol: "tcp",
 *   fromPort: 5432,
 *   toPort: 5432,
 *   referencedGroupId: webSg.groupId,
 *   description: "Allow PostgreSQL from web tier",
 * });
 * ```
 *
 * Referencing `webSg` rather than a CIDR means any instance in the web tier can
 * reach the database, even as the tier's IPs change. This is the preferred way
 * to wire trust between tiers.
 *
 * **Example:** Allow an IPv6 range
 * ```typescript
 * const ipv6Rule = yield* AWS.EC2.SecurityGroupRule("HttpsIpv6", {
 *   group: sg,
 *   type: "ingress",
 *   ipProtocol: "tcp",
 *   fromPort: 443,
 *   toPort: 443,
 *   cidrIpv6: "::/0",
 *   description: "Allow HTTPS over IPv6",
 * });
 * ```
 *
 * Use `cidrIpv6` for dual-stack workloads; `::/0` is the IPv6 equivalent of
 * `0.0.0.0/0`. IPv4 and IPv6 are separate rules — you'd pair this with a
 * `cidrIpv4` rule to cover both.
 *
 * **Example:** Allow from a managed prefix list
 * ```typescript
 * const sshRule = yield* AWS.EC2.SecurityGroupRule("SshFromCorp", {
 *   group: sg,
 *   type: "ingress",
 *   ipProtocol: "tcp",
 *   fromPort: 22,
 *   toPort: 22,
 *   prefixListId: "pl-0123456789abcdef0",
 *   description: "Allow SSH from the corporate prefix list",
 * });
 * ```
 *
 * A `prefixListId` references a centrally-managed set of CIDRs by ID, so the
 * rule's effective ranges update automatically whenever the prefix list does.
 *
 * ### Protocols & Ports
 * `ipProtocol` accepts `tcp`, `udp`, `icmp`/`icmpv6`, a protocol number, or `-1`
 * for all protocols. For ICMP, `fromPort` is the ICMP type and `toPort` is the
 * ICMP code, with `-1` meaning "all".
 *
 * **Example:** Allow all traffic from a trusted CIDR
 * ```typescript
 * const allRule = yield* AWS.EC2.SecurityGroupRule("AllFromVpc", {
 *   group: sg,
 *   type: "ingress",
 *   ipProtocol: "-1",
 *   cidrIpv4: "10.0.0.0/16",
 *   description: "Allow all protocols from within the VPC",
 * });
 * ```
 *
 * With `ipProtocol: "-1"`, ports are ignored and every protocol is permitted —
 * appropriate only for fully trusted sources such as your own VPC CIDR.
 *
 * **Example:** Allow ICMP echo (ping)
 * ```typescript
 * const icmpRule = yield* AWS.EC2.SecurityGroupRule("AllowPing", {
 *   group: sg,
 *   type: "ingress",
 *   ipProtocol: "icmp",
 *   fromPort: 8,
 *   toPort: 0,
 *   cidrIpv4: "10.0.0.0/16",
 *   description: "Allow ICMP echo request",
 * });
 * ```
 *
 * For ICMP the port fields carry the type and code: type `8` / code `0` is an
 * echo request (ping). Use `fromPort: -1, toPort: -1` to allow every ICMP
 * type/code instead.
 *
 * @resource
 */
export const SecurityGroupRule = Resource<SecurityGroupRule>(
  "AWS.EC2.SecurityGroupRule",
);

class InvalidSecurityGroupRuleGroup extends Data.TaggedError(
  "InvalidSecurityGroupRuleGroup",
)<{ message: string }> {}

const ruleGroupId = Effect.fn(function* (
  props: Pick<SecurityGroupRuleProps, "group" | "groupId">,
) {
  if ((props.group === undefined) === (props.groupId === undefined)) {
    return yield* new InvalidSecurityGroupRuleGroup({
      message: "Specify exactly one of group or groupId.",
    });
  }
  const groupId = props.group?.groupId ?? props.groupId;
  if (typeof groupId !== "string") {
    return yield* new InvalidSecurityGroupRuleGroup({
      message: "The group must provide a groupId.",
    });
  }
  return groupId;
});

class SecurityGroupRuleNotConverged extends Data.TaggedError(
  "SecurityGroupRuleNotConverged",
)<{
  ruleId: string;
}> {}

export const SecurityGroupRuleProvider = () =>
  Provider.effect(
    SecurityGroupRule,
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

      const describeRule = (ruleId: string) =>
        ec2.describeSecurityGroupRules({ SecurityGroupRuleIds: [ruleId] }).pipe(
          Effect.map((r) => r.SecurityGroupRules?.[0]),
          Effect.flatMap((rule) =>
            rule
              ? Effect.succeed(rule)
              : Effect.fail(
                  new Error(`Security Group Rule ${ruleId} not found`),
                ),
          ),
        );

      const toAttrs = (
        rule: Awaited<
          ReturnType<
            typeof describeRule extends (
              ...args: any
            ) => Effect.Effect<infer R, any, any>
              ? () => Promise<R>
              : never
          >
        >,
      ): SecurityGroupRule["Attributes"] => ({
        securityGroupRuleId: rule.SecurityGroupRuleId as SecurityGroupRuleId,
        groupId: rule.GroupId as SecurityGroupId,
        groupOwnerId: rule.GroupOwnerId!,
        isEgress: rule.IsEgress as boolean,
        ipProtocol: rule.IpProtocol!,
        fromPort: rule.FromPort,
        toPort: rule.ToPort,
        cidrIpv4: rule.CidrIpv4,
        cidrIpv6: rule.CidrIpv6,
        referencedGroupId: rule.ReferencedGroupInfo?.GroupId,
        prefixListId: rule.PrefixListId,
        description: rule.Description,
      });

      const tagsMatch = (
        rule: ec2.SecurityGroupRule,
        tags: Record<string, string>,
      ) => {
        const { removed, upsert } = diffTags(
          Object.fromEntries(
            (rule.Tags ?? []).map((tag) => [tag.Key!, tag.Value!]),
          ),
          tags,
        );
        return removed.length === 0 && upsert.length === 0;
      };

      return {
        stables: ["securityGroupRuleId", "groupOwnerId"],

        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          return yield* describeRule(output.securityGroupRuleId).pipe(
            Effect.map(toAttrs),
            Effect.catchTag("InvalidSecurityGroupRuleId.NotFound", () =>
              Effect.succeed(undefined),
            ),
          );
        }),

        // Account/region-scoped: every rule is enumerable via
        // describeSecurityGroupRules with no filter. Paginate exhaustively.
        list: () =>
          Effect.gen(function* () {
            // Rules on the default VPC's "default" security group are
            // furniture AWS provisions with the default VPC; never
            // census/nuke them. Rules on user-created groups inside the
            // default VPC are still listed.
            const defaultVpc = yield* getDefaultVpcScope;
            const defaultSgId = yield* getDefaultVpcDefaultSecurityGroupId(
              defaultVpc.vpcId,
            );
            return yield* ec2.describeSecurityGroupRules.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.SecurityGroupRules ?? [])
                    .filter(
                      (
                        rule,
                      ): rule is ec2.SecurityGroupRule & {
                        SecurityGroupRuleId: string;
                      } => rule.SecurityGroupRuleId != null,
                    )
                    .filter(
                      (rule) =>
                        defaultSgId === undefined ||
                        rule.GroupId !== defaultSgId,
                    )
                    .map((rule) => toAttrs(rule)),
                ),
              ),
            );
          }),

        diff: Effect.fn(function* ({ id, news, olds, output }) {
          if (!("type" in news)) return;
          const { group, groupId, ...rule } = news;
          if ((group === undefined) === (groupId === undefined)) {
            return yield* new InvalidSecurityGroupRuleGroup({
              message: "Specify exactly one of group or groupId.",
            });
          }
          // Updating groups expose stable IDs; creating/replacing groups do not.
          if (!isResolved(group)) return { action: "replace" };
          const target = group?.groupId ?? groupId;
          if (!isResolved(target)) return { action: "replace" };
          const desiredGroupId = yield* ruleGroupId({ groupId: target });
          const oldGroupId =
            olds.group?.groupId ?? olds.groupId ?? output?.groupId;
          if (desiredGroupId !== oldGroupId) return { action: "replace" };
          for (const key of [
            "type",
            "ipProtocol",
            "fromPort",
            "toPort",
            "cidrIpv4",
            "cidrIpv6",
            "referencedGroupId",
            "prefixListId",
          ] as const) {
            if (rule[key] !== olds[key]) {
              return { action: "replace" };
            }
          }
          if (
            !isResolved<Omit<SecurityGroupRuleProps, "group" | "groupId">>(rule)
          )
            return;
          const desired = { ...rule, groupId: desiredGroupId };
          const { group: _group, groupId: _groupId, ...oldRule } = olds;
          if (output) {
            const observed = yield* describeRule(
              output.securityGroupRuleId,
            ).pipe(
              Effect.catchTag("InvalidSecurityGroupRuleId.NotFound", () =>
                Effect.succeed(undefined),
              ),
            );
            if (!observed) {
              return { action: "update", stables: ["groupOwnerId"] };
            }
            if (
              observed.GroupId !== desiredGroupId ||
              observed.IsEgress !== (rule.type === "egress")
            ) {
              return { action: "replace" };
            }
            if (
              observedSecurityGroupRuleKey(observed) !==
                securityGroupRuleKey(rule) ||
              !tagsMatch(observed, yield* createTags(id, rule.tags))
            ) {
              return { action: "update" };
            }
            // Ignore only the input form and unconsumed parent attributes.
            if (deepEqual({ ...oldRule, groupId: oldGroupId }, desired)) {
              return { action: "noop" };
            }
          }
          return { action: "update" };
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const groupId = yield* ruleGroupId(news);
          const desiredTags = yield* createTags(id, news.tags);

          const ipPermission = {
            IpProtocol: news.ipProtocol,
            FromPort: news.fromPort,
            ToPort: news.toPort,
            IpRanges: news.cidrIpv4
              ? [{ CidrIp: news.cidrIpv4, Description: news.description }]
              : undefined,
            Ipv6Ranges: news.cidrIpv6
              ? [{ CidrIpv6: news.cidrIpv6, Description: news.description }]
              : undefined,
            UserIdGroupPairs: news.referencedGroupId
              ? [
                  {
                    GroupId: news.referencedGroupId as string,
                    Description: news.description,
                  },
                ]
              : undefined,
            PrefixListIds: news.prefixListId
              ? [
                  {
                    PrefixListId: news.prefixListId as string,
                    Description: news.description,
                  },
                ]
              : undefined,
          };

          // Observe — find the rule via cached id, else fall through to
          // create. SG rule identity is the SecurityGroupRuleId.
          let observed: ec2.SecurityGroupRule | undefined;
          if (output?.securityGroupRuleId) {
            const lookup = yield* ec2
              .describeSecurityGroupRules({
                SecurityGroupRuleIds: [output.securityGroupRuleId],
              })
              .pipe(
                Effect.catchTag("InvalidSecurityGroupRuleId.NotFound", () =>
                  Effect.succeed({ SecurityGroupRules: [] }),
                ),
              );
            observed = lookup.SecurityGroupRules?.[0];
          }

          // Ensure — Authorize{Ingress,Egress} when missing.
          if (observed === undefined) {
            yield* session.note("Creating Security Group Rule...");
            const tagSpec = [
              {
                ResourceType: "security-group-rule" as const,
                Tags: createTagsList(desiredTags),
              },
            ];
            const result =
              news.type === "ingress"
                ? yield* ec2.authorizeSecurityGroupIngress({
                    GroupId: groupId,
                    IpPermissions: [ipPermission],
                    TagSpecifications: tagSpec,
                    DryRun: false,
                  })
                : yield* ec2.authorizeSecurityGroupEgress({
                    GroupId: groupId,
                    IpPermissions: [ipPermission],
                    TagSpecifications: tagSpec,
                    DryRun: false,
                  });
            const newRuleId =
              result.SecurityGroupRules?.[0]?.SecurityGroupRuleId!;
            yield* session.note(`Security Group Rule created: ${newRuleId}`);
            observed = yield* describeRule(newRuleId);
          }

          const ruleId = observed.SecurityGroupRuleId!;

          const desiredKey = securityGroupRuleKey(news);
          if (observedSecurityGroupRuleKey(observed) !== desiredKey) {
            yield* ec2.modifySecurityGroupRules({
              GroupId: groupId,
              SecurityGroupRules: [
                {
                  SecurityGroupRuleId: ruleId,
                  SecurityGroupRule: {
                    IpProtocol: news.ipProtocol,
                    FromPort: news.fromPort,
                    ToPort: news.toPort,
                    CidrIpv4: canonicalCidr(news.cidrIpv4),
                    CidrIpv6: canonicalCidr(news.cidrIpv6),
                    ReferencedGroupId: news.referencedGroupId as
                      | string
                      | undefined,
                    PrefixListId: news.prefixListId as string | undefined,
                    Description: news.description ?? "",
                  },
                },
              ],
            });
          }

          // Sync tags — observed cloud tags vs desired.
          const currentTags = Object.fromEntries(
            (observed.Tags ?? []).map((t) => [t.Key!, t.Value!]),
          ) as Record<string, string>;
          const { removed, upsert } = diffTags(currentTags, desiredTags);
          if (removed.length > 0) {
            yield* ec2.deleteTags({
              Resources: [ruleId],
              Tags: removed.map((key) => ({ Key: key })),
              DryRun: false,
            });
          }
          if (upsert.length > 0) {
            yield* ec2.createTags({
              Resources: [ruleId],
              Tags: upsert,
              DryRun: false,
            });
          }

          const matches = (rule: ec2.SecurityGroupRule) =>
            observedSecurityGroupRuleKey(rule) === desiredKey &&
            tagsMatch(rule, desiredTags);
          const final = yield* describeRule(ruleId).pipe(
            Effect.repeat({
              until: matches,
              schedule: Schedule.spaced("1 second"),
              times: 8,
            }),
          );
          if (!matches(final)) {
            return yield* Effect.fail(
              new SecurityGroupRuleNotConverged({ ruleId }),
            );
          }
          return toAttrs(final);
        }),

        delete: Effect.fn(function* ({ olds, output, session }) {
          const ruleId = output.securityGroupRuleId;
          const groupId = (output.groupId ??
            olds?.group?.groupId ??
            olds?.groupId) as string;
          // Prefer the observed attribute (`isEgress`) — `olds` may be the
          // listed Attributes (e.g. during nuke) rather than the Props shape,
          // in which case `olds.type` is undefined.
          const isEgress = output.isEgress ?? olds?.type !== "ingress";

          yield* session.note(`Deleting Security Group Rule: ${ruleId}`);

          // The whole security group may already be gone, taking its rules
          // with it (InvalidGroup.NotFound) — the rule is deleted either way.
          if (isEgress) {
            yield* ec2
              .revokeSecurityGroupEgress({
                GroupId: groupId,
                SecurityGroupRuleIds: [ruleId],
                DryRun: false,
              })
              .pipe(
                Effect.catchTag(
                  [
                    "InvalidPermission.NotFound",
                    "InvalidSecurityGroupRuleId.NotFound",
                  ],
                  () => Effect.void,
                ),
                Effect.catchTag("InvalidGroup.NotFound", () => Effect.void),
              );
          } else {
            yield* ec2
              .revokeSecurityGroupIngress({
                GroupId: groupId,
                SecurityGroupRuleIds: [ruleId],
                DryRun: false,
              })
              .pipe(
                Effect.catchTag(
                  [
                    "InvalidPermission.NotFound",
                    "InvalidSecurityGroupRuleId.NotFound",
                  ],
                  () => Effect.void,
                ),
                Effect.catchTag("InvalidGroup.NotFound", () => Effect.void),
              );
          }

          yield* session.note(`Security Group Rule ${ruleId} deleted`);
        }),
      };
    }),
  );

// Only current declarations with persisted physical ownership are delegated.
export const declaredSecurityGroupRuleIds = Effect.fn(function* (
  groupId: string,
) {
  const stack = yield* Stack;
  const state = yield* yield* State;
  const ids = new Set<string>();
  const resources = Object.values(stack.resources);
  const upstream: Record<string, object> = {};
  // flatMap can return a resource absent from the target's syntactic upstreams.
  for (const source of resources) {
    const sourceRow = yield* state.get({
      stack: stack.name,
      stage: stack.stage,
      fqn: source.FQN,
    });
    if (
      !sourceRow ||
      isActionState(sourceRow) ||
      sourceRow.resourceType !== source.Type
    )
      continue;
    const sourceAttrs =
      sourceRow.attr ?? ("old" in sourceRow ? sourceRow.old.attr : undefined);
    if (sourceAttrs) upstream[source.FQN] = sourceAttrs;
  }
  for (const resource of resources) {
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
      const { group, groupId: declaredId } = resource.Props;
      if ((group === undefined) === (declaredId === undefined)) continue;
      const target = group ?? declaredId;
      // Evaluate only the declared target, never infer ownership from cloud tags.
      const declared = yield* Output.evaluate(target, upstream).pipe(
        Effect.catchTag(["MissingSourceError", "InvalidReferenceError"], () =>
          Effect.succeed(undefined),
        ),
      );
      const declaredGroupId =
        typeof declared === "string" ? declared : declared?.groupId;
      if (declaredGroupId === groupId) ids.add(attrs.securityGroupRuleId);
    }
  }
  return ids;
});

export const resolveSecurityGroupRules = (
  rules: SecurityGroupRuleData[] | undefined,
  isEgress: boolean,
): SecurityGroupRuleData[] =>
  rules ?? (isEgress ? [{ ipProtocol: "-1", cidrIpv4: "0.0.0.0/0" }] : []);

const protocols: Record<string, string> = {
  "6": "tcp",
  "17": "udp",
  "1": "icmp",
  "58": "icmpv6",
};

export const securityGroupRuleKey = (rule: SecurityGroupRuleData) => {
  const protocol = protocols[rule.ipProtocol] ?? rule.ipProtocol;
  const hasPorts = ["tcp", "udp", "icmp", "icmpv6"].includes(protocol);
  return JSON.stringify({
    protocol,
    from: hasPorts
      ? (rule.fromPort ?? (protocol === "icmpv6" ? -1 : undefined))
      : undefined,
    to: hasPorts
      ? (rule.toPort ?? (protocol === "icmpv6" ? -1 : undefined))
      : undefined,
    ipv4: canonicalCidr(rule.cidrIpv4),
    ipv6: canonicalCidr(rule.cidrIpv6),
    group: rule.referencedGroupId,
    prefix: rule.prefixListId,
    description: rule.description ?? "",
  });
};

export const observedSecurityGroupRuleKey = (rule: ec2.SecurityGroupRule) =>
  securityGroupRuleKey({
    ipProtocol: rule.IpProtocol!,
    fromPort: rule.FromPort,
    toPort: rule.ToPort,
    cidrIpv4: rule.CidrIpv4,
    cidrIpv6: rule.CidrIpv6,
    referencedGroupId: rule.ReferencedGroupInfo?.GroupId as
      | SecurityGroupId
      | undefined,
    prefixListId: rule.PrefixListId,
    description: rule.Description,
  });

// EC2 creates one physical rule per source in an IpPermission.
export const expandSecurityGroupRules = (rules: SecurityGroupRuleData[]) =>
  rules.flatMap(
    ({ cidrIpv4, cidrIpv6, referencedGroupId, prefixListId, ...rule }) => [
      ...(cidrIpv4 === undefined ? [] : [{ ...rule, cidrIpv4 }]),
      ...(cidrIpv6 === undefined ? [] : [{ ...rule, cidrIpv6 }]),
      ...(referencedGroupId === undefined
        ? []
        : [{ ...rule, referencedGroupId }]),
      ...(prefixListId === undefined ? [] : [{ ...rule, prefixListId }]),
    ],
  );
