import * as glacier from "@distilled.cloud/aws/glacier";
import * as Layer from "effect/Layer";
import { makeGlacierVaultHttpBinding } from "./BindingHttp.ts";
import { UploadMultipartPart } from "./UploadMultipartPart.ts";

export const UploadMultipartPartHttp = Layer.effect(
  UploadMultipartPart,
  makeGlacierVaultHttpBinding({
    tag: "AWS.Glacier.UploadMultipartPart",
    operation: glacier.uploadMultipartPart,
    actions: ["glacier:UploadMultipartPart"],
  }),
);
