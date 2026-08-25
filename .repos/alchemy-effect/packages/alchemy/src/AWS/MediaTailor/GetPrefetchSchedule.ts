import type * as mediatailor from "@distilled.cloud/aws/mediatailor";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { PlaybackConfiguration } from "./PlaybackConfiguration.ts";

/**
 * `GetPrefetchSchedule` request with `PlaybackConfigurationName` injected
 * from the bound {@link PlaybackConfiguration}.
 */
export interface GetPrefetchScheduleRequest extends Omit<
  mediatailor.GetPrefetchScheduleRequest,
  "PlaybackConfigurationName"
> {}

/**
 * Runtime binding for `mediatailor:GetPrefetchSchedule` — read a prefetch
 * schedule on the bound {@link PlaybackConfiguration} by name.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.MediaTailor.GetPrefetchScheduleHttp)`.
 *
 * @binding
 * @section Prefetching Ads
 * @example Read a prefetch schedule
 * ```typescript
 * const getPrefetchSchedule = yield* AWS.MediaTailor.GetPrefetchSchedule(config);
 *
 * const schedule = yield* getPrefetchSchedule({ Name: `event-${eventId}` });
 * ```
 */
export interface GetPrefetchSchedule extends Binding.Service<
  GetPrefetchSchedule,
  "AWS.MediaTailor.GetPrefetchSchedule",
  (
    config: PlaybackConfiguration,
  ) => Effect.Effect<
    (
      request: GetPrefetchScheduleRequest,
    ) => Effect.Effect<
      mediatailor.GetPrefetchScheduleResponse,
      mediatailor.GetPrefetchScheduleError
    >
  >
> {}
export const GetPrefetchSchedule = Binding.Service<GetPrefetchSchedule>(
  "AWS.MediaTailor.GetPrefetchSchedule",
);
