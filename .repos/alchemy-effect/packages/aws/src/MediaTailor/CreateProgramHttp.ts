import * as mediatailor from "@distilled.cloud/aws/mediatailor";
import * as Layer from "effect/Layer";
import { makeMediaTailorHttpBinding } from "./BindingHttp.ts";
import { CreateProgram } from "./CreateProgram.ts";

export const CreateProgramHttp = Layer.effect(
  CreateProgram,
  makeMediaTailorHttpBinding({
    capability: "CreateProgram",
    iamActions: ["mediatailor:CreateProgram"],
    operation: mediatailor.createProgram,
  }),
);
