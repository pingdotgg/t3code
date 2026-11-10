import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Layer from "effect/Layer";
import { makeInspector2AccountHttpBinding } from "./BindingHttp.ts";
import { ListUsageTotals } from "./ListUsageTotals.ts";

export const ListUsageTotalsHttp = Layer.effect(
  ListUsageTotals,
  makeInspector2AccountHttpBinding({
    tag: "AWS.Inspector2.ListUsageTotals",
    operation: inspector2.listUsageTotals,
    actions: ["inspector2:ListUsageTotals"],
  }),
);
