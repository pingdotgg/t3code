import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Layer from "effect/Layer";
import { makeKinesisAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeLimits } from "./DescribeLimits.ts";

export const DescribeLimitsHttp = Layer.effect(
  DescribeLimits,
  makeKinesisAccountHttpBinding({
    tag: "AWS.Kinesis.DescribeLimits",
    operation: Kinesis.describeLimits,
    actions: ["kinesis:DescribeLimits"],
  }),
);
