import * as opensearch from "@distilled.cloud/aws/opensearch";
import * as Layer from "effect/Layer";
import { makeOpenSearchHttpBinding } from "./BindingHttp.ts";
import { DescribeDomain } from "./DescribeDomain.ts";

export const DescribeDomainHttp = Layer.effect(
  DescribeDomain,
  makeOpenSearchHttpBinding({
    tag: "AWS.OpenSearch.DescribeDomain",
    operation: opensearch.describeDomain,
    actions: ["es:DescribeDomain"],
  }),
);
