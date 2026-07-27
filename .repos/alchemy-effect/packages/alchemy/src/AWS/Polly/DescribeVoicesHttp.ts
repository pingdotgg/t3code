import * as polly from "@distilled.cloud/aws/polly";
import * as Layer from "effect/Layer";
import { makePollyHttpBinding } from "./BindingHttp.ts";
import { DescribeVoices } from "./DescribeVoices.ts";

export const DescribeVoicesHttp = Layer.effect(
  DescribeVoices,
  makePollyHttpBinding({
    capability: "DescribeVoices",
    iamActions: ["polly:DescribeVoices"],
    operation: polly.describeVoices,
  }),
);
