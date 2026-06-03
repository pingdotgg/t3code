import type * as EC2 from "@distilled.cloud/aws/ec2";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Effect from "effect/Effect";

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
        ec2
          .describeNetworkAcls({ NetworkAclIds: [networkAclId] })
          .pipe(
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

          // Re-read final state.
          const entry = yield* findEntry(
            news.networkAclId as string,
            news.ruleNumber,
            news.egress ?? false,
          );
          if (!entry) {
            return yield* Effect.fail(
              new Error("Network ACL Entry not found after reconcile"),
            );
          }
          return toAttrs(news, entry);
        }),

        delete: Effect.fn(function* ({ olds, output, session }) {
          yield* session.note(
            `Deleting Network ACL Entry (rule ${output.ruleNumber})...`,
          );

          yield* ec2
            .deleteNetworkAclEntry({
              NetworkAclId: olds.networkAclId as string,
              RuleNumber: output.ruleNumber,
              Egress: output.egress,
              DryRun: false,
            })
            .pipe(
              Effect.catchTag(
                "InvalidNetworkAclEntry.NotFound",
                () => Effect.void,
              ),
            );

          yield* session.note(
            `Network ACL Entry deleted: rule ${output.ruleNumber}`,
          );
        }),
      };
    }),
  );
