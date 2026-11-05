import * as pipes from "@distilled.cloud/aws/pipes";
import * as Layer from "effect/Layer";
import { makePipesHttpBinding } from "./BindingHttp.ts";
import { DescribePipe } from "./DescribePipe.ts";

export const DescribePipeHttp = Layer.effect(
  DescribePipe,
  makePipesHttpBinding({
    tag: "AWS.Pipes.DescribePipe",
    operation: pipes.describePipe,
    actions: ["pipes:DescribePipe"],
  }),
);
