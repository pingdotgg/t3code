import * as codeconnections from "@distilled.cloud/aws/codeconnections";
import * as Layer from "effect/Layer";
import { makeCodeConnectionsAccountHttpBinding } from "./BindingHttp.ts";
import { ListRepositoryLinks } from "./ListRepositoryLinks.ts";

export const ListRepositoryLinksHttp = Layer.effect(
  ListRepositoryLinks,
  makeCodeConnectionsAccountHttpBinding({
    tag: "AWS.CodeConnections.ListRepositoryLinks",
    actions: ["codeconnections:ListRepositoryLinks"],
    operation: codeconnections.listRepositoryLinks,
  }),
);
