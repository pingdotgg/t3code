import type * as osis from "@distilled.cloud/aws/osis";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Pipeline } from "./Pipeline.ts";

/**
 * Runtime binding for `osis:RevokePipelineEndpointConnections`.
 *
 * Revokes VPC endpoint connections attached to the bound {@link Pipeline} —
 * a security control that cuts off ingest access from specific endpoints
 * (e.g. after an account is offboarded). The pipeline ARN is injected from
 * the binding; pass the endpoint IDs to revoke. Provide the implementation
 * with `Effect.provide(AWS.OSIS.RevokePipelineEndpointConnectionsHttp)`.
 * @binding
 * @section Managing Endpoint Connections
 * @example Revoke an Endpoint's Access
 * ```typescript
 * // init — bind the operation to the pipeline
 * const revokeConnections =
 *   yield* AWS.OSIS.RevokePipelineEndpointConnections(pipeline);
 *
 * // runtime
 * yield* revokeConnections({ EndpointIds: ["pe-1234567890abcdef0"] });
 * ```
 */
export interface RevokePipelineEndpointConnections extends Binding.Service<
  RevokePipelineEndpointConnections,
  "AWS.OSIS.RevokePipelineEndpointConnections",
  (
    pipeline: Pipeline,
  ) => Effect.Effect<
    (
      request: Omit<
        osis.RevokePipelineEndpointConnectionsRequest,
        "PipelineArn"
      >,
    ) => Effect.Effect<
      osis.RevokePipelineEndpointConnectionsResponse,
      osis.RevokePipelineEndpointConnectionsError
    >
  >
> {}
export const RevokePipelineEndpointConnections =
  Binding.Service<RevokePipelineEndpointConnections>(
    "AWS.OSIS.RevokePipelineEndpointConnections",
  );
