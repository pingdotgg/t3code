import * as mediatailor from "@distilled.cloud/aws/mediatailor";
import * as Layer from "effect/Layer";
import { makeMediaTailorHttpBinding } from "./BindingHttp.ts";
import { UpdateProgram } from "./UpdateProgram.ts";

export const UpdateProgramHttp = Layer.effect(
  UpdateProgram,
  makeMediaTailorHttpBinding({
    capability: "UpdateProgram",
    iamActions: ["mediatailor:UpdateProgram"],
    operation: mediatailor.updateProgram,
  }),
);
