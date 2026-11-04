import * as signer from "@distilled.cloud/aws/signer";
import * as Layer from "effect/Layer";
import { makeSignerProfileHttpBinding } from "./BindingHttp.ts";
import { StartSigningJob } from "./StartSigningJob.ts";

export const StartSigningJobHttp = Layer.effect(
  StartSigningJob,
  makeSignerProfileHttpBinding({
    tag: "AWS.Signer.StartSigningJob",
    operation: signer.startSigningJob,
    actions: ["signer:StartSigningJob"],
  }),
);
