import type * as mediapackagev2 from "@distilled.cloud/aws/mediapackagev2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { OriginEndpoint } from "./OriginEndpoint.ts";

/**
 * Runtime binding for `mediapackagev2:CancelHarvestJob`.
 *
 * Cancels a queued or in-progress harvest job on the bound
 * {@link OriginEndpoint} — e.g. aborting a clip export the operator
 * withdrew. The endpoint's group, channel, and name are injected from the
 * binding. Provide the implementation with
 * `Effect.provide(AWS.MediaPackageV2.CancelHarvestJobHttp)`.
 * @binding
 * @section Harvesting Live-to-VOD Clips
 * @example Cancel an In-Progress Harvest Job
 * ```typescript
 * // init — bind the operation to the endpoint
 * const cancelHarvestJob = yield* AWS.MediaPackageV2.CancelHarvestJob(endpoint);
 *
 * // runtime
 * yield* cancelHarvestJob({ HarvestJobName: job.HarvestJobName });
 * ```
 */
export interface CancelHarvestJob extends Binding.Service<
  CancelHarvestJob,
  "AWS.MediaPackageV2.CancelHarvestJob",
  (
    endpoint: OriginEndpoint,
  ) => Effect.Effect<
    (
      request: Omit<
        mediapackagev2.CancelHarvestJobRequest,
        "ChannelGroupName" | "ChannelName" | "OriginEndpointName"
      >,
    ) => Effect.Effect<
      mediapackagev2.CancelHarvestJobResponse,
      mediapackagev2.CancelHarvestJobError
    >
  >
> {}
export const CancelHarvestJob = Binding.Service<CancelHarvestJob>(
  "AWS.MediaPackageV2.CancelHarvestJob",
);
