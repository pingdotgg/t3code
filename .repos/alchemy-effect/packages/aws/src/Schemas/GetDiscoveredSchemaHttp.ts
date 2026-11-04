import * as schemas from "@distilled.cloud/aws/schemas";
import * as Layer from "effect/Layer";
import { makeSchemasAccountHttpBinding } from "./BindingHttp.ts";
import { GetDiscoveredSchema } from "./GetDiscoveredSchema.ts";

export const GetDiscoveredSchemaHttp = Layer.effect(
  GetDiscoveredSchema,
  makeSchemasAccountHttpBinding({
    tag: "AWS.Schemas.GetDiscoveredSchema",
    operation: schemas.getDiscoveredSchema,
    actions: ["schemas:GetDiscoveredSchema"],
  }),
);
