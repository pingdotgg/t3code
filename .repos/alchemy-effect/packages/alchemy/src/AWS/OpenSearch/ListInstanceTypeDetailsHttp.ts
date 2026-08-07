import * as opensearch from "@distilled.cloud/aws/opensearch";
import * as Layer from "effect/Layer";
import { makeOpenSearchHttpBinding } from "./BindingHttp.ts";
import { ListInstanceTypeDetails } from "./ListInstanceTypeDetails.ts";

export const ListInstanceTypeDetailsHttp = Layer.effect(
  ListInstanceTypeDetails,
  makeOpenSearchHttpBinding({
    tag: "AWS.OpenSearch.ListInstanceTypeDetails",
    operation: opensearch.listInstanceTypeDetails,
    actions: ["es:ListInstanceTypeDetails"],
  }),
);
