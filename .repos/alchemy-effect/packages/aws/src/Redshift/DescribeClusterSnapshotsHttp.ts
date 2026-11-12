import * as redshift from "@distilled.cloud/aws/redshift";
import * as Layer from "effect/Layer";
import { makeRedshiftAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeClusterSnapshots } from "./DescribeClusterSnapshots.ts";

export const DescribeClusterSnapshotsHttp = Layer.effect(
  DescribeClusterSnapshots,
  makeRedshiftAccountHttpBinding({
    tag: "AWS.Redshift.DescribeClusterSnapshots",
    operation: redshift.describeClusterSnapshots,
    actions: ["redshift:DescribeClusterSnapshots"],
  }),
);
