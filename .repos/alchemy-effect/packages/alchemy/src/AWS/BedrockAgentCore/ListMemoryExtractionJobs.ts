import type * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Memory } from "./Memory.ts";

export interface ListMemoryExtractionJobsRequest extends Omit<
  agentcore.ListMemoryExtractionJobsInput,
  "memoryId"
> {}

/**
 * Lists the memory's long-term extraction jobs.
 *
 * Bind a {@link Memory} inside a function runtime to call the
 * AgentCore data-plane API against it. Provide `AgentCore.ListMemoryExtractionJobsHttp`
 * on the Function effect to implement the binding.
 *
 * @binding
 * @section Extraction Jobs
 * @example List Extraction Jobs
 * ```typescript
 * // init
 * const listMemoryExtractionJobs = yield* AgentCore.ListMemoryExtractionJobs(memory);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const result = yield* listMemoryExtractionJobs({});
 *     return HttpServerResponse.json({
 *       count: result.jobs.length,
 *     });
 *   }),
 * };
 * ```
 */
export interface ListMemoryExtractionJobs extends Binding.Service<
  ListMemoryExtractionJobs,
  "AWS.BedrockAgentCore.ListMemoryExtractionJobs",
  <R extends Memory>(
    memory: R,
  ) => Effect.Effect<
    (
      request: ListMemoryExtractionJobsRequest,
    ) => Effect.Effect<
      agentcore.ListMemoryExtractionJobsOutput,
      agentcore.ListMemoryExtractionJobsError
    >
  >
> {}
export const ListMemoryExtractionJobs =
  Binding.Service<ListMemoryExtractionJobs>(
    "AWS.BedrockAgentCore.ListMemoryExtractionJobs",
  );
