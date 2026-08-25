import * as dms from "@distilled.cloud/aws/database-migration-service";
import * as Layer from "effect/Layer";
import { makeDmsAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeTableStatistics } from "./DescribeTableStatistics.ts";

export const DescribeTableStatisticsHttp = Layer.effect(
  DescribeTableStatistics,
  makeDmsAccountHttpBinding({
    tag: "AWS.DMS.DescribeTableStatistics",
    actions: ["dms:DescribeTableStatistics"],
    operation: dms.describeTableStatistics,
  }),
);
