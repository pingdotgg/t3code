import type * as EC2 from "@distilled.cloud/aws/ec2";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import type { NetworkAclId } from "./NetworkAcl.ts";

export interface NetworkAclEntryProps {
  /**
   * The ID of the network ACL.
   */
  networkAclId: NetworkAclId;
  /**
   * The rule number for the entry (1-32766).
   * Rules are evaluated in order from lowest to highest.
   */
  ruleNumber: number;
  /**
   * The protocol number.
   * A value of "-1" means all protocols.
   * Common values: 6 (TCP), 17 (UDP), 1 (ICMP)
   */
  protocol: string;
  /**
   * Whether to allow or deny the traffic that matches the rule.
   */
  ruleAction: EC2.RuleAction;
  /**
   * Whether this is an egress (outbound) rule.
   * @default false
   */
  egress?: boolean;
  /**
   * The IPv4 CIDR block.
   * Either cidrBlock or ipv6CidrBlock must be specified.
   */
  cidrBlock?: string;
  /**
   * The IPv6 CIDR block.
   * Either cidrBlock or ipv6CidrBlock must be specified.
   */
  ipv6CidrBlock?: string;
  /**
   * ICMP type and code. Required if protocol is 1 (ICMP) or 58 (ICMPv6).
   */
  icmpTypeCode?: {
    /** The ICMP code. Use -1 to specify all codes. */
    code?: number;
    /** The ICMP type. Use -1 to specify all types. */
    type?: number;
  };
  /**
   * The port range for TCP/UDP protocols.
   */
  portRange?: {
    /** The first port in the range. */
    from?: number;
    /** The last port in the range. */
    to?: number;
  };
}

export interface NetworkAclEntry extends Resource<
  "AWS.EC2.NetworkAclEntry",
  NetworkAclEntryProps,
  {
    /** The ID of the network ACL. */
    networkAclId: NetworkAclId;
    /** The rule number. */
    ruleNumber: number;
    /** Whether this is an egress rule. */
    egress: boolean;
    /** The protocol. */
    protocol: string;
    /** The rule action (allow or deny). */
    ruleAction: EC2.RuleAction;
    /** The IPv4 CIDR block. */
    cidrBlock?: string;
    /** The IPv6 CIDR block. */
    ipv6CidrBlock?: string;
    /** The ICMP type and code. */
    icmpTypeCode?: {
      code?: number;
      type?: number;
    };
    /** The port range. */
    portRange?: {
      from?: number;
      to?: number;
    };
  },
  never,
  Providers
