import * as schemas from "@distilled.cloud/aws/schemas";
import * as Layer from "effect/Layer";
import { makeSchemasSchemaHttpBinding } from "./BindingHttp.ts";
import { ExportSchema } from "./ExportSchema.ts";

export const ExportSchemaHttp = Layer.effect(
  ExportSchema,
  makeSchemasSchemaHttpBinding({
    tag: "AWS.Schemas.ExportSchema",
    operation: schemas.exportSchema,
    actions: ["schemas:ExportSchema"],
  }),
);
