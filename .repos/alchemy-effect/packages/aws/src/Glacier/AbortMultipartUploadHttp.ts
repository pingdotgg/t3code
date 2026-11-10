import * as glacier from "@distilled.cloud/aws/glacier";
import * as Layer from "effect/Layer";
import { AbortMultipartUpload } from "./AbortMultipartUpload.ts";
import { makeGlacierVaultHttpBinding } from "./BindingHttp.ts";

export const AbortMultipartUploadHttp = Layer.effect(
  AbortMultipartUpload,
  makeGlacierVaultHttpBinding({
    tag: "AWS.Glacier.AbortMultipartUpload",
    operation: glacier.abortMultipartUpload,
    actions: ["glacier:AbortMultipartUpload"],
  }),
);
