import type * as bedrock from "@distilled.cloud/aws/bedrock-runtime";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * The `InvokeModelWithResponseStream` request with the binding-injected
 * `modelId` made optional: it defaults to the first bound model id and may
 * be overridden per call with any of the bound model ids.
 *
 * `body` is the raw, model-specific request payload — there is no
 * auto-marshalling. The response `body` is an event `Stream` whose `chunk`
 * events carry raw model-specific bytes.
 */
export interface InvokeModelWithResponseStreamRequest extends Omit<
  bedrock.InvokeModelWithResponseStreamRequest,
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
 * Runtime binding for `bedrock-runtime:InvokeModelWithResponseStream` — the
 * streaming variant of {@link InvokeModel}. The response arrives as an event
 * `Stream` of `chunk` events carrying model-specific payload bytes.
 *
 * The binding grants the function `bedrock:InvokeModelWithResponseStream`
 * (the IAM action streaming operations authorize against) scoped to exactly
 * the bound models. A model reference may be a foundation-model id, a
 * cross-region inference profile id (e.g. `us.amazon.nova-micro-v1:0`), or a
 * full Bedrock ARN.
 *
 * Prefer {@link ConverseStream} for conversational models — it is
 * model-agnostic and its events are typed.
 *
 * Model access is an account entitlement — enable the model in the Bedrock
 * console (Model access) before invoking, otherwise calls fail with
 * `AccessDeniedException`.
 *
 * @binding
 * @section Streaming a Model Response
 * @example Aggregate Streamed Chunks
 * ```typescript
 * // init
 * const invokeModelStream = yield* Bedrock.InvokeModelWithResponseStream(
 *   "us.amazon.nova-micro-v1:0",
 * );
 *
 * // runtime — body is the raw Nova messages-v1 payload
 * const result = yield* invokeModelStream({
 *   contentType: "application/json",
 *   body: JSON.stringify({
 *     messages: [{ role: "user", content: [{ text: "Say hello." }] }],
 *     inferenceConfig: { maxTokens: 64 },
 *   }),
 * });
 * const events = yield* Stream.runCollect(result.body);
 * // each chunk's bytes is a model-specific JSON event
 * ```
 */
export interface InvokeModelWithResponseStream extends Binding.Service<
  InvokeModelWithResponseStream,
  "AWS.Bedrock.InvokeModelWithResponseStream",
  (
    model: string,
    ...additionalModels: string[]
  ) => Effect.Effect<
    (
      request: InvokeModelWithResponseStreamRequest,
    ) => Effect.Effect<
      bedrock.InvokeModelWithResponseStreamResponse,
      bedrock.InvokeModelWithResponseStreamError
    >
  >
> {}
export const InvokeModelWithResponseStream =
  Binding.Service<InvokeModelWithResponseStream>(
    "AWS.Bedrock.InvokeModelWithResponseStream",
  );
