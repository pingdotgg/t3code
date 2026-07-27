import * as location from "@distilled.cloud/aws/location";
import * as Layer from "effect/Layer";
import { makeLocationAccountHttpBinding } from "./BindingHttp.ts";
import { GetJob } from "./GetJob.ts";

export const GetJobHttp = Layer.effect(
  GetJob,
  makeLocationAccountHttpBinding({
    tag: "AWS.Location.GetJob",
    operation: location.getJob,
    actions: ["geo:GetJob"],
  }),
);
