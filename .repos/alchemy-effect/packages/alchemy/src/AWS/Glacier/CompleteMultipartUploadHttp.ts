import * as glacier from "@distilled.cloud/aws/glacier";
import * as Layer from "effect/Layer";
import { makeGlacierVaultHttpBinding } from "./BindingHttp.ts";
import { CompleteMultipartUpload } from "./CompleteMultipartUpload.ts";

export const CompleteMultipartUploadHttp = Layer.effect(
  CompleteMultipartUpload,
  makeGlacierVaultHttpBinding({
    tag: "AWS.Glacier.CompleteMultipartUpload",
    operation: glacier.completeMultipartUpload,
    actions: ["glacier:CompleteMultipartUpload"],
  }),
);
