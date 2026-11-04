import * as dms from "@distilled.cloud/aws/database-migration-service";
import * as Layer from "effect/Layer";
import { makeDmsEndpointScopedHttpBinding } from "./BindingHttp.ts";
import { DescribeSchemas } from "./DescribeSchemas.ts";

export const DescribeSchemasHttp = Layer.effect(
  DescribeSchemas,
  makeDmsEndpointScopedHttpBinding({
    tag: "AWS.DMS.DescribeSchemas",
    actions: ["dms:DescribeSchemas"],
    operation: dms.describeSchemas,
  }),
);
