import * as synthetics from "@distilled.cloud/aws/synthetics";
import * as Layer from "effect/Layer";
import { makeSyntheticsCanaryHttpBinding } from "./BindingHttp.ts";
import { StartCanary } from "./StartCanary.ts";

export const StartCanaryHttp = Layer.effect(
  StartCanary,
  makeSyntheticsCanaryHttpBinding({
    tag: "AWS.Synthetics.StartCanary",
    operation: synthetics.startCanary,
    actions: ["synthetics:StartCanary"],
  }),
);
