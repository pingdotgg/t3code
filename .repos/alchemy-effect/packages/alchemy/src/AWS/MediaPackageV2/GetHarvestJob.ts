import type * as mediapackagev2 from "@distilled.cloud/aws/mediapackagev2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { OriginEndpoint } from "./OriginEndpoint.ts";

/**
 * Runtime binding for `mediapackagev2:GetHarvestJob`.
 *
 * Reads the status of a harvest job on the bound {@link OriginEndpoint} —
 * e.g. polling until a clip export reaches `COMPLETED` before publishing
 * the VOD asset. The endpoint's group, channel, and name are injected from
 * the binding. Provide the implementation with
 * `Effect.provide(AWS.MediaPackageV2.GetHarvestJobHttp)`.
 * @binding
 * @section Harvesting Live-to-VOD Clips
 * @example Poll a Harvest Job Until It Completes
 * ```typescript
 * // init — bind the operation to the endpoint
 * const getHarvestJob = yield* AWS.MediaPackageV2.GetHarvestJob(endpoint);
 *
 * // runtime
 * const { Status } = yield* getHarvestJob({ HarvestJobName: job.HarvestJobName });
 * ```
 */
export interface GetHarvestJob extends Binding.Service<
  GetHarvestJob,
  "AWS.MediaPackageV2.GetHarvestJob",
  (
    endpoint: OriginEndpoint,
  ) => Effect.Effect<
    (
      request: Omit<
        mediapackagev2.GetHarvestJobRequest,
        "ChannelGroupName" | "ChannelName" | "OriginEndpointName"
      >,
    ) => Effect.Effect<
      mediapackagev2.GetHarvestJobResponse,
      mediapackagev2.GetHarvestJobError
    >
  >
> {}
export const GetHarvestJob = Binding.Service<GetHarvestJob>(
  "AWS.MediaPackageV2.GetHarvestJob",
);
