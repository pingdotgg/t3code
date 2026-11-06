import * as codeconnections from "@distilled.cloud/aws/codeconnections";
import * as Layer from "effect/Layer";
import { makeRepositoryLinkScopedHttpBinding } from "./BindingHttp.ts";
import { ListSyncConfigurations } from "./ListSyncConfigurations.ts";

export const ListSyncConfigurationsHttp = Layer.effect(
  ListSyncConfigurations,
  makeRepositoryLinkScopedHttpBinding({
    tag: "AWS.CodeConnections.ListSyncConfigurations",
    actions: ["codeconnections:ListSyncConfigurations"],
    operation: codeconnections.listSyncConfigurations,
  }),
);
