import * as signer from "@distilled.cloud/aws/signer";
import * as Layer from "effect/Layer";
import { makeSignerHttpBinding } from "./BindingHttp.ts";
import { ListSigningJobs } from "./ListSigningJobs.ts";

export const ListSigningJobsHttp = Layer.effect(
  ListSigningJobs,
  makeSignerHttpBinding({
    tag: "AWS.Signer.ListSigningJobs",
    operation: signer.listSigningJobs,
    actions: ["signer:ListSigningJobs"],
  }),
);
