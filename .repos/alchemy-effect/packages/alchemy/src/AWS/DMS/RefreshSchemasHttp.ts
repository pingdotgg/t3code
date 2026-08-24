import * as dms from "@distilled.cloud/aws/database-migration-service";
import * as Layer from "effect/Layer";
import { makeDmsConnectionScopedHttpBinding } from "./BindingHttp.ts";
import { RefreshSchemas } from "./RefreshSchemas.ts";

export const RefreshSchemasHttp = Layer.effect(
  RefreshSchemas,
  makeDmsConnectionScopedHttpBinding({
    tag: "AWS.DMS.RefreshSchemas",
    actions: ["dms:RefreshSchemas"],
    operation: dms.refreshSchemas,
  }),
);
