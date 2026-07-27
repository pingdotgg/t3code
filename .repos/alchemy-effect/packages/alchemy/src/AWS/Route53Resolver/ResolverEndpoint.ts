import * as r53r from "@distilled.cloud/aws/route53resolver";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  fetchResolverTags,
  sameStringSet,
  syncResolverTags,
  toResolverTagList,
} from "./internal.ts";

export interface ResolverEndpointIpAddress {
  /**
   * ID of the subnet to place a resolver network interface in. Changing the
   * set of subnets forces replacement.
   */
  subnetId: string;
  /**
   * Optional fixed IPv4 address within the subnet. If omitted, Resolver
   * picks an available address.
   */
  ip?: string;
  /**
   * Optional fixed IPv6 address within the subnet (dual-stack/IPv6
   * endpoints only).
   */
  ipv6?: string;
}

export interface ResolverEndpointProps {
  /**
   * Friendly name of the endpoint. Also used as the `CreatorRequestId`.
   * Changing it forces replacement.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * Whether the endpoint accepts DNS queries from your network (`INBOUND`)
   * or forwards queries from your VPC to your network (`OUTBOUND`).
   * Changing it forces replacement.
   */
  direction: "INBOUND" | "OUTBOUND";
  /**
   * IP addresses (one per subnet, minimum 2 subnets in different AZs) that
   * the resolver endpoint's network interfaces are created in. Changing the
   * subnet set forces replacement.
   */
  ipAddresses: ResolverEndpointIpAddress[];
  /**
   * IDs of the security groups controlling access to the endpoint's
   * network interfaces. Changing them forces replacement.
   */
  securityGroupIds: string[];
  /**
   * The IP family of the endpoint.
   * @default "IPV4"
   */
  resolverEndpointType?: "IPV4" | "IPV6" | "DUALSTACK";
  /**
   * DNS protocols the endpoint answers/forwards with.
   * @default ["Do53"]
   */
  protocols?: ("Do53" | "DoH" | "DoH-FIPS")[];
  /**
   * Tags to apply to the endpoint. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface ResolverEndpoint extends Resource<
  "AWS.Route53Resolver.ResolverEndpoint",
  ResolverEndpointProps,
  {
    /**
     * ID of the resolver endpoint (e.g. `rslvr-in-...` / `rslvr-out-...`).
     */
    resolverEndpointId: string;
    /**
     * ARN of the resolver endpoint.
     */
    resolverEndpointArn: string;
    /**
     * Name of the endpoint.
     */
    name: string;
    /**
     * `INBOUND` or `OUTBOUND`.
     */
    direction: string;
    /**
     * ID of the VPC the endpoint's network interfaces live in.
     */
    hostVpcId: string;
  },
  never,
  Providers
> {}

/**
 * A Route 53 Resolver endpoint — the set of elastic network interfaces that
 * connect your VPC's `.2` resolver to DNS resolvers on your own network.
 *
 * An `INBOUND` endpoint lets DNS resolvers on your network forward queries
 * to Route 53 Resolver; an `OUTBOUND` endpoint lets Resolver forward queries
 * from your VPCs to your network (paired with FORWARD `ResolverRule`s).
 *
 * Endpoint provisioning is asynchronous (typically 1-2 minutes); the
 * provider waits (bounded) for the endpoint to become `OPERATIONAL` so
 * dependent resolver rules can use it immediately.
 * @resource
 * @section Creating Endpoints
 * @example Inbound Endpoint
 * ```typescript
 * import * as Route53Resolver from "alchemy/AWS/Route53Resolver";
 *
 * const inbound = yield* Route53Resolver.ResolverEndpoint("Inbound", {
 *   direction: "INBOUND",
 *   securityGroupIds: [sg.securityGroupId],
 *   ipAddresses: [
 *     { subnetId: subnetA.subnetId },
 *     { subnetId: subnetB.subnetId },
 *   ],
 * });
 * ```
 *
 * @example Outbound Endpoint with Fixed IPs
 * ```typescript
 * const outbound = yield* Route53Resolver.ResolverEndpoint("Outbound", {
 *   direction: "OUTBOUND",
 *   securityGroupIds: [sg.securityGroupId],
 *   ipAddresses: [
 *     { subnetId: subnetA.subnetId, ip: "10.0.0.10" },
 *     { subnetId: subnetB.subnetId, ip: "10.0.1.10" },
 *   ],
 * });
 * ```
 *
 * @section Forwarding Queries
 * @example Forward a Domain through an Outbound Endpoint
 * ```typescript
 * const rule = yield* Route53Resolver.ResolverRule("CorpForward", {
 *   domainName: "corp.example.com",
 *   resolverEndpointId: outbound.resolverEndpointId,
 *   targetIps: [{ ip: "192.168.1.10" }],
 * });
 * ```
 */
