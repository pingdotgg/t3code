import * as schemas from "@distilled.cloud/aws/schemas";
import * as Layer from "effect/Layer";
import { makeSchemasSchemaHttpBinding } from "./BindingHttp.ts";
import { GetCodeBindingSource } from "./GetCodeBindingSource.ts";

export const GetCodeBindingSourceHttp = Layer.effect(
  GetCodeBindingSource,
  makeSchemasSchemaHttpBinding({
    tag: "AWS.Schemas.GetCodeBindingSource",
    operation: schemas.getCodeBindingSource,
    actions: ["schemas:GetCodeBindingSource"],
  }),
);
