import type * as bedrock from "@distilled.cloud/aws/bedrock-agent-runtime";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { KnowledgeBase } from "./KnowledgeBase.ts";

/**
 * The `Retrieve` request with the binding-injected `knowledgeBaseId` removed —
 * it is supplied automatically from the bound {@link KnowledgeBase}.
 */
export interface RetrieveRequest extends Omit<
  bedrock.RetrieveRequest,
  "knowledgeBaseId"
> {}

/**
 * Runtime binding for `bedrock-agent-runtime:Retrieve` — query a
 * {@link KnowledgeBase} for the passages most relevant to a natural-language
 * query, without generating an answer.
 *
 * Bind a knowledge base inside a function runtime to get a callable that runs
 * semantic retrieval. The binding grants the function `bedrock:Retrieve`
 * scoped to exactly that knowledge base. Use this when you want the raw
 * retrieved chunks (to build your own prompt); use {@link RetrieveAndGenerate}
 * for a fully managed RAG answer.
 *
 * @binding
 * @section Retrieving Passages
 * @example Retrieve Relevant Chunks
 * ```typescript
 * // init
 * const retrieve = yield* Bedrock.Retrieve(knowledgeBase);
 *
 * // runtime
 * const result = yield* retrieve({
 *   retrievalQuery: { text: "How do I rotate credentials?" },
 *   retrievalConfiguration: {
 *     vectorSearchConfiguration: { numberOfResults: 5 },
 *   },
 * });
 * const passages = result.retrievalResults.map((r) => r.content?.text);
 * ```
 */
export interface Retrieve extends Binding.Service<
  Retrieve,
  "AWS.Bedrock.Retrieve",
  <K extends KnowledgeBase>(
    knowledgeBase: K,
  ) => Effect.Effect<
    (
      request: RetrieveRequest,
    ) => Effect.Effect<bedrock.RetrieveResponse, bedrock.RetrieveError>
  >
> {}
export const Retrieve = Binding.Service<Retrieve>("AWS.Bedrock.Retrieve");
