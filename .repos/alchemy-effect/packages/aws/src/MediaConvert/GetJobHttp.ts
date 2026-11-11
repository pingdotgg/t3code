import * as mediaconvert from "@distilled.cloud/aws/mediaconvert";
import * as Layer from "effect/Layer";
import { makeMediaConvertHttpBinding } from "./BindingHttp.ts";
import { GetJob } from "./GetJob.ts";

export const GetJobHttp = Layer.effect(
  GetJob,
  makeMediaConvertHttpBinding({
    capability: "GetJob",
    iamActions: ["mediaconvert:GetJob"],
    operation: mediaconvert.getJob,
  }),
);
