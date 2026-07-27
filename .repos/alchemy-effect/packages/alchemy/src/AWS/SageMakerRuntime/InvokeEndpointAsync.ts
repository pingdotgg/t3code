import type * as sagemaker from "@distilled.cloud/aws/sagemaker-runtime";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * The `InvokeEndpointAsync` request with the binding-injected `EndpointName`
 * made optional: it defaults to the first bound endpoint name and may be
 * overridden per call with any of the bound endpoint names.
 *
 * `InputLocation` is the S3 URI of the request payload; the response returns
 * an `OutputLocation` S3 URI the container writes the result to. Grant the
 * function S3 access to those buckets separately.
 */
export interface InvokeEndpointAsyncRequest extends Omit<
  sagemaker.InvokeEndpointAsyncInput,
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
 * Runtime binding for `sagemaker:InvokeEndpointAsync` — enqueue an
 * asynchronous inference request against a deployed SageMaker async endpoint.
 * The request payload is read from S3 (`InputLocation`) and the result is
 * written back to S3; the call returns immediately with an `OutputLocation`.
 *
 * The binding takes one or more endpoint names and grants the function
 * `sagemaker:InvokeEndpointAsync` scoped to exactly those endpoint ARNs.
 *
 * @binding
 * @section Invoking an Async Endpoint
 * @example Enqueue an Async Inference Request
 * ```typescript
 * // init
 * const invokeAsync = yield* AWS.SageMakerRuntime.InvokeEndpointAsync(
 *   "my-async-endpoint",
 * );
 *
 * // runtime
 * const result = yield* invokeAsync({
 *   ContentType: "application/json",
 *   InputLocation: "s3://my-bucket/input/request.json",
 * });
 * // result.OutputLocation — poll S3 for the written inference result
 * ```
 */
export interface InvokeEndpointAsync extends Binding.Service<
  InvokeEndpointAsync,
  "AWS.SageMakerRuntime.InvokeEndpointAsync",
  (
    endpoint: string,
    ...additionalEndpoints: string[]
  ) => Effect.Effect<
    (
      request: InvokeEndpointAsyncRequest,
    ) => Effect.Effect<
      sagemaker.InvokeEndpointAsyncOutput,
      sagemaker.InvokeEndpointAsyncError
    >
  >
> {}
export const InvokeEndpointAsync = Binding.Service<InvokeEndpointAsync>(
  "AWS.SageMakerRuntime.InvokeEndpointAsync",
);
