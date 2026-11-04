import * as schemas from "@distilled.cloud/aws/schemas";
import * as Layer from "effect/Layer";
import { makeSchemasSchemaHttpBinding } from "./BindingHttp.ts";
import { PutCodeBinding } from "./PutCodeBinding.ts";

export const PutCodeBindingHttp = Layer.effect(
  PutCodeBinding,
  makeSchemasSchemaHttpBinding({
    tag: "AWS.Schemas.PutCodeBinding",
    operation: schemas.putCodeBinding,
    actions: ["schemas:PutCodeBinding"],
  }),
);
