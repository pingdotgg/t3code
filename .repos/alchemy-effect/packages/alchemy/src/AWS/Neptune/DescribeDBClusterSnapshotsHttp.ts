import * as neptune from "@distilled.cloud/aws/neptune";
import * as Layer from "effect/Layer";
import { makeNeptuneAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeDBClusterSnapshots } from "./DescribeDBClusterSnapshots.ts";

export const DescribeDBClusterSnapshotsHttp = Layer.effect(
  DescribeDBClusterSnapshots,
  makeNeptuneAccountHttpBinding({
    tag: "AWS.Neptune.DescribeDBClusterSnapshots",
    operation: neptune.describeDBClusterSnapshots,
    actions: ["rds:DescribeDBClusterSnapshots"],
  }),
);
