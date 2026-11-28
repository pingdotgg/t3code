import * as neptune from "@distilled.cloud/aws/neptune";
import * as Layer from "effect/Layer";
import { makeNeptuneAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeEvents } from "./DescribeEvents.ts";

export const DescribeEventsHttp = Layer.effect(
  DescribeEvents,
  makeNeptuneAccountHttpBinding({
    tag: "AWS.Neptune.DescribeEvents",
    operation: neptune.describeEvents,
    actions: ["rds:DescribeEvents"],
  }),
);
