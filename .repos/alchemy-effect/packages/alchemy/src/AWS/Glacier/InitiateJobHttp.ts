import * as glacier from "@distilled.cloud/aws/glacier";
import * as Layer from "effect/Layer";
import { makeGlacierVaultHttpBinding } from "./BindingHttp.ts";
import { InitiateJob } from "./InitiateJob.ts";

export const InitiateJobHttp = Layer.effect(
  InitiateJob,
  makeGlacierVaultHttpBinding({
    tag: "AWS.Glacier.InitiateJob",
    operation: glacier.initiateJob,
    actions: ["glacier:InitiateJob"],
  }),
);
