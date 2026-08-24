import * as schemas from "@distilled.cloud/aws/schemas";
import * as Layer from "effect/Layer";
import { makeSchemasSchemaHttpBinding } from "./BindingHttp.ts";
import { DescribeCodeBinding } from "./DescribeCodeBinding.ts";

export const DescribeCodeBindingHttp = Layer.effect(
  DescribeCodeBinding,
  makeSchemasSchemaHttpBinding({
    tag: "AWS.Schemas.DescribeCodeBinding",
    operation: schemas.describeCodeBinding,
    actions: ["schemas:DescribeCodeBinding"],
  }),
);
