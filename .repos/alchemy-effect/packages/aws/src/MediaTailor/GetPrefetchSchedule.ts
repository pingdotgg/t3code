import type * as mediatailor from "@distilled.cloud/aws/mediatailor";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
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
 * ### Prefetching Ads
 * **Example:** Read a prefetch schedule
 * ```typescript
 * const getPrefetchSchedule = yield* AWS.MediaTailor.GetPrefetchSchedule(config);
 *
 * const schedule = yield* getPrefetchSchedule({ Name: `event-${eventId}` });
 * ```
 *
 * @binding
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
