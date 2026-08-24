import type * as bedrock from "@distilled.cloud/aws/bedrock-runtime";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * The `Converse` request with the binding-injected `modelId` made optional:
 * it defaults to the first bound model id and may be overridden per call
 * with any of the bound model ids.
 */
export interface ConverseRequest extends Omit<
  bedrock.ConverseRequest,
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
 * Runtime binding for `bedrock-runtime:Converse` — Amazon Bedrock's unified
 * messages API that works across all conversational foundation models.
 *
 * Bind one or more model references inside a function runtime to get a
 * callable that sends messages to the model. The binding grants the function
 * `bedrock:InvokeModel` scoped to exactly the bound models. A model reference
 * may be a foundation-model id, a cross-region inference profile id (e.g.
 * `us.amazon.nova-micro-v1:0`), or a full Bedrock ARN (application inference
 * profile, imported model, prompt version, ...).
 *
 * Model access is an account entitlement — enable the model in the Bedrock
 * console (Model access) before invoking, otherwise calls fail with
 * `AccessDeniedException`. Many newer models are only invocable through a
 * cross-region inference profile id, not their bare foundation-model id.
 *
 * @binding
 * @section Conversing with a Model
 * @example Send a Single Prompt
 * ```typescript
 * // init
 * const converse = yield* Bedrock.Converse("us.amazon.nova-micro-v1:0");
 *
 * // runtime
 * const result = yield* converse({
 *   messages: [{ role: "user", content: [{ text: "Say hello." }] }],
 *   inferenceConfig: { maxTokens: 64 },
 * });
 * const text = result.output.message.content[0]?.text;
 * ```
 *
 * @example Bind Multiple Models and Pick Per Call
 * ```typescript
 * const converse = yield* Bedrock.Converse(
 *   "us.amazon.nova-micro-v1:0",
 *   "us.anthropic.claude-sonnet-4-20250514-v1:0",
 * );
 *
 * const result = yield* converse({
 *   modelId: "us.anthropic.claude-sonnet-4-20250514-v1:0",
 *   messages: [{ role: "user", content: [{ text: "Summarize this." }] }],
 * });
 * ```
 *
 * @example System Prompt and Inference Config
 * ```typescript
 * const result = yield* converse({
 *   system: [{ text: "You answer in exactly one word." }],
 *   messages: [{ role: "user", content: [{ text: "What color is the sky?" }] }],
 *   inferenceConfig: { maxTokens: 16, temperature: 0 },
 * });
 * ```
 */
export interface Converse extends Binding.Service<
  Converse,
  "AWS.Bedrock.Converse",
  (
    model: string,
    ...additionalModels: string[]
  ) => Effect.Effect<
    (
      request: ConverseRequest,
    ) => Effect.Effect<bedrock.ConverseResponse, bedrock.ConverseError>
  >
> {}
export const Converse = Binding.Service<Converse>("AWS.Bedrock.Converse");
