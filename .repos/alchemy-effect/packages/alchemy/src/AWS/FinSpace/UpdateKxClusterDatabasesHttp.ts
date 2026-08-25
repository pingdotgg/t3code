import * as finspace from "@distilled.cloud/aws/finspace";
import * as Layer from "effect/Layer";
import { makeFinSpaceKxHttpBinding } from "./BindingHttp.ts";
import { UpdateKxClusterDatabases } from "./UpdateKxClusterDatabases.ts";

export const UpdateKxClusterDatabasesHttp = Layer.effect(
  UpdateKxClusterDatabases,
  makeFinSpaceKxHttpBinding({
    tag: "AWS.FinSpace.UpdateKxClusterDatabases",
    operation: finspace.updateKxClusterDatabases,
    actions: ["finspace:UpdateKxClusterDatabases"],
  }),
);
