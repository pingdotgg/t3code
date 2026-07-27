import type * as dsql from "@distilled.cloud/aws/dsql";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Retrieves the VPC endpoint service name of an Aurora DSQL cluster — the
 * `com.amazonaws.{region}.dsql-{suffix}` PrivateLink service name used to
 * create a VPC interface endpoint that reaches the cluster privately.
 *
 * Bind a {@link Cluster} inside a function runtime to look the name up on
 * demand (e.g. from an operations function that provisions VPC endpoints).
 * Provide `DSQL.GetVpcEndpointServiceNameHttp` on the Function effect to
 * implement the binding.
 *
 * @binding
 * @section Resolving the VPC Endpoint Service Name
 * @example Look Up the PrivateLink Service Name
 * ```typescript
 * // init
 * const getVpcEndpointServiceName =
 *   yield* DSQL.GetVpcEndpointServiceName(cluster);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const { serviceName } = yield* getVpcEndpointServiceName();
 *     return HttpServerResponse.json({ serviceName });
 *   }),
 * };
 * ```
 */
export interface GetVpcEndpointServiceName extends Binding.Service<
  GetVpcEndpointServiceName,
  "AWS.DSQL.GetVpcEndpointServiceName",
  <R extends Cluster>(
    cluster: R,
  ) => Effect.Effect<
    () => Effect.Effect<
      dsql.GetVpcEndpointServiceNameOutput,
      dsql.GetVpcEndpointServiceNameError
    >
  >
> {}
export const GetVpcEndpointServiceName =
  Binding.Service<GetVpcEndpointServiceName>(
    "AWS.DSQL.GetVpcEndpointServiceName",
  );
