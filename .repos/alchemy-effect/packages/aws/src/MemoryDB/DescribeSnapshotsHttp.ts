import * as memorydb from "@distilled.cloud/aws/memorydb";
import * as Layer from "effect/Layer";
import { makeMemoryDBAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeSnapshots } from "./DescribeSnapshots.ts";

export const DescribeSnapshotsHttp = Layer.effect(
  DescribeSnapshots,
  makeMemoryDBAccountHttpBinding({
    tag: "AWS.MemoryDB.DescribeSnapshots",
    operation: memorydb.describeSnapshots,
    actions: ["memorydb:DescribeSnapshots"],
  }),
);
