import * as quicksight from "@distilled.cloud/aws/quicksight";
import * as Layer from "effect/Layer";
import { makeQuickSightDashboardHttpBinding } from "./BindingHttp.ts";
import { StartDashboardSnapshotJob } from "./StartDashboardSnapshotJob.ts";

export const StartDashboardSnapshotJobHttp = Layer.effect(
  StartDashboardSnapshotJob,
  makeQuickSightDashboardHttpBinding({
    tag: "AWS.QuickSight.StartDashboardSnapshotJob",
    operation: quicksight.startDashboardSnapshotJob,
    actions: ["quicksight:StartDashboardSnapshotJob"],
  }),
);
