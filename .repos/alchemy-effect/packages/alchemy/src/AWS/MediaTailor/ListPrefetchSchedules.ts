import type * as mediatailor from "@distilled.cloud/aws/mediatailor";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { PlaybackConfiguration } from "./PlaybackConfiguration.ts";

/**
 * `ListPrefetchSchedules` request with `PlaybackConfigurationName` injected
 * from the bound {@link PlaybackConfiguration}.
 */
export interface ListPrefetchSchedulesRequest extends Omit<
  mediatailor.ListPrefetchSchedulesRequest,
  "PlaybackConfigurationName"
> {}

/**
 * Runtime binding for `mediatailor:ListPrefetchSchedules` — page through the
 * prefetch schedules on the bound {@link PlaybackConfiguration}, optionally
 * filtered by `StreamId` or `ScheduleType`.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.MediaTailor.ListPrefetchSchedulesHttp)`.
 *
 * @binding
 * @section Prefetching Ads
 * @example List prefetch schedules for a stream
 * ```typescript
 * const listPrefetchSchedules = yield* AWS.MediaTailor.ListPrefetchSchedules(config);
 *
 * const { Items } = yield* listPrefetchSchedules({ StreamId: streamId });
 * ```
 */
export interface ListPrefetchSchedules extends Binding.Service<
  ListPrefetchSchedules,
  "AWS.MediaTailor.ListPrefetchSchedules",
  (
    config: PlaybackConfiguration,
  ) => Effect.Effect<
    (
      request: ListPrefetchSchedulesRequest,
    ) => Effect.Effect<
      mediatailor.ListPrefetchSchedulesResponse,
      mediatailor.ListPrefetchSchedulesError
    >
  >
> {}
export const ListPrefetchSchedules = Binding.Service<ListPrefetchSchedules>(
  "AWS.MediaTailor.ListPrefetchSchedules",
);
