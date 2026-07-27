import type * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Memory } from "./Memory.ts";

export interface RetrieveMemoryRecordsRequest extends Omit<
  agentcore.RetrieveMemoryRecordsInput,
  "memoryId"
> {}

/**
 * Semantically searches extracted long-term memory records.
 *
 * Bind a {@link Memory} inside a function runtime to run relevance-ranked
 * queries over the records the memory's long-term strategies have extracted.
 * Provide `AgentCore.RetrieveMemoryRecordsHttp` on the Function effect to
 * implement the binding.
 *
 * @binding
 * @section Retrieving Memory Records
 * @example Semantic Search over a Namespace
 * ```typescript
 * // init
 * const retrieveMemoryRecords = yield* AgentCore.RetrieveMemoryRecords(memory);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const result = yield* retrieveMemoryRecords({
 *       namespace: "facts/user-1",
 *       searchCriteria: {
 *         searchQuery: "what is the user's favorite color?",
 *         topK: 3,
 *       },
 *     });
 *     return HttpServerResponse.json({
 *       records: result.memoryRecordSummaries,
 *     });
 *   }),
 * };
 * ```
 */
export interface RetrieveMemoryRecords extends Binding.Service<
  RetrieveMemoryRecords,
  "AWS.BedrockAgentCore.RetrieveMemoryRecords",
  <R extends Memory>(
    memory: R,
  ) => Effect.Effect<
    (
      request: RetrieveMemoryRecordsRequest,
    ) => Effect.Effect<
      agentcore.RetrieveMemoryRecordsOutput,
      agentcore.RetrieveMemoryRecordsError
    >
  >
> {}
export const RetrieveMemoryRecords = Binding.Service<RetrieveMemoryRecords>(
  "AWS.BedrockAgentCore.RetrieveMemoryRecords",
);
