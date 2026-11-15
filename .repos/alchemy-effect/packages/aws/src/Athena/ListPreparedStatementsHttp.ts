import * as athena from "@distilled.cloud/aws/athena";
import * as Layer from "effect/Layer";
import { makeWorkGroupScopedHttpBinding } from "./BindingHttp.ts";
import { ListPreparedStatements } from "./ListPreparedStatements.ts";

export const ListPreparedStatementsHttp = Layer.effect(
  ListPreparedStatements,
  makeWorkGroupScopedHttpBinding({
    tag: "AWS.Athena.ListPreparedStatements",
    operation: athena.listPreparedStatements,
    actions: ["athena:ListPreparedStatements"],
    injectWorkGroup: true,
  }),
);