> {}
/**
 * A single rule in a `NetworkAcl` — a numbered, stateless allow/deny entry that
 * matches traffic by protocol, CIDR (IPv4 or IPv6), and, for TCP/UDP, a port
 * range.
 *
 * Each entry is identified by its `(networkAclId, ruleNumber, egress)` triple,
 * and changing any of those three replaces the entry. Rules are evaluated from
 * the lowest `ruleNumber` upward and the first match wins, so leave gaps between
 * numbers to make room for future rules. Because NACLs are stateless, always add
 * a matching ephemeral-port rule for return traffic.
 *
 * @resource
 * @section Inbound Rules
 * Inbound rules (`egress: false`) match traffic entering the subnet. A common
 * pattern is to allow trusted source ranges plus the ephemeral ports needed for
 * return traffic.
 * @example Allow Inbound Traffic from the VPC CIDR
 * ```typescript
 * const allowVpc = yield* AWS.EC2.NetworkAclEntry("AllowVpc", {
 *   networkAclId: acl.networkAclId,
 *   ruleNumber: 100,
 *   protocol: "-1",
 *   ruleAction: "allow",
 *   egress: false,
 *   cidrBlock: "10.0.0.0/16",
 * });
 * ```
 * `protocol: "-1"` matches all protocols and `cidrBlock` scopes the rule to the
 * VPC's IPv4 range; the low `ruleNumber` (100) makes it take precedence over
 * higher-numbered rules.
 *
 * @example Allow Inbound Ephemeral Ports (NAT Return Traffic)
 * ```typescript
 * const allowEphemeral = yield* AWS.EC2.NetworkAclEntry("AllowEphemeral", {
 *   networkAclId: acl.networkAclId,
 *   ruleNumber: 200,
 *   protocol: "6",
 *   ruleAction: "allow",
 *   egress: false,
 *   cidrBlock: "0.0.0.0/0",
 *   portRange: { from: 1024, to: 65535 },
 * });
 * ```
 * Because the ACL is stateless, responses to outbound requests arrive on
 * ephemeral ports and need their own inbound rule; `protocol: "6"` is TCP and
 * `portRange` restricts the match to the ephemeral port range.
 *
 * @example Deny a Specific IPv6 Range
 * ```typescript
 * const denyRange = yield* AWS.EC2.NetworkAclEntry("DenyBadActor", {
 *   networkAclId: acl.networkAclId,
 *   ruleNumber: 50,
 *   protocol: "-1",
 *   ruleAction: "deny",
 *   egress: false,
 *   ipv6CidrBlock: "2001:db8:1234::/48",
 * });
 * ```
 * `ruleAction: "deny"` with a very low `ruleNumber` blocks an IPv6 range before
 * any allow rule can match it; use `ipv6CidrBlock` instead of `cidrBlock` to
 * target IPv6 traffic.
 *
 * @section Outbound Rules
 * Outbound rules (`egress: true`) match traffic leaving the subnet and are
 * numbered in their own sequence, independent of the inbound rules.
 * @example Allow All Outbound Traffic
 * ```typescript
 * const allowEgress = yield* AWS.EC2.NetworkAclEntry("AllowEgress", {
 *   networkAclId: acl.networkAclId,
 *   ruleNumber: 100,
 *   protocol: "-1",
 *   ruleAction: "allow",
 *   egress: true,
 *   cidrBlock: "0.0.0.0/0",
 * });
 * ```
 * Setting `egress: true` makes this an outbound rule; allowing all protocols to
 * `0.0.0.0/0` is typical when you want the subnet to initiate connections freely.
 *
 * @section ICMP Rules
 * @example Allow Inbound ICMP Echo (Ping)
 * ```typescript
 * const allowPing = yield* AWS.EC2.NetworkAclEntry("AllowPing", {
 *   networkAclId: acl.networkAclId,
 *   ruleNumber: 300,
 *   protocol: "1",
 *   ruleAction: "allow",
 *   egress: false,
 *   cidrBlock: "10.0.0.0/16",
 *   icmpTypeCode: { type: 8, code: -1 },
 * });
 * ```
 * ICMP (`protocol: "1"`) has no ports, so `icmpTypeCode` selects the message
 * type instead — type 8 is echo request and `code: -1` matches all codes.
 */
export const NetworkAclEntry = Resource<NetworkAclEntry>(
  "AWS.EC2.NetworkAclEntry",
);

