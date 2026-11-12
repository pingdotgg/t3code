import * as athena from "@distilled.cloud/aws/athena";
import * as Layer from "effect/Layer";
import { makeWorkGroupScopedHttpBinding } from "./BindingHttp.ts";
import { ListNamedQueries } from "./ListNamedQueries.ts";

export const ListNamedQueriesHttp = Layer.effect(
  ListNamedQueries,
  makeWorkGroupScopedHttpBinding({
    tag: "AWS.Athena.ListNamedQueries",
    operation: athena.listNamedQueries,
    actions: ["athena:ListNamedQueries"],
    injectWorkGroup: true,
  }),
);
