import * as opensearch from "@distilled.cloud/aws/opensearch";
import * as Layer from "effect/Layer";
import { makeOpenSearchHttpBinding } from "./BindingHttp.ts";
import { DescribeDomainNodes } from "./DescribeDomainNodes.ts";

export const DescribeDomainNodesHttp = Layer.effect(
  DescribeDomainNodes,
  makeOpenSearchHttpBinding({
    tag: "AWS.OpenSearch.DescribeDomainNodes",
    operation: opensearch.describeDomainNodes,
    actions: ["es:DescribeDomainNodes"],
  }),
);
