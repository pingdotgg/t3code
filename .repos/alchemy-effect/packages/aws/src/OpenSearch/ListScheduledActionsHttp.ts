import * as opensearch from "@distilled.cloud/aws/opensearch";
import * as Layer from "effect/Layer";
import { makeOpenSearchHttpBinding } from "./BindingHttp.ts";
import { ListScheduledActions } from "./ListScheduledActions.ts";

export const ListScheduledActionsHttp = Layer.effect(
  ListScheduledActions,
  makeOpenSearchHttpBinding({
    tag: "AWS.OpenSearch.ListScheduledActions",
    operation: opensearch.listScheduledActions,
    actions: ["es:ListScheduledActions"],
  }),
);
