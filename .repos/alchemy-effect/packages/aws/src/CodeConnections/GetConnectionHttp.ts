import * as codeconnections from "@distilled.cloud/aws/codeconnections";
import * as Layer from "effect/Layer";
import { makeConnectionScopedHttpBinding } from "./BindingHttp.ts";
import { GetConnection } from "./GetConnection.ts";

export const GetConnectionHttp = Layer.effect(
  GetConnection,
  makeConnectionScopedHttpBinding({
    tag: "AWS.CodeConnections.GetConnection",
    actions: ["codeconnections:GetConnection"],
    operation: codeconnections.getConnection,
  }),
);
