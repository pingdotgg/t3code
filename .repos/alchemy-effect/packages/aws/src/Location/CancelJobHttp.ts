import * as location from "@distilled.cloud/aws/location";
import * as Layer from "effect/Layer";
import { makeLocationAccountHttpBinding } from "./BindingHttp.ts";
import { CancelJob } from "./CancelJob.ts";

export const CancelJobHttp = Layer.effect(
  CancelJob,
  makeLocationAccountHttpBinding({
    tag: "AWS.Location.CancelJob",
    operation: location.cancelJob,
    actions: ["geo:CancelJob"],
  }),
);
