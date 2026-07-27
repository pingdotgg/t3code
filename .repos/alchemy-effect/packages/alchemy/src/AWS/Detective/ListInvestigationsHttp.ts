import * as detective from "@distilled.cloud/aws/detective";
import * as Layer from "effect/Layer";
import { makeDetectiveGraphHttpBinding } from "./BindingHttp.ts";
import { ListInvestigations } from "./ListInvestigations.ts";

export const ListInvestigationsHttp = Layer.effect(
  ListInvestigations,
  makeDetectiveGraphHttpBinding({
    tag: "AWS.Detective.ListInvestigations",
    operation: detective.listInvestigations,
    actions: ["detective:ListInvestigations"],
  }),
);
