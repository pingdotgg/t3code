import * as mediatailor from "@distilled.cloud/aws/mediatailor";
import * as Layer from "effect/Layer";
import { makeMediaTailorHttpBinding } from "./BindingHttp.ts";
import { DeleteProgram } from "./DeleteProgram.ts";

export const DeleteProgramHttp = Layer.effect(
  DeleteProgram,
  makeMediaTailorHttpBinding({
    capability: "DeleteProgram",
    iamActions: ["mediatailor:DeleteProgram"],
    operation: mediatailor.deleteProgram,
  }),
);
