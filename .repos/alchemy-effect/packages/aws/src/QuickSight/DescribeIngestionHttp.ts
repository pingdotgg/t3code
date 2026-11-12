import * as quicksight from "@distilled.cloud/aws/quicksight";
import * as Layer from "effect/Layer";
import { makeQuickSightDataSetHttpBinding } from "./BindingHttp.ts";
import { DescribeIngestion } from "./DescribeIngestion.ts";

export const DescribeIngestionHttp = Layer.effect(
  DescribeIngestion,
  makeQuickSightDataSetHttpBinding({
    tag: "AWS.QuickSight.DescribeIngestion",
    operation: quicksight.describeIngestion,
    actions: ["quicksight:DescribeIngestion"],
  }),
);
