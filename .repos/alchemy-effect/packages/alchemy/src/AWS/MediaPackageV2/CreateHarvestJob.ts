import type * as mediapackagev2 from "@distilled.cloud/aws/mediapackagev2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { OriginEndpoint } from "./OriginEndpoint.ts";

/**
 * Runtime binding for `mediapackagev2:CreateHarvestJob`.
 *
 * Exports a clip of previously streamed content from the bound
 * {@link OriginEndpoint} to an S3 bucket as a live-to-VOD asset — e.g. a
 * Lambda that clips a highlight when an operator flags a moment. The
 * endpoint must have a startover window covering the requested schedule,
 * and the destination bucket needs a policy granting the
 * `mediapackagev2.amazonaws.com` service principal write access. The
 * endpoint's group, channel, and name are injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.MediaPackageV2.CreateHarvestJobHttp)`.
 * @binding
 * @section Harvesting Live-to-VOD Clips
 * @example Harvest the Last Five Minutes to S3
 * ```typescript
 * // init — bind the operation to the endpoint
 * const createHarvestJob = yield* AWS.MediaPackageV2.CreateHarvestJob(endpoint);
 *
 * // runtime
 * const job = yield* createHarvestJob({
 *   HarvestedManifests: { HlsManifests: [{ ManifestName: "index" }] },
 *   ScheduleConfiguration: {
 *     StartTime: new Date(Date.now() - 5 * 60_000),
 *     EndTime: new Date(),
 *   },
 *   Destination: {
 *     S3Destination: { BucketName: "my-clips", DestinationPath: "highlights/" },
 *   },
 * });
 * ```
 */
export interface CreateHarvestJob extends Binding.Service<
  CreateHarvestJob,
  "AWS.MediaPackageV2.CreateHarvestJob",
  (
    endpoint: OriginEndpoint,
  ) => Effect.Effect<
    (
      request: Omit<
        mediapackagev2.CreateHarvestJobRequest,
        "ChannelGroupName" | "ChannelName" | "OriginEndpointName"
      >,
    ) => Effect.Effect<
      mediapackagev2.CreateHarvestJobResponse,
      mediapackagev2.CreateHarvestJobError
    >
  >
> {}
export const CreateHarvestJob = Binding.Service<CreateHarvestJob>(
  "AWS.MediaPackageV2.CreateHarvestJob",
);
