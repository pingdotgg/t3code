import * as iot from "@distilled.cloud/aws/iot";
import * as Layer from "effect/Layer";
import { makeIotThingHttpBinding } from "./BindingHttp.ts";
import { DescribeThing } from "./DescribeThing.ts";

/**
 * HTTP implementation of the {@link DescribeThing} capability — grants
 * `iot:DescribeThing` on the thing ARN and calls the IoT `DescribeThing`
 * API.
 */
export const DescribeThingHttp = Layer.effect(
  DescribeThing,
  makeIotThingHttpBinding({
    tag: "AWS.IoT.DescribeThing",
    operation: iot.describeThing,
    actions: ["iot:DescribeThing"],
  }),
);
