import * as athena from "@distilled.cloud/aws/athena";
import * as Layer from "effect/Layer";
import { makeWorkGroupScopedHttpBinding } from "./BindingHttp.ts";
import { ListQueryExecutions } from "./ListQueryExecutions.ts";

export const ListQueryExecutionsHttp = Layer.effect(
  ListQueryExecutions,
  makeWorkGroupScopedHttpBinding({
    tag: "AWS.Athena.ListQueryExecutions",
    operation: athena.listQueryExecutions,
    actions: ["athena:ListQueryExecutions"],
    injectWorkGroup: true,
  }),
);
