import * as codeconnections from "@distilled.cloud/aws/codeconnections";
import * as Layer from "effect/Layer";
import { makeCodeConnectionsAccountHttpBinding } from "./BindingHttp.ts";
import { ListHosts } from "./ListHosts.ts";

export const ListHostsHttp = Layer.effect(
  ListHosts,
  makeCodeConnectionsAccountHttpBinding({
    tag: "AWS.CodeConnections.ListHosts",
    actions: ["codeconnections:ListHosts"],
    operation: codeconnections.listHosts,
  }),
);
