import type * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Memory } from "./Memory.ts";

export interface StartMemoryExtractionJobRequest extends Omit<
  agentcore.StartMemoryExtractionJobInput,
  "memoryId"
> {}

/**
 * Starts an on-demand long-term extraction job over recorded events.
 *
 * Bind a {@link Memory} inside a function runtime to call the
 * AgentCore data-plane API against it. Provide `AgentCore.StartMemoryExtractionJobHttp`
 * on the Function effect to implement the binding.
 *
 * @binding
 * @section Extraction Jobs
 * @example Start an Extraction Job
 * ```typescript
 * // init
 * const startMemoryExtractionJob = yield* AgentCore.StartMemoryExtractionJob(memory);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const result = yield* startMemoryExtractionJob({
 *       extractionJob: { jobId },
 *     });
 *     return HttpServerResponse.json({ jobId: result.jobId });
 *   }),
 * };
 * ```
 */
export interface StartMemoryExtractionJob extends Binding.Service<
  StartMemoryExtractionJob,
  "AWS.BedrockAgentCore.StartMemoryExtractionJob",
  <R extends Memory>(
    memory: R,
  ) => Effect.Effect<
    (
      request: StartMemoryExtractionJobRequest,
    ) => Effect.Effect<
      agentcore.StartMemoryExtractionJobOutput,
      agentcore.StartMemoryExtractionJobError
    >
  >
> {}
export const StartMemoryExtractionJob =
  Binding.Service<StartMemoryExtractionJob>(
    "AWS.BedrockAgentCore.StartMemoryExtractionJob",
  );
