import * as iot from "@distilled.cloud/aws/iot";
import * as Layer from "effect/Layer";
import { makeIotAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeEndpoint } from "./DescribeEndpoint.ts";

/**
 * HTTP implementation of the {@link DescribeEndpoint} capability — grants
 * `iot:DescribeEndpoint` on `*` and calls the IoT `DescribeEndpoint` API.
 */
export const DescribeEndpointHttp = Layer.effect(
  DescribeEndpoint,
  makeIotAccountHttpBinding({
    tag: "AWS.IoT.DescribeEndpoint",
    operation: iot.describeEndpoint,
    actions: ["iot:DescribeEndpoint"],
  }),
);
