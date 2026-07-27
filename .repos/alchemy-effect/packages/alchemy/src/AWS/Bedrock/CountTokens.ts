import type * as bedrock from "@distilled.cloud/aws/bedrock-runtime";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * The `CountTokens` request with the binding-injected `modelId` made
 * optional: it defaults to the first bound model id and may be overridden
 * per call with any of the bound model ids.
 */
export interface CountTokensRequest extends Omit<
  bedrock.CountTokensRequest,
  "modelId"
> {
  /**
   * The model whose tokenizer counts the input. Must be one of the model
   * ids the binding was created with (IAM is scoped to exactly those).
   * @default the first bound model id
   */
  modelId?: string;
}

/**
 * Runtime binding for `bedrock-runtime:CountTokens` — count the input tokens
 * a `Converse` or `InvokeModel` request would consume, using the bound
 * model's tokenizer, without invoking the model (and without inference
 * cost).
 *
 * The binding grants the function `bedrock:CountTokens` scoped to exactly
 * the bound models.
 *
 * Only a subset of models support token counting, addressed by their BARE
 * foundation-model id (e.g. `anthropic.claude-haiku-4-5-20251001-v1:0`) —
 * Amazon Nova models and cross-region inference-profile ids are rejected
 * with a `ValidationException` ("The provided model doesn't support
 * counting tokens").
 *
 * @binding
 * @section Counting Tokens
 * @example Count Tokens for a Converse Request
 * ```typescript
 * // init
 * const countTokens = yield* Bedrock.CountTokens(
 *   "anthropic.claude-haiku-4-5-20251001-v1:0",
 * );
 *
 * // runtime
 * const result = yield* countTokens({
 *   input: {
 *     converse: {
 *       messages: [{ role: "user", content: [{ text: "Say hello." }] }],
 *     },
 *   },
 * });
 * const tokens = result.inputTokens;
 * ```
 *
 * @example Count Tokens for a Raw InvokeModel Payload
 * ```typescript
 * const result = yield* countTokens({
 *   input: {
 *     invokeModel: {
 *       body: JSON.stringify({
 *         messages: [{ role: "user", content: [{ text: "Say hello." }] }],
 *       }),
 *     },
 *   },
 * });
 * ```
 */
export interface CountTokens extends Binding.Service<
  CountTokens,
  "AWS.Bedrock.CountTokens",
  (
    model: string,
    ...additionalModels: string[]
  ) => Effect.Effect<
    (
      request: CountTokensRequest,
    ) => Effect.Effect<bedrock.CountTokensResponse, bedrock.CountTokensError>
  >
> {}
export const CountTokens = Binding.Service<CountTokens>(
  "AWS.Bedrock.CountTokens",
);
