import type * as bedrock from "@distilled.cloud/aws/bedrock-agent-runtime";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { KnowledgeBase } from "./KnowledgeBase.ts";

/**
 * The `RetrieveAndGenerateStream` request. The knowledge base is referenced
 * inside
 * `retrieveAndGenerateConfiguration.knowledgeBaseConfiguration.knowledgeBaseId`
 * — pass the bound {@link KnowledgeBase}'s `knowledgeBaseId` there.
 */
export interface RetrieveAndGenerateStreamRequest
  extends bedrock.RetrieveAndGenerateStreamRequest {}

/**
 * Runtime binding for `bedrock-agent-runtime:RetrieveAndGenerateStream` —
 * the streaming variant of {@link RetrieveAndGenerate}. The grounded answer
 * arrives as an event `Stream` of `output` text deltas, `citation` events,
 * and `guardrail` events instead of a single response.
 *
 * Bind a knowledge base and one or more generation models inside a function
 * runtime. The binding grants `bedrock:Retrieve` and
 * `bedrock:RetrieveAndGenerate` scoped to the knowledge base, plus
 * `bedrock:InvokeModel` scoped to the bound models (or all foundation models
 * and cross-region inference profiles when none are named).
 *
 * @binding
 * @section Streaming a Grounded Answer
 * @example Aggregate Streamed Output Deltas
 * ```typescript
 * // init
 * const ragStream = yield* Bedrock.RetrieveAndGenerateStream(
 *   knowledgeBase,
 *   "us.amazon.nova-micro-v1:0",
 * );
 *
 * // runtime
 * const result = yield* ragStream({
 *   input: { text: "How do I rotate credentials?" },
 *   retrieveAndGenerateConfiguration: {
 *     type: "KNOWLEDGE_BASE",
 *     knowledgeBaseConfiguration: {
 *       knowledgeBaseId: yield* knowledgeBase.knowledgeBaseId,
 *       modelArn: "us.amazon.nova-micro-v1:0",
 *     },
 *   },
 * });
 * const events = yield* Stream.runCollect(result.stream);
 * const answer = events.map((event) => event.output?.text ?? "").join("");
 * ```
 */
export interface RetrieveAndGenerateStream extends Binding.Service<
  RetrieveAndGenerateStream,
  "AWS.Bedrock.RetrieveAndGenerateStream",
  <K extends KnowledgeBase>(
    knowledgeBase: K,
    ...models: string[]
  ) => Effect.Effect<
    (
      request: RetrieveAndGenerateStreamRequest,
    ) => Effect.Effect<
      bedrock.RetrieveAndGenerateStreamResponse,
      bedrock.RetrieveAndGenerateStreamError
    >
  >
> {}
export const RetrieveAndGenerateStream =
  Binding.Service<RetrieveAndGenerateStream>(
    "AWS.Bedrock.RetrieveAndGenerateStream",
  );
