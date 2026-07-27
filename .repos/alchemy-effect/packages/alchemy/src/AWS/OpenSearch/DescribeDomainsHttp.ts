import * as opensearch from "@distilled.cloud/aws/opensearch";
import * as Layer from "effect/Layer";
import { makeOpenSearchHttpBinding } from "./BindingHttp.ts";
import { DescribeDomains } from "./DescribeDomains.ts";

export const DescribeDomainsHttp = Layer.effect(
  DescribeDomains,
  makeOpenSearchHttpBinding({
    tag: "AWS.OpenSearch.DescribeDomains",
    operation: opensearch.describeDomains,
    actions: ["es:DescribeDomains"],
  }),
);
