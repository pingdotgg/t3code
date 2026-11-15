import * as aiops from "@distilled.cloud/aws/aiops";
import * as Layer from "effect/Layer";
import { makeAIOpsAccountHttpBinding } from "./BindingHttp.ts";
import { ListInvestigationGroups } from "./ListInvestigationGroups.ts";

export const ListInvestigationGroupsHttp = Layer.effect(
  ListInvestigationGroups,
  makeAIOpsAccountHttpBinding({
    tag: "AWS.AIOps.ListInvestigationGroups",
    operation: aiops.listInvestigationGroups,
    actions: ["aiops:ListInvestigationGroups"],
  }),
);
