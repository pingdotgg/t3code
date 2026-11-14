import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Layer from "effect/Layer";
import { makeInspector2AccountHttpBinding } from "./BindingHttp.ts";
import { ListCisScans } from "./ListCisScans.ts";

export const ListCisScansHttp = Layer.effect(
  ListCisScans,
  makeInspector2AccountHttpBinding({
    tag: "AWS.Inspector2.ListCisScans",
    operation: inspector2.listCisScans,
    actions: ["inspector2:ListCisScans"],
  }),
);
