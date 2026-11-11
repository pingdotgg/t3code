import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Layer from "effect/Layer";
import { makeInspector2AccountHttpBinding } from "./BindingHttp.ts";
import { ListCoverage } from "./ListCoverage.ts";

export const ListCoverageHttp = Layer.effect(
  ListCoverage,
  makeInspector2AccountHttpBinding({
    tag: "AWS.Inspector2.ListCoverage",
    operation: inspector2.listCoverage,
    actions: ["inspector2:ListCoverage"],
  }),
);
