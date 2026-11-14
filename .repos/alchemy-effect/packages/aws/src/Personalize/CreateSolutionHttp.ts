import * as personalize from "@distilled.cloud/aws/personalize";
import * as Layer from "effect/Layer";
import { makePersonalizeAccountHttpBinding } from "./BindingHttp.ts";
import { CreateSolution } from "./CreateSolution.ts";

export const CreateSolutionHttp = Layer.effect(
  CreateSolution,
  makePersonalizeAccountHttpBinding({
    tag: "AWS.Personalize.CreateSolution",
    operation: personalize.createSolution,
    actions: ["personalize:CreateSolution"],
  }),
);
