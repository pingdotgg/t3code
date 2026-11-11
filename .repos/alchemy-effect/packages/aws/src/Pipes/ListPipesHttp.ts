import * as pipes from "@distilled.cloud/aws/pipes";
import * as Layer from "effect/Layer";
import { makePipesAccountHttpBinding } from "./BindingHttp.ts";
import { ListPipes } from "./ListPipes.ts";

export const ListPipesHttp = Layer.effect(
  ListPipes,
  makePipesAccountHttpBinding({
    tag: "AWS.Pipes.ListPipes",
    operation: pipes.listPipes,
    actions: ["pipes:ListPipes"],
  }),
);
