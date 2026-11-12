import * as codeconnections from "@distilled.cloud/aws/codeconnections";
import * as Layer from "effect/Layer";
import { makeCodeConnectionsAccountHttpBinding } from "./BindingHttp.ts";
import { ListConnections } from "./ListConnections.ts";

export const ListConnectionsHttp = Layer.effect(
  ListConnections,
  makeCodeConnectionsAccountHttpBinding({
    tag: "AWS.CodeConnections.ListConnections",
    actions: ["codeconnections:ListConnections"],
    operation: codeconnections.listConnections,
  }),
);
