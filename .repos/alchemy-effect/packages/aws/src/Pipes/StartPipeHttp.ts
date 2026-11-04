import * as pipes from "@distilled.cloud/aws/pipes";
import * as Layer from "effect/Layer";
import { makePipesHttpBinding } from "./BindingHttp.ts";
import { StartPipe } from "./StartPipe.ts";

export const StartPipeHttp = Layer.effect(
  StartPipe,
  makePipesHttpBinding({
    tag: "AWS.Pipes.StartPipe",
    operation: pipes.startPipe,
    actions: ["pipes:StartPipe"],
  }),
);
