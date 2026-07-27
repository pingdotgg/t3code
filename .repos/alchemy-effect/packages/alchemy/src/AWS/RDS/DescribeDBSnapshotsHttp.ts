import * as rds from "@distilled.cloud/aws/rds";
import * as Layer from "effect/Layer";
import { makeRdsAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeDBSnapshots } from "./DescribeDBSnapshots.ts";

export const DescribeDBSnapshotsHttp = Layer.effect(
  DescribeDBSnapshots,
  makeRdsAccountHttpBinding({
    tag: "AWS.RDS.DescribeDBSnapshots",
    operation: rds.describeDBSnapshots,
    actions: ["rds:DescribeDBSnapshots"],
  }),
);
