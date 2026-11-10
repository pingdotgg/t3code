import * as memorydb from "@distilled.cloud/aws/memorydb";
import * as Layer from "effect/Layer";
import { makeMemoryDBAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeServiceUpdates } from "./DescribeServiceUpdates.ts";

export const DescribeServiceUpdatesHttp = Layer.effect(
  DescribeServiceUpdates,
  makeMemoryDBAccountHttpBinding({
    tag: "AWS.MemoryDB.DescribeServiceUpdates",
    operation: memorydb.describeServiceUpdates,
    actions: ["memorydb:DescribeServiceUpdates"],
  }),
);
