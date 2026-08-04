import * as redshift from "@distilled.cloud/aws/redshift";
import * as Layer from "effect/Layer";
import { makeRedshiftAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeEvents } from "./DescribeEvents.ts";

export const DescribeEventsHttp = Layer.effect(
  DescribeEvents,
  makeRedshiftAccountHttpBinding({
    tag: "AWS.Redshift.DescribeEvents",
    operation: redshift.describeEvents,
    actions: ["redshift:DescribeEvents"],
  }),
);
