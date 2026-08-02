import * as dms from "@distilled.cloud/aws/database-migration-service";
import * as Layer from "effect/Layer";
import { makeDmsConnectionScopedHttpBinding } from "./BindingHttp.ts";
import { TestConnection } from "./TestConnection.ts";

export const TestConnectionHttp = Layer.effect(
  TestConnection,
  makeDmsConnectionScopedHttpBinding({
    tag: "AWS.DMS.TestConnection",
    actions: ["dms:TestConnection"],
    operation: dms.testConnection,
  }),
);
