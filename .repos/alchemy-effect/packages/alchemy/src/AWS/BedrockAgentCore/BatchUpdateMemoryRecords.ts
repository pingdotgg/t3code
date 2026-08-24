import type * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Memory } from "./Memory.ts";

export interface BatchUpdateMemoryRecordsRequest extends Omit<
  agentcore.BatchUpdateMemoryRecordsInput,
  "memoryId"
> {}

/**
 * Updates long-term memory records in bulk.
 *
 * Bind a {@link Memory} inside a function runtime to call the
 * AgentCore data-plane API against it. Provide `AgentCore.BatchUpdateMemoryRecordsHttp`
 * on the Function effect to implement the binding.
 *
 * @binding
 * @section Writing Memory Records
 * @example Update a Record's Content
 * ```typescript
 * // init
 * const batchUpdateMemoryRecords = yield* AgentCore.BatchUpdateMemoryRecords(memory);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const result = yield* batchUpdateMemoryRecords({
 *       records: [
 *         {
 *           memoryRecordId,
 *           timestamp: new Date(),
 *           content: { text: "The user's favorite color is green." },
 *           namespaces: ["facts/user-1"],
 *         },
 *       ],
 *     });
 *     return HttpServerResponse.json({
 *       updated: result.successfulRecords.length,
 *     });
 *   }),
 * };
 * ```
 */
export interface BatchUpdateMemoryRecords extends Binding.Service<
  BatchUpdateMemoryRecords,
  "AWS.BedrockAgentCore.BatchUpdateMemoryRecords",
  <R extends Memory>(
    memory: R,
  ) => Effect.Effect<
    (
      request: BatchUpdateMemoryRecordsRequest,
    ) => Effect.Effect<
      agentcore.BatchUpdateMemoryRecordsOutput,
      agentcore.BatchUpdateMemoryRecordsError
    >
  >
> {}
export const BatchUpdateMemoryRecords =
  Binding.Service<BatchUpdateMemoryRecords>(
    "AWS.BedrockAgentCore.BatchUpdateMemoryRecords",
  );
