import type * as polly from "@distilled.cloud/aws/polly";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `polly:ListSpeechSynthesisTasks` — list asynchronous
 * synthesis tasks ordered by creation date, optionally filtered by status.
 *
 * The binding takes no arguments and grants the function
 * `polly:ListSpeechSynthesisTasks`. Provide the implementation with
 * `Effect.provide(AWS.Polly.ListSpeechSynthesisTasksHttp)`.
 *
 * @binding
 * @section Asynchronous Synthesis
 * @example List recently completed tasks
 * ```typescript
 * // init
 * const listSpeechSynthesisTasks = yield* AWS.Polly.ListSpeechSynthesisTasks();
 *
 * // runtime
 * const result = yield* listSpeechSynthesisTasks({
 *   Status: "completed",
 *   MaxResults: 10,
 * });
 * const taskIds = (result.SynthesisTasks ?? []).map((task) => task.TaskId);
 * ```
 */
export interface ListSpeechSynthesisTasks extends Binding.Service<
  ListSpeechSynthesisTasks,
  "AWS.Polly.ListSpeechSynthesisTasks",
  () => Effect.Effect<
    (
      request?: polly.ListSpeechSynthesisTasksInput,
    ) => Effect.Effect<
      polly.ListSpeechSynthesisTasksOutput,
      polly.ListSpeechSynthesisTasksError
    >
  >
> {}
export const ListSpeechSynthesisTasks =
  Binding.Service<ListSpeechSynthesisTasks>(
    "AWS.Polly.ListSpeechSynthesisTasks",
  );
