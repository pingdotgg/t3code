import type * as r53r from "@distilled.cloud/aws/route53resolver";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ResolverEndpoint } from "./ResolverEndpoint.ts";

/**
 * Runtime binding for `route53resolver:GetResolverEndpoint` — read the bound
 * {@link ResolverEndpoint}'s live state (status, IP address count, host VPC,
 * protocols); the endpoint ID is injected automatically.
 *
 * Provide `Route53Resolver.GetResolverEndpointHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * @binding
 * @section Reading Endpoint State
 * @example Read the Endpoint Status
 * ```typescript
 * // init — grants route53resolver:GetResolverEndpoint on the endpoint
 * const getEndpoint = yield* AWS.Route53Resolver.GetResolverEndpoint(endpoint);
 *
 * // runtime
 * const { ResolverEndpoint } = yield* getEndpoint();
 * console.log(ResolverEndpoint?.Status, ResolverEndpoint?.IpAddressCount);
 * ```
 */
export interface GetResolverEndpoint extends Binding.Service<
  GetResolverEndpoint,
  "AWS.Route53Resolver.GetResolverEndpoint",
  (
    endpoint: ResolverEndpoint,
  ) => Effect.Effect<
    () => Effect.Effect<
      r53r.GetResolverEndpointResponse,
      r53r.GetResolverEndpointError
    >
  >
> {}

export const GetResolverEndpoint = Binding.Service<GetResolverEndpoint>(
  "AWS.Route53Resolver.GetResolverEndpoint",
);
