import type * as polly from "@distilled.cloud/aws/polly";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `polly:GetSpeechSynthesisTask` — retrieve the status
 * (and output S3 URI) of an asynchronous synthesis task by its TaskId.
 *
 * The binding takes no arguments and grants the function
 * `polly:GetSpeechSynthesisTask`. Provide the implementation with
 * `Effect.provide(AWS.Polly.GetSpeechSynthesisTaskHttp)`.
 *
 * @binding
 * @section Asynchronous Synthesis
 * @example Poll a synthesis task until it completes
 * ```typescript
 * // init
 * const getSpeechSynthesisTask = yield* AWS.Polly.GetSpeechSynthesisTask();
 *
 * // runtime — bounded poll until the task leaves the queue
 * const task = yield* getSpeechSynthesisTask({ TaskId: taskId }).pipe(
 *   Effect.repeat({
 *     schedule: Schedule.spaced("2 seconds"),
 *     until: (r): boolean =>
 *       r.SynthesisTask?.TaskStatus === "completed" ||
 *       r.SynthesisTask?.TaskStatus === "failed",
 *     times: 25,
 *   }),
 * );
 * ```
 */
export interface GetSpeechSynthesisTask extends Binding.Service<
  GetSpeechSynthesisTask,
  "AWS.Polly.GetSpeechSynthesisTask",
  () => Effect.Effect<
    (
      request: polly.GetSpeechSynthesisTaskInput,
    ) => Effect.Effect<
      polly.GetSpeechSynthesisTaskOutput,
      polly.GetSpeechSynthesisTaskError
    >
  >
> {}
export const GetSpeechSynthesisTask = Binding.Service<GetSpeechSynthesisTask>(
  "AWS.Polly.GetSpeechSynthesisTask",
);
