import type * as bedrock from "@distilled.cloud/aws/bedrock-agent-runtime";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { KnowledgeBase } from "./KnowledgeBase.ts";

/**
 * The `RetrieveAndGenerate` request. The knowledge base is referenced inside
 * `retrieveAndGenerateConfiguration.knowledgeBaseConfiguration.knowledgeBaseId`
 * — pass the bound {@link KnowledgeBase}'s `knowledgeBaseId` there. The
 * binding scopes IAM to the bound knowledge base and the bound generation
 * models.
 */
export interface RetrieveAndGenerateRequest
  extends bedrock.RetrieveAndGenerateRequest {}

/**
 * Runtime binding for `bedrock-agent-runtime:RetrieveAndGenerate` — the fully
 * managed RAG operation: retrieve relevant passages from a
 * {@link KnowledgeBase} and generate a grounded answer with a foundation
 * model in one call.
 *
 * Bind a knowledge base and one or more generation models inside a function
 * runtime. The binding grants `bedrock:Retrieve` and
 * `bedrock:RetrieveAndGenerate` scoped to the knowledge base, plus
 * `bedrock:InvokeModel` scoped to the bound models (or all foundation models
 * and cross-region inference profiles when none are named).
 *
 * @binding
 * @section Retrieving and Generating
 * @example One-Shot Grounded Answer
 * ```typescript
 * // init
 * const rag = yield* Bedrock.RetrieveAndGenerate(
 *   knowledgeBase,
 *   "us.anthropic.claude-3-5-sonnet-20240620-v1:0",
 * );
 *
 * // runtime
 * const result = yield* rag({
 *   input: { text: "How do I rotate credentials?" },
 *   retrieveAndGenerateConfiguration: {
 *     type: "KNOWLEDGE_BASE",
 *     knowledgeBaseConfiguration: {
 *       knowledgeBaseId: yield* knowledgeBase.knowledgeBaseId,
 *       modelArn: "us.anthropic.claude-3-5-sonnet-20240620-v1:0",
 *     },
 *   },
 * });
 * const answer = result.output.text;
 * ```
 */
export interface RetrieveAndGenerate extends Binding.Service<
  RetrieveAndGenerate,
  "AWS.Bedrock.RetrieveAndGenerate",
  <K extends KnowledgeBase>(
    knowledgeBase: K,
    ...models: string[]
  ) => Effect.Effect<
    (
      request: RetrieveAndGenerateRequest,
    ) => Effect.Effect<
      bedrock.RetrieveAndGenerateResponse,
      bedrock.RetrieveAndGenerateError
    >
  >
> {}
export const RetrieveAndGenerate = Binding.Service<RetrieveAndGenerate>(
  "AWS.Bedrock.RetrieveAndGenerate",
);
