import * as quicksight from "@distilled.cloud/aws/quicksight";
import * as Layer from "effect/Layer";
import { makeQuickSightDataSetHttpBinding } from "./BindingHttp.ts";
import { ListIngestions } from "./ListIngestions.ts";

export const ListIngestionsHttp = Layer.effect(
  ListIngestions,
  makeQuickSightDataSetHttpBinding({
    tag: "AWS.QuickSight.ListIngestions",
    operation: quicksight.listIngestions,
    actions: ["quicksight:ListIngestions"],
  }),
);
