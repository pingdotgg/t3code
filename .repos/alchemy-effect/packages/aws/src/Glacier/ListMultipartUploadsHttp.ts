import * as glacier from "@distilled.cloud/aws/glacier";
import * as Layer from "effect/Layer";
import { makeGlacierVaultHttpBinding } from "./BindingHttp.ts";
import { ListMultipartUploads } from "./ListMultipartUploads.ts";

export const ListMultipartUploadsHttp = Layer.effect(
  ListMultipartUploads,
  makeGlacierVaultHttpBinding({
    tag: "AWS.Glacier.ListMultipartUploads",
    operation: glacier.listMultipartUploads,
    actions: ["glacier:ListMultipartUploads"],
  }),
);
