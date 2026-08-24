import * as opensearch from "@distilled.cloud/aws/opensearch";
import * as Layer from "effect/Layer";
import { makeOpenSearchHttpBinding } from "./BindingHttp.ts";
import { GetUpgradeHistory } from "./GetUpgradeHistory.ts";

export const GetUpgradeHistoryHttp = Layer.effect(
  GetUpgradeHistory,
  makeOpenSearchHttpBinding({
    tag: "AWS.OpenSearch.GetUpgradeHistory",
    operation: opensearch.getUpgradeHistory,
    actions: ["es:GetUpgradeHistory"],
  }),
);
