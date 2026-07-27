import type * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Memory } from "./Memory.ts";

export interface GetMemoryRecordRequest extends Omit<
  agentcore.GetMemoryRecordInput,
  "memoryId"
> {}

/**
 * Fetches a single extracted long-term memory record.
 *
 * Bind a {@link Memory} inside a function runtime to call the
 * AgentCore data-plane API against it. Provide `AgentCore.GetMemoryRecordHttp`
 * on the Function effect to implement the binding.
 *
 * @binding
 * @section Reading Memory Records
 * @example Fetch a Record by Id
 * ```typescript
 * // init
 * const getMemoryRecord = yield* AgentCore.GetMemoryRecord(memory);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const result = yield* getMemoryRecord({ memoryRecordId });
 *     return HttpServerResponse.json({ record: result.memoryRecord });
 *   }),
 * };
 * ```
 */
export interface GetMemoryRecord extends Binding.Service<
  GetMemoryRecord,
  "AWS.BedrockAgentCore.GetMemoryRecord",
  <R extends Memory>(
    memory: R,
  ) => Effect.Effect<
    (
      request: GetMemoryRecordRequest,
    ) => Effect.Effect<
      agentcore.GetMemoryRecordOutput,
      agentcore.GetMemoryRecordError
    >
  >
> {}
export const GetMemoryRecord = Binding.Service<GetMemoryRecord>(
  "AWS.BedrockAgentCore.GetMemoryRecord",
);
