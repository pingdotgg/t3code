import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Layer from "effect/Layer";
import { makeStreamHttpBinding } from "./BindingHttp.ts";
import { DescribeStream } from "./DescribeStream.ts";

export const DescribeStreamHttp = Layer.effect(
  DescribeStream,
  makeStreamHttpBinding({
    tag: "AWS.Kinesis.DescribeStream",
    operation: Kinesis.describeStream,
    actions: ["kinesis:DescribeStream"],
    key: "StreamARN",
  }),
);
