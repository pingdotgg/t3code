import * as memorydb from "@distilled.cloud/aws/memorydb";
import * as Layer from "effect/Layer";
import { makeMemoryDBAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeEvents } from "./DescribeEvents.ts";

export const DescribeEventsHttp = Layer.effect(
  DescribeEvents,
  makeMemoryDBAccountHttpBinding({
    tag: "AWS.MemoryDB.DescribeEvents",
    operation: memorydb.describeEvents,
    actions: ["memorydb:DescribeEvents"],
  }),
);
