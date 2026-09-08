import * as sesv2 from "@distilled.cloud/aws/sesv2";
import * as Layer from "effect/Layer";
import { makeSESHttpBinding } from "./BindingHttp.ts";
import { BatchGetMetricData } from "./BatchGetMetricData.ts";

export const BatchGetMetricDataHttp = Layer.effect(
  BatchGetMetricData,
  makeSESHttpBinding({
    tag: "AWS.SES.BatchGetMetricData",
    operation: sesv2.batchGetMetricData,
    actions: ["ses:BatchGetMetricData"],
  }),
);