export const NetworkAclEntryProvider = () =>
  Provider.effect(
    NetworkAclEntry,
    Effect.gen(function* () {
      const findEntry = (
        networkAclId: string,
        ruleNumber: number,
        egress: boolean,
      ) =>
        ec2.describeNetworkAcls({ NetworkAclIds: [networkAclId] }).pipe(
          Effect.catchTag("InvalidNetworkAclID.NotFound", () =>
            Effect.succeed({ NetworkAcls: [] }),
          ),
          Effect.map((r) =>
            r.NetworkAcls?.[0]?.Entries?.find(
              (e) => e.RuleNumber === ruleNumber && e.Egress === egress,
            ),
          ),
        );

      const toAttrs = (
        props: NetworkAclEntryProps,
        entry: NonNullable<
          Awaited<
            ReturnType<
              typeof findEntry extends (
                ...args: any
              ) => Effect.Effect<infer R, any, any>
                ? () => Promise<R>
                : never
            >
          >
        >,
      ) => ({
        networkAclId: props.networkAclId as NetworkAclId,
        ruleNumber: entry.RuleNumber!,
        egress: entry.Egress!,
        protocol: entry.Protocol!,
        ruleAction: entry.RuleAction!,
        cidrBlock: entry.CidrBlock,
        ipv6CidrBlock: entry.Ipv6CidrBlock,
        icmpTypeCode: entry.IcmpTypeCode
          ? {
              code: entry.IcmpTypeCode.Code,
              type: entry.IcmpTypeCode.Type,
            }
          : undefined,
        portRange: entry.PortRange
          ? {
              from: entry.PortRange.From,
              to: entry.PortRange.To,
            }
          : undefined,
      });

      return {
        stables: [],

        // Entries are embedded in describeNetworkAcls (each NetworkAcl owns an
        // Entries[]). Flatten every ACL's entries into the full Attributes
        // shape. Skip the AWS-managed default-deny rule (32767) since it is not
        // a user-manageable entry.
        list: () =>
          ec2.describeNetworkAcls.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.NetworkAcls ?? [])
                  // Entries on AWS's default ACL are service-managed account
                  // baseline, not independently owned resources. Enumerating
                  // their rule-100 allow entries made every clean nuke mutate
                  // the rematerialized default VPC and report two false
                  // stragglers.
                  .filter((acl) => acl.IsDefault !== true)
                  .flatMap((acl) =>
                    (acl.Entries ?? [])
                      .filter((e) => e.RuleNumber !== 32767)
                      .map((entry) => ({
                        networkAclId: acl.NetworkAclId as NetworkAclId,
                        ruleNumber: entry.RuleNumber!,
                        egress: entry.Egress!,
                        protocol: entry.Protocol!,
                        ruleAction: entry.RuleAction!,
                        cidrBlock: entry.CidrBlock,
                        ipv6CidrBlock: entry.Ipv6CidrBlock,
                        icmpTypeCode: entry.IcmpTypeCode
                          ? {
                              code: entry.IcmpTypeCode.Code,
                              type: entry.IcmpTypeCode.Type,
                            }
                          : undefined,
                        portRange: entry.PortRange
                          ? {
                              from: entry.PortRange.From,
                              to: entry.PortRange.To,
                            }
                          : undefined,
                      })),
                  ),
              ),
            ),
          ),

        read: Effect.fn(function* ({ olds, output }) {
          if (!output) return undefined;
          const entry = yield* findEntry(
            olds.networkAclId as string,
            output.ruleNumber,
            output.egress,
          );
          if (!entry) {
            return yield* Effect.fail(
              new Error(
                `Network ACL Entry not found: ${output.networkAclId} rule ${output.ruleNumber} egress=${output.egress}`,
              ),
            );
          }
          return toAttrs(olds, entry);
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          // If network ACL, rule number, or egress changes, need to replace
          if (
            news.networkAclId !== olds.networkAclId ||
            news.ruleNumber !== olds.ruleNumber ||
            news.egress !== olds.egress
          ) {
            return { action: "replace" };
          }
          // Other properties can be updated by replacing the entry
        }),

        reconcile: Effect.fn(function* ({ news, session }) {
          const entryParams = {
            NetworkAclId: news.networkAclId as string,
            RuleNumber: news.ruleNumber,
            Protocol: news.protocol,
            RuleAction: news.ruleAction,
            Egress: news.egress ?? false,
            CidrBlock: news.cidrBlock,
            Ipv6CidrBlock: news.ipv6CidrBlock,
            IcmpTypeCode: news.icmpTypeCode
              ? {
                  Code: news.icmpTypeCode.code,
                  Type: news.icmpTypeCode.type,
                }
              : undefined,
            PortRange: news.portRange
              ? {
                  From: news.portRange.from,
                  To: news.portRange.to,
                }
              : undefined,
            DryRun: false,
          };

          // Observe — entries are identified by (networkAclId, ruleNumber,
          // egress); look up the live entry to decide between create and
          // replace.
          const observed = yield* findEntry(
            news.networkAclId as string,
            news.ruleNumber,
            news.egress ?? false,
          );

          // Ensure / Sync — if the entry doesn't exist, create it; otherwise
          // ReplaceNetworkAclEntry overwrites its mutable properties in place.
          if (observed === undefined) {
            yield* session.note(
              `Creating Network ACL Entry (rule ${news.ruleNumber})...`,
            );
            yield* ec2.createNetworkAclEntry(entryParams);
            yield* session.note(
              `Network ACL Entry created: rule ${news.ruleNumber}`,
            );
          } else {
            yield* session.note(
              `Updating Network ACL Entry (rule ${news.ruleNumber})...`,
            );
            yield* ec2.replaceNetworkAclEntry(entryParams);
            yield* session.note(
              `Network ACL Entry updated: rule ${news.ruleNumber}`,
            );
          }

          // Re-read final state. A freshly created/replaced entry can lag
          // `describeNetworkAcls` by a moment (EC2 eventual consistency), so
          // poll until it appears, bounded.
          const entry = yield* findEntry(
            news.networkAclId as string,
            news.ruleNumber,
            news.egress ?? false,
          ).pipe(
            Effect.flatMap((e) =>
              e
                ? Effect.succeed(e)
                : Effect.fail({ _tag: "EntryNotYetVisible" } as const),
            ),
            Effect.retry({
              while: (e) => e._tag === "EntryNotYetVisible",
              schedule: Schedule.max([
                Schedule.exponential("500 millis"),
                Schedule.recurs(8),
              ]),
            }),
            Effect.catchTag("EntryNotYetVisible", () =>
              Effect.fail(
                new Error("Network ACL Entry not found after reconcile"),
              ),
            ),
          );
          return toAttrs(news, entry);
        }),

        delete: Effect.fn(function* ({ output, session }) {
          const networkAclId = output.networkAclId;
          yield* session.note(
            `Deleting Network ACL Entry (rule ${output.ruleNumber})...`,
          );

          yield* ec2
            .deleteNetworkAclEntry({
              NetworkAclId: networkAclId,
              RuleNumber: output.ruleNumber,
              Egress: output.egress,
              DryRun: false,
            })
            .pipe(
              Effect.catchTag(
                "InvalidNetworkAclEntry.NotFound",
                () => Effect.void,
              ),
              Effect.catchTag(
                "InvalidNetworkAclID.NotFound",
                () => Effect.void,
              ),
            );

          // Delete success is only an acknowledgement. Observe the exact
          // (ACL, rule number, direction) tuple until it is absent so nuke
          // cannot report success while the entry is still enumerable.
          yield* findEntry(networkAclId, output.ruleNumber, output.egress).pipe(
            Effect.flatMap((entry) =>
              entry === undefined
                ? Effect.void
                : Effect.fail(
                    new NetworkAclEntryStillVisible({
                      networkAclId,
                      ruleNumber: output.ruleNumber,
                      egress: output.egress,
                    }),
                  ),
            ),
            Effect.retry({
              while: (error) => error instanceof NetworkAclEntryStillVisible,
              schedule: Schedule.max([
                Schedule.fixed(1000),
                Schedule.recurs(10),
              ]),
            }),
          );

          yield* session.note(
            `Network ACL Entry deleted: rule ${output.ruleNumber}`,
          );
        }),
      };
    }),
  );

class NetworkAclEntryStillVisible extends Data.TaggedError(
  "NetworkAclEntryStillVisible",
)<{
  networkAclId: string;
  ruleNumber: number;
  egress: boolean;
}> {}
