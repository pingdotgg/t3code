import type * as bedrock from "@distilled.cloud/aws/bedrock-runtime";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * The `InvokeModel` request with the binding-injected `modelId` made
 * optional: it defaults to the first bound model id and may be overridden
 * per call with any of the bound model ids.
 *
 * `body` is the raw, model-specific request payload (e.g. the Anthropic
 * Messages API shape for Claude models, the Nova messages-v1 shape for
 * Amazon Nova) — there is no auto-marshalling. The response `body` is a
 * byte `Stream` of the model-specific JSON response.
 */
export interface InvokeModelRequest extends Omit<
  bedrock.InvokeModelRequest,
  "modelId"
> {
  /**
   * The model to run inference on for this call. Must be one of the model
   * ids the binding was created with (IAM is scoped to exactly those).
   * @default the first bound model id
   */
  modelId?: string;
}

/**
 * Runtime binding for `bedrock-runtime:InvokeModel` — run inference with a
 * model-specific request body (text, image, or embedding models).
 *
 * Bind one or more model references inside a function runtime to get a
 * callable that invokes the model with a raw payload. The binding grants the
 * function `bedrock:InvokeModel` scoped to exactly the bound models. A model
 * reference may be a foundation-model id, a cross-region inference profile
 * id (e.g. `us.amazon.nova-micro-v1:0`), or a full Bedrock ARN.
 *
 * Prefer {@link Converse} for conversational models — it is model-agnostic.
 * `InvokeModel` is for model-native payloads (embeddings, image generation,
 * or provider-specific request features).
 *
 * Model access is an account entitlement — enable the model in the Bedrock
 * console (Model access) before invoking, otherwise calls fail with
 * `AccessDeniedException`.
 *
 * @binding
 * @section Invoking a Model
 * @example Invoke with a Model-Native Payload
 * ```typescript
 * // init
 * const invokeModel = yield* Bedrock.InvokeModel("us.amazon.nova-micro-v1:0");
 *
 * // runtime — body is the raw Nova messages-v1 payload
 * const result = yield* invokeModel({
 *   contentType: "application/json",
 *   accept: "application/json",
 *   body: JSON.stringify({
 *     messages: [{ role: "user", content: [{ text: "Say hello." }] }],
 *     inferenceConfig: { maxTokens: 64 },
 *   }),
 * });
 * // result.body is a byte Stream of the JSON response
 * const json = JSON.parse(
 *   yield* Stream.mkString(Stream.decodeText(result.body)),
 * );
 * ```
 */
export interface InvokeModel extends Binding.Service<
  InvokeModel,
  "AWS.Bedrock.InvokeModel",
  (
    model: string,
    ...additionalModels: string[]
  ) => Effect.Effect<
    (
      request: InvokeModelRequest,
    ) => Effect.Effect<bedrock.InvokeModelResponse, bedrock.InvokeModelError>
  >
> {}
export const InvokeModel = Binding.Service<InvokeModel>(
  "AWS.Bedrock.InvokeModel",
);