export const ResolverEndpoint = Resource<ResolverEndpoint>(
  "AWS.Route53Resolver.ResolverEndpoint",
);

/**
 * Recreating an endpoint whose deterministic `CreatorRequestId` is still
 * attached to a `DELETING` predecessor raises `ResourceExistsException`
 * until the old endpoint is fully gone (~1 min). Retry on a bounded
 * schedule (~2 min).
 *
 * Explicitly typed: inlining `Effect.retry` in provider lifecycle code can
 * widen the provider layer to `unknown` in declaration emit.
 *
 * @internal
 */
const retryEndpointExists = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ResourceExistsException",
    schedule: Schedule.max([Schedule.fixed("5 seconds"), Schedule.recurs(24)]),
  });

/**
 * Deleting an endpoint that still has resolver rules attached (their own
 * deletion may still be propagating) surfaces `InvalidRequestException` —
 * retry briefly so the delete converges.
 *
 * @internal
 */
const retryEndpointInUse = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "InvalidRequestException",
    schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(15)]),
  });

/**
 * Bounded wait (~3.5 min) for an endpoint to leave its transitional state
 * (`CREATING`/`UPDATING`). If the budget is exhausted the last observation
 * is returned and downstream consumers retry on their own typed errors.
 *
 * @internal
 */
const untilEndpointSettled = <E, R>(
  self: Effect.Effect<r53r.ResolverEndpoint | undefined, E, R>,
): Effect.Effect<r53r.ResolverEndpoint | undefined, E, R> =>
  self.pipe(
    Effect.repeat({
      schedule: Schedule.fixed("5 seconds"),
      until: (endpoint) =>
        endpoint === undefined ||
        (endpoint.Status !== "CREATING" && endpoint.Status !== "UPDATING"),
      times: 42,
    }),
  );

