import * as sagemaker from "@distilled.cloud/aws/sagemaker";
import * as Layer from "effect/Layer";
import { makeEndpointHttpBinding } from "./BindingHttp.ts";
import { DescribeEndpoint } from "./DescribeEndpoint.ts";

export const DescribeEndpointHttp = Layer.effect(
  DescribeEndpoint,
  makeEndpointHttpBinding({
    tag: "AWS.SageMaker.DescribeEndpoint",
    operation: sagemaker.describeEndpoint,
    actions: ["sagemaker:DescribeEndpoint"],
  }),
);
