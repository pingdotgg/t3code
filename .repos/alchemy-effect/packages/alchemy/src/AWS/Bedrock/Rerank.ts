import type * as bedrock from "@distilled.cloud/aws/bedrock-agent-runtime";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * The `Rerank` request. The reranker model is referenced inside
 * `rerankingConfiguration.bedrockRerankingConfiguration.modelConfiguration.modelArn`
 * — pass the full foundation-model ARN of one of the bound models there.
 */
export interface RerankRequest extends bedrock.RerankRequest {}

/**
 * Runtime binding for `bedrock-agent-runtime:Rerank` — re-order a list of
 * candidate documents by semantic relevance to a query using a Bedrock
 * reranker model (e.g. `amazon.rerank-v1:0`, `cohere.rerank-v3-5:0`).
 *
 * Bind one or more reranker model references inside a function runtime. The
 * binding grants the function `bedrock:Rerank` (which AWS authorizes only
 * against `*`) plus `bedrock:InvokeModel` scoped to exactly the bound
 * models.
 *
 * @binding
 * @section Reranking Documents
 * @example Rerank Inline Text Documents
 * ```typescript
 * // init
 * const rerank = yield* Bedrock.Rerank("amazon.rerank-v1:0");
 *
 * // runtime
 * const result = yield* rerank({
 *   queries: [{ type: "TEXT", textQuery: { text: "What is Alchemy?" } }],
 *   sources: docs.map((text) => ({
 *     type: "INLINE",
 *     inlineDocumentSource: { type: "TEXT", textDocument: { text } },
 *   })),
 *   rerankingConfiguration: {
 *     type: "BEDROCK_RERANKING_MODEL",
 *     bedrockRerankingConfiguration: {
 *       modelConfiguration: {
 *         modelArn: `arn:aws:bedrock:us-west-2::foundation-model/amazon.rerank-v1:0`,
 *       },
 *     },
 *   },
 * });
 * const best = result.results[0]; // { index, relevanceScore }
 * ```
 */
export interface Rerank extends Binding.Service<
  Rerank,
  "AWS.Bedrock.Rerank",
  (
    model: string,
    ...additionalModels: string[]
  ) => Effect.Effect<
    (
      request: RerankRequest,
    ) => Effect.Effect<bedrock.RerankResponse, bedrock.RerankError>
  >
> {}
export const Rerank = Binding.Service<Rerank>("AWS.Bedrock.Rerank");
