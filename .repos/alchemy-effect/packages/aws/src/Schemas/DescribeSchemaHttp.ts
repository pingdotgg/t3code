import * as schemas from "@distilled.cloud/aws/schemas";
import * as Layer from "effect/Layer";
import { makeSchemasSchemaHttpBinding } from "./BindingHttp.ts";
import { DescribeSchema } from "./DescribeSchema.ts";

export const DescribeSchemaHttp = Layer.effect(
  DescribeSchema,
  makeSchemasSchemaHttpBinding({
    tag: "AWS.Schemas.DescribeSchema",
    operation: schemas.describeSchema,
    actions: ["schemas:DescribeSchema"],
  }),
);
