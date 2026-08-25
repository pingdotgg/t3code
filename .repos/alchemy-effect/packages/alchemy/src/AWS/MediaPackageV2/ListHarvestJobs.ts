import type * as mediapackagev2 from "@distilled.cloud/aws/mediapackagev2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ChannelGroup } from "./ChannelGroup.ts";

/**
 * Runtime binding for `mediapackagev2:ListHarvestJobs`.
 *
 * Enumerates the harvest jobs in the bound {@link ChannelGroup}, optionally
 * filtered by channel, endpoint, or status — e.g. a dashboard Lambda
 * listing in-progress clip exports. The group's name is injected from the
 * binding. Provide the implementation with
 * `Effect.provide(AWS.MediaPackageV2.ListHarvestJobsHttp)`.
 * @binding
 * @section Harvesting Live-to-VOD Clips
 * @example List the Group's Queued Harvest Jobs
 * ```typescript
 * // init — bind the operation to the channel group
 * const listHarvestJobs = yield* AWS.MediaPackageV2.ListHarvestJobs(group);
 *
 * // runtime
 * const { Items } = yield* listHarvestJobs({ Status: "QUEUED" });
 * ```
 */
export interface ListHarvestJobs extends Binding.Service<
  ListHarvestJobs,
  "AWS.MediaPackageV2.ListHarvestJobs",
  (
    group: ChannelGroup,
  ) => Effect.Effect<
    (
      request?: Omit<mediapackagev2.ListHarvestJobsRequest, "ChannelGroupName">,
    ) => Effect.Effect<
      mediapackagev2.ListHarvestJobsResponse,
      mediapackagev2.ListHarvestJobsError
    >
  >
> {}
export const ListHarvestJobs = Binding.Service<ListHarvestJobs>(
  "AWS.MediaPackageV2.ListHarvestJobs",
);
