import * as synthetics from "@distilled.cloud/aws/synthetics";
import * as Layer from "effect/Layer";
import { makeSyntheticsCanaryHttpBinding } from "./BindingHttp.ts";
import { GetCanaryRuns } from "./GetCanaryRuns.ts";

export const GetCanaryRunsHttp = Layer.effect(
  GetCanaryRuns,
  makeSyntheticsCanaryHttpBinding({
    tag: "AWS.Synthetics.GetCanaryRuns",
    operation: synthetics.getCanaryRuns,
    actions: ["synthetics:GetCanaryRuns"],
  }),
);
