import * as dax from "@distilled.cloud/aws/dax";
import * as Layer from "effect/Layer";
import { makeDaxAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeEvents } from "./DescribeEvents.ts";

export const DescribeEventsHttp = Layer.effect(
  DescribeEvents,
  makeDaxAccountHttpBinding({
    tag: "AWS.DAX.DescribeEvents",
    operation: dax.describeEvents,
    actions: ["dax:DescribeEvents"],
  }),
);
