import type * as r53r from "@distilled.cloud/aws/route53resolver";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ResolverEndpoint } from "./ResolverEndpoint.ts";

export interface ListResolverEndpointIpAddressesRequest extends Omit<
  r53r.ListResolverEndpointIpAddressesRequest,
  "ResolverEndpointId"
> {}

/**
 * Runtime binding for `route53resolver:ListResolverEndpointIpAddresses` —
 * discover the IP addresses the bound {@link ResolverEndpoint}'s network
 * interfaces answer/forward on (one per subnet); the endpoint ID is injected
 * automatically.
 *
 * The canonical runtime use: DNS bootstrap automation that reads an INBOUND
 * endpoint's IPs to configure on-premises conditional forwarders (or a VPN /
 * DHCP option set) without hard-coding addresses.
 *
 * Provide `Route53Resolver.ListResolverEndpointIpAddressesHttp` on the
 * hosting Lambda Function to satisfy the requirement.
 * @binding
 * @section Discovering Endpoint IPs
 * @example List the Endpoint's IP Addresses
 * ```typescript
 * // init — grants route53resolver:ListResolverEndpointIpAddresses on the endpoint
 * const listIps = yield* AWS.Route53Resolver.ListResolverEndpointIpAddresses(endpoint);
 *
 * // runtime
 * const { IpAddresses } = yield* listIps();
 * const ips = (IpAddresses ?? []).map((ip) => ip.Ip);
 * ```
 */
export interface ListResolverEndpointIpAddresses extends Binding.Service<
  ListResolverEndpointIpAddresses,
  "AWS.Route53Resolver.ListResolverEndpointIpAddresses",
  (
    endpoint: ResolverEndpoint,
  ) => Effect.Effect<
    (
      request?: ListResolverEndpointIpAddressesRequest,
    ) => Effect.Effect<
      r53r.ListResolverEndpointIpAddressesResponse,
      r53r.ListResolverEndpointIpAddressesError
    >
  >
> {}

export const ListResolverEndpointIpAddresses =
  Binding.Service<ListResolverEndpointIpAddresses>(
    "AWS.Route53Resolver.ListResolverEndpointIpAddresses",
  );
