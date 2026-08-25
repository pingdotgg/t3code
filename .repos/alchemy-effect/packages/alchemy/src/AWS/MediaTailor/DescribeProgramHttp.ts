import * as mediatailor from "@distilled.cloud/aws/mediatailor";
import * as Layer from "effect/Layer";
import { makeMediaTailorHttpBinding } from "./BindingHttp.ts";
import { DescribeProgram } from "./DescribeProgram.ts";

export const DescribeProgramHttp = Layer.effect(
  DescribeProgram,
  makeMediaTailorHttpBinding({
    capability: "DescribeProgram",
    iamActions: ["mediatailor:DescribeProgram"],
    operation: mediatailor.describeProgram,
  }),
);
