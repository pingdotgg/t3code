import type * as sagemaker from "@distilled.cloud/aws/sagemaker-runtime";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * The `InvokeEndpoint` request with the binding-injected `EndpointName` made
 * optional: it defaults to the first bound endpoint name and may be
 * overridden per call with any of the bound endpoint names (IAM is scoped to
 * exactly those).
 *
 * `Body` is the raw, model-specific inference payload (the container behind
 * the endpoint decides the shape) — there is no auto-marshalling. Set
 * `ContentType`/`Accept` to match your container's serializer.
 */
export interface InvokeEndpointRequest extends Omit<
  sagemaker.InvokeEndpointInput,
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
 * Runtime binding for `sagemaker:InvokeEndpoint` — run real-time inference
 * against a deployed SageMaker endpoint with a model-native request body.
 *
 * SageMaker Runtime is a pure pay-per-call data-plane API: the endpoint
 * itself is provisioned out of band (a deployed SageMaker model/endpoint —
 * costly to keep running). The binding takes one or more endpoint names and
 * grants the function `sagemaker:InvokeEndpoint` scoped to exactly those
 * endpoint ARNs. Pass the request/response bodies as raw bytes — the
 * container behind the endpoint owns the payload shape, no marshalling.
 *
 * @binding
 * @section Invoking an Endpoint
 * @example Invoke a Real-Time Endpoint
 * ```typescript
 * // init
 * const invokeEndpoint = yield* AWS.SageMakerRuntime.InvokeEndpoint(
 *   "my-model-endpoint",
 * );
 *
 * // runtime — Body is the raw payload the container expects
 * const result = yield* invokeEndpoint({
 *   ContentType: "application/json",
 *   Accept: "application/json",
 *   Body: JSON.stringify({ instances: [[1, 2, 3, 4]] }),
 * });
 * const raw = new TextDecoder().decode(result.Body);
 * ```
 */
export interface InvokeEndpoint extends Binding.Service<
  InvokeEndpoint,
  "AWS.SageMakerRuntime.InvokeEndpoint",
  (
    endpoint: string,
    ...additionalEndpoints: string[]
  ) => Effect.Effect<
    (
      request: InvokeEndpointRequest,
    ) => Effect.Effect<
      sagemaker.InvokeEndpointOutput,
      sagemaker.InvokeEndpointError
    >
  >
> {}
export const InvokeEndpoint = Binding.Service<InvokeEndpoint>(
  "AWS.SageMakerRuntime.InvokeEndpoint",
);
