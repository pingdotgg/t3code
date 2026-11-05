import * as docdb from "@distilled.cloud/aws/docdb";
import * as Layer from "effect/Layer";
import { makeDocDBAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeEvents } from "./DescribeEvents.ts";

export const DescribeEventsHttp = Layer.effect(
  DescribeEvents,
  makeDocDBAccountHttpBinding({
    tag: "AWS.DocDB.DescribeEvents",
    operation: docdb.describeEvents,
    actions: ["rds:DescribeEvents"],
  }),
);
