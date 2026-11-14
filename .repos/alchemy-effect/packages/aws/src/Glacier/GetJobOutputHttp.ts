import * as glacier from "@distilled.cloud/aws/glacier";
import * as Layer from "effect/Layer";
import { makeGlacierVaultHttpBinding } from "./BindingHttp.ts";
import { GetJobOutput } from "./GetJobOutput.ts";

export const GetJobOutputHttp = Layer.effect(
  GetJobOutput,
  makeGlacierVaultHttpBinding({
    tag: "AWS.Glacier.GetJobOutput",
    operation: glacier.getJobOutput,
    actions: ["glacier:GetJobOutput"],
  }),
);
