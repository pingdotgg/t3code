import * as athena from "@distilled.cloud/aws/athena";
import * as Layer from "effect/Layer";
import { makeDataCatalogScopedHttpBinding } from "./BindingHttp.ts";
import { ListDatabases } from "./ListDatabases.ts";

export const ListDatabasesHttp = Layer.effect(
  ListDatabases,
  makeDataCatalogScopedHttpBinding({
    tag: "AWS.Athena.ListDatabases",
    operation: athena.listDatabases,
    actions: ["athena:ListDatabases"],
  }),
);
