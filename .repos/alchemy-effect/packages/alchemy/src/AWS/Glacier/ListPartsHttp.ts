import * as glacier from "@distilled.cloud/aws/glacier";
import * as Layer from "effect/Layer";
import { makeGlacierVaultHttpBinding } from "./BindingHttp.ts";
import { ListParts } from "./ListParts.ts";

export const ListPartsHttp = Layer.effect(
  ListParts,
  makeGlacierVaultHttpBinding({
    tag: "AWS.Glacier.ListParts",
    operation: glacier.listParts,
    actions: ["glacier:ListParts"],
  }),
);
