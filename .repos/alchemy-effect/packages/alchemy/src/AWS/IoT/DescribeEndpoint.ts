import type * as iot from "@distilled.cloud/aws/iot";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface DescribeEndpointRequest extends iot.DescribeEndpointRequest {}

/**
 * Runtime binding for the `DescribeEndpoint` operation (IAM action
 * `iot:DescribeEndpoint`, granted on `*`).
 *
 * Returns the account-specific IoT endpoint — pass
 * `endpointType: "iot:Data-ATS"` for the recommended ATS data endpoint that
 * devices and MQTT clients connect to. Provide the implementation with
 * `Effect.provide(AWS.IoT.DescribeEndpointHttp)`.
 * @binding
 * @section Endpoints
 * @example Discover the ATS Data Endpoint
 * ```typescript
 * const describeEndpoint = yield* AWS.IoT.DescribeEndpoint();
 *
 * const { endpointAddress } = yield* describeEndpoint({
 *   endpointType: "iot:Data-ATS",
 * });
 * ```
 */
export interface DescribeEndpoint extends Binding.Service<
  DescribeEndpoint,
  "AWS.IoT.DescribeEndpoint",
  () => Effect.Effect<
    (
      request?: DescribeEndpointRequest,
    ) => Effect.Effect<iot.DescribeEndpointResponse, iot.DescribeEndpointError>
  >
> {}

export const DescribeEndpoint = Binding.Service<DescribeEndpoint>(
  "AWS.IoT.DescribeEndpoint",
);
