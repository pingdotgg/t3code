import type * as mediatailor from "@distilled.cloud/aws/mediatailor";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { PlaybackConfiguration } from "./PlaybackConfiguration.ts";

/**
 * `DeletePrefetchSchedule` request with `PlaybackConfigurationName` injected
 * from the bound {@link PlaybackConfiguration}.
 */
export interface DeletePrefetchScheduleRequest extends Omit<
  mediatailor.DeletePrefetchScheduleRequest,
  "PlaybackConfigurationName"
> {}

/**
 * Runtime binding for `mediatailor:DeletePrefetchSchedule` — remove a
 * prefetch schedule from the bound {@link PlaybackConfiguration} (e.g. when
 * a live event is cancelled).
 *
 * Provide the implementation with
 * `Effect.provide(AWS.MediaTailor.DeletePrefetchScheduleHttp)`.
 *
 * @binding
 * @section Prefetching Ads
 * @example Delete a prefetch schedule
 * ```typescript
 * const deletePrefetchSchedule = yield* AWS.MediaTailor.DeletePrefetchSchedule(config);
 *
 * yield* deletePrefetchSchedule({ Name: `event-${eventId}` });
 * ```
 */
export interface DeletePrefetchSchedule extends Binding.Service<
  DeletePrefetchSchedule,
  "AWS.MediaTailor.DeletePrefetchSchedule",
  (
    config: PlaybackConfiguration,
  ) => Effect.Effect<
    (
      request: DeletePrefetchScheduleRequest,
    ) => Effect.Effect<
      mediatailor.DeletePrefetchScheduleResponse,
      mediatailor.DeletePrefetchScheduleError
    >
  >
> {}
export const DeletePrefetchSchedule = Binding.Service<DeletePrefetchSchedule>(
  "AWS.MediaTailor.DeletePrefetchSchedule",
);
