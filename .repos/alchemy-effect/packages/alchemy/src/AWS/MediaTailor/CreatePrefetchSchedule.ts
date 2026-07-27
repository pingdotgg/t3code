import type * as mediatailor from "@distilled.cloud/aws/mediatailor";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { PlaybackConfiguration } from "./PlaybackConfiguration.ts";

/**
 * `CreatePrefetchSchedule` request with `PlaybackConfigurationName` injected
 * from the bound {@link PlaybackConfiguration}.
 */
export interface CreatePrefetchScheduleRequest extends Omit<
  mediatailor.CreatePrefetchScheduleRequest,
  "PlaybackConfigurationName"
> {}

/**
 * Runtime binding for `mediatailor:CreatePrefetchSchedule` — tell MediaTailor
 * to fetch and prepare ads for upcoming ad breaks ahead of time (e.g. right
 * before a live event's scheduled break) so avails fill without ADS latency.
 *
 * The bound {@link PlaybackConfiguration}'s name is injected; the grant is
 * scoped to that configuration's prefetch-schedule ARN space. Provide the
 * implementation with `Effect.provide(AWS.MediaTailor.CreatePrefetchScheduleHttp)`.
 *
 * @binding
 * @section Prefetching Ads
 * @example Prefetch ads for an upcoming break
 * ```typescript
 * const createPrefetchSchedule = yield* AWS.MediaTailor.CreatePrefetchSchedule(config);
 *
 * const schedule = yield* createPrefetchSchedule({
 *   Name: `event-${eventId}`,
 *   Retrieval: { EndTime: retrievalDeadline },
 *   Consumption: { EndTime: breakEnd },
 * });
 * ```
 */
export interface CreatePrefetchSchedule extends Binding.Service<
  CreatePrefetchSchedule,
  "AWS.MediaTailor.CreatePrefetchSchedule",
  (
    config: PlaybackConfiguration,
  ) => Effect.Effect<
    (
      request: CreatePrefetchScheduleRequest,
    ) => Effect.Effect<
      mediatailor.CreatePrefetchScheduleResponse,
      mediatailor.CreatePrefetchScheduleError
    >
  >
> {}
export const CreatePrefetchSchedule = Binding.Service<CreatePrefetchSchedule>(
  "AWS.MediaTailor.CreatePrefetchSchedule",
);