export const ResolverEndpointProvider = () =>
  Provider.effect(
    ResolverEndpoint,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { name?: string | undefined },
      ) {
        return props.name ?? (yield* createPhysicalName({ id, maxLength: 64 }));
      });

      const getEndpoint = (endpointId: string) =>
        r53r.getResolverEndpoint({ ResolverEndpointId: endpointId }).pipe(
          Effect.map((r) => r.ResolverEndpoint),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );

      // Observe by the cached endpoint ID first, falling back to the
      // deterministic CreatorRequestId (set to the physical name at create).
      // Endpoints in DELETING state are treated as missing so a reconcile
      // after an out-of-band delete recreates.
      const observe = Effect.fn(function* (
        name: string,
        endpointId: string | undefined,
      ) {
        if (endpointId !== undefined) {
          const byId = yield* getEndpoint(endpointId);
          if (byId !== undefined && byId.Status !== "DELETING") {
            return byId;
          }
        }
        return yield* r53r.listResolverEndpoints
          .items({
            Filters: [{ Name: "CreatorRequestId", Values: [name] }],
          })
          .pipe(
            Stream.filter((endpoint) => endpoint.Status !== "DELETING"),
            Stream.runHead,
            Effect.map(Option.getOrUndefined),
          );
      });

      return ResolverEndpoint.Provider.of({
        stables: [
          "resolverEndpointId",
          "resolverEndpointArn",
          "name",
          "direction",
          "hostVpcId",
        ],
        // Top-level resource: enumerate every resolver endpoint in the
        // ambient account/region.
        list: () =>
          r53r.listResolverEndpoints.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .flatMap((page) => page.ResolverEndpoints ?? [])
                .flatMap((endpoint) =>
                  endpoint.Id !== undefined && endpoint.Arn !== undefined
                    ? [
                        {
                          resolverEndpointId: endpoint.Id,
                          resolverEndpointArn: endpoint.Arn,
                          name: endpoint.Name ?? "",
                          direction: endpoint.Direction ?? "",
                          hostVpcId: endpoint.HostVPCId ?? "",
                        },
                      ]
                    : [],
                ),
            ),
          ),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* createName(id, olds ?? {}));
          const endpoint = yield* observe(name, output?.resolverEndpointId);
          if (endpoint?.Id === undefined || endpoint.Arn === undefined) {
            return undefined;
          }
          const attrs = {
            resolverEndpointId: endpoint.Id,
            resolverEndpointArn: endpoint.Arn,
            name: endpoint.Name ?? name,
            direction: endpoint.Direction ?? "",
            hostVpcId: endpoint.HostVPCId ?? "",
          };
          const tags = yield* fetchResolverTags(endpoint.Arn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),
        // Replacement detection only. Direction, security groups, and the
        // subnet placement of the network interfaces are immutable;
        // protocols/endpoint type/tags update in place via reconcile.
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) return { action: "replace" } as const;
          if (olds.direction !== news.direction) {
            return { action: "replace" } as const;
          }
          if (!sameStringSet(olds.securityGroupIds, news.securityGroupIds)) {
            return { action: "replace" } as const;
          }
          const ipKey = (ip: ResolverEndpointIpAddress) =>
            `${ip.subnetId}:${ip.ip ?? ""}:${ip.ipv6 ?? ""}`;
          if (
            !sameStringSet(
              olds.ipAddresses.map(ipKey),
              news.ipAddresses.map(ipKey),
            )
          ) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.name ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE — cloud state is authoritative; output only caches
          //    the endpoint ID.
          let endpoint = yield* observe(name, output?.resolverEndpointId);

          // 2. ENSURE — create if missing. A DELETING predecessor holding
          //    the same CreatorRequestId surfaces ResourceExistsException,
          //    which is retried until the old endpoint drains.
          if (endpoint === undefined) {
            yield* session.note(`creating resolver endpoint ${name}`);
            endpoint = yield* retryEndpointExists(
              r53r.createResolverEndpoint({
                CreatorRequestId: name,
                Name: name,
                Direction: news.direction,
                SecurityGroupIds: news.securityGroupIds,
                IpAddresses: news.ipAddresses.map((ip) => ({
                  SubnetId: ip.subnetId,
                  Ip: ip.ip,
                  Ipv6: ip.ipv6,
                })),
                ResolverEndpointType: news.resolverEndpointType,
                Protocols: news.protocols,
                Tags: toResolverTagList(desiredTags),
              }),
            ).pipe(Effect.map((r) => r.ResolverEndpoint!));
          }
          const endpointId = endpoint.Id!;

          // Endpoint provisioning is asynchronous (~1-2 min). Wait (bounded)
          // for it to settle so dependents (FORWARD rules) can use it.
          yield* session.note(
            `waiting for resolver endpoint ${endpointId} to become OPERATIONAL`,
          );
          const settled = yield* untilEndpointSettled(getEndpoint(endpointId));
          endpoint = settled ?? endpoint;

          // 3. SYNC — protocols and endpoint type are mutable in place.
          //    Diff observed cloud state against desired; skip the API on
          //    no-op.
          const desiredProtocols = news.protocols;
          const protocolsDelta =
            desiredProtocols !== undefined &&
            !sameStringSet(endpoint.Protocols ?? [], desiredProtocols);
          const desiredType = news.resolverEndpointType;
          const typeDelta =
            desiredType !== undefined &&
            endpoint.ResolverEndpointType !== desiredType;
          if (protocolsDelta || typeDelta) {
            endpoint = yield* r53r
              .updateResolverEndpoint({
                ResolverEndpointId: endpointId,
                ...(protocolsDelta ? { Protocols: desiredProtocols } : {}),
                ...(typeDelta ? { ResolverEndpointType: desiredType } : {}),
              })
              .pipe(Effect.map((r) => r.ResolverEndpoint ?? endpoint!));
          }

          // 3b. SYNC TAGS — diff against observed cloud tags.
          const arn = endpoint.Arn!;
          yield* syncResolverTags(arn, desiredTags);

          yield* session.note(endpointId);
          return {
            resolverEndpointId: endpointId,
            resolverEndpointArn: arn,
            name: endpoint.Name ?? name,
            direction: endpoint.Direction ?? news.direction,
            hostVpcId: endpoint.HostVPCId ?? "",
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* retryEndpointInUse(
            r53r.deleteResolverEndpoint({
              ResolverEndpointId: output.resolverEndpointId,
            }),
          ).pipe(
            Effect.asVoid,
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        }),
      });
    }),
  );
