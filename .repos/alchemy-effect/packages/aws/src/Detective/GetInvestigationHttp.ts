import * as detective from "@distilled.cloud/aws/detective";
import * as Layer from "effect/Layer";
import { makeDetectiveGraphHttpBinding } from "./BindingHttp.ts";
import { GetInvestigation } from "./GetInvestigation.ts";

export const GetInvestigationHttp = Layer.effect(
  GetInvestigation,
  makeDetectiveGraphHttpBinding({
    tag: "AWS.Detective.GetInvestigation",
    operation: detective.getInvestigation,
    actions: ["detective:GetInvestigation"],
  }),
);
