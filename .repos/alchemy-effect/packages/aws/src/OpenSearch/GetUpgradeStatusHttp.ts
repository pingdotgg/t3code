import * as opensearch from "@distilled.cloud/aws/opensearch";
import * as Layer from "effect/Layer";
import { makeOpenSearchHttpBinding } from "./BindingHttp.ts";
import { GetUpgradeStatus } from "./GetUpgradeStatus.ts";

export const GetUpgradeStatusHttp = Layer.effect(
  GetUpgradeStatus,
  makeOpenSearchHttpBinding({
    tag: "AWS.OpenSearch.GetUpgradeStatus",
    operation: opensearch.getUpgradeStatus,
    actions: ["es:GetUpgradeStatus"],
  }),
);
