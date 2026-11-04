import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Layer from "effect/Layer";
import { makeStreamHttpBinding } from "./BindingHttp.ts";
import { DescribeStreamSummary } from "./DescribeStreamSummary.ts";

export const DescribeStreamSummaryHttp = Layer.effect(
  DescribeStreamSummary,
  makeStreamHttpBinding({
    tag: "AWS.Kinesis.DescribeStreamSummary",
    operation: Kinesis.describeStreamSummary,
    actions: ["kinesis:DescribeStreamSummary"],
    key: "StreamARN",
  }),
);
