import * as mediaconvert from "@distilled.cloud/aws/mediaconvert";
import * as Layer from "effect/Layer";
import { makeMediaConvertHttpBinding } from "./BindingHttp.ts";
import { CreateJob } from "./CreateJob.ts";

export const CreateJobHttp = Layer.effect(
  CreateJob,
  makeMediaConvertHttpBinding({
    capability: "CreateJob",
    iamActions: ["mediaconvert:CreateJob"],
    operation: mediaconvert.createJob,
    passRole: true,
  }),
);
