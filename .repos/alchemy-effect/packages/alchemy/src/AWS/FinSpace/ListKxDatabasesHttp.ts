import * as finspace from "@distilled.cloud/aws/finspace";
import * as Layer from "effect/Layer";
import { makeFinSpaceKxHttpBinding } from "./BindingHttp.ts";
import { ListKxDatabases } from "./ListKxDatabases.ts";

export const ListKxDatabasesHttp = Layer.effect(
  ListKxDatabases,
  makeFinSpaceKxHttpBinding({
    tag: "AWS.FinSpace.ListKxDatabases",
    operation: finspace.listKxDatabases,
    actions: ["finspace:ListKxDatabases"],
  }),
);
