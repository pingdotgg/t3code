import * as dms from "@distilled.cloud/aws/database-migration-service";
import * as Layer from "effect/Layer";
import { makeDmsAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeEvents } from "./DescribeEvents.ts";

export const DescribeEventsHttp = Layer.effect(
  DescribeEvents,
  makeDmsAccountHttpBinding({
    tag: "AWS.DMS.DescribeEvents",
    actions: ["dms:DescribeEvents"],
    operation: dms.describeEvents,
  }),
);
