import * as athena from "@distilled.cloud/aws/athena";
import * as Layer from "effect/Layer";
import { makeDataCatalogScopedHttpBinding } from "./BindingHttp.ts";
import { ListTableMetadata } from "./ListTableMetadata.ts";

export const ListTableMetadataHttp = Layer.effect(
  ListTableMetadata,
  makeDataCatalogScopedHttpBinding({
    tag: "AWS.Athena.ListTableMetadata",
    operation: athena.listTableMetadata,
    actions: ["athena:ListTableMetadata"],
  }),
);
