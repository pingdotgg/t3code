import type * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Memory } from "./Memory.ts";

export interface ListMemoryRecordsRequest extends Omit<
  agentcore.ListMemoryRecordsInput,
  "memoryId"
> {}

/**
 * Lists extracted long-term memory records in a namespace.
 *
 * Bind a {@link Memory} inside a function runtime to enumerate the records
 * the memory's strategies (semantic, summary, user preference, ...) have
 * extracted into a namespace. Provide `AgentCore.ListMemoryRecordsHttp` on
 * the Function effect to implement the binding.
 *
 * @binding
 * @section Listing Memory Records
 * @example List a Namespace's Records
 * ```typescript
 * // init
 * const listMemoryRecords = yield* AgentCore.ListMemoryRecords(memory);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const result = yield* listMemoryRecords({
 *       namespace: "facts/user-1",
 *     });
 *     return HttpServerResponse.json({
 *       count: result.memoryRecordSummaries.length,
 *     });
 *   }),
 * };
 * ```
 */
export interface ListMemoryRecords extends Binding.Service<
  ListMemoryRecords,
  "AWS.BedrockAgentCore.ListMemoryRecords",
  <R extends Memory>(
    memory: R,
  ) => Effect.Effect<
    (
      request: ListMemoryRecordsRequest,
    ) => Effect.Effect<
      agentcore.ListMemoryRecordsOutput,
      agentcore.ListMemoryRecordsError
    >
  >
> {}
export const ListMemoryRecords = Binding.Service<ListMemoryRecords>(
  "AWS.BedrockAgentCore.ListMemoryRecords",
);
