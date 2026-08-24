import * as translate from "@distilled.cloud/aws/translate";
import * as Layer from "effect/Layer";
import { makeTranslateHttpBinding } from "./BindingHttp.ts";
import { ListParallelData } from "./ListParallelData.ts";

export const ListParallelDataHttp = Layer.effect(
  ListParallelData,
  makeTranslateHttpBinding({
    tag: "AWS.Translate.ListParallelData",
    operation: translate.listParallelData,
    actions: ["translate:ListParallelData"],
  }),
);
