import * as translate from "@distilled.cloud/aws/translate";
import * as Layer from "effect/Layer";
import { makeTranslateHttpBinding } from "./BindingHttp.ts";
import { GetParallelData } from "./GetParallelData.ts";

export const GetParallelDataHttp = Layer.effect(
  GetParallelData,
  makeTranslateHttpBinding({
    tag: "AWS.Translate.GetParallelData",
    operation: translate.getParallelData,
    actions: ["translate:GetParallelData"],
  }),
);
