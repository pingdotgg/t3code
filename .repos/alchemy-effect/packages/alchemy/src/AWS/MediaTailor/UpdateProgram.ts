import type * as mediatailor from "@distilled.cloud/aws/mediatailor";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `mediatailor:UpdateProgram` — move or re-configure a
 * scheduled program on a channel-assembly channel (e.g. change its
 * transition or ad breaks) before it plays.
 *
 * Channel/program names are runtime parameters, so the binding is
 * account-level and grants `mediatailor:UpdateProgram` on `*`. Provide the
 * implementation with `Effect.provide(AWS.MediaTailor.UpdateProgramHttp)`.
 *
 * @binding
 * @section Channel Assembly
 * @example Reschedule a program
 * ```typescript
 * const updateProgram = yield* AWS.MediaTailor.UpdateProgram();
 *
 * yield* updateProgram({
 *   ChannelName: "my-channel",
 *   ProgramName: `episode-${id}`,
 *   ScheduleConfiguration: { Transition: { ScheduledStartTimeMillis: startAt } },
 * });
 * ```
 */
export interface UpdateProgram extends Binding.Service<
  UpdateProgram,
  "AWS.MediaTailor.UpdateProgram",
  () => Effect.Effect<
    (
      request: mediatailor.UpdateProgramRequest,
    ) => Effect.Effect<
      mediatailor.UpdateProgramResponse,
      mediatailor.UpdateProgramError
    >
  >
> {}
export const UpdateProgram = Binding.Service<UpdateProgram>(
  "AWS.MediaTailor.UpdateProgram",
);
