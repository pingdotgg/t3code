import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

/** Internal: the ALB is still visible after `deleteLoadBalancer`. */
class LoadBalancerStillDeleting extends Data.TaggedError(
  "LoadBalancerStillDeleting",
)<{}> {}
import { deepEqual, isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";
import type { AccountID } from "../Environment.ts";
import type { SecurityGroupId } from "../EC2/SecurityGroup.ts";
import type { SubnetId } from "../EC2/Subnet.ts";
import type { RegionID } from "../Region.ts";

export type LoadBalancerName = string;
export type LoadBalancerArn =
  `arn:aws:elasticloadbalancing:${RegionID}:${AccountID}:loadbalancer/${string}`;

export interface LoadBalancerProps {
  /** The load balancer name. If omitted, a unique name is generated. Changing it replaces the load balancer. */
  name?: string;
  /**
   * Whether the load balancer is internet-facing or internal. Changing it
   * replaces the load balancer.
   * @default "internet-facing"
   */
  scheme?: "internal" | "internet-facing";
  /**
   * The load balancer type. Changing it replaces the load balancer.
   * @default "application"
   */
  type?: "application" | "network" | "gateway";
  /**
   * The subnets to attach. Mutually exclusive with {@link subnetMappings}.
   * Updated in place via `setSubnets`.
   */
  subnets?: Input<SubnetId[]>;
  /**
   * Per-subnet mappings for static/EIP addresses (Network Load Balancers).
   * Mutually exclusive with {@link subnets}. Updated in place via `setSubnets`.
   */
  subnetMappings?: {
    subnetId: Input<SubnetId>;
    /** The allocation ID of an Elastic IP (NLB). */
    allocationId?: string;
    /** A private IPv4 address from the subnet (internal NLB). */
    privateIPv4Address?: string;
    /** An IPv6 address from the subnet (dualstack NLB). */
    iPv6Address?: string;
    /** A source NAT IPv6 prefix. */
    sourceNatIpv6Prefix?: string;
  }[];
  /** The security groups to attach. Updated in place via `setSecurityGroups`. */
  securityGroups?: Input<SecurityGroupId[]>;
  /** The IP address type (`ipv4`, `dualstack`, ...). Updated in place via `setIpAddressType`. */
  ipAddressType?: string;
  /** The ID of the customer-owned IPv4 pool (Outposts). Changing it replaces the load balancer. */
  customerOwnedIpv4Pool?: string;
  /** Whether to prefix-delegate IPv6 for source NAT (`on`/`off`). */
  enablePrefixForIpv6SourceNat?: "on" | "off";
  /**
   * Whether to enforce security-group inbound rules on PrivateLink traffic
   * (`on`/`off`). Carried by `setSecurityGroups`.
   */
  enforceSecurityGroupInboundRulesOnPrivateLinkTraffic?: "on" | "off";
  /** Raw load-balancer attributes (idle timeout, deletion protection, access logs, ...). */
  attributes?: Record<string, string>;
  /** Tags to apply to the load balancer. */
  tags?: Record<string, string>;
}

export interface LoadBalancer extends Resource<
  "AWS.ELBv2.LoadBalancer",
  LoadBalancerProps,
  {
    /** The ARN of the load balancer. */
    loadBalancerArn: LoadBalancerArn;
    /** The name of the load balancer. */
    loadBalancerName: LoadBalancerName;
    /** The public DNS name of the load balancer. */
    dnsName: string;
    /** The Route 53 hosted zone ID for alias records targeting the load balancer. */
    canonicalHostedZoneId: string;
    /** The ID of the VPC the load balancer resides in. */
    vpcId: string;
    /** Whether the load balancer is `internet-facing` or `internal`. */
    scheme: string;
    /** The load balancer type (`application`, `network`, or `gateway`). */
    type: string;
    /** The IDs of the security groups attached to the load balancer. */
    securityGroups: string[];
    /** The IDs of the subnets the load balancer spans. */
    subnets: string[];
    /** The tags applied to the load balancer. */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An ELBv2 (Application / Network / Gateway) load balancer.
 * @resource
 * @section Creating a Load Balancer
 * @example Internet-facing Application Load Balancer
 * ```typescript
 * const lb = yield* LoadBalancer("web", {
 *   type: "application",
 *   scheme: "internet-facing",
 *   subnets: [subnet1.subnetId, subnet2.subnetId],
 *   securityGroups: [sg.groupId],
 * });
 * ```
 *
 * @example Network Load Balancer with static EIPs
 * ```typescript
 * const nlb = yield* LoadBalancer("edge", {
 *   type: "network",
 *   scheme: "internet-facing",
 *   subnetMappings: [
 *     { subnetId: subnet1.subnetId, allocationId: eip1.allocationId },
 *     { subnetId: subnet2.subnetId, allocationId: eip2.allocationId },
 *   ],
 * });
 * ```
 *
 * @section Attributes
 * @example Idle timeout and deletion protection
 * ```typescript
 * const lb = yield* LoadBalancer("web", {
 *   type: "application",
 *   subnets: [subnet1.subnetId, subnet2.subnetId],
 *   attributes: {
 *     "idle_timeout.timeout_seconds": "120",
 *     "deletion_protection.enabled": "true",
 *   },
 * });
 * ```
 */
export const LoadBalancer = Resource<LoadBalancer>("AWS.ELBv2.LoadBalancer");

export const LoadBalancerProvider = () =>
  Provider.effect(
    LoadBalancer,
    Effect.gen(function* () {
      const toName = (id: string, props: { name?: string } = {}) =>
        props.name
          ? Effect.succeed(props.name)
          : createPhysicalName({ id, maxLength: 32, lowercase: true });

      return {
        stables: [
          "loadBalancerArn",
          "loadBalancerName",
          "dnsName",
          "canonicalHostedZoneId",
          "vpcId",
        ],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          const oldName = yield* toName(id, olds ?? {});
          const newName = yield* toName(id, news ?? {});
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          // Only scheme, type and customerOwnedIpv4Pool are immutable.
          // subnets, securityGroups and ipAddressType are mutated in place
          // during reconcile (setSubnets / setSecurityGroups / setIpAddressType).
          if (
            !deepEqual(
              {
                scheme: olds.scheme ?? "internet-facing",
                type: olds.type ?? "application",
                customerOwnedIpv4Pool: olds.customerOwnedIpv4Pool,
              },
              {
                scheme: news.scheme ?? "internet-facing",
                type: news.type ?? "application",
                customerOwnedIpv4Pool: news.customerOwnedIpv4Pool,
              },
            )
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output) {
            return undefined;
          }
          const described = yield* elbv2
            .describeLoadBalancers({
              LoadBalancerArns: [output.loadBalancerArn],
            })
            .pipe(
              Effect.catchTag("LoadBalancerNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          const loadBalancer = described?.LoadBalancers?.[0];
          if (!loadBalancer?.LoadBalancerArn) {
            return undefined;
          }
          return {
            ...output,
            dnsName: loadBalancer.DNSName!,
            canonicalHostedZoneId: loadBalancer.CanonicalHostedZoneId!,
            vpcId: loadBalancer.VpcId!,
            scheme: loadBalancer.Scheme!,
            type: loadBalancer.Type!,
            securityGroups: loadBalancer.SecurityGroups ?? [],
            subnets:
              loadBalancer.AvailabilityZones?.flatMap((zone) =>
                zone.SubnetId ? [zone.SubnetId] : [],
              ) ?? [],
          };
        }),
        list: () =>
          Effect.gen(function* () {
            // Enumerate every load balancer in the account/region, paginating
            // exhaustively.
            const loadBalancers = yield* elbv2.describeLoadBalancers
              .pages({})
              .pipe(
                Stream.runCollect,
                Effect.map((chunk) =>
                  Array.from(chunk).flatMap((page) => page.LoadBalancers ?? []),
                ),
              );
            const owned = loadBalancers.filter(
              (lb): lb is elbv2.LoadBalancer & { LoadBalancerArn: string } =>
                lb.LoadBalancerArn != null,
            );
            if (owned.length === 0) {
              return [];
            }

            // describeTags accepts at most 20 ARNs per call, so batch.
            const batches: (typeof owned)[] = [];
            for (let i = 0; i < owned.length; i += 20) {
              batches.push(owned.slice(i, i + 20));
            }
            const tagDescriptions = yield* Effect.forEach(
              batches,
              (batch) =>
                elbv2
                  .describeTags({
                    ResourceArns: batch.map((lb) => lb.LoadBalancerArn),
                  })
                  .pipe(Effect.map((res) => res.TagDescriptions ?? [])),
              { concurrency: 5 },
            );
            const tagsByArn = new Map(
              tagDescriptions
                .flat()
                .flatMap((desc) =>
                  desc.ResourceArn
                    ? ([
                        [
                          desc.ResourceArn,
                          Object.fromEntries(
                            (desc.Tags ?? [])
                              .filter(
                                (t): t is { Key: string; Value: string } =>
                                  typeof t.Key === "string" &&
                                  typeof t.Value === "string",
                              )
                              .map((t) => [t.Key, t.Value]),
                          ),
                        ],
                      ] as const)
                    : [],
                ),
            );

            return owned.map((lb) => ({
              loadBalancerArn: lb.LoadBalancerArn as LoadBalancerArn,
              loadBalancerName: lb.LoadBalancerName!,
              dnsName: lb.DNSName!,
              canonicalHostedZoneId: lb.CanonicalHostedZoneId!,
              vpcId: lb.VpcId!,
              scheme: lb.Scheme!,
              type: lb.Type!,
              securityGroups: lb.SecurityGroups ?? [],
              subnets:
                lb.AvailabilityZones?.flatMap((zone) =>
                  zone.SubnetId ? [zone.SubnetId] : [],
                ) ?? [],
              tags: tagsByArn.get(lb.LoadBalancerArn) ?? {},
            }));
          }),
        reconcile: Effect.fn(function* ({ id, news, session }) {
          const name = yield* toName(id, news);
          const desiredTags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };

          // Observe — look up by deterministic name.
          let described = yield* elbv2
            .describeLoadBalancers({
              Names: [name],
            })
            .pipe(
              Effect.catchTag("LoadBalancerNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          let loadBalancer = described?.LoadBalancers?.[0];

          const subnetMappings = news.subnetMappings?.map((m) => ({
            SubnetId: m.subnetId as string,
            AllocationId: m.allocationId,
            PrivateIPv4Address: m.privateIPv4Address,
            IPv6Address: m.iPv6Address,
            SourceNatIpv6Prefix: m.sourceNatIpv6Prefix,
          }));

          // Ensure — create if missing. The replacement axes (scheme, type,
          // customerOwnedIpv4Pool) are handled by diff so we don't need to
          // deal with mismatches here.
          if (!loadBalancer?.LoadBalancerArn) {
            const created = yield* elbv2.createLoadBalancer({
              Name: name,
              Scheme: news.scheme ?? "internet-facing",
              Type: news.type ?? "application",
              Subnets: news.subnets as string[] | undefined,
              SubnetMappings: subnetMappings,
              SecurityGroups: news.securityGroups as string[] | undefined,
              IpAddressType: news.ipAddressType,
              CustomerOwnedIpv4Pool: news.customerOwnedIpv4Pool,
              EnablePrefixForIpv6SourceNat: news.enablePrefixForIpv6SourceNat,
              Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                Key,
                Value,
              })),
            });
            loadBalancer = created.LoadBalancers?.[0];
            if (!loadBalancer?.LoadBalancerArn) {
              return yield* Effect.die(
                new Error("createLoadBalancer returned no load balancer"),
              );
            }
          }

          const loadBalancerArn =
            loadBalancer.LoadBalancerArn as LoadBalancerArn;

          // Sync subnets — diff observed against desired. Only applies to
          // application/network LBs that manage subnets in place.
          const observedSubnets =
            loadBalancer.AvailabilityZones?.flatMap((z) =>
              z.SubnetId ? [z.SubnetId] : [],
            ) ?? [];
          if (news.subnets) {
            const desiredSubnets = news.subnets as string[];
            if (
              !deepEqual(
                [...observedSubnets].sort(),
                [...desiredSubnets].sort(),
              )
            ) {
              yield* elbv2.setSubnets({
                LoadBalancerArn: loadBalancerArn,
                Subnets: desiredSubnets,
              });
            }
          } else if (subnetMappings) {
            yield* elbv2.setSubnets({
              LoadBalancerArn: loadBalancerArn,
              SubnetMappings: subnetMappings,
            });
          }

          // Sync security groups — diff observed against desired.
          if (news.securityGroups) {
            const observedSgs = loadBalancer.SecurityGroups ?? [];
            const desiredSgs = news.securityGroups as string[];
            if (
              !deepEqual([...observedSgs].sort(), [...desiredSgs].sort()) ||
              news.enforceSecurityGroupInboundRulesOnPrivateLinkTraffic
            ) {
              yield* elbv2.setSecurityGroups({
                LoadBalancerArn: loadBalancerArn,
                SecurityGroups: desiredSgs,
                EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic:
                  news.enforceSecurityGroupInboundRulesOnPrivateLinkTraffic,
              });
            }
          }

          // Sync IP address type — diff observed against desired.
          if (
            news.ipAddressType &&
            news.ipAddressType !== loadBalancer.IpAddressType
          ) {
            yield* elbv2.setIpAddressType({
              LoadBalancerArn: loadBalancerArn,
              IpAddressType: news.ipAddressType,
            });
          }

          // Sync attributes — observed ↔ desired. We always apply when
          // desired attrs are non-empty; AWS rejects an empty list anyway,
          // and reading observed attributes is an extra round-trip we
          // don't need for convergence.
          if (news.attributes && Object.keys(news.attributes).length > 0) {
            yield* elbv2.modifyLoadBalancerAttributes({
              LoadBalancerArn: loadBalancerArn,
              Attributes: Object.entries(news.attributes).map(
                ([Key, Value]) => ({
                  Key,
                  Value,
                }),
              ),
            });
          }

          // Sync tags — diff observed cloud tags against desired.
          const tagDescriptions = yield* elbv2.describeTags({
            ResourceArns: [loadBalancerArn],
          });
          const observedTags = Object.fromEntries(
            (tagDescriptions.TagDescriptions?.[0]?.Tags ?? [])
              .filter(
                (t): t is { Key: string; Value: string } =>
                  typeof t.Key === "string" && typeof t.Value === "string",
              )
              .map((t) => [t.Key, t.Value]),
          );
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* elbv2.addTags({
              ResourceArns: [loadBalancerArn],
              Tags: upsert,
            });
          }
          if (removed.length > 0) {
            yield* elbv2.removeTags({
              ResourceArns: [loadBalancerArn],
              TagKeys: removed,
            });
          }

          yield* session.note(loadBalancerArn);
          return {
            loadBalancerArn,
            loadBalancerName: loadBalancer.LoadBalancerName!,
            dnsName: loadBalancer.DNSName!,
            canonicalHostedZoneId: loadBalancer.CanonicalHostedZoneId!,
            vpcId: loadBalancer.VpcId!,
            scheme: loadBalancer.Scheme!,
            type: loadBalancer.Type!,
            securityGroups: loadBalancer.SecurityGroups ?? [],
            subnets:
              loadBalancer.AvailabilityZones?.flatMap((zone) =>
                zone.SubnetId ? [zone.SubnetId] : [],
              ) ?? [],
            tags: desiredTags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* elbv2
            .deleteLoadBalancer({
              LoadBalancerArn: output.loadBalancerArn,
            })
            .pipe(
              Effect.catchTag(
                "LoadBalancerNotFoundException",
                () => Effect.void,
              ),
            );

          // `deleteLoadBalancer` returns immediately, but the ALB's ENIs
          // linger for a minute or two afterwards and block deletion of any
          // subnet or security group they occupy. Wait until the balancer is
          // fully gone so downstream network resources tear down on the first
          // attempt instead of spinning on dependency-violation retries.
          yield* elbv2
            .describeLoadBalancers({
              LoadBalancerArns: [output.loadBalancerArn],
            })
            .pipe(
              Effect.flatMap(() =>
                Effect.fail(new LoadBalancerStillDeleting()),
              ),
              Effect.catchTag(
                "LoadBalancerNotFoundException",
                () => Effect.void,
              ),
              Effect.retry({
                while: (e) => e._tag === "LoadBalancerStillDeleting",
                schedule: Schedule.max([
                  Schedule.fixed("5 seconds"),
                  Schedule.recurs(48),
                ]),
              }),
              // Best-effort: if it is somehow still visible after ~4 min, let
              // the downstream deletes retry rather than fail the teardown.
              Effect.catchTag("LoadBalancerStillDeleting", () => Effect.void),
            );
        }),
      };
    }),
  );
