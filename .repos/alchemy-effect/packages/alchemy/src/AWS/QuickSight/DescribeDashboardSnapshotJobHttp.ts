import * as quicksight from "@distilled.cloud/aws/quicksight";
import * as Layer from "effect/Layer";
import { makeQuickSightDashboardHttpBinding } from "./BindingHttp.ts";
import { DescribeDashboardSnapshotJob } from "./DescribeDashboardSnapshotJob.ts";

export const DescribeDashboardSnapshotJobHttp = Layer.effect(
  DescribeDashboardSnapshotJob,
  makeQuickSightDashboardHttpBinding({
    tag: "AWS.QuickSight.DescribeDashboardSnapshotJob",
    operation: quicksight.describeDashboardSnapshotJob,
    actions: ["quicksight:DescribeDashboardSnapshotJob"],
  }),
);
