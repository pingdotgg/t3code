import * as aiops from "@distilled.cloud/aws/aiops";
import * as Layer from "effect/Layer";
import { makeAIOpsGroupHttpBinding } from "./BindingHttp.ts";
import { GetInvestigationGroup } from "./GetInvestigationGroup.ts";

export const GetInvestigationGroupHttp = Layer.effect(
  GetInvestigationGroup,
  makeAIOpsGroupHttpBinding({
    tag: "AWS.AIOps.GetInvestigationGroup",
    operation: aiops.getInvestigationGroup,
    actions: ["aiops:GetInvestigationGroup"],
    input: (identifier) => ({ identifier }),
  }),
);
