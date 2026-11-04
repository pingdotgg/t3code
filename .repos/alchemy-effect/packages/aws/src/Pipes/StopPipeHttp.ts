import * as pipes from "@distilled.cloud/aws/pipes";
import * as Layer from "effect/Layer";
import { makePipesHttpBinding } from "./BindingHttp.ts";
import { StopPipe } from "./StopPipe.ts";

export const StopPipeHttp = Layer.effect(
  StopPipe,
  makePipesHttpBinding({
    tag: "AWS.Pipes.StopPipe",
    operation: pipes.stopPipe,
    actions: ["pipes:StopPipe"],
  }),
);
