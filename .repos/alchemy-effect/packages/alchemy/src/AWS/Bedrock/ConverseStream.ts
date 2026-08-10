import type * as bedrock from "@distilled.cloud/aws/bedrock-runtime";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * The `ConverseStream` request with the binding-injected `modelId` made
 * optional: it defaults to the first bound model id and may be overridden
 * per call with any of the bound model ids.
 */
export interface ConverseStreamRequest extends Omit<
  bedrock.ConverseStreamRequest,
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
 * Runtime binding for `bedrock-runtime:ConverseStream` — the streaming
 * variant of {@link Converse}. The response arrives as an event `Stream` of
 * `ConverseStreamOutput` events (`messageStart`, `contentBlockDelta`,
 * `messageStop`, `metadata`, ...) instead of a single message.
 *
 * The binding grants the function `bedrock:InvokeModelWithResponseStream`
 * (the IAM action streaming operations authorize against) scoped to exactly
 * the bound models. A model reference may be a foundation-model id, a
 * cross-region inference profile id (e.g. `us.amazon.nova-micro-v1:0`), or a
 * full Bedrock ARN.
 *
 * Model access is an account entitlement — enable the model in the Bedrock
 * console (Model access) before invoking, otherwise calls fail with
 * `AccessDeniedException`.
 *
 * @binding
 * @section Streaming a Conversation
 * @example Aggregate Streamed Text Deltas
 * ```typescript
 * // init
 * const converseStream = yield* Bedrock.ConverseStream("us.amazon.nova-micro-v1:0");
 *
 * // runtime
 * const result = yield* converseStream({
 *   messages: [{ role: "user", content: [{ text: "Say hello." }] }],
 *   inferenceConfig: { maxTokens: 64 },
 * });
 * const events = yield* Stream.runCollect(result.stream ?? Stream.empty);
 * const text = events
 *   .map((event) => event.contentBlockDelta?.delta.text ?? "")
 *   .join("");
 * ```
 */
export interface ConverseStream extends Binding.Service<
  ConverseStream,
  "AWS.Bedrock.ConverseStream",
  (
    model: string,
    ...additionalModels: string[]
  ) => Effect.Effect<
    (
      request: ConverseStreamRequest,
    ) => Effect.Effect<
      bedrock.ConverseStreamResponse,
      bedrock.ConverseStreamError
    >
  >
> {}
export const ConverseStream = Binding.Service<ConverseStream>(
  "AWS.Bedrock.ConverseStream",
);
