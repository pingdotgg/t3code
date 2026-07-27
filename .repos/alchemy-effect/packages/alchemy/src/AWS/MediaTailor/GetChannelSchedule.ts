import type * as mediatailor from "@distilled.cloud/aws/mediatailor";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `mediatailor:GetChannelSchedule` — read the current
 * schedule (programs + ad breaks) of a channel-assembly channel.
 *
 * Channel names are runtime parameters, so the binding is account-level and
 * grants `mediatailor:GetChannelSchedule` on `*`. Provide the implementation
 * with `Effect.provide(AWS.MediaTailor.GetChannelScheduleHttp)`.
 *
 * @binding
 * @section Channel Assembly
 * @example Read a channel's schedule
 * ```typescript
 * const getChannelSchedule = yield* AWS.MediaTailor.GetChannelSchedule();
 *
 * const { Items } = yield* getChannelSchedule({ ChannelName: "my-channel" });
 * ```
 */
export interface GetChannelSchedule extends Binding.Service<
  GetChannelSchedule,
  "AWS.MediaTailor.GetChannelSchedule",
  () => Effect.Effect<
    (
      request: mediatailor.GetChannelScheduleRequest,
    ) => Effect.Effect<
      mediatailor.GetChannelScheduleResponse,
      mediatailor.GetChannelScheduleError
    >
  >
> {}
export const GetChannelSchedule = Binding.Service<GetChannelSchedule>(
  "AWS.MediaTailor.GetChannelSchedule",
);
