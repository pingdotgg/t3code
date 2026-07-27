import * as athena from "@distilled.cloud/aws/athena";
import * as Layer from "effect/Layer";
import { makeDataCatalogScopedHttpBinding } from "./BindingHttp.ts";
import { GetTableMetadata } from "./GetTableMetadata.ts";

export const GetTableMetadataHttp = Layer.effect(
  GetTableMetadata,
  makeDataCatalogScopedHttpBinding({
    tag: "AWS.Athena.GetTableMetadata",
    operation: athena.getTableMetadata,
    actions: ["athena:GetTableMetadata"],
  }),
);
