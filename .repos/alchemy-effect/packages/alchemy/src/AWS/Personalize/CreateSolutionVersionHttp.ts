import * as personalize from "@distilled.cloud/aws/personalize";
import * as Layer from "effect/Layer";
import { makePersonalizeAccountHttpBinding } from "./BindingHttp.ts";
import { CreateSolutionVersion } from "./CreateSolutionVersion.ts";

export const CreateSolutionVersionHttp = Layer.effect(
  CreateSolutionVersion,
  makePersonalizeAccountHttpBinding({
    tag: "AWS.Personalize.CreateSolutionVersion",
    operation: personalize.createSolutionVersion,
    actions: ["personalize:CreateSolutionVersion"],
  }),
);
