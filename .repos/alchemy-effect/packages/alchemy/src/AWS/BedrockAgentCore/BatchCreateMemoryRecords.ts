import type * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Memory } from "./Memory.ts";

export interface BatchCreateMemoryRecordsRequest extends Omit<
  agentcore.BatchCreateMemoryRecordsInput,
  "memoryId"
> {}

/**
 * Directly inserts long-term memory records, bypassing asynchronous extraction.
 *
 * Bind a {@link Memory} inside a function runtime to call the
 * AgentCore data-plane API against it. Provide `AgentCore.BatchCreateMemoryRecordsHttp`
 * on the Function effect to implement the binding.
 *
 * @binding
 * @section Writing Memory Records
 * @example Insert a Record Directly
 * ```typescript
 * // init
 * const batchCreateMemoryRecords = yield* AgentCore.BatchCreateMemoryRecords(memory);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const result = yield* batchCreateMemoryRecords({
 *       records: [
 *         {
 *           requestIdentifier: "rec-1",
 *           namespaces: ["facts/user-1"],
 *           content: { text: "The user's favorite color is teal." },
 *           timestamp: new Date(),
 *         },
 *       ],
 *     });
 *     return HttpServerResponse.json({
 *       created: result.successfulRecords.length,
 *     });
 *   }),
 * };
 * ```
 */
export interface BatchCreateMemoryRecords extends Binding.Service<
  BatchCreateMemoryRecords,
  "AWS.BedrockAgentCore.BatchCreateMemoryRecords",
  <R extends Memory>(
    memory: R,
  ) => Effect.Effect<
    (
      request: BatchCreateMemoryRecordsRequest,
    ) => Effect.Effect<
      agentcore.BatchCreateMemoryRecordsOutput,
      agentcore.BatchCreateMemoryRecordsError
    >
  >
> {}
export const BatchCreateMemoryRecords =
  Binding.Service<BatchCreateMemoryRecords>(
    "AWS.BedrockAgentCore.BatchCreateMemoryRecords",
  );
