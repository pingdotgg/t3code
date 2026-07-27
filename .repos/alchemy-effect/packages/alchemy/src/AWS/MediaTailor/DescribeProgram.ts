import type * as mediatailor from "@distilled.cloud/aws/mediatailor";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `mediatailor:DescribeProgram` — read a scheduled
 * program on a channel-assembly channel.
 *
 * Channel/program names are runtime parameters, so the binding is
 * account-level and grants `mediatailor:DescribeProgram` on `*`. Provide the
 * implementation with `Effect.provide(AWS.MediaTailor.DescribeProgramHttp)`.
 *
 * @binding
 * @section Channel Assembly
 * @example Read a scheduled program
 * ```typescript
 * const describeProgram = yield* AWS.MediaTailor.DescribeProgram();
 *
 * const program = yield* describeProgram({
 *   ChannelName: "my-channel",
 *   ProgramName: `episode-${id}`,
 * });
 * ```
 */
export interface DescribeProgram extends Binding.Service<
  DescribeProgram,
  "AWS.MediaTailor.DescribeProgram",
  () => Effect.Effect<
    (
      request: mediatailor.DescribeProgramRequest,
    ) => Effect.Effect<
      mediatailor.DescribeProgramResponse,
      mediatailor.DescribeProgramError
    >
  >
> {}
export const DescribeProgram = Binding.Service<DescribeProgram>(
  "AWS.MediaTailor.DescribeProgram",
);
