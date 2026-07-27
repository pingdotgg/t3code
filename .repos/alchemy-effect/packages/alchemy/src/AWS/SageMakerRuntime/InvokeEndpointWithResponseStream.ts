import type * as sagemaker from "@distilled.cloud/aws/sagemaker-runtime";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * The `InvokeEndpointWithResponseStream` request with the binding-injected
 * `EndpointName` made optional: it defaults to the first bound endpoint name
 * and may be overridden per call with any of the bound endpoint names.
 *
 * `Body` is the raw, model-specific inference payload — there is no
 * auto-marshalling. The response `Body` is an event `Stream` whose
 * `PayloadPart` events carry raw model-specific bytes.
 */
export interface InvokeEndpointWithResponseStreamRequest extends Omit<
  sagemaker.InvokeEndpointWithResponseStreamInput,
  "EndpointName"
> {
  /**
   * The endpoint to run inference on for this call. Must be one of the
   * endpoint names the binding was created with.
   * @default the first bound endpoint name
   */
  EndpointName?: string;
}

/**
 * Runtime binding for `sagemaker:InvokeEndpointWithResponseStream` — the
 * streaming variant of {@link InvokeEndpoint}. The inference response arrives
 * incrementally as an event `Stream` of `PayloadPart` events carrying raw
 * model-specific bytes; the container behind the endpoint must support
 * inference streaming.
 *
 * The binding takes one or more endpoint names and grants the function
 * `sagemaker:InvokeEndpoint` (the IAM action the streaming operation
 * authorizes against) scoped to exactly those endpoint ARNs.
 *
 * @binding
 * @section Streaming an Endpoint Response
 * @example Aggregate Streamed Payload Parts
 * ```typescript
 * // init
 * const invokeStream = yield* AWS.SageMakerRuntime.InvokeEndpointWithResponseStream(
 *   "my-streaming-endpoint",
 * );
 *
 * // runtime — Body is the raw payload the container expects
 * const result = yield* invokeStream({
 *   ContentType: "application/json",
 *   Body: JSON.stringify({ inputs: "Say hello." }),
 * });
 * const events = yield* Stream.runCollect(result.Body);
 * // each PayloadPart's Bytes is a model-specific chunk
 * ```
 */
export interface InvokeEndpointWithResponseStream extends Binding.Service<
  InvokeEndpointWithResponseStream,
  "AWS.SageMakerRuntime.InvokeEndpointWithResponseStream",
  (
    endpoint: string,
    ...additionalEndpoints: string[]
  ) => Effect.Effect<
    (
      request: InvokeEndpointWithResponseStreamRequest,
    ) => Effect.Effect<
      sagemaker.InvokeEndpointWithResponseStreamOutput,
      sagemaker.InvokeEndpointWithResponseStreamError
    >
  >
> {}
export const InvokeEndpointWithResponseStream =
  Binding.Service<InvokeEndpointWithResponseStream>(
    "AWS.SageMakerRuntime.InvokeEndpointWithResponseStream",
  );
