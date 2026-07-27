import type * as mediatailor from "@distilled.cloud/aws/mediatailor";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `mediatailor:DeleteProgram` — remove a scheduled
 * program from a channel-assembly channel.
 *
 * Channel/program names are runtime parameters, so the binding is
 * account-level and grants `mediatailor:DeleteProgram` on `*`. Provide the
 * implementation with `Effect.provide(AWS.MediaTailor.DeleteProgramHttp)`.
 *
 * @binding
 * @section Channel Assembly
 * @example Remove a program from the schedule
 * ```typescript
 * const deleteProgram = yield* AWS.MediaTailor.DeleteProgram();
 *
 * yield* deleteProgram({
 *   ChannelName: "my-channel",
 *   ProgramName: `episode-${id}`,
 * });
 * ```
 */
export interface DeleteProgram extends Binding.Service<
  DeleteProgram,
  "AWS.MediaTailor.DeleteProgram",
  () => Effect.Effect<
    (
      request: mediatailor.DeleteProgramRequest,
    ) => Effect.Effect<
      mediatailor.DeleteProgramResponse,
      mediatailor.DeleteProgramError
    >
  >
> {}
export const DeleteProgram = Binding.Service<DeleteProgram>(
  "AWS.MediaTailor.DeleteProgram",
);
