import type * as sagemaker from "@distilled.cloud/aws/sagemaker";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Endpoint } from "./Endpoint.ts";

/**
 * Runtime binding for `sagemaker:DescribeEndpoint` — read a live endpoint's
 * status, variants, and deployment state from a function runtime.
 *
 * Bind this operation to an `Endpoint` inside a function runtime to get a
 * callable that automatically injects the endpoint name. Use it to check
 * `EndpointStatus` (e.g. gate invocations while an update is rolling) or to
 * observe per-variant weights and instance counts.
 * @binding
 * @section Observing Endpoints
 * @example Check Endpoint Status
 * ```typescript
 * // init
 * const describeEndpoint = yield* AWS.SageMaker.DescribeEndpoint(endpoint);
 *
 * // runtime
 * const { EndpointStatus, ProductionVariants } = yield* describeEndpoint();
 * ```
 */
export interface DescribeEndpoint extends Binding.Service<
  DescribeEndpoint,
  "AWS.SageMaker.DescribeEndpoint",
  <E extends Endpoint>(
    endpoint: E,
  ) => Effect.Effect<
    () => Effect.Effect<
      sagemaker.DescribeEndpointOutput,
      sagemaker.DescribeEndpointError
    >
  >
> {}
export const DescribeEndpoint = Binding.Service<DescribeEndpoint>(
  "AWS.SageMaker.DescribeEndpoint",
);
