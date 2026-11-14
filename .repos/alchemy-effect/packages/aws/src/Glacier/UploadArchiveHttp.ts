import * as glacier from "@distilled.cloud/aws/glacier";
import * as Layer from "effect/Layer";
import { makeGlacierVaultHttpBinding } from "./BindingHttp.ts";
import { UploadArchive } from "./UploadArchive.ts";

export const UploadArchiveHttp = Layer.effect(
  UploadArchive,
  makeGlacierVaultHttpBinding({
    tag: "AWS.Glacier.UploadArchive",
    operation: glacier.uploadArchive,
    actions: ["glacier:UploadArchive"],
  }),
);
