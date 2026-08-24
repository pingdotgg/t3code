import * as mediaconvert from "@distilled.cloud/aws/mediaconvert";
import * as Layer from "effect/Layer";
import { makeMediaConvertHttpBinding } from "./BindingHttp.ts";
import { CancelJob } from "./CancelJob.ts";

export const CancelJobHttp = Layer.effect(
  CancelJob,
  makeMediaConvertHttpBinding({
    capability: "CancelJob",
    iamActions: ["mediaconvert:CancelJob"],
    operation: mediaconvert.cancelJob,
  }),
);
