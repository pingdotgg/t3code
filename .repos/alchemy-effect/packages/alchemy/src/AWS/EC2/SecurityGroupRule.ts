import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, createTagsList, diffTags } from "../../Tags.ts";
import {
  getDefaultVpcDefaultSecurityGroupId,
  getDefaultVpcScope,
} from "./defaultVpcScope.ts";
import type { SecurityGroupId } from "./SecurityGroup.ts";

export type SecurityGroupRuleId<ID extends string = string> = `sgr-${ID}`;
export const SecurityGroupRuleId = <ID extends string>(
  id: ID,
): ID & SecurityGroupRuleId<ID> => `sgr-${id}` as ID & SecurityGroupRuleId<ID>;

export interface SecurityGroupRuleProps {
  /**
   * The ID of the security group.
   */
  groupId: SecurityGroupId;

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
 * security group's rules independently of the group itself — for example, to
 * add rules to a group owned by another stack, or to add rules without
 * triggering a full re-sync of the group's inline rule set.
 *
 * Most properties (protocol, ports, source, `type`) replace the rule when
 * changed; only `description` and `tags` are updated in place.
 *
 * @resource
 * @section Ingress vs Egress
 * The `type` field decides the direction: `"ingress"` for inbound rules and
 * `"egress"` for outbound. Everything else (protocol, ports, source) is shared
 * between the two directions.
 *
 * @example Inbound HTTPS from anywhere
 * ```typescript
 * const httpsRule = yield* AWS.EC2.SecurityGroupRule("HttpsIngress", {
 *   groupId: sg.groupId,
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
 * @example Outbound to a database port
 * ```typescript
 * const egressRule = yield* AWS.EC2.SecurityGroupRule("DbEgress", {
 *   groupId: sg.groupId,
 *   type: "egress",
 *   ipProtocol: "tcp",
 *   fromPort: 5432,
 *   toPort: 5432,
 *   cidrIpv4: "10.0.0.0/16",
 *   description: "Allow PostgreSQL to the VPC",
 * });
 * ```
 *
 * An egress rule restricts where the group's members may connect out to — here,
 * only PostgreSQL within the VPC CIDR. Adding any egress rule to a group
 * supersedes the default allow-all-outbound behavior.
 *
 * @section Rule Sources
 * A rule's source (for ingress) or destination (for egress) is exactly one of:
 * an IPv4 CIDR (`cidrIpv4`), an IPv6 CIDR (`cidrIpv6`), another security group
 * (`referencedGroupId`), or a managed prefix list (`prefixListId`).
 *
 * @example Allow traffic from another security group
 * ```typescript
 * const dbFromWeb = yield* AWS.EC2.SecurityGroupRule("DbFromWeb", {
 *   groupId: dbSg.groupId,
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
 * @example Allow an IPv6 range
 * ```typescript
 * const ipv6Rule = yield* AWS.EC2.SecurityGroupRule("HttpsIpv6", {
 *   groupId: sg.groupId,
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
 * @example Allow from a managed prefix list
 * ```typescript
 * const sshRule = yield* AWS.EC2.SecurityGroupRule("SshFromCorp", {
 *   groupId: sg.groupId,
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
 * @section Protocols & Ports
 * `ipProtocol` accepts `tcp`, `udp`, `icmp`/`icmpv6`, a protocol number, or `-1`
 * for all protocols. For ICMP, `fromPort` is the ICMP type and `toPort` is the
 * ICMP code, with `-1` meaning "all".
 *
 * @example Allow all traffic from a trusted CIDR
 * ```typescript
 * const allRule = yield* AWS.EC2.SecurityGroupRule("AllFromVpc", {
 *   groupId: sg.groupId,
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
 * @example Allow ICMP echo (ping)
 * ```typescript
 * const icmpRule = yield* AWS.EC2.SecurityGroupRule("AllowPing", {
 *   groupId: sg.groupId,
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
 */
export const SecurityGroupRule = Resource<SecurityGroupRule>(
  "AWS.EC2.SecurityGroupRule",
);

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

      return {
        stables: ["securityGroupRuleId", "groupOwnerId"],

        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          const rule = yield* describeRule(output.securityGroupRuleId);
          return toAttrs(rule);
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

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          // Most properties require replacement
          if (
            news.groupId !== olds.groupId ||
            news.type !== olds.type ||
            news.ipProtocol !== olds.ipProtocol ||
            news.fromPort !== olds.fromPort ||
            news.toPort !== olds.toPort ||
            news.cidrIpv4 !== olds.cidrIpv4 ||
            news.cidrIpv6 !== olds.cidrIpv6 ||
            news.referencedGroupId !== olds.referencedGroupId ||
            news.prefixListId !== olds.prefixListId
          ) {
            return { action: "replace" };
          }
          // Description and tags can be updated
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
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
                    GroupId: news.groupId as string,
                    IpPermissions: [ipPermission],
                    TagSpecifications: tagSpec,
                    DryRun: false,
                  })
                : yield* ec2.authorizeSecurityGroupEgress({
                    GroupId: news.groupId as string,
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

          // Sync description — modifySecurityGroupRules patches the
          // mutable description in place when it drifts.
          if ((observed.Description ?? undefined) !== news.description) {
            yield* ec2.modifySecurityGroupRules({
              GroupId: news.groupId as string,
              SecurityGroupRules: [
                {
                  SecurityGroupRuleId: ruleId,
                  SecurityGroupRule: {
                    IpProtocol: news.ipProtocol,
                    FromPort: news.fromPort,
                    ToPort: news.toPort,
                    CidrIpv4: news.cidrIpv4,
                    CidrIpv6: news.cidrIpv6,
                    ReferencedGroupId: news.referencedGroupId as
                      | string
                      | undefined,
                    PrefixListId: news.prefixListId as string | undefined,
                    Description: news.description,
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

          // Re-read final state.
          const final = yield* describeRule(ruleId);
          return toAttrs(final);
        }),

        delete: Effect.fn(function* ({ olds, output, session }) {
          const ruleId = output.securityGroupRuleId;
          const groupId = (output.groupId ?? olds?.groupId) as string;
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
                  "InvalidPermission.NotFound",
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
                  "InvalidPermission.NotFound",
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
