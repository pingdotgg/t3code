import * as glacier from "@distilled.cloud/aws/glacier";
import * as Layer from "effect/Layer";
import { makeGlacierVaultHttpBinding } from "./BindingHttp.ts";
import { AbortMultipartUpload } from "./AbortMultipartUpload.ts";

export const AbortMultipartUploadHttp = Layer.effect(
  AbortMultipartUpload,
  makeGlacierVaultHttpBinding({
    tag: "AWS.Glacier.AbortMultipartUpload",
    operation: glacier.abortMultipartUpload,
    actions: ["glacier:AbortMultipartUpload"],
  }),
);
