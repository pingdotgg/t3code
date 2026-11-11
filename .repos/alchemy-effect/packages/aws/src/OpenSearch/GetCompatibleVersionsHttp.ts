import * as opensearch from "@distilled.cloud/aws/opensearch";
import * as Layer from "effect/Layer";
import { makeOpenSearchHttpBinding } from "./BindingHttp.ts";
import { GetCompatibleVersions } from "./GetCompatibleVersions.ts";

export const GetCompatibleVersionsHttp = Layer.effect(
  GetCompatibleVersions,
  makeOpenSearchHttpBinding({
    tag: "AWS.OpenSearch.GetCompatibleVersions",
    operation: opensearch.getCompatibleVersions,
    actions: ["es:GetCompatibleVersions"],
  }),
);
