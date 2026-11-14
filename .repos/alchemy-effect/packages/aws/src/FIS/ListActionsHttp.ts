import * as fis from "@distilled.cloud/aws/fis";
import * as Layer from "effect/Layer";
import { makeFisAccountHttpBinding } from "./BindingHttp.ts";
import { ListActions } from "./ListActions.ts";

export const ListActionsHttp = Layer.effect(
  ListActions,
  makeFisAccountHttpBinding({
    tag: "AWS.FIS.ListActions",
    operation: fis.listActions,
    actions: ["fis:ListActions"],
  }),
);
