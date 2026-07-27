import type * as osis from "@distilled.cloud/aws/osis";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `osis:ListPipelineEndpointConnections`.
 *
 * Lists the VPC endpoint connections attached to pipelines in the account —
 * including endpoints owned by other accounts — so an ops function can audit
 * who can ingest into your pipelines (pair with
 * {@link RevokePipelineEndpointConnections} to cut off access). Account-level:
 * no resource argument. Provide the implementation with
 * `Effect.provide(AWS.OSIS.ListPipelineEndpointConnectionsHttp)`.
 * @binding
 * @section Managing Endpoint Connections
 * @example Audit Endpoint Connections
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listConnections = yield* AWS.OSIS.ListPipelineEndpointConnections();
 *
 * // runtime
 * const { PipelineEndpointConnections } = yield* listConnections();
 * for (const connection of PipelineEndpointConnections ?? []) {
 *   yield* Effect.log(
 *     `${connection.EndpointId} (owner ${connection.VpcEndpointOwner})`,
 *   );
 * }
 * ```
 */
export interface ListPipelineEndpointConnections extends Binding.Service<
  ListPipelineEndpointConnections,
  "AWS.OSIS.ListPipelineEndpointConnections",
  () => Effect.Effect<
    (
      request?: osis.ListPipelineEndpointConnectionsRequest,
    ) => Effect.Effect<
      osis.ListPipelineEndpointConnectionsResponse,
      osis.ListPipelineEndpointConnectionsError
    >
  >
> {}
export const ListPipelineEndpointConnections =
  Binding.Service<ListPipelineEndpointConnections>(
    "AWS.OSIS.ListPipelineEndpointConnections",
  );
