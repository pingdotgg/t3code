import * as servicecatalog from "@distilled.cloud/aws/service-catalog";
import * as Layer from "effect/Layer";
import { makeServiceCatalogHttpBinding } from "./BindingHttp.ts";
import { ListRecordHistory } from "./ListRecordHistory.ts";

export const ListRecordHistoryHttp = Layer.effect(
  ListRecordHistory,
  makeServiceCatalogHttpBinding({
    capability: "ListRecordHistory",
    iamActions: ["servicecatalog:ListRecordHistory"],
    operation: servicecatalog.listRecordHistory,
  }),
);
