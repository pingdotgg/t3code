import * as rds from "@distilled.cloud/aws/rds";
import * as Layer from "effect/Layer";
import { makeRdsAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeEvents } from "./DescribeEvents.ts";

export const DescribeEventsHttp = Layer.effect(
  DescribeEvents,
  makeRdsAccountHttpBinding({
    tag: "AWS.RDS.DescribeEvents",
    operation: rds.describeEvents,
    actions: ["rds:DescribeEvents"],
  }),
);
