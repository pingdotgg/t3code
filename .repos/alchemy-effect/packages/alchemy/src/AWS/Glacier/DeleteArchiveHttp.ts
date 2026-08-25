import * as glacier from "@distilled.cloud/aws/glacier";
import * as Layer from "effect/Layer";
import { makeGlacierVaultHttpBinding } from "./BindingHttp.ts";
import { DeleteArchive } from "./DeleteArchive.ts";

export const DeleteArchiveHttp = Layer.effect(
  DeleteArchive,
  makeGlacierVaultHttpBinding({
    tag: "AWS.Glacier.DeleteArchive",
    operation: glacier.deleteArchive,
    actions: ["glacier:DeleteArchive"],
  }),
);
