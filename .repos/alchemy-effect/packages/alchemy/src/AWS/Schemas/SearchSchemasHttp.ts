import * as schemas from "@distilled.cloud/aws/schemas";
import * as Layer from "effect/Layer";
import { makeSchemasRegistryHttpBinding } from "./BindingHttp.ts";
import { SearchSchemas } from "./SearchSchemas.ts";

export const SearchSchemasHttp = Layer.effect(
  SearchSchemas,
  makeSchemasRegistryHttpBinding({
    tag: "AWS.Schemas.SearchSchemas",
    operation: schemas.searchSchemas,
    actions: ["schemas:SearchSchemas"],
  }),
);
