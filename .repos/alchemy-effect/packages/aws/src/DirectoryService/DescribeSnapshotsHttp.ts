import * as ds from "@distilled.cloud/aws/directory-service";
import * as Layer from "effect/Layer";
import { makeDirectoryHttpBinding } from "./BindingHttp.ts";
import { DescribeSnapshots } from "./DescribeSnapshots.ts";

export const DescribeSnapshotsHttp = Layer.effect(
  DescribeSnapshots,
  makeDirectoryHttpBinding({
    tag: "AWS.DirectoryService.DescribeSnapshots",
    operation: ds.describeSnapshots,
    actions: ["ds:DescribeSnapshots"],
  }),
);
